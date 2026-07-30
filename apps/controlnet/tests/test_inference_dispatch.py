"""CPU tests for the v1/v2 dispatch in ``app/services/inference.py`` (plan 008).

Exercises ``QRControlNetInference.generate()`` end-to-end WITHOUT a GPU:
``torch``/``diffusers`` are replaced by minimal stubs *before* the module
import, and the SD pipeline is a fake that returns its control image as the
"generated" image (which is a real, decodable QR — so the scan-verification
wiring runs for real). Inputs are ``data:`` URLs, so no network is touched.

This pins the plan-008 contracts on CPU:
- absent ``pipeline`` -> the v1 path with v1 defaults (steps 30, 1024,
  scales [1.25, 0.1]) and per-image ``images_metadata`` parallel to
  ``images`` ({scan_verified, scan_score, decoders_passed,
  repair_stage_used: null, seed, ...});
- ``pipeline:"v2"`` -> canonical conditioning at 768, preset-owned params,
  scaffolded prompt, verified metadata + top-level canonical geometry;
- v2 with nothing canonicalizable -> falls back to the v1 path.

The GPU byte-parity check (same seed before/after the refactor) is the
deferred half of this gate — see plan 008 Phase 3 verify.

Run: cd apps/controlnet && python3 -m pytest tests/test_inference_dispatch.py -q
(needs Pillow, numpy, qrcode, zxing-cpp, opencv-contrib, boto3, requests)
"""

import base64
import importlib
import sys
import types
from io import BytesIO
from pathlib import Path

import pytest
import qrcode
from PIL import Image

APP_DIR = Path(__file__).resolve().parent.parent / "app"
WECHAT_CACHE = Path(__file__).resolve().parent / ".cache" / "wechat_models"


# ---------------------------------------------------------------------------
# Stubs — installed before app.services.inference is imported. setdefault so
# a real torch (e.g. inside the container) is never shadowed once imported.
# ---------------------------------------------------------------------------

def _install_stubs():
    if "torch" not in sys.modules:
        torch_stub = types.ModuleType("torch")
        torch_stub.manual_seed = lambda seed: None
        torch_stub.float16 = object()
        torch_stub.float32 = object()
        torch_stub.cuda = types.SimpleNamespace(
            is_available=lambda: False,
            device_count=lambda: 0,
            manual_seed=lambda seed: None,
            manual_seed_all=lambda seed: None,
            empty_cache=lambda: None,
        )

        class _InferenceMode:
            def __call__(self):
                return self

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        torch_stub.inference_mode = _InferenceMode()
        sys.modules["torch"] = torch_stub

    if "diffusers" not in sys.modules:
        class _StubDiffusersClass:
            @classmethod
            def from_pretrained(cls, *args, **kwargs):
                raise RuntimeError("model loading is not available in CPU tests")

            @classmethod
            def from_config(cls, *args, **kwargs):
                return cls()

        diffusers_stub = types.ModuleType("diffusers")
        diffusers_stub.StableDiffusionControlNetPipeline = _StubDiffusersClass
        diffusers_stub.ControlNetModel = _StubDiffusersClass
        diffusers_stub.DPMSolverMultistepScheduler = _StubDiffusersClass
        schedulers_stub = types.ModuleType("diffusers.schedulers")
        for name in (
            "DDIMScheduler", "DPMSolverMultistepScheduler",
            "EulerAncestralDiscreteScheduler", "EulerDiscreteScheduler",
            "LMSDiscreteScheduler", "PNDMScheduler", "UniPCMultistepScheduler",
            "HeunDiscreteScheduler", "KDPM2DiscreteScheduler",
            "KDPM2AncestralDiscreteScheduler", "DEISMultistepScheduler",
            "DPMSolverSinglestepScheduler",
        ):
            setattr(schedulers_stub, name, _StubDiffusersClass)
        diffusers_stub.schedulers = schedulers_stub
        sys.modules["diffusers"] = diffusers_stub
        sys.modules["diffusers.schedulers"] = schedulers_stub

    if "app" not in sys.modules:
        app_pkg = types.ModuleType("app")
        app_pkg.__path__ = [str(APP_DIR)]
        sys.modules["app"] = app_pkg
    if "app.utils" not in sys.modules:
        utils_pkg = types.ModuleType("app.utils")
        utils_pkg.__path__ = [str(APP_DIR / "utils")]
        sys.modules["app.utils"] = utils_pkg
    if "app.services" not in sys.modules:
        services_pkg = types.ModuleType("app.services")
        services_pkg.__path__ = [str(APP_DIR / "services")]
        sys.modules["app.services"] = services_pkg


