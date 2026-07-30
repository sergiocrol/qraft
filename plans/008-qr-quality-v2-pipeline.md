# Plan 008: v2 generation pipeline — scannable-by-construction artistic QR codes

> **Executor instructions**: Follow this plan phase by phase. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done (or when landing an independently shippable phase), update the
> status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 803136b..HEAD -- apps/controlnet/app/services/inference.py apps/controlnet/app/constants.py apps/controlnet/app/schemas/generate.py apps/controlnet/app/lambda.py apps/controlnet/requirements.txt apps/controlnet/Dockerfile packages/validation-schemas/src/qr-generation.ts apps/api/src/services/ControlNetService.ts`
> On any mismatch with the "Current state" excerpts, treat it as a STOP
> condition. Additionally verify the *deployed* relay Lambda matches the repo
> copy before Phase 7 (see STOP conditions — the relay was deployed by hand and
> may have drifted from `app/lambda.py`).

## Status

- **Priority**: P1 (product quality — this is the core value of the product)
- **Effort**: XL (phased; Phases 1–3 are an independently shippable M)
- **Risk**: MED — all changes ship in a new image on the **staging** endpoint
  behind a `pipeline: "v2"` flag; production behavior is unchanged until the
  explicit promotion step, and `make rollback` covers regressions after it.
- **Depends on**: nothing hard. 001 (tests) recommended. **Reconcile with 005
  and 006 if they land first or concurrently** — all three edit
  `apps/controlnet/app/schemas/generate.py` and/or `inference.py` and the Zod
  schema (see "Coordination with other plans").
- **Category**: feature / quality
- **Planned at**: commit `732ba99` (branch `refactor/fable-redesign-controlnet`), 2026-07-04

## Why this matters

The product promise is "artistic **and** scannable". Today both halves are
luck-based, for three compounding reasons:

1. **The QR conditioning input is uncontrolled.** The client renders QR PNGs at
   1024px with whatever module-to-pixel ratio falls out of the QR version, with
   a **white** margin, mixed ECC levels (H/H/M across the three variants — see
   `apps/client/src/lib/qr/variationConfig.ts`), and one variant with a hole
   punched in the middle (`withSpaceQR`, which spends the ECC damage budget
   before generation even starts). The container then NEAREST-resizes that
   arbitrary raster to the output size (`inference.py:440`). Module edges land
   at arbitrary sub-latent positions, and the white margin is interpreted by
   qrcode_monster v2 as "must stay white" instead of "free for art" (v2 treats
   **#808080 gray** as the no-constraint signal — see the model card).
2. **Generation runs off SD 1.5's native manifold.** The default output is
   1024×1024 direct txt2img (`app/constants.py:19-20`) on an SD 1.5 base —
   above its 512–768 training regime, which produces duplicated/mushy
   compositions and *weaker* ControlNet adherence. Every published pipeline on
   this model family (incl. DiffQRCoder, WACV 2025) generates at ~768.
3. **There is no feedback loop.** Nothing on the server verifies that a result
   scans. The only mitigation is client-side reordering of whatever came back
   (`apps/client/src/lib/qr/analyzer.tsx`). Extra generations use *randomly
   chosen* alternative conditioning scales (`qr_processor.py:41`) rather than
   scales chosen in response to a failure.

The fix is a **v2 pipeline** in the same container: canonicalize the QR input
server-side, generate at 768 with tuned per-style presets, **verify scannability
in the container** with the two strongest open-source decoders, and run a
bounded **repair ladder** (deterministic module blending → latent-space
scanning-robust guidance → directed re-roll) borrowed from DiffQRCoder — which
is training-free, MIT-licensed, and built on **exactly the checkpoint family
this repo already ships** (SD 1.5 + `monster-labs/control_v1p_sd15_qrcode_monster` v2
at conditioning scale 1.35).

## Research grounding (summary of sources)

- **DiffQRCoder** (WACV 2025, https://github.com/jwliao1209/DiffQRCoder, MIT;
  paper https://arxiv.org/abs/2409.06355): two-stage pipeline on SD 1.5 +
  QR Monster v2 (scale 1.35). Stage 2 re-noises the stage-1 result and denoises
  under **Scanning-Robust Perceptual Guidance** (SRL, a Gaussian-center-weighted
  per-module error vs. the target matrix, λ₁=500 + LPIPS λ₂=3), then an optional
  latent gradient-descent post-process (**SR-MPGD**) lifts Scanning Success Rate
  (SSR) from 93% → 99–100%. Their setup: QR version 3, module 20px, padding 80px,
  ECC M, mask 4, 40+40 steps, 768² — 14–18 s/image on an RTX 4090 (≈ 35–45 s on
  our A10G). Beats QR Code AI Art (90% SSR), QR Diffusion (96%), QRBTF (56%,
  prettier but unscannable) with SSR 99% at CLIP-aesthetics 6.82.
- **qrcode_monster v2 model card**
  (https://huggingface.co/monster-labs/control_v1p_sd15_qrcode_monster):
  gray (#808080) background = "blend freely"; module size ≥16px recommended;
  higher conditioning scale → more readable, lower → more creative. An SDXL port
  exists (`monster-labs/control_v1p_sdxl_qrcode_monster`) but the community
  still gets the best QR art from SD 1.5 (fine-tune ecosystem + this exact CN).
- **Anthony Fu, "Stylistic QR Code 101"** (https://antfu.me/posts/ai-qrcode-101):
  input QR quality is "one of the most important parts"; Monster weight ~1.0–1.5
  full-window + brightness 0.15–0.35 in a **shortened window (start 0.1–0.4,
  end 0.75–1.0)**; img2img with low denoise + high CN weight to *rescue* nearly
  scannable results; verify with the WeChat scanner (most tolerant); non-square
  canvases hide the QR better.
- **Decoder benchmark** (Dynamsoft 2024,
  https://www.dynamsoft.com/codepool/qr-code-reading-benchmark-and-comparison.html):
  OpenCV **WeChat** module decodes 48.9% of a hard set vs zbar 39%, zxing 32% —
  and it is the same detector family as the client's `qr-scanner-wechat`, so
  server- and client-side verdicts will agree. `zxing-cpp` (pip wheel, no model
  files) is the strict second opinion: if *both* wechat and zxing-cpp decode,
  real-phone success is near-certain.
- **QR capacity facts** used below (byte mode, per version/ECC):
  v3 = 29 modules (M 42 / Q 32 / H 24 bytes), v4 = 33 (M 62 / Q 46 / H 34),
  v5 = 37 (M 84 / Q 60 / H 44), v6 = 41 (M 106 / Q 74 / H 58). Quiet zone =
  4 modules per side.

## Current state (excerpts that must still hold)

- `apps/controlnet/app/constants.py:13-21` —
  `DEFAULT_CONTROLNET_CONDITIONING_SCALE = [1.25, 0.1]`,
  `DEFAULT_CONTROL_GUIDANCE_START = [0.0, 0.1]`, `..._END = [1.0, 1.0]`,
  `DEFAULT_NUM_INFERENCE_STEPS = 30`, `DEFAULT_HEIGHT = DEFAULT_WIDTH = 1024`,
  `DEFAULT_MODEL_KEY = "epicrealism"`.
- `apps/controlnet/app/services/inference.py:440` — input QR is
  `qr_image.resize((width, height), Image.NEAREST)`; `generate()` loops over
  `qr_processor.plan_qr_generations(...)` (random alternative scales), runs
  `self.pipe(...)` once per image, uploads to S3. No decode/verify anywhere.
- `apps/controlnet/app/models/controlnet.py` — `PipelineManager` caches ≤2
  `StableDiffusionControlNetPipeline`s (txt2img only), ControlNets
  `[qrcode_monster(v2 subfolder), latentcat brightness]` shared across bases.
- `apps/controlnet/requirements.txt` — `torch==2.3.1`, `diffusers==0.29.2`,
  `transformers==4.44.2`, `Pillow==10.2.0`, `numpy==1.26.3`. No decoder libs.
- `apps/controlnet/Dockerfile:5` — base `pytorch/pytorch:2.3.1-cuda12.1-cudnn8-devel`;
  ControlNets baked at build; base SD models from S3 at runtime
  (`ENABLE_S3_MODEL_LOADING=True`).
- `apps/controlnet/app/lambda.py:103-135` — the API-Gateway relay **whitelists**
  payload fields (prompt, base_qr_code, negative_prompt, num_inference_steps,
  controlnet_conditioning_scale, control_guidance_start/end, height, width,
  guidance_scale, sampler, + optional num_images_per_prompt/model/seed/guess_mode)
  and routes `environment == "staging"` → `SAGEMAKER_STAGING_ENDPOINT_NAME`.
  New fields are silently dropped unless added here **and** the deployed Lambda
  is updated (no Makefile target exists for it today).
- `packages/validation-schemas/src/qr-generation.ts:113` — Zod already accepts
  `environment: z.enum(["production", "staging"]).optional()`;
  `apps/api/src/services/ControlNetService.ts:510-534` forwards it (staging
  only); `apps/client/src/pages/staging.astro` renders
  `<GenerationPage client:load environment="staging" />`. **The staging lane is
  plumbed end-to-end** — v2 rides it; no new environment value is needed.
- `apps/client/src/lib/qr/analyzer.tsx` — client decodes results with
  `qr-scanner-wechat` and reorders; keep as a second opinion, later fed by
  server metadata.
- `deploy_sagemaker.py` + `Makefile` — `make release-staging IMAGE_VERSION=...`
  does a rolling update of the **staging** endpoint; `make release` / `make
  rollback ROLLBACK_TAG=...` cover production. `AsyncInferenceConfig`
  `max_concurrent_invocations_per_instance=1` (one request at a time per GPU —
  VRAM budget below assumes this).

**Convention to follow**: public API camelCase ↔ container snake_case (keep).
Numeric bounds live in `@repo/qr-constants`, mirrored by Zod and marshmallow.
New container code goes under `apps/controlnet/app/` in the existing package
layout (`utils/`, `services/`, `schemas/`); tests under `apps/controlnet/tests/`.

## Target architecture

One container, two pipelines selected per request. `pipeline: "v1"` (default) is
byte-for-byte today's behavior. `pipeline: "v2"`:

```
qr_content (URL text, preferred)          base_qr_code URLs (fallback)
        │                                          │
        ▼                                          ▼
