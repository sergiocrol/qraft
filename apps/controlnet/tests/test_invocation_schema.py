"""Bounds tests for InvocationRequestSchema — the schema bound to the live
SageMaker ``/invocations`` endpoint (see app/__init__.py).

These assert the numeric bounds stay aligned with the public contract in
``@repo/validation-schemas`` (Zod): num_inference_steps 1-100, height/width
512-1024 and divisible by 8.

The module under test is loaded WITHOUT importing the ``app`` package
``__init__`` (which pulls in Flask, torch and diffusers). Instead, a stub
``app`` package is registered whose ``__path__`` points at the real ``app/``
directory, and the boto3-dependent ``app.utils.model_downloader`` module is
replaced by a minimal stand-in exposing ``MODEL_REGISTRY`` with the default
model key. ``app.constants`` and ``app.schemas.generate`` themselves are the
real modules.

Run (only needs marshmallow==3.21.3 + pytest, no GPU / container deps):

    cd apps/controlnet && python3 -m pytest tests/test_invocation_schema.py
"""

import importlib
import sys
import types
from pathlib import Path

import pytest
from marshmallow import ValidationError

APP_DIR = Path(__file__).resolve().parent.parent / "app"


def _load_generate_module():
    """Import app.schemas.generate with the heavy dependency stubbed out."""
    if "app.schemas.generate" in sys.modules:
        return sys.modules["app.schemas.generate"]

    app_pkg = types.ModuleType("app")
    app_pkg.__path__ = [str(APP_DIR)]
    sys.modules["app"] = app_pkg

    utils_pkg = types.ModuleType("app.utils")
    utils_pkg.__path__ = [str(APP_DIR / "utils")]
    sys.modules["app.utils"] = utils_pkg

    # model_downloader imports boto3 at module level; the schema only needs
    # MODEL_REGISTRY's keys. Include the default model key so the schema's
    # default passes its own model validator.
    downloader_stub = types.ModuleType("app.utils.model_downloader")
    downloader_stub.MODEL_REGISTRY = {"epicrealism": {}}
    sys.modules["app.utils.model_downloader"] = downloader_stub

    return importlib.import_module("app.schemas.generate")


generate = _load_generate_module()

VALID_REQUEST = {
    "prompt": "A japanese small village full of cherry blossom trees",
    "base_qr_code": "https://example.com/qr.png",
}


def _load(**overrides):
    payload = {**VALID_REQUEST, **overrides}
    return generate.InvocationRequestSchema().load(payload)


class TestNumInferenceStepsBounds:
    def test_accepts_default(self):
        result = _load()
        assert result["num_inference_steps"] == 30

    def test_accepts_typical_value(self):
        assert _load(num_inference_steps=40)["num_inference_steps"] == 40

    def test_accepts_max(self):
        assert _load(num_inference_steps=100)["num_inference_steps"] == 100

    def test_rejects_above_max(self):
        with pytest.raises(ValidationError):
            _load(num_inference_steps=101)

    def test_rejects_unbounded(self):
        with pytest.raises(ValidationError):
            _load(num_inference_steps=999)

    def test_rejects_zero(self):
        with pytest.raises(ValidationError):
            _load(num_inference_steps=0)


class TestDimensionBounds:
    def test_accepts_min_dimension(self):
        result = _load(height=512, width=512)
        assert result["height"] == 512
        assert result["width"] == 512

    def test_accepts_max_dimension(self):
        result = _load(height=1024, width=1024)
        assert result["height"] == 1024
        assert result["width"] == 1024

    def test_rejects_tiny_height(self):
        with pytest.raises(ValidationError):
            _load(height=8)

    def test_rejects_below_floor_even_if_divisible_by_8(self):
        with pytest.raises(ValidationError):
            _load(height=504)

    def test_rejects_width_below_floor(self):
        with pytest.raises(ValidationError):
            _load(width=256)

    def test_rejects_above_ceiling(self):
        with pytest.raises(ValidationError):
            _load(height=1032)

    def test_rejects_not_divisible_by_8(self):
        with pytest.raises(ValidationError):
            _load(height=1000, width=1001)