_install_stubs()
inference = importlib.import_module("app.services.inference")


class FakePipe:
    """Stands in for StableDiffusionControlNetPipeline: records the call and
    returns the first control image as the "generated" image (a real QR, so
    downstream scan verification is exercised for real)."""

    device = "cpu"

    def __init__(self):
        self.calls = []
        self.scheduler = types.SimpleNamespace(config={})

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        control = kwargs["image"][0]
        return types.SimpleNamespace(images=[control.copy()])


def _qr_data_url(content):
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,
                       box_size=16, border=4)
    qr.add_data(content)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    return _image_data_url(image)


def _image_data_url(image):
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


CONTENT = "https://qraft.ai/e2e"


@pytest.fixture
def model(tmp_path, monkeypatch):
    monkeypatch.setenv("WECHAT_MODEL_DIR", str(WECHAT_CACHE))
    scan_verifier = sys.modules["app.utils.scan_verifier"]
    scan_verifier.reset_wechat_detector_cache()
    config = {
        "RESULTS_DIR": str(tmp_path / "results"),
        "AWS_S3_BUCKET": "",  # forces the base64 output path (no S3)
        "MODEL_KEY": "epicrealism",
    }
    instance = inference.QRControlNetInference(pre_loaded_pipe=FakePipe(), config=config)
    yield instance
    scan_verifier.reset_wechat_detector_cache()


class TestV1Dispatch:
    def test_absent_pipeline_runs_v1_with_v1_defaults(self, model):
        result = model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            num_images_per_prompt=1, seed=42,
        )
        call = model.pipe.calls[0]
        assert call["prompt"] == "a fox"  # no scaffold on v1
        assert call["num_inference_steps"] == 30
        assert call["height"] == 1024 and call["width"] == 1024
        assert call["controlnet_conditioning_scale"] == [1.25, 0.1]
        assert "pipeline" not in result  # v1 output shape untouched
        assert result["num_images_generated"] == 1

    def test_v1_images_metadata_contract(self, model):
        result = model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            num_images_per_prompt=1, seed=42,
        )
        assert len(result["images_metadata"]) == len(result["images"]) == 1
        meta = result["images_metadata"][0]
        assert meta["pipeline"] == "v1"
        assert meta["seed"] == 42
        assert meta["repair_stage_used"] is None
        assert meta["expected_content"] == CONTENT  # decoded from the input QR
        # FakePipe returns the QR itself, so verification must succeed.
        assert meta["scan_verified"] is True
        assert meta["scan_score"] > 0
        assert "zxing" in meta["decoders_passed"]
        gen_info = result["generations"][0]
        assert gen_info["scan_verified"] is True

    def test_v1_undecodable_input_yields_null_scan_fields(self, model):
        gray = Image.new("RGB", (600, 600), (128, 128, 128))
        result = model.generate(
            prompt="a fox", base_qr_code=[_image_data_url(gray)],
            num_images_per_prompt=1, seed=1,
        )
        meta = result["images_metadata"][0]
        assert meta["expected_content"] is None
        assert meta["scan_verified"] is None
        assert meta["scan_score"] is None
        assert meta["decoders_passed"] == []
        assert result["num_images_generated"] == 1  # generation unaffected


class TestPromptEnhancementDispatch:
    """plan 009: the prompt_enhancement flag in generate().

    The enhancer is replaced by a sentinel-returning fake — these tests pin
    the dispatch wiring and the transparency contract, not the LLM.
    """

    SENTINEL = "ENHANCED-SENTINEL-PROMPT"

    def _install_fake_enhancer(self, monkeypatch):
        calls = []
        enhancer_mod = importlib.import_module("app.services.prompt_enhancer")

        class FakeEnhancer:
            def enhance(self_inner, prompt, preset=None, clip_tokenizer=None,
                        timeout_s=None):
                calls.append({"prompt": prompt, "preset": preset})
                return enhancer_mod.EnhancementResult(
                    TestPromptEnhancementDispatch.SENTINEL, "llm", "ok", 0.1)

        monkeypatch.setattr(enhancer_mod, "get_enhancer",
                            lambda config=None: FakeEnhancer())
        return calls

    def test_flag_off_prompt_verbatim_v1_purity(self, model):
        result = model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            num_images_per_prompt=1, seed=42, prompt_enhancement=False,
        )
        call = model.pipe.calls[0]
        assert call["prompt"] == "a fox"
        assert "prompt_enhancement" not in call  # popped, never reaches pipe
        assert result["num_images_generated"] == 1

    def test_flag_on_pipe_gets_sentinel_output_stays_clean(self, model, monkeypatch):
        calls = self._install_fake_enhancer(monkeypatch)
        result = model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            num_images_per_prompt=1, seed=42, prompt_enhancement=True,
        )
        assert calls[0]["prompt"] == "a fox"
        assert calls[0]["preset"] is None  # v1: no preset
        call = model.pipe.calls[0]
        assert call["prompt"] == self.SENTINEL
        assert "prompt_enhancement" not in call
        # Transparency pin: no prompt text (original OR enhanced) anywhere in
        # the response payload.
        import json as _json
        serialized = _json.dumps(
            {k: v for k, v in result.items() if k != "images"})
        assert self.SENTINEL not in serialized

    def test_flag_on_v2_scaffold_wraps_sentinel(self, model, monkeypatch):
        self._install_fake_enhancer(monkeypatch)
        model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            qr_content=CONTENT, pipeline="v2", style_preset="cyberpunk",
            num_images_per_prompt=1, seed=7, prompt_enhancement=True,
        )
        call = model.pipe.calls[0]
        assert call["prompt"] == f"cyberpunk scene of {self.SENTINEL}, neon lights, rain-slick streets, holographic glow, high contrast"