[0. Canonicalize] ──────────────── decode input QR (wechat); if undecodable → v1 resize path
    qrcode lib: smallest version ≤8 that fits at ECC M,
    then raise ECC to max that still fits (H > Q > M);
    explicit mask; scale = floor(768 / (modules + 8)) px/module (min 12);
    black/white modules, 4-module quiet zone, centered on a
    768×768 #808080 canvas  →  also emit the module matrix + geometry
        │
        ▼
[1. Generate @768] StableDiffusionControlNetPipeline (txt2img)
    monster scale per preset (default 1.35), window [0.0 → 1.0]
    brightness scale per preset (default 0.25), window [0.30 → 0.90]
    30–36 steps DPM++ 2M Karras, CFG 7, per-preset base checkpoint
        │
        ▼
[2. Verify] wechat_qrcode + zxing-cpp over {1.0, 0.5, 0.31}× scales (+ mild blur)
    decoded payload must equal expected content        ── pass ─→ [5]
        │ fail
        ▼
[3. Repair ladder]  (budget: SCAN_REPAIR_BUDGET_S, default 90s/image)
    a. module blend (~0.5s, CPU): SRL-style Gaussian-center error matrix vs
       target; alpha-blend worst modules toward target luminance; re-verify
    b. latent repair (~20–40s): img2img re-noise (strength ≈ 0.40) + denoise
       under SRL+LPIPS gradient guidance (adapted from DiffQRCoder, MIT);
       optional SR-MPGD latent GD polish; re-verify
    c. directed re-roll (last resort): regenerate with monster scale +0.15
       (cap 1.65) and a new seed; re-verify
        │
        ▼
