# Plan 009 — Transparent prompt enhancement

## Problem

QR-art quality depends critically on the prompt: organic/fluid/fragmented
elements and structured density blend with QR modules; flat minimal scenes and
dominant portraits fight them (antfu "AI QR Code 101", stable-diffusion-art.com,
qrcode_monster v2 model card). Users write short prompts, often in Spanish
(SD 1.5's CLIP performs much better in English), without texture/quality
modifiers.

## Solution

A prompt-enhancement module that rewrites the user's prompt automatically and
**completely transparently** — the user only ever sees their original prompt
(input, processing, results) — without distorting their message, with an
Advanced-settings checkbox (default ON) to disable it.

- **Engine**: Qwen2.5-1.5B-Instruct (Apache-2.0, ~3.1 GB fp16), co-resident
  with SD on the GPU (the FLUX.2 `prompt_upsampling` pattern). Multilingual
  (translates ES→EN), compatible with the pinned `transformers==4.48.3`
  (qwen2 arch needs ≥4.37; Qwen3 would need ≥4.51 — do NOT touch pins).
- **Determinism**: greedy decoding (`do_sample=False`) — same input, same
  enhanced prompt; per-seed reproducibility intact.
- **Safety rails** (`app/services/prompt_enhancer.py`, lore in
  `prompt_enhancer_lore.py`): ops kill-switch `PROMPT_ENHANCEMENT_ENABLED`,
  sticky load failure, hard timeout (default 4 s, `StoppingCriteria` deadline
  + 1-worker executor), strict one-line JSON parse with rejection markers,
  CLIP budget ≤ 60 tokens over the **composed** prompt (v2 preset scaffold
  included) with deterministic comma-clause trimming, rules-based fallback
  (`FALLBACK_SUFFIX_PACKS` per preset). `enhance()` never raises — enhancement
  can never take a generation down.
- **Transparency by construction**: DynamoDB stores the original prompt; the
  status endpoint and "Prompt used" read from it; `output_data` carries no
  prompt text. The enhanced prompt exists only in the container + CloudWatch
  logs (`source/reason/latency`, `original=`, `final=`).
- **VRAM**: SD peaks ~6-8 GB of 24 GB (A10G); worst case with the LLM
  resident ~16-18 GB. If OOM: kill-switch + `deploy_sagemaker.py
  --update-only` (fresh instances never load the LLM).

## Request flow

```
client checkbox (default ON)
  → Zod: promptEnhancement .default(true)      [DynamoDB keeps ORIGINAL]
  → ControlNetService: prompt_enhancement (snake_case)
  → relay lambda whitelist (is-not-None forward)
  → container: prompt_enhancer.enhance() → diffusers pipe(prompt=enhanced)
```

Container-side schema default is **False** — the ON default lives only in the
public Zod schema, so old clients keep byte-identical behavior.

## Weights delivery

S3 runtime download (same pattern as SD checkpoints; no Dockerfile change):
`make upload-llm-model` once → `s3://$MODEL_S3_BUCKET/llm-models/qwen2.5-1.5b-instruct/`;
container syncs via `download_llm_from_s3` (sentinel `config.json`,
`local_files_only` — NOT `HF_HUB_OFFLINE`). Optional pre-warm daemon thread in
`create_app()` hides the ~30-60 s first load inside the 3-4 min wake.

## Deployment order — STOP CONDITION

Marshmallow uses `unknown=RAISE`: an **old container receiving the new field
400s every generation**. Mandatory order:

1. **Container** (`make release IMAGE_VERSION=…` / release-staging) — accepts
   the field, defaults False.
2. **Relay lambda** (`make deploy-relay-lambda`, after the anti-drift diff) —
   forwards the field.
3. **API** (`make deploy-api`) — maps `promptEnhancement` →
   `prompt_enhancement`.
4. **Client** (`make deploy-client`) — sends it (default true).

Rollback in reverse. Emergency soft-off without ordering:
`PROMPT_ENHANCEMENT_ENABLED=False` via `deploy_sagemaker.py --update-only`.

## Eval (A/B)

`eval/run_eval.py --prompt-enhancement` vs default-off baseline, same seeds.
Gate: SSR must not regress (gates in run_eval.py); record scan_score and p95
latency deltas. `results.json`/report are labelled with the flag.

## Tests

- vitest (`apps/api`): Zod default-true / explicit-false / non-boolean
  rejected; `transformRequest` maps true AND false; absent stays absent.
- pytest (`apps/controlnet`): schema defaults/bounds
  (`test_invocation_schema.py`), enhancer unit suite with mocked LLM
  (`test_prompt_enhancer.py`), dispatch pins (`test_inference_dispatch.py`):
  flag off → verbatim (v1 purity), flag on → pipe gets the enhanced prompt and
  `output_data` never contains it, v2 → preset scaffold wraps the enhanced
  prompt.
