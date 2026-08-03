# app/constants.py
"""Centralized inference and API defaults (non-env). For env-driven config see app.config.Config."""

# Inference defaults
DEFAULT_NEGATIVE_PROMPT = (
    "ugly, disfigured, low quality, blurry, nsfw, deformed, mutated, watermark, text, signature, "
    "logo, banner, extra digits, cropped, jpeg artifacts, username, error, sketch, duplicate, "
    "morbid, gross, out of frame, poorly drawn face, poorly drawn hands, mutation, missing arms, "
    "missing legs, extra arms, extra legs, fused fingers, too many fingers, long neck, low resolution, "
    "bad anatomy, bad proportions, cloned face, oversaturated"
)

DEFAULT_CONTROLNET_CONDITIONING_SCALE = [1.25, 0.1]
DEFAULT_CONTROL_GUIDANCE_START = [0.0, 0.1]
DEFAULT_CONTROL_GUIDANCE_END = [1.0, 1.0]
DEFAULT_NUM_INFERENCE_STEPS = 30
DEFAULT_GUIDANCE_SCALE = 7.0
DEFAULT_SAMPLER = "dpm++_2m_karras"
DEFAULT_HEIGHT = 1024
DEFAULT_WIDTH = 1024
DEFAULT_MODEL_KEY = "epicrealism"

# Short negative prompt
DEFAULT_NEGATIVE_PROMPT_SHORT = "ugly, blurry, pixelated, low quality, text, watermark"

# AWS/SageMaker defaults (fallbacks when env not set)
DEFAULT_AWS_REGION = "eu-west-1"
DEFAULT_S3_BUCKET = ""
DEFAULT_SAGEMAKER_ENDPOINT_NAME = ""
DEFAULT_SAGEMAKER_STAGING_ENDPOINT_NAME = ""

# QR canonicalization + scan verification (plan 008).
# Shared by app/utils/qr_canonical.py, app/utils/scan_verifier.py and the
# request schemas. This module must stay import-light (no torch): the scan/QR
# utils and the CPU test suite import it without the ML stack.
QR_CONTENT_MAX_LENGTH = 90  # chars; mirrored by the public API schemas
QR_MAX_VERSION = 8          # canonical QR must fit in version <= 8
VALID_SCAN_STRICTNESS = ["relaxed", "standard", "strict"]
DEFAULT_SCAN_STRICTNESS = "standard"

# v2 pipeline defaults (plan 008). The v1 defaults above are the public
# contract for pipeline:"v1" (absent) requests — do NOT touch them.
# v2 generates at 768 (SD 1.5's native regime; every published pipeline on
# this checkpoint family, incl. DiffQRCoder WACV'25, generates at ~768) with
# monster full-window and brightness in a shortened window (antfu's
# "Stylistic QR Code 101" lore); per-style overrides live in app/presets.py.
VALID_PIPELINES = ["v1", "v2"]
DEFAULT_PIPELINE = "v1"
V2_DEFAULT_HEIGHT = 768
V2_DEFAULT_WIDTH = 768
V2_DEFAULT_MONSTER_SCALE = 1.3
V2_DEFAULT_BRIGHTNESS_SCALE = 0.25
V2_DEFAULT_MONSTER_WINDOW = (0.0, 1.0)
V2_DEFAULT_BRIGHTNESS_WINDOW = (0.30, 0.90)
V2_DEFAULT_NUM_INFERENCE_STEPS = 36

# v2 repair ladder (plan 008 Phase 4). Ladder rungs run only after a failed
# scan verification, under the env-driven wall-clock budget
# Config.SCAN_REPAIR_BUDGET_S (default below). Latent-repair numbers follow
# DiffQRCoder's stage 2 (strength ~0.4 re-noise; see
# app/services/latent_repair.py for weights and attribution); the re-roll
# rung bumps the qrcode_monster scale (readability up, creativity down —
# model card) capped at 1.65.
DEFAULT_SCAN_REPAIR_BUDGET_S = 90.0
V2_REPAIR_STRENGTH = 0.40
V2_REPAIR_STEPS = 40
V2_REROLL_MONSTER_BUMP = 0.15
V2_MONSTER_SCALE_CAP = 1.65
# Seed offset for the re-roll rung: far beyond the base_seed + i (i < 3)
# per-image offsets, so a directed re-roll never collides with a sibling
# image's seed in the same request.
V2_REROLL_SEED_OFFSET = 9973

# v2 hires stage (plan 008 Phase 5): final img2img upscale of the verified
# 768 image to the >=1024-class output the product ships, with both
# ControlNets re-applied at a fraction of the preset scales. Gated by the
# env flag Config.V2_HIRES; if the upscale breaks scanning the 768 image is
# returned instead (metadata flag `hires_dropped`).
V2_HIRES_FACTOR = 1.5      # 768 -> 1152
V2_HIRES_STRENGTH = 0.40
V2_HIRES_STEPS = 20
V2_HIRES_CN_FACTOR = 0.8   # both CN scales at 0.8x the preset values
# Prompt enhancement (plan 009). A small instruct LLM co-resident on the GPU
# rewrites the user's prompt into a QR-friendly English tag prompt; the
# original prompt remains the only text the public contract ever exposes.
# Weights are synced from S3 at runtime (same pattern as the SD checkpoints);
# env knobs live in app.config.Config (PROMPT_ENHANCEMENT_ENABLED etc.).
PROMPT_ENHANCER_HF_ID = "Qwen/Qwen2.5-1.5B-Instruct"
PROMPT_ENHANCER_S3_KEY = "qwen2.5-1.5b-instruct"
PROMPT_ENHANCER_MAX_CLIP_TOKENS = 60   # of CLIP's 77 — leaves headroom
PROMPT_ENHANCER_MAX_NEW_TOKENS = 96
DEFAULT_PROMPT_ENHANCER_TIMEOUT_S = 4.0

REPAIR_STAGE_MODULE_BLEND = "module_blend"
REPAIR_STAGE_LATENT_SRPG = "latent_srpg"
REPAIR_STAGE_REROLL = "reroll"
