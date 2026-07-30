"""Server-side scan verification for generated QR art (plan 008).

Runs the two strongest open-source decoders over a small robustness matrix
and reports whether the decoded payload matches the expected content exactly:

- **wechat** — OpenCV contrib ``wechat_qrcode`` (CNN detector + super
  resolution). Most tolerant open decoder, and the same detector family as
  the client's ``qr-scanner-wechat``, so server and client verdicts agree.
- **zxing** — ``zxing-cpp``. The strict second opinion: when *both* decode,
  real-phone success is near-certain.

Conditions per decoder: scales {1.0, 0.5, 0.31} plus a 1px-Gaussian-blur
variant (distance / focus proxies). A decoder *passes* when its payload
equals the expected content on at least one condition; ``scan_score`` is the
weighted fraction of (decoder x condition) passes.

Robustness: cv2, zxing-cpp and the WeChat model files (env
``WECHAT_MODEL_DIR``, default ``/opt/program/wechat_models``, see Dockerfile;
mirrored in ``app.config.Config`` for visibility) are resolved lazily. When
anything is unavailable the affected decoder is reported unavailable and the
verdict degrades gracefully — ``verify()`` never raises for that, so
verification can never take the container down.

Deliberately importable without torch (and without cv2/zxing installed).
"""

import os
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageFilter

from ..constants import DEFAULT_SCAN_STRICTNESS, VALID_SCAN_STRICTNESS
from .logging import get_logger

logger = get_logger(__name__)

try:  # pragma: no cover - exercised only where opencv-contrib is absent
    import cv2 as _cv2
except ImportError:  # pragma: no cover
    _cv2 = None
    logger.warning("cv2 not importable; wechat QR verification disabled")

try:  # pragma: no cover - exercised only where zxing-cpp is absent
    import zxingcpp as _zxingcpp
except ImportError:  # pragma: no cover
    _zxingcpp = None
    logger.warning("zxingcpp not importable; zxing QR verification disabled")

DEFAULT_WECHAT_MODEL_DIR = "/opt/program/wechat_models"
WECHAT_MODEL_FILES = (
    "detect.prototxt",
    "detect.caffemodel",
    "sr.prototxt",
    "sr.caffemodel",
)

DECODER_WECHAT = "wechat"
DECODER_ZXING = "zxing"

# (condition_id, scale, gaussian_blur_radius_px, weight). Full/half scale are
# the primary conditions; the harsher small-scale and blur probes contribute
# less to the score.
CONDITIONS = (
    ("scale_1.0", 1.0, 0.0, 1.0),
    ("scale_0.5", 0.5, 0.0, 1.0),
    ("scale_0.31", 0.31, 0.0, 0.5),
    ("blur_1px", 1.0, 1.0, 0.5),
)

# Acceptance per strictness: ``require`` lists the decoders that must pass at
# least one condition for scan_verified=True. ``allow_latent_repair`` is
# consumed by the Phase 4 repair ladder (relaxed skips the expensive rung).
STRICTNESS_TABLE = {
    "relaxed": {"require": (DECODER_WECHAT,), "allow_latent_repair": False},
    "standard": {"require": (DECODER_WECHAT,), "allow_latent_repair": True},
    "strict": {"require": (DECODER_WECHAT, DECODER_ZXING), "allow_latent_repair": True},
}
assert set(STRICTNESS_TABLE) == set(VALID_SCAN_STRICTNESS)

_wechat_state = {"detector": None, "checked": False}


def wechat_model_dir():
    """Directory holding the four WeChat model files (env-overridable)."""
    return os.environ.get("WECHAT_MODEL_DIR", DEFAULT_WECHAT_MODEL_DIR)


def reset_wechat_detector_cache():
    """Forget the cached detector so WECHAT_MODEL_DIR is re-resolved (tests)."""
    _wechat_state["detector"] = None
    _wechat_state["checked"] = False


def _get_wechat_detector():
    """Lazily build the WeChat detector; None (with one warning) on failure."""
    if _wechat_state["checked"]:
        return _wechat_state["detector"]
    _wechat_state["checked"] = True

    if _cv2 is None or not hasattr(_cv2, "wechat_qrcode_WeChatQRCode"):
        logger.warning(
            "cv2.wechat_qrcode unavailable; scan verification degrades to zxing-only"
        )
        return None

    model_dir = wechat_model_dir()
    paths = [os.path.join(model_dir, f) for f in WECHAT_MODEL_FILES]
    missing = [p for p in paths if not os.path.isfile(p)]
    if missing:
        logger.warning(
            "WeChat QR model files missing under %s (%s); "
            "scan verification degrades to zxing-only",
            model_dir, ", ".join(os.path.basename(p) for p in missing),
        )
        return None

    try:
        _wechat_state["detector"] = _cv2.wechat_qrcode_WeChatQRCode(*paths)
        logger.info("WeChat QR detector loaded from %s", model_dir)
    except Exception as e:
        logger.warning("WeChat QR detector failed to construct: %s", e)
    return _wechat_state["detector"]


def wechat_available():
    return _get_wechat_detector() is not None


def zxing_available():
    return _zxingcpp is not None


