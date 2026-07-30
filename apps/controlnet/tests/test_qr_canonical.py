"""CPU tests for ``app/utils/qr_canonical.py`` (plan 008 Phase 2).

Covers the canonicalization rules: smallest version <= 8 at ECC M then raise
ECC within that version; explicit mask; integer module scale (min 12px) with
a 4-module quiet zone centered on a #808080 canvas; content limits; the
``base_qr_code`` decode fallback; and the function-pattern mask used by the
repair ladder.

Loading follows tests/test_invocation_schema.py: a stub ``app`` package whose
``__path__`` points at the real ``app/`` directory, so the module under test
imports without Flask/torch/diffusers. Needs qrcode[pil], Pillow, numpy and
zxing-cpp (for the decode fallback), no GPU.

Run: cd apps/controlnet && python3 -m pytest tests/test_qr_canonical.py -q
"""

import importlib
import sys
import types
from pathlib import Path

import pytest
import qrcode
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
qr_canonical = importlib.import_module("app.utils.qr_canonical")

GRAY = qr_canonical.CANVAS_GRAY


class TestCapacityAndEccSelection:
    """Version = smallest fitting at M; ECC = strongest that still fits."""

    @pytest.mark.parametrize(
        "length,expected_version,expected_ecc",
        [
            (7, 1, "H"),   # v1 capacity: M 14 / Q 11 / H 7
            (14, 1, "M"),  # fills v1 at M exactly; Q/H don't fit
            (20, 2, "Q"),  # v2 capacity: M 26 / Q 20 / H 14
            (24, 2, "M"),  # fits v2 at M; Q (20) doesn't fit -> stays M
            (58, 4, "M"),  # v4 capacity: M 62 / Q 46 / H 34
            (90, 6, "M"),  # max content length; v5 M (84) < 90 <= v6 M (106)
        ],
    )
    def test_version_and_ecc(self, length, expected_version, expected_ecc):
        content = "x" * length
        canonical = qr_canonical.render_canonical_qr(content)
        assert canonical.version == expected_version
        assert canonical.ecc == expected_ecc
        assert canonical.content == content

    def test_rejects_91_chars(self):
        with pytest.raises(ValueError, match="91 chars"):
            qr_canonical.render_canonical_qr("x" * 91)

    def test_rejects_empty_content(self):
        with pytest.raises(ValueError):
            qr_canonical.render_canonical_qr("")

    def test_rejects_version_above_8(self):
        # 60 chars passes the length check but is 180 UTF-8 bytes -> version 9.
        with pytest.raises(ValueError, match="version"):
            qr_canonical.render_canonical_qr("漢" * 60)