[4. Hires (optional, default on for v2)] img2img ×1.5 → 1152², denoise 0.40,
    both CNs re-applied at 0.8× preset scales; re-verify; if the upscale
    breaks scanning, return the verified 768 image instead
        │
        ▼
[5. Output] PNG → S3 (as today) + per-image metadata:
    scan_verified, scan_score (0–1), decoders_passed, repair_stage_used,
    effective params (seed, scales, preset)
```

New request fields (all optional; absent ⇒ exact v1 behavior):

| public (camelCase) | container (snake_case) | type / bounds | default |
|---|---|---|---|
| `pipeline` | `pipeline` | `"v1" \| "v2"` | `"v1"` |
| `qrContent` | `qr_content` | string, 1–90 chars | — (v2 falls back to decoding `base_qr_code[0]`) |
| `stylePreset` | `style_preset` | enum: `illustration`, `photo`, `cyberpunk`, `watercolor`, `architecture`, `none` | `none` |
| `scanStrictness` | `scan_strictness` | `"relaxed" \| "standard" \| "strict"` | `"standard"` |

Presets map server-side (new `app/presets.py`) to: base `model` key from
`MODEL_REGISTRY`, conditioning scales, guidance windows, steps, prompt
scaffold/negative additions. Initial values come from the research lore above;
**final values come from the Phase 8 eval report**, which is the deliverable
that turns tuning from folklore into a table. `scan_strictness` maps to repair
budget and acceptance: relaxed = wechat-only pass, no latent repair; standard =
wechat pass required, full ladder; strict = wechat **and** zxing-cpp pass
required, full ladder.

v2 generates at 768×768 internally regardless of `height`/`width` unless the
caller sets them explicitly ≤768; the hires stage produces the ≥1024-class
output the product ships today. GPU budget on ml.g5.xlarge (A10G, 24 GB,
1 concurrent invocation): pipeline ~3.5 GB + LPIPS VGG ~0.5 GB + SRPG backprop
peak ~6–8 GB at 768² — comfortable; the 2-pipeline LRU cache still fits.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Python syntax gate | `cd apps/controlnet && python -m py_compile $(git ls-files 'app/**/*.py' 'serve.py')` | exit 0 |
| Container unit tests (new) | `cd apps/controlnet && python -m pytest tests/ -q` | all pass, no GPU needed |
| Local GPU container | `make dev-controlnet` then `make test-local` | 200 + images in S3/local |
| Eval harness (new) | `make eval-qr` (wraps `python apps/controlnet/eval/run_eval.py --target local`) | writes `eval/report.html` + `eval/results.json` |
| JS build/tests | `pnpm -r --filter '@repo/*' run build && cd apps/api && pnpm test` | all pass |
| Client typecheck | `cd apps/client && npx astro check` | no new errors in touched files |
| Staging image release | `make release-staging IMAGE_VERSION=v2.0.0-rc1` | rolling update of staging endpoint |
| Relay lambda deploy (new target) | `make deploy-relay-lambda` | `aws lambda update-function-code` succeeds |
| Promotion (later) | `make release IMAGE_VERSION=v2.0.0` | prod endpoint updated; `make rollback ROLLBACK_TAG=...` is the escape hatch |

## Scope

**In scope**:
- `apps/controlnet/app/utils/qr_canonical.py` (new — content→canonical QR + geometry)
- `apps/controlnet/app/utils/scan_verifier.py` (new — wechat + zxing-cpp verdicts)
- `apps/controlnet/app/utils/module_repair.py` (new — SRL error matrix + module blend)
- `apps/controlnet/app/services/latent_repair.py` (new — SRPG img2img loop + SR-MPGD, adapted from DiffQRCoder, MIT — keep the license header)
- `apps/controlnet/app/presets.py` (new), `app/constants.py` (v2 defaults)
- `apps/controlnet/app/services/inference.py` (stage orchestration; v1 path preserved)
- `apps/controlnet/app/models/controlnet.py` (also build/cache a `StableDiffusionControlNetImg2ImgPipeline` sharing the same components)
- `apps/controlnet/app/schemas/generate.py` (new optional fields)
- `apps/controlnet/requirements.txt` + `Dockerfile` (dep bump + wechat model files)
- `apps/controlnet/tests/` (new pytest suite), `apps/controlnet/eval/` (new harness)
- `apps/controlnet/app/lambda.py` (pass through 4 new fields) + new Makefile target `deploy-relay-lambda`
- `packages/qr-constants/src/index.tsx`, `packages/validation-schemas/src/qr-generation.ts`, `packages/shared-types` (new optional fields)
- `apps/api/src/services/ControlNetService.ts` (`transformRequest` additions)
- `apps/client/src/pages/lab.astro` (new subpage) + minimal props threading in `GenerationPage`/`GenerationForm`/`ResultsView` to send `pipeline:"v2"`+`qrContent` and show scan badges
- `Makefile` (`eval-qr`, `deploy-relay-lambda`)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- Anything plans 002/003/007 own: `JobManager.ts` submission timing, auth/rate
  limiting, `apps/api/src/routes/endpoint.ts`, wake UX.
- The SSRF guard on `base_qr_code` fetching (plan 005 owns `load_qr_code_from_url`
  and the Zod `baseQrCode` field). `qr_content` is text rendered locally — it
  makes no network request and is the *safer* input path.
- Replacing SD 1.5 with SDXL/Flux (future track — see Maintenance notes).
- The client's legacy 3-variant QR generator and analyzer (keep working for the
  main page; the lab page simply also sends `qrContent`).
- Prod endpoint config, autoscaling policies, instance type.
- The Werkzeug-dev-server / RESULTS_DIR-cleanup hygiene items (deferred cluster
  in `plans/README.md`) — don't fix here, but **don't make them worse** (v2
  writes only via the existing `_ensure_results_dir` path).

## Git workflow

- Branch: `advisor/008-qr-quality-v2` off the current integration branch.
- Commit per phase (`feat(controlnet): ...`, `feat(api): ...`, `feat(client): ...`,
  `chore(deploy): ...`). Phases 1–3 may merge as an independently useful unit
  (scan metadata on v1 results) before the rest lands.
- Do NOT push images or deploy anything (staging included) without the operator
  present — deploys cost money and touch live AWS.

## Steps

### Phase 0: Baseline + dependency spike (gate for everything else)

1. Run the drift check; read `plans/README.md` status table for 005/006 state
   and apply "Coordination with other plans" below.
2. Build the current image locally (`make dev-controlnet`) and run
   `make test-local` — record the v1 baseline: wall time per image and, using a
   throwaway script with the Phase 2 verifier, the v1 SSR on
   `eval/prompts.txt` (create it: 20 prompts × the 6 preset themes, fixed seeds,
   one QR content string). **This baseline number is the promotion gate's
   denominator; save it to `eval/baseline_v1.json`.**
3. Dependency spike in a scratch venv (no repo changes yet): install
   `torch==2.6.*+cu124`, `diffusers==0.32.2`, `transformers==4.48.*`,
   `zxing-cpp`, `opencv-contrib-python-headless`, `qrcode[pil]`, `lpips`;
   verify (a) the existing dual-ControlNet txt2img pipeline produces images
   under the new versions, (b) `cv2.wechat_qrcode_WeChatQRCode` constructs with
   the 4 model files from `github.com/WeChatCV/opencv_3rdparty`
   (pin the commit), (c) `zxingcpp.read_barcodes` decodes a PIL-rendered QR.

**Verify**: baseline JSON exists; spike script exits 0 on GPU dev box.
**STOP if** the pinned torch/cu124 wheel is incompatible with the GPU driver on
the SageMaker AMI (check `nvidia-smi` CUDA version on a staging instance first;
fall back to `torch==2.5.*+cu121` and note it).

### Phase 1: New container stack (image only, behavior unchanged)

1. `requirements.txt`: bump `torch`, `diffusers`, `transformers`, `numpy`,
   `accelerate` to the spike-validated pins; add `qrcode[pil]`, `zxing-cpp`,
   `opencv-contrib-python-headless`, `lpips`. (Pillow: leave at the 005-chosen
   version if 005 landed; else bump to the spike-validated one.)
2. `Dockerfile`: switch base to the matching `pytorch/pytorch:2.6.*-cuda12.4-*-devel`
   image; `curl` the four WeChat model files into
   `/opt/program/wechat_models/` pinned to a commit SHA; keep the ControlNet
   bake and S3 model loading exactly as-is.
3. Adjust `app/models/controlnet.py` for any diffusers 0.32 API deltas
   (`resume_download` is deprecated — drop it; scheduler `from_pretrained`
   signature is unchanged). Build the image, run `make dev-controlnet` +
   `make test-local`: output must be visually comparable to baseline (same
   params, same seed ⇒ near-identical images modulo library numerics).

**Verify**: image builds; `make test-local` 200; `py_compile` gate passes.
**STOP if** qrcode_monster or the brightness CN fail to load under
diffusers 0.32 (both are plain `ControlNetModel` safetensors — they should not).

### Phase 2: Canonical QR + verifier + tests (CPU-only, shippable alone)

1. `app/utils/qr_canonical.py`:
   `render_canonical_qr(content: str, canvas_px: int = 768) -> CanonicalQR`
   implementing the version/ECC/scale rules from the architecture diagram
   (`qrcode.QRCode(version=None→fit, error_correction=..., mask_pattern=explicit,
   border=4, box_size=scale)`), gray #808080 canvas, returning the PIL image,
   the module matrix (`qr.get_matrix()`), module size, and origin offset.
   Reject content >90 chars or version >8 with `ValueError`.
   Also `decode_then_canonicalize(image) -> CanonicalQR | None` for the
   `base_qr_code`-only fallback (decode via the Phase 2 verifier, re-render).
   (Corruption-tolerance fixture note for step 3: invert ~20% of *data-area*
   modules, keeping finder/timing patterns intact — full-corner blobs can kill
   finder patterns and make the ECC-level comparison meaningless.)
2. `app/utils/scan_verifier.py`: `verify(image, expected: str, strictness) ->
   ScanReport` — run wechat + zxing-cpp on the image at scales
   {1.0, 0.5, 0.31} and one 1px-Gaussian-blurred variant; a decoder "passes"
   only if its payload equals `expected` exactly; `scan_score` = weighted
   fraction of (decoder × condition) passes, `scan_verified` per the
   strictness table.
3. `tests/test_qr_canonical.py` + `tests/test_scan_verifier.py`: pure-CPU
   pytest — capacity/version/ECC selection table cases (24-byte URL → v3+Q,
   58-byte → v6+H, 91 bytes → ValueError), geometry math
   (modules+8)×scale ≤ 768, gray padding value, round-trip: canonical render →
   verifier decodes = content; a deliberately corrupted render (30% of one
   corner) still decodes at ECC H but not at L.
4. Wire the verifier into **v1 output metadata only** (no behavior change):
   in `inference.py.generate()`, after each image, if the expected content is
   known (decodable input QR), attach `scan_verified`/`scan_score`/
   `decoders_passed` to the per-image `generation_info`. This gives production
   observability of today's real SSR from day one.

**Verify**: `python -m pytest tests/ -q` green on CPU; `make test-local` result
JSON now carries scan fields.

### Phase 3: v2 orchestration skeleton + schema plumbing (container side)

1. `app/schemas/generate.py`: add `pipeline` (OneOf v1/v2, missing="v1"),
   `qr_content` (Length ≤90), `style_preset` (OneOf), `scan_strictness`
   (OneOf, missing="standard") to `InvocationRequestSchema` **and**
   `SageMakerRequestSchema` (keep both schemas' existing fields untouched —
   see the 005/006 reconciliation note).
2. `app/presets.py`: the preset table (checkpoint key, scales, windows, steps,
   prompt scaffold). Seed it with the research values; mark `TUNED_BY:
   eval/report.html` so Phase 8 provably updates it.
3. `inference.py`: extract the current body of the per-image loop into
   `_generate_v1(...)` (verbatim); add `_generate_v2(...)` implementing stages
   0→2 only (canonicalize → generate at 768 → verify; no repair yet), and a
   dispatch on `pipeline`. `app/__init__.py` `/invocations` passes the new
   fields through.
4. Update `app/constants.py` with the v2 defaults block (do not touch v1
   defaults).

**Verify**: `make dev-controlnet`; POST `/invocations` with `pipeline:"v2"`,
`qr_content:"https://example.com/a"` → 200, image at 768², metadata shows
canonical QR geometry + scan report. POST the same body **without** `pipeline`
→ byte-identical v1 behavior (same seed ⇒ compare hashes to Phase 1 output).

### Phase 4: Repair ladder

1. `app/utils/module_repair.py`: SRL-style error matrix (grayscale image vs
   target matrix, Gaussian-center weighting per module, function patterns
   excluded), and `blend_failing_modules(image, canonical, error_matrix,
   strength_ramp)`. Deterministic, CPU, unit-tested with synthetic failures.
2. `app/services/latent_repair.py`: adapt DiffQRCoder's Stage-2 (SRPG-guided
   img2img at strength ≈0.4 under the monster CN, λ₁=500 SRL + λ₂=3 LPIPS) and
   SR-MPGD onto our `StableDiffusionControlNetImg2ImgPipeline`. Vendor only
   the loss/guidance code with the MIT header; do not copy their pipeline
   wholesale. Extend `PipelineManager` to lazily build the img2img pipeline
   **from the same loaded components** — `StableDiffusionControlNetImg2ImgPipeline(**pipe.components)`
   (note: `pipe.components` already includes `controlnet`; don't pass it twice) —
   so VRAM is shared, not doubled.
3. Orchestrate the ladder in `_generate_v2` with the `SCAN_REPAIR_BUDGET_S`
   wall-clock budget (env-driven via `Config`, default 90): a → b → c, re-verify
   after each rung, record `repair_stage_used`, keep the best-scoring image if
   nothing fully passes (never return worse than stage-1 output).

**Verify**: pytest for module_repair; on GPU: craft a low-scale generation
(monster 0.9) that fails verification, confirm the ladder rescues it and
metadata shows the rung used; total added time within budget.
**STOP if** SRPG backprop OOMs at 768² on the dev GPU (<24 GB): halve to
gradient checkpointing or run guidance every 2nd step — note the deviation.

### Phase 5: Hires stage

`_generate_v2` final img2img ×1.5 (768→1152, both CNs at 0.8× scales, denoise
0.40, 20 steps), then re-verify; on failure return the verified 768 image and
flag `hires_dropped: true`. Container flag `V2_HIRES=True` default.

**Verify**: output ≥1152² and still `scan_verified` on the happy path.

### Phase 6: Eval harness + tuning round (the numbers that gate promotion)

1. `apps/controlnet/eval/run_eval.py`: matrix runner (prompts file × presets ×
   3 seeds × {v1, v2}) against `--target local|staging`; decodes every output
   with `scan_verifier`; writes `eval/results.json` (SSR per cell, mean
   scan_score, p50/p95 latency, repair-rung histogram) and a self-contained
   `eval/report.html` grid (image thumbnails base64-inlined, pass/fail badges).
   Add `eval-qr` Makefile target. Never runs in CI (GPU + cost); it's the
   operator's tuning tool — this is the "test it in dev mode" deliverable.
2. Tuning round on the dev GPU: adjust `presets.py` scales/windows until the
   eval set reaches **SSR ≥ 95% at standard strictness with mean scan_score ≥
   0.6 and p95 ≤ 150 s/image** (3-image jobs stay under the 15-min async
   invocation ceiling). Commit the updated presets + the report.

**Verify**: `make eval-qr` produces both artifacts; acceptance numbers met on
the dev GPU (record them in the plan-status row when updating README).

### Phase 7: API / relay / client plumbing (the `/lab` subpage)

1. `packages/qr-constants`: `SUPPORTED_PIPELINES`, `STYLE_PRESETS`,
   `SCAN_STRICTNESS`, `QR_CONTENT_MAX_LENGTH = 90`. `packages/shared-types` +
   `packages/validation-schemas`: optional `pipeline`, `qrContent`,
   `stylePreset`, `scanStrictness` (bounds from qr-constants). Rebuild packages.
2. `ControlNetService.transformRequest`: map the four camelCase fields to
   snake_case (only when present).
3. `app/lambda.py`: pass the four fields through the whitelist (only when
   present). Add `deploy-relay-lambda` Makefile target: zip `app/lambda.py` →
   `aws lambda update-function-code --function-name $$RELAY_LAMBDA_NAME` (name
   from `.env`; document in `.env.example`). **Run the STOP-condition drift
   check against the deployed code first.**
4. Client: `apps/client/src/pages/lab.astro` renders
   `<GenerationPage client:load environment="staging" pipeline="v2" />`;
   thread the prop through `GenerationPage` → `useGenerationForm` →
   `GenerationService.generateQR` so the submit body carries
   `pipeline`/`qrContent` (the form already has the URL text the QR encodes —
   pass it as `qrContent`) and, in `ResultsView`, render a "verified scannable"
   badge when the job result's per-image metadata says `scan_verified` (fall
   back to the existing client analyzer when absent). No other UI redesign.

**Verify**: `pnpm -r --filter '@repo/*' run build`, `cd apps/api && pnpm test`
(add transform-mapping cases to the schema test), `npx astro check`; local
end-to-end: `make dev` → submit from `/lab` → job completes with badges.

### Phase 8: Staging bake + promotion gate (operator-driven)

1. With the operator: `make release-staging IMAGE_VERSION=v2.0.0-rc1`,
   `make deploy-relay-lambda`, deploy client (staging path), run
   `python eval/run_eval.py --target staging` for the cloud numbers.
2. Bake: use `/lab` for real sessions; watch CloudWatch for OOM/latency;
   compare staging eval vs `eval/baseline_v1.json`.
3. Promotion (separate, explicit decision): `make release IMAGE_VERSION=v2.0.0`
   updates prod — **safe because the container default is `pipeline:"v1"`**;
   the main page is unchanged. Flipping the main page to v2 later is a
   one-line client change, done only after the bake. Rollback:
   `make rollback ROLLBACK_TAG=...` (image) + revert the client line.

**Verify**: staging eval meets the Phase 6 gate; prod smoke test post-promotion
(one generation from the main page, v1 behavior + scan metadata present).

## Test plan

- **CPU pytest (new, runs anywhere)**: canonicalizer capacity/geometry table;
  verifier round-trip + corruption tolerance; module-repair error matrix and
  blend; presets table shape; schema accepts/rejects the new fields
  (`pipeline:"v3"` → 400, `qr_content` 91 chars → 400).
- **TS**: schema test extends plan-001 suite — new optional fields validate,
  `transformRequest` maps them, absent fields stay absent.
- **GPU manual gates**: Phase 1 parity check (same seed before/after dep bump);
  Phase 3 v1-bytes-unchanged check; Phase 4 rescue demo; `make eval-qr`
  acceptance numbers.
- **Verification commands**: the Commands table; every phase ends with its
  listed check.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd apps/controlnet && python -m pytest tests/ -q` exits 0 (≥ 12 new tests)
