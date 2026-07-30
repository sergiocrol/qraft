"""Transparent prompt enhancement (plan 009).

A small instruct LLM (Qwen2.5-1.5B-Instruct) co-resident with SD on the GPU
rewrites the user's prompt into a QR-friendly English tag prompt: subject
preserved, translated to English, texture/quality modifiers appended. The
enhanced prompt exists ONLY inside this container (and its logs): the public
contract — DynamoDB, status endpoint, output_data — always carries the
user's original prompt.

Guarantees:
- ``enhance()`` never raises: every failure (kill-switch, load failure,
  timeout, invalid output, unexpected exception) degrades to the rules-based
  fallback or to the original prompt verbatim. Enhancement can never take a
  generation down.
- Greedy decoding (``do_sample=False``): same input -> same enhanced prompt,
  so per-seed reproducibility is intact.
- The final composed prompt (preset scaffold applied on top when a v2 preset
  is active) is budgeted to <= PROMPT_ENHANCER_MAX_CLIP_TOKENS CLIP tokens.

torch/transformers are imported inside methods so the CPU test suite can
import this module with the existing stub trick (see test_inference_dispatch).
"""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass

from ..constants import (
    PROMPT_ENHANCER_HF_ID,
    PROMPT_ENHANCER_S3_KEY,
    PROMPT_ENHANCER_MAX_CLIP_TOKENS,
    PROMPT_ENHANCER_MAX_NEW_TOKENS,
    DEFAULT_PROMPT_ENHANCER_TIMEOUT_S,
)
from ..presets import apply_prompt_scaffold
from ..utils.logging import get_logger
from .prompt_enhancer_lore import (
    REJECTION_MARKERS,
    FALLBACK_SUFFIX_PACKS,
    build_messages,
)

logger = get_logger(__name__)

# Longest raw LLM output we accept as a candidate prompt (chars). Anything
# beyond this is a runaway/degenerate generation, not a tag prompt.
_MAX_CANDIDATE_CHARS = 600


@dataclass
class EnhancementResult:
    prompt: str
    source: str      # "llm" | "fallback" | "original"
    reason: str
    latency_s: float


