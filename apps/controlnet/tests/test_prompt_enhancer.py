"""CPU tests for the prompt enhancer (plan 009).

The LLM is never loaded: ``_ensure_loaded``/``_generate`` are monkeypatched,
and torch/transformers are stubbed before import (same trick as
test_inference_dispatch). A fake CLIP tokenizer (1 token per whitespace word
+ 2 specials) exercises the budget/trimming logic deterministically.

Run: cd apps/controlnet && python3 -m pytest tests/test_prompt_enhancer.py -q
"""

import importlib
import sys
import time
import types
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent / "app"


def _install_stubs():
    if "torch" not in sys.modules:
        torch_stub = types.ModuleType("torch")
        torch_stub.manual_seed = lambda seed: None
        torch_stub.float16 = object()
        torch_stub.float32 = object()
        torch_stub.cuda = types.SimpleNamespace(is_available=lambda: False)

        class _InferenceMode:
            def __call__(self):
                return self

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        torch_stub.inference_mode = _InferenceMode()
        sys.modules["torch"] = torch_stub

    for name, path in (("app", APP_DIR), ("app.utils", APP_DIR / "utils"),
                       ("app.services", APP_DIR / "services")):
        if name not in sys.modules:
            pkg = types.ModuleType(name)
            pkg.__path__ = [str(path)]
            sys.modules[name] = pkg

    # model_downloader imports boto3 at module level; the enhancer only needs
    # download_llm_from_s3, which these tests never reach.
    if "app.utils.model_downloader" not in sys.modules:
        downloader_stub = types.ModuleType("app.utils.model_downloader")
        downloader_stub.MODEL_REGISTRY = {"epicrealism": {}}
        downloader_stub.download_llm_from_s3 = lambda *a, **k: None
        sys.modules["app.utils.model_downloader"] = downloader_stub


_install_stubs()
prompt_enhancer = importlib.import_module("app.services.prompt_enhancer")
lore = importlib.import_module("app.services.prompt_enhancer_lore")
presets = importlib.import_module("app.presets")
constants = importlib.import_module("app.constants")

PromptEnhancer = prompt_enhancer.PromptEnhancer
BUDGET = constants.PROMPT_ENHANCER_MAX_CLIP_TOKENS


class FakeClipTokenizer:
    """1 token per whitespace word + 2 specials (bos/eos)."""

    def __call__(self, text):
        return {"input_ids": [0] * (len(text.split()) + 2)}


TOKENIZER = FakeClipTokenizer()

ENABLED_CONFIG = {
    "PROMPT_ENHANCEMENT_ENABLED": True,
    "ENABLE_S3_MODEL_LOADING": False,
    "MODEL_S3_BUCKET": "",
    "PROMPT_ENHANCER_S3_PREFIX": "llm-models",
    "MODEL_CACHE_DIR": "/tmp/hf-cache",
    "PROMPT_ENHANCER_TIMEOUT_S": 4.0,
}


def _enhancer(llm_output=None, config=None, generate_fn=None):
    """Enhancer whose LLM is mocked to return *llm_output* (str)."""
    enhancer = PromptEnhancer(config or ENABLED_CONFIG)
    enhancer._model = object()  # marks "loaded"
    enhancer._tokenizer = object()
    if generate_fn is not None:
        enhancer._generate = generate_fn
    else:
        enhancer._generate = lambda prompt, preset_name, deadline: llm_output
    return enhancer


class TestHappyPath:
    def test_valid_llm_output_is_used(self):
        result = _enhancer('{"prompt": "a fox, autumn leaves, sharp focus"}').enhance(
            "un zorro", clip_tokenizer=TOKENIZER)
        assert result.source == "llm"
        assert result.reason == "ok"
        assert result.prompt == "a fox, autumn leaves, sharp focus"

    def test_budget_is_scaffold_aware(self):
        # Candidate fits alone but not once the preset scaffold wraps it:
        # trimming must account for the composed prompt.
        preset = presets.get_preset("cyberpunk")
        long_candidate = ", ".join(f"clause{i} word word" for i in range(20))
        result = _enhancer(f'{{"prompt": "{long_candidate}"}}').enhance(
            "city", preset=preset, clip_tokenizer=TOKENIZER)
        assert result.source == "llm"
        composed = presets.apply_prompt_scaffold(preset, result.prompt)
        assert len(TOKENIZER(composed)["input_ids"]) <= BUDGET

    def test_determinism_same_input_same_output(self):
        enhancer = _enhancer('{"prompt": "a fox, snow, sharp focus"}')
        first = enhancer.enhance("a fox", clip_tokenizer=TOKENIZER)
        second = enhancer.enhance("a fox", clip_tokenizer=TOKENIZER)
        assert first.prompt == second.prompt


