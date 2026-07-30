"""CPU tests for ``app/utils/module_repair.py`` (plan 008 Phase 4, rung a).

Synthetic-failure coverage of the SRL-style error matrix and the module
blend: exact per-module flagging, Gaussian-center weighting, function-pattern
exclusion (matrix and blend), alpha ramp ordering, and an end-to-end rescue —
a canonical render corrupted beyond decodability decodes again after
``blend_failing_modules``.

Loading follows tests/test_qr_canonical.py: a stub ``app`` package whose
``__path__`` points at the real ``app/`` directory, so the modules under test
import without Flask/torch/diffusers. Needs Pillow, numpy, qrcode[pil] and
zxing-cpp (for the rescue round-trip), no GPU.

Run: cd apps/controlnet && python3 -m pytest tests/test_module_repair.py -q
"""

import importlib
import random
import sys
import types
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

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
module_repair = importlib.import_module("app.utils.module_repair")
qr_canonical = importlib.import_module("app.utils.qr_canonical")

CONTENT = "https://qraft.ai/e2e"


@pytest.fixture(scope="module")
def canonical():
    return qr_canonical.render_canonical_qr(CONTENT)


def _module_box(canonical, r, c):
    """Pixel box (x0, y0, x1, y1) of module (row r, col c)."""
    px = canonical.module_px
    x0 = canonical.origin[0] + c * px
    y0 = canonical.origin[1] + r * px
    return (x0, y0, x0 + px, y0 + px)


def _paint_module(image, canonical, r, c, value):
    """Fill module (r, c) with the RGB gray *value* (in place)."""
    image.paste((value, value, value), _module_box(canonical, r, c))


def _invert_module(image, canonical, r, c):
    """Flip module (r, c) to the opposite of its canonical color (in place)."""
    dark = canonical.matrix[r][c]
    _paint_module(image, canonical, r, c, 255 if dark else 0)


def _data_modules(canonical):
    """All (r, c) that are data/ECC modules (function patterns excluded)."""
    n = canonical.modules
    return [
        (r, c)
        for r in range(n)
        for c in range(n)
        if not canonical.function_mask[r][c]
    ]


