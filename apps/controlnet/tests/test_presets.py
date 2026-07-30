"""CPU tests for ``app/presets.py`` (plan 008 Phase 3).

Validates the preset table's shape: every checkpoint key exists in the REAL
``MODEL_REGISTRY`` (not a stub — a typo here would 500 at request time),
scales/windows/steps stay inside the schema bounds, the prompt scaffolds
compose, and the TUNED_BY marker that Phase 8's eval round must replace is
present.

Needs boto3 importable (model_downloader imports it at module level); its
``from ..config import Config`` falls back gracefully when torch is absent.

Run: cd apps/controlnet && python3 -m pytest tests/test_presets.py -q
"""

import importlib
import sys
import types
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent / "app"


def _ensure_app_pkg():
    """Register the stub ``app`` package once (idempotent across test files)."""
    if "app" not in sys.modules:
        app_pkg = types.ModuleType("app")
        app_pkg.__path__ = [str(APP_DIR)]
        sys.modules["app"] = app_pkg
    if "app.utils" not in sys.modules:
        utils_pkg = types.ModuleType("app.utils")
        utils_pkg.__path__ = [str(APP_DIR / "utils")]
        sys.modules["app.utils"] = utils_pkg


_ensure_app_pkg()
# Other test files may have stubbed model_downloader (it's heavy for them);
# this suite cross-checks against the REAL registry, so force a fresh import.
sys.modules.pop("app.utils.model_downloader", None)
model_downloader = importlib.import_module("app.utils.model_downloader")
presets = importlib.import_module("app.presets")

EXPECTED_NAMES = {"none", "illustration", "photo", "cyberpunk", "watercolor", "architecture"}


class TestPresetTable:
    def test_exactly_the_planned_style_names(self):
        assert set(presets.STYLE_PRESET_NAMES) == EXPECTED_NAMES
        assert presets.DEFAULT_STYLE_PRESET == "none"

    def test_every_checkpoint_key_exists_in_model_registry(self):
        for name, preset in presets.PRESETS.items():
            model = preset["model"]
            assert model is None or model in model_downloader.MODEL_REGISTRY, (
                f"preset {name!r} references unknown checkpoint {model!r}"
            )

    def test_none_preset_keeps_request_model(self):
        assert presets.PRESETS["none"]["model"] is None

    @pytest.mark.parametrize("name", sorted(EXPECTED_NAMES))
    def test_values_within_schema_bounds(self, name):
        preset = presets.PRESETS[name]
        assert 0.5 <= preset["monster_scale"] <= 2.0
        assert 0.0 <= preset["brightness_scale"] <= 1.0
        for window_key in ("monster_window", "brightness_window"):
            start, end = preset[window_key]
            assert 0.0 <= start < end <= 1.0
        assert 1 <= preset["steps"] <= 100  # InvocationRequestSchema bound
        assert 1.0 <= preset["guidance_scale"] <= 20.0

    def test_tuned_by_marker_present(self):
        # Phase 8's eval round must provably replace the research-seeded
        # values; the marker is the grep-able contract for that.
        assert "TUNED_BY: eval/report.html" in presets.__doc__


class TestGetPreset:
    def test_returns_named_copy(self):
        preset = presets.get_preset("cyberpunk")
        assert preset["name"] == "cyberpunk"
        preset["monster_scale"] = 99.0  # mutating the copy...
        assert presets.PRESETS["cyberpunk"]["monster_scale"] != 99.0  # ...not the table

    @pytest.mark.parametrize("unknown", [None, "", "vaporwave", "NONE "])
    def test_unknown_or_absent_falls_back_to_none(self, unknown):
        preset = presets.get_preset(unknown)
        if unknown == "NONE ":  # case/whitespace-insensitive lookup
            assert preset["name"] == "none"
        assert preset["name"] in presets.PRESETS


class TestPromptScaffolds:
    def test_prompt_scaffold_wraps(self):
        preset = presets.get_preset("illustration")
        result = presets.apply_prompt_scaffold(preset, "a fox in autumn leaves")
        assert "a fox in autumn leaves" in result
        assert result.startswith(preset["prompt_prefix"])
        assert result.endswith(preset["prompt_suffix"])

    def test_none_preset_leaves_prompt_unchanged(self):
        preset = presets.get_preset("none")
        assert presets.apply_prompt_scaffold(preset, "a fox") == "a fox"

    def test_negative_scaffold_appends(self):
        preset = presets.get_preset("photo")
        result = presets.apply_negative_scaffold(preset, "ugly, blurry")
        assert result.startswith("ugly, blurry, ")
        assert preset["negative_extra"] in result

    def test_negative_scaffold_handles_empty_base(self):
        preset = presets.get_preset("photo")
        assert presets.apply_negative_scaffold(preset, "") == preset["negative_extra"]

    def test_none_preset_leaves_negative_unchanged(self):
        preset = presets.get_preset("none")
        assert presets.apply_negative_scaffold(preset, "ugly") == "ugly"
