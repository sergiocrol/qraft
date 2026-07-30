"""Style presets for the v2 pipeline (plan 008).

Each preset maps to: a base checkpoint key from
``app.utils.model_downloader.MODEL_REGISTRY`` (None keeps the request/default
model), ControlNet conditioning scales and guidance windows for
[qrcode_monster, brightness], step count, guidance scale, and a prompt
scaffold (prefix/suffix + extra negative terms) prepended/appended around the
user's prompt.

In v2 the preset OWNS scales/windows/steps/guidance: the marshmallow schema
always fills those request fields with v1 defaults, so the container cannot
distinguish "caller chose 30 steps" from "schema default" — preset values win
on the v2 path (v1 requests are untouched).

TUNED_BY: eval/report.html — the values below are research-seeded starting
points (qrcode_monster v2 model card; DiffQRCoder, WACV 2025; Anthony Fu,
"Stylistic QR Code 101"; see plan 008 "Research grounding"), NOT measured
optima. Phase 8 must replace them with the numbers from the committed eval
report before promotion.

This module must stay importable without torch (plain data + string keys —
no imports from model-loading modules); the CPU test suite cross-checks the
checkpoint keys against MODEL_REGISTRY.
"""

from .constants import (
    V2_DEFAULT_MONSTER_SCALE,
    V2_DEFAULT_BRIGHTNESS_SCALE,
    V2_DEFAULT_MONSTER_WINDOW,
    V2_DEFAULT_BRIGHTNESS_WINDOW,
    V2_DEFAULT_NUM_INFERENCE_STEPS,
    DEFAULT_GUIDANCE_SCALE,
)

DEFAULT_STYLE_PRESET = "none"

PRESETS = {
    "none": {
        "model": None,  # keep the request/default checkpoint
        "monster_scale": V2_DEFAULT_MONSTER_SCALE,
        "brightness_scale": V2_DEFAULT_BRIGHTNESS_SCALE,
        "monster_window": V2_DEFAULT_MONSTER_WINDOW,
        "brightness_window": V2_DEFAULT_BRIGHTNESS_WINDOW,
        "steps": V2_DEFAULT_NUM_INFERENCE_STEPS,
        "guidance_scale": DEFAULT_GUIDANCE_SCALE,
        "prompt_prefix": "",
        "prompt_suffix": "",
        "negative_extra": "",
    },
    "illustration": {
        "model": "dreamshaper",
        "monster_scale": 1.35,
        "brightness_scale": 0.28,
        "monster_window": (0.0, 1.0),
        "brightness_window": (0.30, 0.90),
        "steps": 36,
        "guidance_scale": 7.0,
        "prompt_prefix": "vibrant detailed illustration of ",
        "prompt_suffix": ", intricate linework, rich colors, storybook art",
        "negative_extra": "photorealistic, photograph, 3d render",
    },
    "photo": {
        # Realism fights the QR structure hardest -> slightly stronger monster.
        "model": "epicrealism",
        "monster_scale": 1.40,
        "brightness_scale": 0.22,
        "monster_window": (0.0, 1.0),
        "brightness_window": (0.35, 0.90),
        "steps": 36,
        "guidance_scale": 7.0,
        "prompt_prefix": "professional photograph of ",
        "prompt_suffix": ", natural lighting, shallow depth of field, 35mm",
        "negative_extra": "illustration, painting, drawing, cartoon, anime",
    },
    "cyberpunk": {
        # Neon high-contrast scenes carry QR structure well -> can relax a bit.
        "model": "cyberrealistic",
        "monster_scale": 1.30,
        "brightness_scale": 0.30,
        "monster_window": (0.0, 1.0),
        "brightness_window": (0.25, 0.85),
        "steps": 36,
        "guidance_scale": 7.0,
        "prompt_prefix": "cyberpunk scene of ",
        "prompt_suffix": ", neon lights, rain-slick streets, holographic glow, high contrast",
        "negative_extra": "daylight, pastel, washed out",
    },
    "watercolor": {
        # Soft washes blur module edges -> strongest monster of the table.
        "model": "meinamix",
        "monster_scale": 1.45,
        "brightness_scale": 0.30,
        "monster_window": (0.0, 1.0),
        "brightness_window": (0.30, 0.95),
        "steps": 36,
        "guidance_scale": 7.0,
        "prompt_prefix": "delicate watercolor painting of ",
        "prompt_suffix": ", soft washes, paper texture, flowing pigment",
        "negative_extra": "photorealistic, sharp edges, 3d render, neon",
    },
    "architecture": {
        # Geometric facades align naturally with modules -> default scales.
        "model": "absolute_reality",
        "monster_scale": 1.35,
        "brightness_scale": 0.20,
        "monster_window": (0.0, 1.0),
        "brightness_window": (0.35, 0.90),
        "steps": 36,
        "guidance_scale": 7.0,
        "prompt_prefix": "dramatic architectural view of ",
        "prompt_suffix": ", geometric facades, strong shadows, golden hour light",
        "negative_extra": "people, portrait, blurry",
    },
}

STYLE_PRESET_NAMES = list(PRESETS.keys())


def get_preset(name):
    """Preset dict for *name* (with its ``name`` included).

    Unknown/absent names fall back to ``none`` — the schema validates the
    field, so this is defense in depth, not an API surface.
    """
    key = (name or DEFAULT_STYLE_PRESET).lower().strip()
    if key not in PRESETS:
        key = DEFAULT_STYLE_PRESET
    preset = dict(PRESETS[key])
    preset["name"] = key
    return preset


def apply_prompt_scaffold(preset, prompt):
    """User *prompt* wrapped in the preset's prefix/suffix."""
    return f"{preset.get('prompt_prefix', '')}{prompt}{preset.get('prompt_suffix', '')}"


def apply_negative_scaffold(preset, negative_prompt):
    """*negative_prompt* extended with the preset's extra negative terms."""
    extra = preset.get("negative_extra", "")
    if not extra:
        return negative_prompt
    if not negative_prompt:
        return extra
    return f"{negative_prompt}, {extra}"
