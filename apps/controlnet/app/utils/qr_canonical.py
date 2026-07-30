"""Canonical QR rendering for the v2 pipeline (plan 008).

The v2 pipeline never conditions on a caller-supplied QR raster. Instead it
re-renders the QR *content* into a canonical conditioning image tuned for
qrcode_monster v2:

- smallest QR version <= 8 that fits the content at ECC M, then the ECC is
  raised to the strongest level (H > Q > M) that still fits in that version
  (spend spare capacity on damage budget, not on a bigger symbol);
- explicit mask pattern (4, per DiffQRCoder's reference setup) so renders are
  fully deterministic;
- integer module scale ``floor(canvas / (modules + 8))`` px/module (min 12),
  so module edges land on exact pixel boundaries;
- pure black/white modules with a 4-module quiet zone, centered on a
  ``#808080`` gray canvas — qrcode_monster v2 treats mid-gray as "no
  constraint", freeing the area outside the symbol for art (a white margin
  would be enforced as *white*).

This module is deliberately importable without torch/cv2 (qrcode + PIL only);
``decode_then_canonicalize`` imports the scan verifier lazily.
"""

from dataclasses import dataclass, field, replace

import qrcode
from qrcode.exceptions import DataOverflowError
from PIL import Image

from ..constants import QR_CONTENT_MAX_LENGTH, QR_MAX_VERSION
from .logging import get_logger

logger = get_logger(__name__)

# Canonical-render parameters (see module docstring for rationale).
QUIET_ZONE_MODULES = 4
MIN_MODULE_PX = 12
CANONICAL_MASK_PATTERN = 4
CANVAS_GRAY = (128, 128, 128)  # #808080 — qrcode_monster v2 "blend freely"
DEFAULT_CANVAS_PX = 768

_ECC_CONSTANTS = {
    "L": qrcode.constants.ERROR_CORRECT_L,
    "M": qrcode.constants.ERROR_CORRECT_M,
    "Q": qrcode.constants.ERROR_CORRECT_Q,
    "H": qrcode.constants.ERROR_CORRECT_H,
}

# Alignment-pattern center coordinates per version (ISO/IEC 18004, v <= 8).
_ALIGNMENT_CENTERS = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
}


@dataclass(frozen=True)
class CanonicalQR:
    """A canonically rendered QR plus the geometry needed to reason about it.

    ``matrix`` excludes the quiet zone: ``matrix[r][c]`` is True where module
    (row r, col c) is dark. Module (r, c) occupies the pixel square of side
    ``module_px`` whose top-left corner is
    ``(origin[0] + c * module_px, origin[1] + r * module_px)`` on ``image``.
    """

    image: Image.Image
    matrix: list  # list[list[bool]], modules x modules, True = dark
    content: str
    version: int
    ecc: str  # "M" | "Q" | "H" (canonical renders never use L)
    mask_pattern: int
    modules: int  # matrix dimension = 17 + 4 * version
    module_px: int  # rendered pixels per module
    origin: tuple  # (x, y) canvas pixel of module (0, 0)'s top-left corner
    quiet_zone_modules: int = QUIET_ZONE_MODULES
    canvas_px: int = DEFAULT_CANVAS_PX
    function_mask: list = field(default=None, repr=False)  # same shape as matrix

    def to_metadata(self):
        """JSON-safe geometry summary for result payloads (no image/matrix)."""
        return {
            "version": self.version,
            "ecc": self.ecc,
            "mask_pattern": self.mask_pattern,
            "modules": self.modules,
            "module_px": self.module_px,
            "origin": list(self.origin),
            "quiet_zone_modules": self.quiet_zone_modules,
            "canvas_px": self.canvas_px,
        }


def _fits(content, version, ecc):
    """True when *content* fits a QR of exactly *version* at ECC *ecc*."""
    qr = qrcode.QRCode(version=version, error_correction=_ECC_CONSTANTS[ecc])
    qr.add_data(content)
    try:
        qr.make(fit=False)
        return True
    except DataOverflowError:
        return False