class TestV2Dispatch:
    def test_v2_generates_on_canonical_at_768_with_preset_params(self, model):
        result = model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            qr_content=CONTENT, pipeline="v2", style_preset="cyberpunk",
            scan_strictness="standard", num_images_per_prompt=2, seed=7,
        )
        assert len(model.pipe.calls) == 2
        call = model.pipe.calls[0]
        assert call["height"] == 768 and call["width"] == 768
        assert call["num_inference_steps"] == 36
        assert call["controlnet_conditioning_scale"] == [1.30, 0.30]
        assert call["control_guidance_start"] == [0.0, 0.25]
        assert call["control_guidance_end"] == [1.0, 0.85]
        assert call["prompt"].startswith("cyberpunk scene of a fox")
        assert "neon" in call["negative_prompt"] or "daylight" in call["negative_prompt"]
        # Control image is the canonical render: 768 canvas, gray corners.
        control = call["image"][0]
        assert control.size == (768, 768)
        assert control.getpixel((0, 0)) == (128, 128, 128)

        assert result["pipeline"] == "v2"
        assert result["style_preset"] == "cyberpunk"
        assert result["qr_content"] == CONTENT
        assert result["canonical_qr"]["version"] >= 1
        assert result["canonical_qr"]["module_px"] >= 12

    def test_v2_images_metadata_contract(self, model):
        result = model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            qr_content=CONTENT, pipeline="v2", style_preset="none",
            num_images_per_prompt=2, seed=7,
        )
        assert len(result["images_metadata"]) == len(result["images"]) == 2
        for offset, meta in enumerate(result["images_metadata"]):
            assert meta["pipeline"] == "v2"
            assert meta["style_preset"] == "none"
            assert meta["seed"] == 7 + offset
            assert meta["repair_stage_used"] is None
            assert meta["expected_content"] == CONTENT
            assert meta["scan_verified"] is True
            assert meta["scan_score"] > 0

    def test_v2_falls_back_to_decoding_base_qr_code(self, model):
        result = model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            pipeline="v2", num_images_per_prompt=1, seed=3,
        )
        # No qr_content given: content must come from decoding the input QR.
        assert result["pipeline"] == "v2"
        assert result["qr_content"] == CONTENT
        assert result["images_metadata"][0]["scan_verified"] is True

    def test_v2_with_nothing_canonicalizable_falls_back_to_v1(self, model):
        gray = Image.new("RGB", (600, 600), (128, 128, 128))
        result = model.generate(
            prompt="a fox", base_qr_code=[_image_data_url(gray)],
            pipeline="v2", num_images_per_prompt=1, seed=3,
        )
        assert "pipeline" not in result  # v1 output shape
        assert result["num_images_generated"] == 1
        meta = result["images_metadata"][0]
        assert meta["pipeline"] == "v1"
        # v1 path resizes the (undecodable) input to the v2-clamped dims.
        assert model.pipe.calls[0]["height"] == 768

    def test_v2_respects_explicit_smaller_dims(self, model):
        result = model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            qr_content=CONTENT, pipeline="v2", height=512, width=512,
            num_images_per_prompt=1,
        )
        call = model.pipe.calls[0]
        assert call["height"] == 512 and call["width"] == 512
        assert call["image"][0].size == (512, 512)
        assert result["canonical_qr"]["module_px"] >= 12