class TestFallback:
    @pytest.mark.parametrize("bad_output", [
        "", "   ", "not json at all", '{"other": "x"}', '{"prompt": ""}',
        '{"prompt": "I cannot assist with that request"}',
        '{broken json', '{"prompt": "' + "x" * 700 + '"}',
    ])
    def test_invalid_llm_output_falls_back(self, bad_output):
        result = _enhancer(bad_output).enhance(
            "a fox", clip_tokenizer=TOKENIZER)
        assert result.source == "fallback"
        assert result.prompt.startswith("a fox")

    def test_fallback_uses_preset_pack(self):
        preset = presets.get_preset("watercolor")
        result = _enhancer("garbage").enhance(
            "a fox", preset=preset, clip_tokenizer=TOKENIZER)
        assert result.source == "fallback"
        pack_head = lore.FALLBACK_SUFFIX_PACKS["watercolor"].split(",")[0].strip()
        assert pack_head in result.prompt

    def test_fallback_dedupes_clauses_already_present(self):
        result = _enhancer("garbage").enhance(
            "a fox, highly detailed", clip_tokenizer=TOKENIZER)
        assert result.prompt.lower().count("highly detailed") == 1

    def test_original_that_does_not_fit_is_untouched(self):
        huge = " ".join(f"word{i}" for i in range(120))  # >> 60 tokens
        result = _enhancer("garbage").enhance(huge, clip_tokenizer=TOKENIZER)
        assert result.source == "original"
        assert result.prompt == huge

    def test_llm_exception_returns_original(self):
        def boom(prompt, preset_name, deadline):
            raise RuntimeError("cuda exploded")

        result = _enhancer(generate_fn=boom).enhance(
            "a fox", clip_tokenizer=TOKENIZER)
        # The worker exception surfaces via future.result() and is caught by
        # the outer guard -> original verbatim, never a raise.
        assert result.prompt.startswith("a fox")
        assert result.source in ("fallback", "original")

    def test_trimming_is_deterministic_comma_clauses(self):
        candidate = "subject, aaa bbb, ccc ddd, eee fff, ggg hhh"
        fitted = PromptEnhancer._fit_to_budget(candidate, None, TOKENIZER)
        again = PromptEnhancer._fit_to_budget(candidate, None, TOKENIZER)
        assert fitted == again
        assert fitted.startswith("subject")


class TestTimeout:
    def test_slow_generation_falls_back_within_bound(self):
        def slow(prompt, preset_name, deadline):
            time.sleep(2.0)
            return '{"prompt": "too late"}'

        enhancer = _enhancer(generate_fn=slow)
        start = time.monotonic()
        result = enhancer.enhance("a fox", clip_tokenizer=TOKENIZER,
                                  timeout_s=0.2)
        elapsed = time.monotonic() - start
        assert result.source == "fallback"
        assert result.reason == "timeout"
        assert elapsed < 1.5  # bounded: does not wait for the slow worker


class TestKillSwitchAndLoading:
    def test_kill_switch_returns_original_verbatim(self):
        config = dict(ENABLED_CONFIG, PROMPT_ENHANCEMENT_ENABLED=False)
        enhancer = PromptEnhancer(config)
        result = enhancer.enhance("un zorro en el bosque",
                                  clip_tokenizer=TOKENIZER)
        assert result.source == "original"
        assert result.reason == "disabled"
        assert result.prompt == "un zorro en el bosque"

    def test_load_failure_is_sticky(self):
        enhancer = PromptEnhancer(ENABLED_CONFIG)
        attempts = []

        def failing_load():
            attempts.append(1)
            raise RuntimeError("no weights")

        enhancer._load = failing_load
        first = enhancer.enhance("a fox", clip_tokenizer=TOKENIZER)
        second = enhancer.enhance("a fox", clip_tokenizer=TOKENIZER)
        assert first.source == "fallback" and first.reason == "load_failed"
        assert second.reason == "load_failed"
        assert len(attempts) == 1  # not retried per request


class TestLore:
    def test_fallback_packs_cover_all_style_presets(self):
        assert set(lore.FALLBACK_SUFFIX_PACKS) >= set(presets.STYLE_PRESET_NAMES)
        assert "none" in lore.FALLBACK_SUFFIX_PACKS

    def test_packs_avoid_negative_prompt_vocabulary(self):
        banned = ("blurry", "text", "watermark", "logo", "signature",
                  "low quality")
        for pack in lore.FALLBACK_SUFFIX_PACKS.values():
            clauses = {c.strip().lower() for c in pack.split(",")}
            assert not clauses & set(banned)

    def test_build_messages_wraps_user_text_and_flags_preset(self):
        messages = lore.build_messages("un zorro", "watercolor")
        assert messages[0]["role"] == "system"
        assert "<<<un zorro>>>" in messages[1]["content"]
        assert "watercolor" in messages[1]["content"]
        # no style note when no preset is active
        plain = lore.build_messages("un zorro", None)
        assert "style preset" not in plain[1]["content"]