def _render_at(content, version, ecc, canvas_px):
    """Render *content* at an exact version/ECC onto the gray canvas.

    Internal building block of :func:`render_canonical_qr`; also used by the
    test suite to build non-canonical (e.g. ECC L) comparison fixtures.
    """
    modules = 17 + 4 * version
    module_px = canvas_px // (modules + 2 * QUIET_ZONE_MODULES)
    if module_px < MIN_MODULE_PX:
        raise ValueError(
            f"QR version {version} needs {(modules + 2 * QUIET_ZONE_MODULES) * MIN_MODULE_PX}px "
            f"for >= {MIN_MODULE_PX}px/module; canvas is {canvas_px}px"
        )

    qr = qrcode.QRCode(
        version=version,
        error_correction=_ECC_CONSTANTS[ecc],
        box_size=module_px,
        border=QUIET_ZONE_MODULES,
        mask_pattern=CANONICAL_MASK_PATTERN,
    )
    qr.add_data(content)
    qr.make(fit=False)

    qr_image = qr.make_image(fill_color="black", back_color="white").convert("RGB")

    canvas = Image.new("RGB", (canvas_px, canvas_px), CANVAS_GRAY)
    paste_x = (canvas_px - qr_image.width) // 2
    paste_y = (canvas_px - qr_image.height) // 2
    canvas.paste(qr_image, (paste_x, paste_y))

    # qr.get_matrix() includes the quiet zone; strip it to modules x modules.
    bordered = qr.get_matrix()
    b = QUIET_ZONE_MODULES
    matrix = [
        [bool(cell) for cell in row[b:-b]]
        for row in bordered[b:-b]
    ]

    origin = (
        paste_x + QUIET_ZONE_MODULES * module_px,
        paste_y + QUIET_ZONE_MODULES * module_px,
    )

    return CanonicalQR(
        image=canvas,
        matrix=matrix,
        content=content,
        version=version,
        ecc=ecc,
        mask_pattern=CANONICAL_MASK_PATTERN,
        modules=modules,
        module_px=module_px,
        origin=origin,
        quiet_zone_modules=QUIET_ZONE_MODULES,
        canvas_px=canvas_px,
        function_mask=function_pattern_mask(version),
    )


def render_canonical_qr(content, canvas_px=DEFAULT_CANVAS_PX):
    """Render *content* as the canonical v2 conditioning QR.

    Raises ``ValueError`` for empty content, content longer than
    ``QR_CONTENT_MAX_LENGTH`` chars, content that needs a QR version above
    ``QR_MAX_VERSION`` (e.g. many multi-byte chars), or a canvas too small
    for ``MIN_MODULE_PX``-pixel modules.
    """
    if not content or not isinstance(content, str):
        raise ValueError("qr_content must be a non-empty string")
    if len(content) > QR_CONTENT_MAX_LENGTH:
        raise ValueError(
            f"qr_content is {len(content)} chars; max is {QR_CONTENT_MAX_LENGTH}"
        )

    # 1. Smallest version that fits at ECC M.
    probe = qrcode.QRCode(version=None, error_correction=_ECC_CONSTANTS["M"])
    probe.add_data(content)
    probe.make(fit=True)
    version = probe.version
    if version > QR_MAX_VERSION:
        raise ValueError(
            f"qr_content needs QR version {version} at ECC M; max is {QR_MAX_VERSION}"
        )

    # 2. Raise ECC to the strongest level that still fits in that version.
    ecc = "M"
    for candidate in ("H", "Q"):
        if _fits(content, version, candidate):
            ecc = candidate
            break

    canonical = _render_at(content, version, ecc, canvas_px)
    logger.debug(
        "Canonical QR: version=%s ecc=%s modules=%s module_px=%s origin=%s",
        canonical.version, canonical.ecc, canonical.modules,
        canonical.module_px, canonical.origin,
    )
    return canonical


