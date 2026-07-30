"""CPU regression tests for ``_warmup_pipeline`` (dual-ControlNet warmup).

Every prod container boot logged
``Warmup failed (non-critical): For multiple controlnets: `image` must have
the same length as the number of controlnets, but got 1 images and 2
ControlNets.`` — the warmup counted controlnets with
``isinstance(pipe.controlnet, list)``, but diffusers wraps the list into a
``MultiControlNetModel`` at pipeline build time, so the check always
undercounted to 1 and the warmup never actually warmed anything.

Prefers the real ``MultiControlNetModel`` wrapper (over bare ``nn.Module``s)
when torch/diffusers are installed, and falls back to a duck-typed ``.nets``
stand-in under the CPU-stub environment other test modules install. No GPU,
no weights, no network.

Run: cd apps/controlnet && venv/bin/python -m pytest tests/test_warmup.py -q
"""

import importlib
import sys
import types
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent / "app"


def _install_pkg_bypass():
    # Import app.* submodules without executing app/__init__.py (which pulls
    # in flask); same pattern as test_inference_dispatch.py.
    for name, path in (
        ("app", APP_DIR),
        ("app.models", APP_DIR / "models"),
        ("app.utils", APP_DIR / "utils"),
    ):
        if name not in sys.modules:
            pkg = types.ModuleType(name)
            pkg.__path__ = [str(path)]
            sys.modules[name] = pkg


_install_pkg_bypass()

# Skips (instead of erroring) when torch/diffusers are stubbed too minimally
# for app.models.controlnet — e.g. under another module's CPU stubs.
controlnet_mod = pytest.importorskip("app.models.controlnet")
_warmup_pipeline = controlnet_mod._warmup_pipeline

try:
    # The faithful wrapper: exactly what StableDiffusionControlNetPipeline
    # builds from a controlnet list.
    import torch.nn as nn

    try:
        from diffusers.models.controlnets.multicontrolnet import MultiControlNetModel
    except ImportError:  # pre-0.32 import path
        from diffusers.pipelines.controlnet import MultiControlNetModel

    def _multi_controlnet(n):
        return MultiControlNetModel([nn.Module() for _ in range(n)])

except Exception:  # pragma: no cover - stub environment

    def _multi_controlnet(n):
        return types.SimpleNamespace(nets=[object()] * n)


class _RecordingPipe:
    """Mimics ``StableDiffusionControlNetPipeline.__call__``'s
    multi-controlnet image-count validation and records its kwargs."""

    def __init__(self, controlnet):
        self.controlnet = controlnet
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        nets = getattr(self.controlnet, "nets", None)
        num_nets = len(nets) if nets is not None else 1
        image = kwargs["image"]
        num_images = len(image) if isinstance(image, list) else 1
        if num_nets > 1 and num_images != num_nets:
            raise ValueError(
                f"For multiple controlnets: `image` must have the same length "
                f"as the number of controlnets, but got {num_images} images "
                f"and {num_nets} ControlNets."
            )
        return None


def test_warmup_passes_one_image_per_controlnet_for_multicontrolnet():
    pipe = _RecordingPipe(_multi_controlnet(2))

    _warmup_pipeline(pipe, device="cpu")

    assert len(pipe.calls) == 1
    kwargs = pipe.calls[0]
    assert isinstance(kwargs["image"], list) and len(kwargs["image"]) == 2
    assert kwargs["controlnet_conditioning_scale"] == [0.1, 0.1]


def test_warmup_handles_unwrapped_controlnet_list():
    # Pre-build shape: a plain list, as passed to from_pretrained().
    pipe = _RecordingPipe([object(), object()])

    _warmup_pipeline(pipe, device="cpu")

    assert len(pipe.calls[0]["image"]) == 2
    assert pipe.calls[0]["controlnet_conditioning_scale"] == [0.1, 0.1]


def test_warmup_single_controlnet_keeps_scalar_scale():
    pipe = _RecordingPipe(types.SimpleNamespace())  # single net: no .nets

    _warmup_pipeline(pipe, device="cpu")

    assert len(pipe.calls[0]["image"]) == 1
    assert pipe.calls[0]["controlnet_conditioning_scale"] == 0.1
