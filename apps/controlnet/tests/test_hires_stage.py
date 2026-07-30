"""CPU tests for the v2 hires stage (plan 008 Phase 5).

Follows the stubbed-torch pattern of ``tests/test_repair_ladder.py``. The
img2img pipeline is a scripted fake injected through ``_get_img2img_pipe``;
scan verification runs for real, so the accept/drop decision is exercised
against the actual decoders.

Pins the Phase 5 contracts:
- final img2img x1.5 (768 -> 1152) with both ControlNets at 0.8x the preset
  scales, denoise 0.40, 20 steps, preset guidance windows;
- re-verified: an upscale that breaks scanning is dropped — the verified 768
  image ships and the image's metadata carries ``hires_dropped: true``;
- ``V2_HIRES`` (Config, default True) disables the stage entirely;
- an unavailable img2img pipeline degrades gracefully (no drop flag);
- the v1 path is untouched (no hires keys in v1 metadata).

Run: cd apps/controlnet && python3 -m pytest tests/test_hires_stage.py -q
"""

import base64
import importlib
import sys
import types
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

# Reuse the stub installer + fakes from the ladder tests (same directory).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_repair_ladder import (  # noqa: E402
    _install_stubs, SequencedPipe, _qr_data_url, CONTENT, GRAY_768,
)

_install_stubs()
inference = importlib.import_module("app.services.inference")
qr_canonical = importlib.import_module("app.utils.qr_canonical")


class FakeImg2Img:
    """Fake StableDiffusionControlNetImg2ImgPipeline.

    Returns the scripted *output* if given, else echoes the (already
    hires-sized) first control image — which is a decodable canonical QR, so
    the real verifier accepts it.
    """

    def __init__(self, output=None):
        self.output = output
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.output is not None:
            image = self.output.copy()
        else:
            image = kwargs["control_image"][0].copy()
        return types.SimpleNamespace(images=[image])


@pytest.fixture(scope="module")
def canonical():
    return qr_canonical.render_canonical_qr(CONTENT)