class TestV2PipelineFields:
    """plan 008: optional v2 fields on InvocationRequestSchema.

    Absent fields must produce the v1 defaults (pipeline "v1"), so existing
    clients keep byte-identical behavior.
    """

    def test_defaults_when_absent(self):
        result = _load()
        assert result["pipeline"] == "v1"
        assert result["qr_content"] is None
        assert result["style_preset"] == "none"
        assert result["scan_strictness"] == "standard"

    def test_accepts_v2_fields(self):
        result = _load(
            pipeline="v2",
            qr_content="https://qraft.ai/e2e",
            style_preset="cyberpunk",
            scan_strictness="strict",
        )
        assert result["pipeline"] == "v2"
        assert result["qr_content"] == "https://qraft.ai/e2e"
        assert result["style_preset"] == "cyberpunk"
        assert result["scan_strictness"] == "strict"

    def test_rejects_pipeline_v3(self):
        with pytest.raises(ValidationError):
            _load(pipeline="v3")

    def test_accepts_qr_content_at_max_length(self):
        assert _load(qr_content="x" * 90)["qr_content"] == "x" * 90

    def test_rejects_qr_content_91_chars(self):
        with pytest.raises(ValidationError):
            _load(qr_content="x" * 91)

    def test_rejects_empty_qr_content(self):
        with pytest.raises(ValidationError):
            _load(qr_content="")

    @pytest.mark.parametrize(
        "preset",
        ["illustration", "photo", "cyberpunk", "watercolor", "architecture", "none"],
    )
    def test_accepts_all_style_presets(self, preset):
        assert _load(style_preset=preset)["style_preset"] == preset

    def test_rejects_unknown_style_preset(self):
        with pytest.raises(ValidationError):
            _load(style_preset="vaporwave")

    @pytest.mark.parametrize("strictness", ["relaxed", "standard", "strict"])
    def test_accepts_all_scan_strictness(self, strictness):
        assert _load(scan_strictness=strictness)["scan_strictness"] == strictness

    def test_rejects_unknown_scan_strictness(self):
        with pytest.raises(ValidationError):
            _load(scan_strictness="paranoid")


class TestPromptEnhancementField:
    """plan 009: prompt_enhancement flag. Container-side default is False —
    the ON default lives in the public Zod schema, so an old client that
    never sends the field keeps byte-identical behavior."""

    def test_defaults_to_false_when_absent(self):
        assert _load()["prompt_enhancement"] is False

    def test_accepts_true(self):
        assert _load(prompt_enhancement=True)["prompt_enhancement"] is True

    def test_accepts_false(self):
        assert _load(prompt_enhancement=False)["prompt_enhancement"] is False

    def test_rejects_non_boolean(self):
        # NB: marshmallow's Boolean coerces "yes"/"1" etc.; only values
        # outside its truthy/falsy sets are rejected.
        with pytest.raises(ValidationError):
            _load(prompt_enhancement="maybe")

    def test_generate_image_schema_defaults_to_false(self):
        result = generate.GenerateImageSchema().load({
            "prompt": "p",
            "base_qr_code": ["https://example.com/qr.png"],
        })
        assert result["prompt_enhancement"] is False

    def test_sagemaker_schema_accepts_flag(self):
        result = generate.SageMakerRequestSchema().load(
            {"prompt": "p", "prompt_enhancement": True})
        assert result["prompt_enhancement"] is True


class TestSageMakerSchemaV2Fields:
    """plan 008: the same optional v2 fields on SageMakerRequestSchema."""

    def _load_sm(self, **overrides):
        return generate.SageMakerRequestSchema().load({"prompt": "p", **overrides})

    def test_defaults_when_absent(self):
        result = self._load_sm()
        assert result["pipeline"] == "v1"
        assert result["qr_content"] is None
        assert result["style_preset"] == "none"
        assert result["scan_strictness"] == "standard"

    def test_accepts_v2_fields(self):
        result = self._load_sm(
            pipeline="v2", qr_content="https://qraft.ai", style_preset="photo",
            scan_strictness="relaxed",
        )
        assert result["pipeline"] == "v2"
        assert result["qr_content"] == "https://qraft.ai"
        assert result["style_preset"] == "photo"
        assert result["scan_strictness"] == "relaxed"

    def test_rejects_pipeline_v3(self):
        with pytest.raises(ValidationError):
            self._load_sm(pipeline="v3")

    def test_rejects_qr_content_91_chars(self):
        with pytest.raises(ValidationError):
            self._load_sm(qr_content="x" * 91)