def decode_then_canonicalize(image, canvas_px=DEFAULT_CANVAS_PX):
    """Decode an arbitrary QR *image* and re-render it canonically.

    Fallback path for jobs that send only ``base_qr_code`` rasters (no
    ``qr_content``). Returns ``None`` when the image can't be decoded or its
    payload can't be rendered canonically (too long / version too high) —
    callers then fall back to the v1 resize path.
    """
    # Lazy import: keeps this module importable when cv2/zxing are absent.
    from .scan_verifier import decode_any

    try:
        payload = decode_any(image)
    except Exception as e:  # decode_any shouldn't raise, but never propagate
        logger.warning("QR decode for canonicalization failed: %s", e)
        return None
    if not payload:
        logger.info("Input QR not decodable; cannot canonicalize")
        return None
    try:
        return render_canonical_qr(payload, canvas_px=canvas_px)
    except ValueError as e:
        logger.warning("Decoded QR payload not canonically renderable: %s", e)
        return None


def fit_to_canvas(canonical, width, height):
    """Center a square canonical render on a ``width x height`` gray canvas.

    No-op when the sizes already match. Used when a caller pins non-square
    dims on the v2 path: stretching the canonical QR non-uniformly would
    destroy scannability, so it is padded with free-for-art gray instead.
    ``canvas_px`` keeps the square base size; ``image``/``origin`` are
    authoritative for geometry.
    """
    if (canonical.image.width, canonical.image.height) == (width, height):
        return canonical
    if width < canonical.image.width or height < canonical.image.height:
        raise ValueError(
            f"target canvas {width}x{height} smaller than canonical render "
            f"{canonical.image.width}x{canonical.image.height}"
        )
    canvas = Image.new("RGB", (width, height), CANVAS_GRAY)
    off_x = (width - canonical.image.width) // 2
    off_y = (height - canonical.image.height) // 2
    canvas.paste(canonical.image, (off_x, off_y))
    return replace(
        canonical,
        image=canvas,
        origin=(canonical.origin[0] + off_x, canonical.origin[1] + off_y),
    )


def function_pattern_mask(version):
    """Boolean matrix marking the QR *function* modules for *version*.

    True where a module belongs to a function pattern (finders + separators,
    format info, timing, alignment, version info, dark module) — i.e. modules
    the repair ladder must never touch; False for data/ECC modules.
    """
    if version < 1 or version > QR_MAX_VERSION:
        raise ValueError(f"version must be 1..{QR_MAX_VERSION}, got {version}")

    n = 17 + 4 * version
    mask = [[False] * n for _ in range(n)]

    for r in range(n):
        for c in range(n):
            # Finder patterns + separators + format-info strips share the
            # three 9x8/8x9 corner regions (dark module included bottom-left).
            if r < 9 and c < 9:
                mask[r][c] = True
            elif r < 9 and c >= n - 8:
                mask[r][c] = True
            elif r >= n - 8 and c < 9:
                mask[r][c] = True
            # Timing patterns.
            elif r == 6 or c == 6:
                mask[r][c] = True

    # Alignment patterns (5x5 blocks; centers overlapping finders are skipped).
    centers = _ALIGNMENT_CENTERS[version]
    for cr in centers:
        for cc in centers:
            if (cr < 9 and cc < 9) or (cr < 9 and cc >= n - 9) or (cr >= n - 9 and cc < 9):
                continue
            for r in range(cr - 2, cr + 3):
                for c in range(cc - 2, cc + 3):
                    mask[r][c] = True

    # Version info blocks (versions >= 7): 6x3 above bottom-left finder and
    # 3x6 left of top-right finder.
    if version >= 7:
        for r in range(6):
            for c in range(n - 11, n - 8):
                mask[r][c] = True
        for r in range(n - 11, n - 8):
            for c in range(6):
                mask[r][c] = True

    return mask