- [ ] `python -m py_compile` gate passes for all touched Python files
- [ ] POST `/invocations` without `pipeline` reproduces v1 output byte-identically for a fixed seed (hash compare vs Phase 1)
- [ ] POST with `pipeline:"v2"` returns per-image `scan_verified`, `scan_score`, `repair_stage_used` in the result JSON
- [ ] `eval/results.json` shows v2 SSR ≥ 95% and v2 SSR > v1 SSR on the same prompt set, and p95 per-image latency ≤ 150 s
- [ ] `grep -n "qr_content" apps/controlnet/app/lambda.py` shows the relay pass-through, and `make deploy-relay-lambda` target exists
- [ ] `cd apps/api && pnpm test` exits 0 including the new field-mapping cases
- [ ] `cd apps/client && npx astro check` reports no new errors; `/lab` page exists and submits `pipeline:"v2"`
- [ ] Production endpoint untouched until Phase 8's explicit promotion (`git log` shows no prod deploy target invocations; deployment_info.json unchanged until then)
- [ ] `plans/README.md` status row updated (include the eval SSR numbers)

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check fails, or plans 005/006 landed changes to
  `generate.py`/`qr-generation.ts` that don't match the excerpts — reconcile
  first (see below), then re-run the drift check.
- `aws lambda get-function` for the relay shows code that **differs from
  `app/lambda.py`** (it was deployed manually and may have drifted) — download
  the deployed zip, diff it, and reconcile the repo copy *before* adding fields.
