"""CPU tests for ``app/utils/scan_verifier.py`` (plan 008 Phase 2).

Covers the strictness verdict table, the weighted score, the round-trip
(canonical render -> verify), graceful degradation when the WeChat models are
missing, and ECC-level corruption tolerance of the canonicalizer's raise-ECC
rule (data-area corner blob decodes at H, not at L).

WeChat model files are looked up in ``tests/.cache/wechat_models`` (gitignored;
download them pinned to WeChatCV/opencv_3rdparty commit
3487ef7cde71d93c6a01bb0b84aa0f22c6128f6b, e.g.:

    mkdir -p tests/.cache/wechat_models && cd tests/.cache/wechat_models
    for f in detect.prototxt detect.caffemodel sr.prototxt sr.caffemodel; do
      curl -fsSLO "https://raw.githubusercontent.com/WeChatCV/opencv_3rdparty/3487ef7cde71d93c6a01bb0b84aa0f22c6128f6b/$f"
    done

). WeChat-dependent tests skip when the files are absent; everything else
runs with zxing-cpp alone.

Run: cd apps/controlnet && python3 -m pytest tests/test_scan_verifier.py -q
"""

import importlib
import sys
import types
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

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
scan_verifier = importlib.import_module("app.utils.scan_verifier")
qr_canonical = importlib.import_module("app.utils.qr_canonical")

WECHAT_CACHE = Path(__file__).resolve().parent / ".cache" / "wechat_models"
WECHAT_MODELS_PRESENT = all(
    (WECHAT_CACHE / f).is_file() for f in scan_verifier.WECHAT_MODEL_FILES
)

CONTENT = "https://qraft.ai/e2e"

W = scan_verifier.DECODER_WECHAT
Z = scan_verifier.DECODER_ZXING


@pytest.fixture
def wechat_env(monkeypatch):
    """Point the verifier at the test model cache for the test's duration."""
    monkeypatch.setenv("WECHAT_MODEL_DIR", str(WECHAT_CACHE))
    scan_verifier.reset_wechat_detector_cache()
    yield
    scan_verifier.reset_wechat_detector_cache()


@pytest.fixture
def no_wechat_env(monkeypatch, tmp_path):
    """Point the verifier at an empty model dir to force degradation."""
    monkeypatch.setenv("WECHAT_MODEL_DIR", str(tmp_path / "empty"))
    scan_verifier.reset_wechat_detector_cache()
    yield
    scan_verifier.reset_wechat_detector_cache()


class TestVerdictTable:
    """Pure acceptance-rule truth table (no images involved)."""

    @pytest.mark.parametrize(
        "strictness,passed,available,expected",
        [
            ("relaxed", {W}, {W, Z}, True),
            ("relaxed", {Z}, {W, Z}, False),   # wechat is the accept gate
            ("standard", {W}, {W, Z}, True),
            ("standard", {Z}, {W, Z}, False),
            ("standard", {W, Z}, {W, Z}, True),
            ("strict", {W, Z}, {W, Z}, True),
            ("strict", {W}, {W, Z}, False),    # strict needs both
            ("strict", {Z}, {W, Z}, False),
            # Degraded: wechat unavailable -> any available decoder substitutes.
            ("standard", {Z}, {Z}, True),
            ("relaxed", {Z}, {Z}, True),
            ("strict", {Z}, {Z}, True),
            ("standard", set(), {Z}, False),
        ],
    )
    def test_verdict(self, strictness, passed, available, expected):
        assert scan_verifier._verdict(strictness, passed, available) is expected

    def test_verdict_incomputable_without_decoders(self):
        assert scan_verifier._verdict("standard", set(), set()) is None

    def test_table_covers_all_strictness_levels(self):
        assert set(scan_verifier.STRICTNESS_TABLE) == {"relaxed", "standard", "strict"}
        assert scan_verifier.STRICTNESS_TABLE["relaxed"]["allow_latent_repair"] is False
        assert scan_verifier.STRICTNESS_TABLE["strict"]["require"] == (W, Z)


class TestScore:
    def test_all_pass_is_one(self):
        cells = [{"weight": w, "passed": True} for w in (1.0, 1.0, 0.5, 0.5)]
        assert scan_verifier._score(cells) == 1.0

    def test_none_pass_is_zero(self):
        cells = [{"weight": w, "passed": False} for w in (1.0, 1.0, 0.5, 0.5)]
        assert scan_verifier._score(cells) == 0.0

    def test_weighting(self):
        cells = [
            {"weight": 1.0, "passed": True},
            {"weight": 1.0, "passed": True},
            {"weight": 0.5, "passed": False},
            {"weight": 0.5, "passed": False},
        ]
        assert scan_verifier._score(cells) == pytest.approx(2 / 3, abs=1e-3)

    def test_empty_cells_incomputable(self):
        assert scan_verifier._score([]) is None


class TestConditionsMatrix:
    def test_four_conditions_unique_positive_weights(self):
        ids = [c[0] for c in scan_verifier.CONDITIONS]
        assert len(ids) == 4 and len(set(ids)) == 4
        assert {"scale_1.0", "scale_0.5", "scale_0.31", "blur_1px"} == set(ids)
        assert all(c[3] > 0 for c in scan_verifier.CONDITIONS)


