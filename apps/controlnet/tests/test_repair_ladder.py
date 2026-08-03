"""CPU tests for the v2 repair-ladder orchestration (plan 008 Phase 4).

Follows the stubbed-torch pattern of ``tests/test_inference_dispatch.py``:
``torch``/``diffusers`` are minimal stubs, the SD pipeline is a scripted fake
whose outputs drive the ladder, and the module blend + scan verification run
for real (the fixtures were validated against the real decoders: a canonical
render with 45% of its data modules inverted fails verification and is
rescued by the default module blend; a plain gray canvas is unrepairable by
blending, which forces the ladder down to the latent/re-roll rungs).

Pins the Phase 4 contracts:
- verified images never enter the ladder (``repair_stage_used`` stays null);
- rung order a -> b -> c with re-verification after each rung, stopping at
  the first verified output;
- ``relaxed`` strictness skips the latent rung; a spent budget skips the
  expensive rungs; ``repair_stage_used`` records the LAST rung applied;
- the ladder never returns an image scan-scored worse than its input.

Run: cd apps/controlnet && python3 -m pytest tests/test_repair_ladder.py -q
"""

import base64
import importlib
import random
import sys
import types
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

APP_DIR = Path(__file__).resolve().parent.parent / "app"
WECHAT_CACHE = Path(__file__).resolve().parent / ".cache" / "wechat_models"


# ---------------------------------------------------------------------------
# Stubs — identical to tests/test_inference_dispatch.py (setdefault pattern,
# so whichever test module loads first installs them).
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
qr_canonical = importlib.import_module("app.utils.qr_canonical")

CONTENT = "https://qraft.ai/e2e"


class SequencedPipe:
    """Fake SD pipeline that returns scripted images in order.

    Once the script is exhausted it falls back to echoing the control image
    (a decodable canonical QR). Records every call's kwargs.
    """

    device = "cpu"

    def __init__(self, images):
        self.script = list(images)
        self.calls = []
        self.scheduler = types.SimpleNamespace(config={})

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.script:
            image = self.script.pop(0).copy()
        else:
            image = kwargs["image"][0].copy()
        return types.SimpleNamespace(images=[image])


def _qr_data_url(content):
    import qrcode

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,
                       box_size=16, border=4)
    qr.add_data(content)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


@pytest.fixture(scope="module")
def canonical():
    """The exact canonical render the model will build for CONTENT at 768."""
    return qr_canonical.render_canonical_qr(CONTENT)


@pytest.fixture(scope="module")
def corrupted_image(canonical):
    """Canonical render with 45% of data modules inverted: fails
    verification, rescued by the default module blend (validated against the
    real decoders)."""
    rng = random.Random(1234)
    data = [
        (r, c)
        for r in range(canonical.modules)
        for c in range(canonical.modules)
        if not canonical.function_mask[r][c]
    ]
    image = canonical.image.copy()
    px = canonical.module_px
    for r, c in rng.sample(data, int(len(data) * 0.45)):
        dark = canonical.matrix[r][c]
        x0 = canonical.origin[0] + c * px
        y0 = canonical.origin[1] + r * px
        image.paste(
            (255, 255, 255) if dark else (0, 0, 0), (x0, y0, x0 + px, y0 + px)
        )
    return image


GRAY_768 = Image.new("RGB", (768, 768), (128, 128, 128))


@pytest.fixture
def make_model(tmp_path, monkeypatch):
    """Factory: model with a SequencedPipe and optional config overrides."""
    monkeypatch.setenv("WECHAT_MODEL_DIR", str(WECHAT_CACHE))
    scan_verifier = sys.modules["app.utils.scan_verifier"]
    scan_verifier.reset_wechat_detector_cache()

    def _make(images, config_extra=None):
        config = {
            "RESULTS_DIR": str(tmp_path / "results"),
            "AWS_S3_BUCKET": "",  # forces the base64 output path (no S3)
            "MODEL_KEY": "epicrealism",
        }
        if config_extra:
            config.update(config_extra)
        return inference.QRControlNetInference(
            pre_loaded_pipe=SequencedPipe(images), config=config
        )

    yield _make
    scan_verifier.reset_wechat_detector_cache()


def _generate(model, **overrides):
    kwargs = dict(
        prompt="a fox",
        base_qr_code=[_qr_data_url(CONTENT)],
        qr_content=CONTENT,
        pipeline="v2",
        style_preset="none",
        num_images_per_prompt=1,
        seed=7,
    )
    kwargs.update(overrides)
    return model.generate(**kwargs)