- The torch/cu124 wheels are incompatible with the SageMaker GPU driver
  (Phase 0 spike catches this locally, but confirm the staging instance's
  `nvidia-smi` before Phase 8).
- SRPG guidance OOMs or exceeds 60 s per repair on the A10G — degrade per the
  Phase 4 note; if still failing, ship v2 with ladder rungs a+c only and record
  the SSR delta.
- The Phase 6 acceptance gate can't be met after a full tuning round — report
  the best numbers and the failure pattern (which presets/prompts fail); do not
  lower the gate unilaterally.
- Anything requires touching prod endpoint config, autoscaling, or plan
  002/003/007-owned files.

## Coordination with other plans

- **005 (SSRF)**: owns `load_qr_code_from_url` and Zod `baseQrCode`. This plan
  must not modify either. If 005 lands first, the v2 fallback path
  (`base_qr_code`-only jobs) automatically inherits its guard. If this plan
  lands first, note in the README row that 005's `inference.py` line anchors
  have moved (the fetch is untouched but the file is reorganized).
- **006 (validation alignment)**: edits the same three schema files. Prefer
  landing 006 first (it's small). Either way: this plan only *adds* optional
  fields and never changes existing bounds; on conflict, keep 006's bounds and
  re-apply the additions.
- **002/003**: new fields ride inside the existing request object through
  `JobManager` untouched; 003's per-job token work affects `/lab` only via the
  shared `GenerationService`, which it already covers.
- **007**: not touched (`endpoint.ts` stays out of scope here).

## Maintenance notes

- **Promotion end-state**: after a clean bake, flip the main page to
  `pipeline:"v2"` (one prop), keep `/lab` as the experiments page, and schedule
  deletion of the client's `withSpaceQR` variant (its center hole fights the
  ECC budget) — that's a separate small plan.
- **Future track (deliberately not in scope)**: SDXL
  (`monster-labs/control_v1p_sdxl_qrcode_monster`) or Flux-family QR ControlNets
  for a "premium" preset tier — needs ml.g5.2xlarge sizing and its own eval
  round; the eval harness built here is the prerequisite either way. Same for
  an aesthetic scorer (CLIP-aesthetics/ImageReward) to auto-rank the N outputs —
  the metadata pipe built here is where its score would go. These are the D3/D4
  directions from the audit given a measurement backbone.
- **Reviewer focus**: (1) the v1 path must be provably unchanged (hash check);
  (2) the relay-lambda drift STOP actually ran; (3) `latent_repair.py` carries
  the MIT attribution; (4) the eval report is committed alongside the preset
  values it justifies.
- Key sources for whoever re-tunes later: DiffQRCoder repo/paper, monster v2
  model card, antfu's 101 post, Dynamsoft decoder benchmark (URLs in "Research
  grounding").