def _decode_wechat(image):
    """All payloads the WeChat decoder finds in a PIL image ([] if none)."""
    detector = _get_wechat_detector()
    if detector is None:
        return []
    try:
        bgr = _cv2.cvtColor(np.asarray(image.convert("RGB")), _cv2.COLOR_RGB2BGR)
        texts, _points = detector.detectAndDecode(bgr)
        return [t for t in texts if t]
    except Exception as e:
        logger.debug("wechat decode errored: %s", e)
        return []


def _decode_zxing(image):
    """All payloads zxing-cpp finds in a PIL image ([] if none)."""
    if _zxingcpp is None:
        return []
    try:
        results = _zxingcpp.read_barcodes(image)
        return [r.text for r in results if r.text]
    except Exception as e:
        logger.debug("zxing decode errored: %s", e)
        return []


_DECODERS = {
    DECODER_WECHAT: _decode_wechat,
    DECODER_ZXING: _decode_zxing,
}


def decode_any(image):
    """Best-effort payload of the QR in *image*, or None.

    Tries wechat then zxing, at native size then half size (half size helps
    with very large module-size renders). Used to discover the expected
    content of caller-supplied ``base_qr_code`` rasters.
    """
    if image.mode != "RGB":
        image = image.convert("RGB")
    half = None
    for decoder in (_decode_wechat, _decode_zxing):
        payloads = decoder(image)
        if payloads:
            return payloads[0]
        if half is None:
            half = image.resize(
                (max(1, image.width // 2), max(1, image.height // 2)),
                Image.LANCZOS,
            )
        payloads = decoder(half)
        if payloads:
            return payloads[0]
    return None


def _make_variant(image, scale, blur_radius):
    variant = image
    if scale != 1.0:
        variant = variant.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.LANCZOS,
        )
    if blur_radius > 0:
        variant = variant.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    return variant


def _verdict(strictness, passed_decoders, available_decoders):
    """Pure acceptance rule: does *passed_decoders* satisfy *strictness*?

    Every decoder required by the strictness level must have passed; a
    required decoder that is *unavailable* degrades to "any available decoder
    passed" so a missing wechat model file can't hard-fail verification.
    Returns None when no decoder is available at all (verdict incomputable).
    """
    if not available_decoders:
        return None
    ok = True
    for decoder in STRICTNESS_TABLE[strictness]["require"]:
        if decoder in available_decoders:
            ok = ok and decoder in passed_decoders
        else:
            ok = ok and bool(passed_decoders)
    return ok


def _score(cells):
    """Weighted pass fraction over (decoder x condition) *cells*.

    Each cell is a dict with ``weight`` and ``passed``. None when empty.
    """
    total = sum(c["weight"] for c in cells)
    if total <= 0:
        return None
    return round(sum(c["weight"] for c in cells if c["passed"]) / total, 4)


@dataclass
class ScanReport:
    """Outcome of verifying one generated image against expected content."""

    scan_verified: bool  # None when no decoder was available
    scan_score: float  # weighted pass fraction, None when incomputable
    decoders_passed: list
    strictness: str
    expected: str
    wechat_available: bool
    zxing_available: bool
    conditions: list = field(default_factory=list)  # per-cell detail

    def to_metadata(self):
        """Flat JSON-safe fields for per-image result metadata."""
        return {
            "scan_verified": self.scan_verified,
            "scan_score": self.scan_score,
            "decoders_passed": list(self.decoders_passed),
        }


def verify(image, expected, strictness=DEFAULT_SCAN_STRICTNESS):
    """Verify that *image* scans as exactly *expected*.

    Never raises for decoder/model availability problems — those degrade into
    the report (see module docstring). Raises ``ValueError`` only for caller
    errors (empty expected content / unknown strictness).
    """
    if not expected or not isinstance(expected, str):
        raise ValueError("expected content must be a non-empty string")
    if strictness not in STRICTNESS_TABLE:
        raise ValueError(
            f"strictness must be one of {VALID_SCAN_STRICTNESS}, got {strictness!r}"
        )

    if image.mode != "RGB":
        image = image.convert("RGB")

    available = []
    if wechat_available():
        available.append(DECODER_WECHAT)
    if zxing_available():
        available.append(DECODER_ZXING)

    variants = [
        (condition_id, _make_variant(image, scale, blur), weight)
        for condition_id, scale, blur, weight in CONDITIONS
    ]

    cells = []
    passed_decoders = []
    for decoder_name in available:
        decode = _DECODERS[decoder_name]
        decoder_passed = False
        for condition_id, variant, weight in variants:
            payloads = decode(variant)
            cell_passed = expected in payloads
            decoder_passed = decoder_passed or cell_passed
            cells.append({
                "decoder": decoder_name,
                "condition": condition_id,
                "weight": weight,
                "passed": cell_passed,
                "decoded": payloads[0] if payloads else None,
            })
        if decoder_passed:
            passed_decoders.append(decoder_name)

    report = ScanReport(
        scan_verified=_verdict(strictness, passed_decoders, available),
        scan_score=_score(cells),
        decoders_passed=passed_decoders,
        strictness=strictness,
        expected=expected,
        wechat_available=DECODER_WECHAT in available,
        zxing_available=DECODER_ZXING in available,
        conditions=cells,
    )
    logger.debug(
        "Scan verify: verified=%s score=%s passed=%s (strictness=%s)",
        report.scan_verified, report.scan_score, passed_decoders, strictness,
    )
    return report