def _center_luma(image, canonical, r, c):
    """Mean luminance (0-255) of the central third of module (r, c)."""
    px = canonical.module_px
    x0, y0, _, _ = _module_box(canonical, r, c)
    third = max(1, px // 3)
    lo = (px - third) // 2
    patch = np.asarray(image.convert("L"), dtype=np.float32)[
        y0 + lo : y0 + lo + third, x0 + lo : x0 + lo + third
    ]
    return float(patch.mean())


class TestErrorMatrix:
    def test_perfect_render_scores_zero_everywhere(self, canonical):
        matrix = module_repair.compute_error_matrix(canonical.image, canonical)
        assert matrix.shape == (canonical.modules, canonical.modules)
        assert float(matrix.max()) == 0.0

    def test_flipped_data_modules_are_flagged_exactly(self, canonical):
        rng = random.Random(42)
        flipped = rng.sample(_data_modules(canonical), 8)
        image = canonical.image.copy()
        for r, c in flipped:
            _invert_module(image, canonical, r, c)

        matrix = module_repair.compute_error_matrix(image, canonical)
        for r, c in flipped:
            assert matrix[r, c] > 0.5, f"module ({r},{c}) not flagged"
        untouched = matrix.copy()
        for r, c in flipped:
            untouched[r, c] = 0.0
        assert float(untouched.max()) == 0.0  # nothing else flagged

    def test_dead_zone_gray_is_a_smaller_error_than_inversion(self, canonical):
        data = _data_modules(canonical)
        (r1, c1), (r2, c2) = data[0], data[1]
        image = canonical.image.copy()
        _paint_module(image, canonical, r1, c1, 140)  # ~0.55: dead zone
        _invert_module(image, canonical, r2, c2)      # confidently wrong

        matrix = module_repair.compute_error_matrix(image, canonical)
        assert 0.0 < matrix[r1, c1] < matrix[r2, c2]

    def test_function_pattern_corruption_is_excluded(self, canonical):
        image = canonical.image.copy()
        n = canonical.modules
        corrupted = []
        for r in range(n):
            for c in range(n):
                if canonical.function_mask[r][c]:
                    _invert_module(image, canonical, r, c)
                    corrupted.append((r, c))
                if len(corrupted) >= 12:
                    break
            if len(corrupted) >= 12:
                break

        matrix = module_repair.compute_error_matrix(image, canonical)
        for r, c in corrupted:
            assert matrix[r, c] == 0.0

    def test_center_corruption_outweighs_border_corruption(self, canonical):
        data = _data_modules(canonical)
        dark = [(r, c) for r, c in data if canonical.matrix[r][c]]
        (r1, c1), (r2, c2) = dark[0], dark[1]
        px = canonical.module_px
        image = canonical.image.copy()

        # Same corrupted area (2px-thick stripe) at the center vs the border.
        x0, y0, _, _ = _module_box(canonical, r1, c1)
        mid = px // 2 - 1
        image.paste((255, 255, 255), (x0, y0 + mid, x0 + px, y0 + mid + 2))
        x0, y0, _, _ = _module_box(canonical, r2, c2)
        image.paste((255, 255, 255), (x0, y0, x0 + px, y0 + 2))

        matrix = module_repair.compute_error_matrix(image, canonical)
        assert matrix[r1, c1] > matrix[r2, c2]

    def test_size_mismatch_raises(self, canonical):
        with pytest.raises(ValueError):
            module_repair.compute_error_matrix(
                Image.new("RGB", (64, 64), (128, 128, 128)), canonical
            )


class TestBlendFailingModules:
    def test_noop_when_nothing_fails(self, canonical):
        matrix = module_repair.compute_error_matrix(canonical.image, canonical)
        blended = module_repair.blend_failing_modules(
            canonical.image, canonical, matrix
        )
        assert np.array_equal(
            np.asarray(blended), np.asarray(canonical.image.convert("RGB"))
        )

    def test_moves_failing_centers_toward_target_and_leaves_the_rest(self, canonical):
        rng = random.Random(7)
        data = _data_modules(canonical)
        flipped = rng.sample(data, 6)
        image = canonical.image.copy()
        for r, c in flipped:
            _invert_module(image, canonical, r, c)

        matrix = module_repair.compute_error_matrix(image, canonical)
        blended = module_repair.blend_failing_modules(image, canonical, matrix)

        before = np.asarray(image, dtype=np.int16)
        after = np.asarray(blended, dtype=np.int16)

        for r, c in flipped:
            dark = canonical.matrix[r][c]
            luma_before = _center_luma(image, canonical, r, c)
            luma_after = _center_luma(blended, canonical, r, c)
            if dark:
                assert luma_after < luma_before  # pulled toward dark target
            else:
                assert luma_after > luma_before

        # Pixels outside the failing modules are untouched.
        diff = np.abs(after - before).sum(axis=2)
        mask = np.zeros(diff.shape, dtype=bool)
        for r, c in flipped:
            x0, y0, x1, y1 = _module_box(canonical, r, c)
            mask[y0:y1, x0:x1] = True
        assert int(diff[~mask].max()) == 0

    def test_never_touches_function_patterns(self, canonical):
        rng = random.Random(9)
        image = canonical.image.copy()
        for r, c in rng.sample(_data_modules(canonical), 10):
            _invert_module(image, canonical, r, c)

        matrix = module_repair.compute_error_matrix(image, canonical)
        blended = module_repair.blend_failing_modules(image, canonical, matrix)

        before = np.asarray(image, dtype=np.int16)
        after = np.asarray(blended, dtype=np.int16)
        for r in range(canonical.modules):
            for c in range(canonical.modules):
                if canonical.function_mask[r][c]:
                    x0, y0, x1, y1 = _module_box(canonical, r, c)
                    assert np.array_equal(
                        before[y0:y1, x0:x1], after[y0:y1, x0:x1]
                    )

    def test_worst_module_is_blended_hardest(self, canonical):
        data = _data_modules(canonical)
        dark = [(r, c) for r, c in data if canonical.matrix[r][c]]
        (r1, c1), (r2, c2) = dark[0], dark[1]
        image = canonical.image.copy()
        _paint_module(image, canonical, r1, c1, 140)  # mild error
        _paint_module(image, canonical, r2, c2, 255)  # severe error

        matrix = module_repair.compute_error_matrix(image, canonical)
        blended = module_repair.blend_failing_modules(image, canonical, matrix)

        delta_mild = _center_luma(image, canonical, r1, c1) - _center_luma(
            blended, canonical, r1, c1
        )
        delta_severe = _center_luma(image, canonical, r2, c2) - _center_luma(
            blended, canonical, r2, c2
        )
        assert delta_severe > delta_mild > 0

    def test_blend_rescues_decodability(self, canonical):
        zxingcpp = pytest.importorskip("zxingcpp")

        def decodes(image):
            results = zxingcpp.read_barcodes(image)
            return any(r.text == CONTENT for r in results)

        rng = random.Random(1234)
        data = _data_modules(canonical)
        corrupted = rng.sample(data, int(len(data) * 0.45))
        image = canonical.image.copy()
        for r, c in corrupted:
            _invert_module(image, canonical, r, c)

        assert not decodes(image), "fixture too weak: corrupted QR still decodes"

        matrix = module_repair.compute_error_matrix(image, canonical)
        blended = module_repair.blend_failing_modules(
            image, canonical, matrix, strength_ramp=(0.5, 0.9)
        )
        assert decodes(blended), "module blend failed to rescue the QR"

    def test_invalid_ramp_raises(self, canonical):
        matrix = np.zeros((canonical.modules, canonical.modules), dtype=np.float32)
        with pytest.raises(ValueError):
            module_repair.blend_failing_modules(
                canonical.image, canonical, matrix, strength_ramp=(0.9, 0.5)
            )