@pytest.fixture
def make_model(tmp_path, monkeypatch):
    monkeypatch.setenv("WECHAT_MODEL_DIR",
                       str(Path(__file__).resolve().parent / ".cache" / "wechat_models"))
    scan_verifier = sys.modules["app.utils.scan_verifier"]
    scan_verifier.reset_wechat_detector_cache()

    def _make(images, config_extra=None):
        config = {
            "RESULTS_DIR": str(tmp_path / "results"),
            "AWS_S3_BUCKET": "",
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


def _final_image(result):
    """Decode the base64 data-URL output back into a PIL image."""
    payload = result["images"][0].split(",", 1)[1]
    return Image.open(BytesIO(base64.b64decode(payload)))


class TestHiresStage:
    def test_happy_path_upscales_to_1152_and_stays_verified(
            self, make_model, canonical, monkeypatch):
        model = make_model([canonical.image])
        img2img = FakeImg2Img()
        monkeypatch.setattr(model, "_get_img2img_pipe", lambda: img2img)

        result = _generate(model)

        meta = result["images_metadata"][0]
        assert meta["scan_verified"] is True
        assert meta["hires_dropped"] is False
        assert meta["repair_stage_used"] is None
        assert _final_image(result).size == (1152, 1152)

        assert len(img2img.calls) == 1
        call = img2img.calls[0]
        assert call["height"] == 1152 and call["width"] == 1152
        assert call["strength"] == pytest.approx(0.40)
        assert call["num_inference_steps"] == 20
        # Both CNs at 0.8x the preset (none: monster 1.35, brightness 0.25).
        assert call["controlnet_conditioning_scale"] == pytest.approx([1.08, 0.20])
        assert call["control_guidance_start"] == [0.0, 0.30]
        assert call["control_guidance_end"] == [1.0, 0.90]
        # Init image is the 768 stage output; control is the upscaled canonical.
        assert call["image"].size == (768, 768)
        assert call["control_image"][0].size == (1152, 1152)

        gen_info = result["generations"][0]
        assert gen_info["hires_applied"] is True
        assert gen_info["output_size"] == [1152, 1152]

    def test_upscale_that_breaks_scanning_is_dropped(
            self, make_model, canonical, monkeypatch):
        model = make_model([canonical.image])
        img2img = FakeImg2Img(output=Image.new("RGB", (1152, 1152), (128, 128, 128)))
        monkeypatch.setattr(model, "_get_img2img_pipe", lambda: img2img)

        result = _generate(model)

        meta = result["images_metadata"][0]
        assert meta["hires_dropped"] is True
        assert meta["scan_verified"] is True  # the verified 768 image ships
        assert _final_image(result).size == (768, 768)
        assert result["generations"][0]["hires_applied"] is False

    def test_v2_hires_flag_disables_the_stage(self, make_model, canonical, monkeypatch):
        model = make_model([canonical.image], config_extra={"V2_HIRES": False})
        img2img = FakeImg2Img()
        monkeypatch.setattr(model, "_get_img2img_pipe", lambda: img2img)

        result = _generate(model)

        assert img2img.calls == []
        meta = result["images_metadata"][0]
        assert meta["hires_dropped"] is False
        assert _final_image(result).size == (768, 768)

    def test_unavailable_img2img_degrades_without_drop_flag(self, make_model, canonical):
        # Default _get_img2img_pipe cannot build a pipeline under the stubbed
        # diffusers — the stage must skip cleanly, not flag a drop.
        model = make_model([canonical.image])
        result = _generate(model)

        meta = result["images_metadata"][0]
        assert meta["scan_verified"] is True
        assert meta["hires_dropped"] is False
        assert _final_image(result).size == (768, 768)

    def test_hires_runs_after_the_repair_ladder(
            self, make_model, canonical, monkeypatch):
        # Stage 1 fails, the module blend rescues it, THEN hires upscales the
        # repaired image.
        import random

        rng = random.Random(1234)
        data = [
            (r, c)
            for r in range(canonical.modules)
            for c in range(canonical.modules)
            if not canonical.function_mask[r][c]
        ]
        corrupted = canonical.image.copy()
        px = canonical.module_px
        for r, c in rng.sample(data, int(len(data) * 0.45)):
            dark = canonical.matrix[r][c]
            x0 = canonical.origin[0] + c * px
            y0 = canonical.origin[1] + r * px
            corrupted.paste(
                (255, 255, 255) if dark else (0, 0, 0), (x0, y0, x0 + px, y0 + px)
            )

        model = make_model([corrupted])
        img2img = FakeImg2Img()
        monkeypatch.setattr(model, "_get_img2img_pipe", lambda: img2img)

        result = _generate(model)

        meta = result["images_metadata"][0]
        assert meta["repair_stage_used"] == "module_blend"
        assert meta["scan_verified"] is True
        assert meta["hires_dropped"] is False
        assert _final_image(result).size == (1152, 1152)
        assert len(img2img.calls) == 1
        # The hires init image is the REPAIRED 768 image (not the corrupted one).
        assert img2img.calls[0]["image"].size == (768, 768)

    def test_hires_may_rescue_an_unverified_image(
            self, make_model, canonical, monkeypatch):
        # Ladder exhausted on an unrepairable gray (latent rung unavailable
        # under the stubs, re-roll returns gray again); the hires output
        # verifies, so it is accepted rather than dropped.
        model = make_model([GRAY_768, GRAY_768])
        img2img = FakeImg2Img()
        monkeypatch.setattr(model, "_get_img2img_pipe", lambda: img2img)

        result = _generate(model)

        meta = result["images_metadata"][0]
        assert meta["repair_stage_used"] == "reroll"
        assert meta["scan_verified"] is True  # rescued by the hires re-verify
        assert meta["hires_dropped"] is False
        assert _final_image(result).size == (1152, 1152)

    def test_v1_metadata_has_no_hires_keys(self, make_model):
        model = make_model([])  # v1 echoes the control image
        result = model.generate(
            prompt="a fox", base_qr_code=[_qr_data_url(CONTENT)],
            num_images_per_prompt=1, seed=42,
        )
        meta = result["images_metadata"][0]
        assert meta["pipeline"] == "v1"
        assert "hires_dropped" not in meta
        assert "hires_applied" not in result["generations"][0]