class TestLadderDispatch:
    def test_verified_image_skips_the_ladder(self, make_model, canonical):
        model = make_model([canonical.image])
        result = _generate(model)
        meta = result["images_metadata"][0]
        assert meta["scan_verified"] is True
        assert meta["repair_stage_used"] is None
        assert len(model.pipe.calls) == 1
        assert result["generations"][0]["repair_ladder"] == []

    def test_module_blend_rescues_a_failing_image(self, make_model, corrupted_image):
        model = make_model([corrupted_image])
        result = _generate(model)
        meta = result["images_metadata"][0]
        assert meta["repair_stage_used"] == "module_blend"
        assert meta["scan_verified"] is True
        assert meta["scan_score"] > 0
        assert len(model.pipe.calls) == 1  # no re-roll needed
        events = result["generations"][0]["repair_ladder"]
        assert [e["rung"] for e in events] == ["module_blend"]
        assert events[0]["scan_verified"] is True

    def test_unblendable_image_falls_through_to_reroll(self, make_model, canonical):
        # Latent rung is naturally unavailable here (stubbed torch has no
        # torch.nn), so the gray stage-1 image must reach the re-roll rung,
        # which the script rescues with a pristine canonical render.
        model = make_model([GRAY_768, canonical.image])
        result = _generate(model)
        meta = result["images_metadata"][0]
        assert meta["repair_stage_used"] == "reroll"
        assert meta["scan_verified"] is True
        assert len(model.pipe.calls) == 2

        reroll_call = model.pipe.calls[1]
        # Monster scale bumped +0.15 from the preset (none: 1.3 -> 1.45),
        # brightness unchanged; same scaffolded prompt and canonical control.
        # approx: the bump is computed as 1.3 + 0.15, which is not exactly 1.45.
        assert reroll_call["controlnet_conditioning_scale"] == pytest.approx([1.45, 0.25])
        assert reroll_call["prompt"] == model.pipe.calls[0]["prompt"]
        assert reroll_call["image"][0].size == (768, 768)

        events = result["generations"][0]["repair_ladder"]
        assert [e["rung"] for e in events] == ["module_blend", "reroll"]
        assert events[-1]["monster_scale"] == pytest.approx(1.45)

    def test_monster_bump_is_capped_at_1_65(self, make_model, canonical):
        model = make_model([GRAY_768, canonical.image])
        _generate(model, style_preset="watercolor")  # monster 1.45 in presets
        reroll_call = model.pipe.calls[1]
        assert reroll_call["controlnet_conditioning_scale"][0] == pytest.approx(1.60)

        model2 = make_model([GRAY_768, canonical.image])
        high_preset = inference.get_preset("none")
        high_preset["monster_scale"] = 1.60  # 1.60 + 0.15 would exceed the cap
        model2._repair_ladder(
            GRAY_768, {"scan_verified": False, "scan_score": 0.0, "decoders_passed": []},
            canonical, CONTENT, "standard", high_preset, "a fox",
            {"negative_prompt": "", "guidance_scale": 7.0}, False, 7,
        )
        assert model2.pipe.calls[0]["controlnet_conditioning_scale"][0] == pytest.approx(1.65)

    def test_latent_srpg_rung_rescues(self, make_model, canonical, monkeypatch):
        model = make_model([GRAY_768])
        recorded = {}

        def fake_run_latent_repair(pipe, image, canonical_arg, **kwargs):
            recorded["pipe"] = pipe
            recorded["image"] = image
            recorded["kwargs"] = kwargs
            return canonical.image.copy()

        fake_module = types.SimpleNamespace(run_latent_repair=fake_run_latent_repair)
        sentinel_pipe = object()
        monkeypatch.setattr(model, "_load_latent_repair", lambda: fake_module)
        monkeypatch.setattr(model, "_get_img2img_pipe", lambda: sentinel_pipe)

        result = _generate(model)
        meta = result["images_metadata"][0]
        assert meta["repair_stage_used"] == "latent_srpg"
        assert meta["scan_verified"] is True
        assert len(model.pipe.calls) == 1  # rescued before the re-roll rung

        assert recorded["pipe"] is sentinel_pipe
        assert recorded["kwargs"]["strength"] == pytest.approx(0.40)
        assert recorded["kwargs"]["num_inference_steps"] == 40
        assert recorded["kwargs"]["monster_scale"] == pytest.approx(1.3)
        assert recorded["kwargs"]["seed"] == 7
        events = result["generations"][0]["repair_ladder"]
        assert [e["rung"] for e in events] == ["module_blend", "latent_srpg"]

    def test_relaxed_strictness_skips_the_latent_rung(self, make_model, canonical, monkeypatch):
        model = make_model([GRAY_768, canonical.image])
        called = {"latent": False}

        def spy_loader():
            called["latent"] = True
            return None

        monkeypatch.setattr(model, "_load_latent_repair", spy_loader)
        result = _generate(model, scan_strictness="relaxed")

        assert called["latent"] is False
        meta = result["images_metadata"][0]
        assert meta["repair_stage_used"] == "reroll"
        assert meta["scan_verified"] is True

    def test_spent_budget_stops_after_module_blend(self, make_model, monkeypatch):
        model = make_model([GRAY_768], config_extra={"SCAN_REPAIR_BUDGET_S": 0})
        called = {"latent": False}

        def spy_loader():
            called["latent"] = True
            return None

        monkeypatch.setattr(model, "_load_latent_repair", spy_loader)
        result = _generate(model)

        assert called["latent"] is False
        assert len(model.pipe.calls) == 1  # no re-roll either
        meta = result["images_metadata"][0]
        assert meta["repair_stage_used"] == "module_blend"  # last rung applied
        assert meta["scan_verified"] is False

    def test_ladder_never_returns_a_worse_scoring_image(self, make_model, canonical, monkeypatch):
        model = make_model([GRAY_768])  # re-roll returns another gray copy
        stage1_image = GRAY_768.copy()
        stage1_fields = {
            "scan_verified": False, "scan_score": 0.5, "decoders_passed": [],
        }
        # Every repair attempt scores WORSE than stage 1.
        scripted = iter([0.2, 0.3])

        def fake_scan(image, expected, strictness):
            return {
                "scan_verified": False,
                "scan_score": next(scripted),
                "decoders_passed": [],
            }

        monkeypatch.setattr(model, "_scan_image_metadata", fake_scan)
        image, fields, last_rung, events = model._repair_ladder(
            stage1_image, stage1_fields, canonical, CONTENT, "standard",
            inference.get_preset("none"), "a fox",
            {"negative_prompt": "", "guidance_scale": 7.0}, False, 7,
        )

        assert image is stage1_image  # kept the best-scoring image
        assert fields["scan_score"] == 0.5
        assert last_rung == "reroll"  # ...but the last rung applied is recorded
        assert [e["rung"] for e in events] == ["module_blend", "reroll"]