class TestRoundTrip:
    def test_canonical_render_verifies_with_zxing_at_least(self, wechat_env):
        canonical = qr_canonical.render_canonical_qr(CONTENT)
        report = scan_verifier.verify(canonical.image, CONTENT, "standard")
        assert report.zxing_available is True
        assert Z in report.decoders_passed
        assert report.scan_verified is True
        assert report.scan_score is not None and report.scan_score > 0.5

    @pytest.mark.skipif(not WECHAT_MODELS_PRESENT, reason="wechat model files not cached")
    def test_canonical_render_passes_strict_with_wechat(self, wechat_env):
        canonical = qr_canonical.render_canonical_qr(CONTENT)
        report = scan_verifier.verify(canonical.image, CONTENT, "strict")
        assert report.wechat_available is True
        assert set(report.decoders_passed) == {W, Z}
        assert report.scan_verified is True
        assert report.scan_score >= 0.75

    def test_wrong_expected_content_fails(self, wechat_env):
        canonical = qr_canonical.render_canonical_qr(CONTENT)
        report = scan_verifier.verify(canonical.image, "https://attacker.example", "relaxed")
        assert report.scan_verified is False
        assert report.decoders_passed == []
        assert report.scan_score == 0.0

    def test_to_metadata_shape(self, wechat_env):
        canonical = qr_canonical.render_canonical_qr(CONTENT)
        report = scan_verifier.verify(canonical.image, CONTENT, "standard")
        meta = report.to_metadata()
        assert set(meta) == {"scan_verified", "scan_score", "decoders_passed"}

    def test_verify_rejects_empty_expected(self):
        with pytest.raises(ValueError):
            scan_verifier.verify(Image.new("RGB", (64, 64)), "", "standard")

    def test_verify_rejects_unknown_strictness(self):
        with pytest.raises(ValueError):
            scan_verifier.verify(Image.new("RGB", (64, 64)), CONTENT, "paranoid")


class TestDecodeAny:
    def test_decodes_canonical(self, wechat_env):
        canonical = qr_canonical.render_canonical_qr(CONTENT)
        assert scan_verifier.decode_any(canonical.image) == CONTENT

    def test_none_for_blank_image(self, wechat_env):
        blank = Image.new("RGB", (300, 300), qr_canonical.CANVAS_GRAY)
        assert scan_verifier.decode_any(blank) is None


class TestGracefulDegradation:
    def test_missing_models_never_crash_and_zxing_substitutes(self, no_wechat_env):
        canonical = qr_canonical.render_canonical_qr(CONTENT)
        report = scan_verifier.verify(canonical.image, CONTENT, "standard")
        assert report.wechat_available is False
        assert scan_verifier.wechat_available() is False
        # Degraded standard: zxing's pass substitutes for the missing wechat.
        assert report.scan_verified is True
        assert report.decoders_passed == [Z]

    def test_env_var_controls_model_dir(self, no_wechat_env):
        assert scan_verifier.wechat_model_dir().endswith("empty")


def _corrupt_modules(canonical, cells):
    """Copy of canonical.image with the given (row, col) modules inverted."""
    image = canonical.image.copy()
    draw = ImageDraw.Draw(image)
    px = canonical.module_px
    ox, oy = canonical.origin
    for r, c in cells:
        color = (255, 255, 255) if canonical.matrix[r][c] else (0, 0, 0)
        draw.rectangle(
            [ox + c * px, oy + r * px, ox + (c + 1) * px - 1, oy + (r + 1) * px - 1],
            fill=color,
        )
    return image


class TestCorruptionTolerance:
    """The raise-to-H rule buys real damage budget: a data-area corner blob
    (function patterns untouched) still decodes at ECC H but not at ECC L."""

    CONTENT7 = "qraft.1"  # 7 chars -> v1 + ECC H under canonical rules

    def _corner_cells(self, canonical):
        n = canonical.modules
        mask = canonical.function_mask
        return [
            (r, c)
            for r in range(n - 6, n)
            for c in range(n - 6, n)
            if not mask[r][c]
        ]

    def test_blob_hits_data_area_only(self):
        canonical = qr_canonical.render_canonical_qr(self.CONTENT7)
        assert canonical.ecc == "H"
        cells = self._corner_cells(canonical)
        assert len(cells) == 36  # 6x6 all-data corner in v1

    def test_ecc_h_survives_corner_blob(self, wechat_env):
        canonical = qr_canonical.render_canonical_qr(self.CONTENT7)
        corrupted = _corrupt_modules(canonical, self._corner_cells(canonical))
        assert scan_verifier._decode_zxing(corrupted) == [self.CONTENT7]

    def test_ecc_l_dies_under_same_blob(self, wechat_env):
        canonical_l = qr_canonical._render_at(self.CONTENT7, 1, "L", 768)
        corrupted = _corrupt_modules(canonical_l, self._corner_cells(canonical_l))
        assert self.CONTENT7 not in scan_verifier._decode_zxing(corrupted)