class TestGeometry:
    @pytest.mark.parametrize("length", [7, 24, 58, 90])
    def test_geometry_invariants(self, length):
        canonical = qr_canonical.render_canonical_qr("x" * length)
        modules = canonical.modules
        px = canonical.module_px

        assert canonical.image.size == (768, 768)
        assert modules == 17 + 4 * canonical.version
        assert px == 768 // (modules + 8)
        assert px >= qr_canonical.MIN_MODULE_PX
        assert (modules + 8) * px <= 768

        # Centered: origin = paste offset + quiet zone.
        symbol_px = (modules + 8) * px
        offset = (768 - symbol_px) // 2
        assert canonical.origin == (offset + 4 * px, offset + 4 * px)

        # Matrix is modules x modules with a dark finder corner.
        assert len(canonical.matrix) == modules
        assert all(len(row) == modules for row in canonical.matrix)
        assert canonical.matrix[0][0] is True

    def test_rejects_canvas_too_small_for_min_module(self):
        # v6 (41 modules + 8) * 12px = 588px minimum canvas.
        with pytest.raises(ValueError, match="module"):
            qr_canonical.render_canonical_qr("x" * 90, canvas_px=512)

    def test_pixel_colors(self):
        canonical = qr_canonical.render_canonical_qr("https://qraft.ai/e2e")
        image = canonical.image
        ox, oy = canonical.origin
        px = canonical.module_px

        assert image.getpixel((0, 0)) == GRAY  # canvas corner is free-for-art gray
        assert image.getpixel((ox + px // 2, oy + px // 2)) == (0, 0, 0)  # finder dark
        assert image.getpixel((ox - px, oy - px)) == (255, 255, 255)  # quiet zone white

    def test_mask_pattern_is_explicit(self):
        canonical = qr_canonical.render_canonical_qr("https://qraft.ai/e2e")
        assert canonical.mask_pattern == qr_canonical.CANONICAL_MASK_PATTERN == 4

    def test_render_is_deterministic(self):
        a = qr_canonical.render_canonical_qr("https://qraft.ai/e2e")
        b = qr_canonical.render_canonical_qr("https://qraft.ai/e2e")
        assert a.image.tobytes() == b.image.tobytes()
        assert a.matrix == b.matrix


class TestDecodeThenCanonicalize:
    def _messy_qr(self, content, ecc, box_size=10, border=2):
        """A deliberately non-canonical render (small border, white bg)."""
        qr = qrcode.QRCode(error_correction=ecc, box_size=box_size, border=border)
        qr.add_data(content)
        qr.make(fit=True)
        return qr.make_image(fill_color="black", back_color="white").convert("RGB")

    def test_round_trips_messy_input(self):
        content = "https://qraft.ai/x"
        messy = self._messy_qr(content, qrcode.constants.ERROR_CORRECT_L)
        canonical = qr_canonical.decode_then_canonicalize(messy)
        assert canonical is not None
        assert canonical.content == content
        # Re-rendered under canonical rules, not the input's ECC L.
        assert canonical.ecc in ("M", "Q", "H")
        assert canonical.image.size == (768, 768)

    def test_returns_none_for_undecodable_image(self):
        blank = Image.new("RGB", (400, 400), GRAY)
        assert qr_canonical.decode_then_canonicalize(blank) is None

    def test_returns_none_for_oversized_payload(self):
        # Decodable QR whose payload breaks the 90-char canonical limit.
        messy = self._messy_qr("y" * 120, qrcode.constants.ERROR_CORRECT_M)
        assert qr_canonical.decode_then_canonicalize(messy) is None


class TestFitToCanvas:
    """fit_to_canvas pads non-square v2 canvases with gray (plan 008 Phase 3)."""

    def test_pads_and_offsets_origin(self):
        canonical = qr_canonical.render_canonical_qr("x" * 7, canvas_px=512)
        fitted = qr_canonical.fit_to_canvas(canonical, 768, 512)
        assert fitted.image.size == (768, 512)
        assert fitted.origin == (canonical.origin[0] + 128, canonical.origin[1])
        assert fitted.image.getpixel((0, 0)) == GRAY  # new padding is gray
        assert fitted.matrix == canonical.matrix  # geometry-only change

    def test_noop_when_size_matches(self):
        canonical = qr_canonical.render_canonical_qr("x" * 7)
        assert qr_canonical.fit_to_canvas(canonical, 768, 768) is canonical

    def test_rejects_shrinking(self):
        canonical = qr_canonical.render_canonical_qr("x" * 7, canvas_px=768)
        with pytest.raises(ValueError):
            qr_canonical.fit_to_canvas(canonical, 512, 512)


class TestFunctionPatternMask:
    def test_v1_marks_function_regions_only(self):
        mask = qr_canonical.function_pattern_mask(1)
        n = 21
        assert len(mask) == n and all(len(row) == n for row in mask)
        assert mask[0][0] is True          # finder
        assert mask[8][0] is True          # format strip
        assert mask[6][10] is True         # timing row
        assert mask[10][6] is True         # timing col
        assert mask[n - 8][8] is True      # dark module
        assert mask[10][10] is False       # data area
        assert mask[n - 1][n - 1] is False # bottom-right corner is data in v1
        # v1 function-module count is exactly 233 (=> 208 data modules = 26 codewords).
        assert sum(sum(row) for row in mask) == 233

    def test_v2_alignment_pattern_marked(self):
        mask = qr_canonical.function_pattern_mask(2)
        for r in range(16, 21):
            for c in range(16, 21):
                assert mask[r][c] is True, f"alignment module ({r},{c}) unmarked"
        assert mask[13][13] is False  # outside the 5x5 alignment block

    def test_v7_version_info_marked(self):
        mask = qr_canonical.function_pattern_mask(7)
        n = 17 + 4 * 7
        assert mask[0][n - 11] is True  # top-right version block
        assert mask[n - 11][0] is True  # bottom-left version block

    def test_rejects_out_of_range_version(self):
        with pytest.raises(ValueError):
            qr_canonical.function_pattern_mask(9)