class PromptEnhancer:
    """Lazy-loaded enhancer. One instance per process (see get_enhancer())."""

    def __init__(self, config=None):
        from ..config import Config
        cfg = config or {}
        get = cfg.get if hasattr(cfg, "get") else lambda k, d=None: getattr(cfg, k, d)
        self._enabled = get("PROMPT_ENHANCEMENT_ENABLED", Config.PROMPT_ENHANCEMENT_ENABLED)
        self._s3_loading = get("ENABLE_S3_MODEL_LOADING", Config.ENABLE_S3_MODEL_LOADING)
        self._s3_bucket = get("MODEL_S3_BUCKET", Config.MODEL_S3_BUCKET)
        self._s3_prefix = get("PROMPT_ENHANCER_S3_PREFIX", Config.PROMPT_ENHANCER_S3_PREFIX)
        self._cache_root = get("MODEL_CACHE_DIR", Config.MODEL_CACHE_DIR)
        self._timeout_s = float(get(
            "PROMPT_ENHANCER_TIMEOUT_S",
            getattr(Config, "PROMPT_ENHANCER_TIMEOUT_S", DEFAULT_PROMPT_ENHANCER_TIMEOUT_S),
        ))
        self._model = None
        self._tokenizer = None
        self._load_failed = False   # sticky: a failed load is not retried
        self._load_lock = threading.Lock()
        # Single worker: generations are serialized, and an abandoned
        # (timed-out) generation self-terminates via its StoppingCriteria
        # deadline instead of blocking the worker forever.
        self._executor = ThreadPoolExecutor(max_workers=1)

    # -- loading ------------------------------------------------------------

    def _ensure_loaded(self):
        """Load the LLM once; a failure is sticky. Returns True when usable."""
        if self._model is not None:
            return True
        if self._load_failed:
            return False
        with self._load_lock:
            if self._model is not None:
                return True
            if self._load_failed:
                return False
            try:
                self._load()
                return True
            except Exception as e:
                logger.error("Prompt enhancer LLM load failed (sticky): %s", e)
                self._load_failed = True
                return False

    def _load(self):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        start = time.time()
        hf_id = PROMPT_ENHANCER_HF_ID
        local_only = False
        if self._s3_loading:
            from ..utils.model_downloader import download_llm_from_s3
            download_llm_from_s3(
                hf_id,
                PROMPT_ENHANCER_S3_KEY,
                bucket=self._s3_bucket,
                prefix=self._s3_prefix,
                cache_root=self._cache_root,
            )
            local_only = True

        # NOTE: local_files_only (not HF_HUB_OFFLINE) — the Dockerfile omits
        # HF_HUB_OFFLINE on purpose; setting it would break other loads.
        self._tokenizer = AutoTokenizer.from_pretrained(
            hf_id, local_files_only=local_only)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32
        self._model = AutoModelForCausalLM.from_pretrained(
            hf_id, torch_dtype=dtype, local_files_only=local_only).to(device)
        self._model.eval()
        logger.info(
            "Prompt enhancer LLM loaded (%s on %s) in %.1fs",
            hf_id, device, time.time() - start,
        )

    def prewarm(self):
        """Best-effort eager load (call from a daemon thread at startup to
        hide the first-load latency inside the endpoint wake). Never raises."""
        if not self._enabled:
            return
        try:
            self._ensure_loaded()
        except Exception:
            pass

    # -- generation ---------------------------------------------------------

    def _generate(self, prompt, preset_name, deadline):
        """Run the LLM (greedy, deterministic). Executed on the worker thread."""
        import torch
        from transformers import StoppingCriteria, StoppingCriteriaList

        class _Deadline(StoppingCriteria):
            def __call__(self, input_ids, scores, **kwargs):
                return time.monotonic() >= deadline

        messages = build_messages(prompt, preset_name)
        text = self._tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True)
        inputs = self._tokenizer(text, return_tensors="pt").to(self._model.device)
        with torch.inference_mode():
            output_ids = self._model.generate(
                **inputs,
                do_sample=False,
                num_beams=1,
                max_new_tokens=PROMPT_ENHANCER_MAX_NEW_TOKENS,
                pad_token_id=self._tokenizer.pad_token_id or self._tokenizer.eos_token_id,
                stopping_criteria=StoppingCriteriaList([_Deadline()]),
            )
        new_tokens = output_ids[0][inputs["input_ids"].shape[1]:]
        return self._tokenizer.decode(new_tokens, skip_special_tokens=True)

    @staticmethod
    def _parse_candidate(raw):
        """Strict parse of the LLM output -> candidate prompt or (None, why)."""
        if not raw or not raw.strip():
            return None, "empty_output"
        line = raw.strip().splitlines()[0].strip()
        if not line.startswith("{"):
            return None, "not_json"
        try:
            payload = json.loads(line)
        except (ValueError, TypeError):
            return None, "invalid_json"
        candidate = payload.get("prompt") if isinstance(payload, dict) else None
        if not isinstance(candidate, str) or not candidate.strip():
            return None, "no_prompt_field"
        candidate = " ".join(candidate.split())  # collapse whitespace/newlines
        if len(candidate) > _MAX_CANDIDATE_CHARS:
            return None, "too_long"
        lowered = candidate.lower()
        if any(marker in lowered for marker in REJECTION_MARKERS):
            return None, "rejection_marker"
        return candidate, None

    # -- budgeting ----------------------------------------------------------

    @staticmethod
    def _count_clip_tokens(text, clip_tokenizer):
        return len(clip_tokenizer(text)["input_ids"])

    @classmethod
    def _fit_to_budget(cls, candidate, preset, clip_tokenizer):
        """Deterministically trim comma-clauses off *candidate*'s tail until
        the COMPOSED prompt (preset scaffold applied when active) fits the
        CLIP budget. Returns the fitted candidate, or None if even an empty
        remainder can't fit (caller then leaves the original untouched)."""
        if clip_tokenizer is None:
            return candidate

        def composed(text):
            return apply_prompt_scaffold(preset, text) if preset else text

        clauses = [c.strip() for c in candidate.split(",") if c.strip()]
        while clauses:
            text = ", ".join(clauses)
            if cls._count_clip_tokens(composed(text), clip_tokenizer) <= PROMPT_ENHANCER_MAX_CLIP_TOKENS:
                return text
            clauses.pop()
        return None

    # -- fallback -----------------------------------------------------------

    def _fallback(self, prompt, preset, clip_tokenizer, reason, start):
        """Rules-based fallback: original + curated suffix pack, budgeted.
        If even the original prompt doesn't fit, return it untouched."""
        preset_name = preset["name"] if preset else "none"
        pack = FALLBACK_SUFFIX_PACKS.get(preset_name, FALLBACK_SUFFIX_PACKS["none"])
        existing = {c.strip().lower() for c in prompt.split(",")}
        additions = [c.strip() for c in pack.split(",")
                     if c.strip() and c.strip().lower() not in existing]
        candidate = f"{prompt}, {', '.join(additions)}" if additions else prompt

        if clip_tokenizer is not None:
            original_tokens = self._count_clip_tokens(
                apply_prompt_scaffold(preset, prompt) if preset else prompt,
                clip_tokenizer,
            )
            if original_tokens > PROMPT_ENHANCER_MAX_CLIP_TOKENS:
                return EnhancementResult(prompt, "original", reason, time.time() - start)
            fitted = self._fit_to_budget(candidate, preset, clip_tokenizer)
            # The original fits, so trimming can never go below it — but be
            # safe against a pathological tokenizer.
            candidate = fitted if fitted else prompt
        return EnhancementResult(candidate, "fallback", reason, time.time() - start)

    # -- public entry point ---------------------------------------------------

    def enhance(self, prompt, preset=None, clip_tokenizer=None, timeout_s=None):
        """Enhance *prompt*. Never raises; worst case returns it verbatim.

        *preset* is the resolved v2 preset dict (or None on v1): the CLIP
        budget is computed over the composed prompt, i.e. with the preset's
        scaffold applied on top of the candidate.
        """
        start = time.time()
        try:
            if not self._enabled:
                return EnhancementResult(prompt, "original", "disabled", 0.0)
            if not self._ensure_loaded():
                return self._fallback(prompt, preset, clip_tokenizer, "load_failed", start)

            timeout = float(timeout_s) if timeout_s is not None else self._timeout_s
            preset_name = preset["name"] if preset else None
            deadline = time.monotonic() + timeout
            future = self._executor.submit(self._generate, prompt, preset_name, deadline)
            try:
                raw = future.result(timeout=timeout + 0.5)
            except FutureTimeoutError:
                return self._fallback(prompt, preset, clip_tokenizer, "timeout", start)

            candidate, why = self._parse_candidate(raw)
            if candidate is None:
                return self._fallback(prompt, preset, clip_tokenizer, why, start)

            fitted = self._fit_to_budget(candidate, preset, clip_tokenizer)
            if fitted is None:
                return self._fallback(prompt, preset, clip_tokenizer, "over_budget", start)
            return EnhancementResult(fitted, "llm", "ok", time.time() - start)
        except Exception as e:
            logger.exception("Prompt enhancement failed unexpectedly: %s", e)
            return EnhancementResult(prompt, "original", "error", time.time() - start)


_enhancer = None
_enhancer_lock = threading.Lock()


def get_enhancer(config=None):
    """Process-wide singleton (first caller's config wins)."""
    global _enhancer
    if _enhancer is None:
        with _enhancer_lock:
            if _enhancer is None:
                _enhancer = PromptEnhancer(config)
    return _enhancer
