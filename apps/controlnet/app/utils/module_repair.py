"""SRL-style module error matrix + deterministic module blending (plan 008).

Repair-ladder rung (a): the cheapest, fully deterministic rescue for a
generated QR image that fails scan verification. It measures, per QR module,
how far the artwork's luminance is from what a decoder needs to see
(the *Scanning Robust Loss* formulation of DiffQRCoder, WACV 2025 — see
``app/services/latent_repair.py`` for the full attribution), then
alpha-blends the failing modules toward their target luminance, hardest
where the error is largest.

Key properties:

- **Gaussian-center weighting** — decoders sample module centers, so the
  per-module error weights pixel errors with a Gaussian centered on the
  module (DiffQRCoder uses ``cv2.getGaussianKernel(module_size, sigma=1.5)``
  at module_size 20; we scale sigma proportionally for our 12-24px modules).
- **Function patterns are EXCLUDED** — finder/timing/alignment/format
  modules (``CanonicalQR.function_mask``) are never scored and never
  blended: they are structural, and qrcode_monster already holds them; a
  blend there is pure art damage with no decode upside.
- **Center-weighted blending** — the blend alpha follows the same Gaussian
  profile, so module centers are corrected decisively while module borders
  (where neighboring art lives) stay largely untouched.

Pure numpy + PIL — NO torch imports. This module must stay importable and
unit-testable on any CPU host (the container's torch stack is not needed).
"""

import numpy as np
from PIL import Image

from .logging import get_logger

logger = get_logger(__name__)

# Decoder-oriented luminance thresholds (0-1 grayscale), from DiffQRCoder's
# ScanningRobustLoss: a module that should be dark reads reliably below 0.45,
# a light one above 0.65; the band in between is the failure zone.
SRL_DARK_THRESHOLD = 0.45
SRL_LIGHT_THRESHOLD = 0.65

# DiffQRCoder's Gaussian center filter: ksize=module_size, sigma=1.5 at their
# reference module size of 20px; values under 10% of the peak are zeroed.
_REFERENCE_MODULE_PX = 20
_REFERENCE_SIGMA = 1.5
_KERNEL_FLOOR = 0.1

# Blend targets: safely beyond the decoder thresholds (0.45/0.65 -> ~115/166
# in 8-bit) without forcing pure black/white, so blended modules keep a hint
# of the artwork's tone.
TARGET_DARK_LUMA = 25
TARGET_LIGHT_LUMA = 230

DEFAULT_STRENGTH_RAMP = (0.35, 0.75)

# Rec. 601 luma weights, matching DiffQRCoder's convert_to_gray.
_LUMA_WEIGHTS = np.array([0.2999, 0.587, 0.1114], dtype=np.float32)


def gaussian_center_kernel(module_px):
    """Gaussian center-weight kernel for one ``module_px``-sided module.

    Peak-normalized to 1.0 at the center with sub-floor values zeroed, per
    DiffQRCoder's filter construction; sigma scales linearly with module size
    so the kernel keeps its shape across our 12-24px canonical modules.
    """
    if module_px < 1:
        raise ValueError(f"module_px must be >= 1, got {module_px}")
    sigma = _REFERENCE_SIGMA * module_px / _REFERENCE_MODULE_PX
    coords = np.arange(module_px, dtype=np.float32) - (module_px - 1) / 2.0
    kernel_1d = np.exp(-(coords**2) / (2.0 * sigma**2))
    kernel = np.outer(kernel_1d, kernel_1d)
    kernel /= kernel.max()  # min-max normalize (min is ~0 already)
    kernel[kernel < _KERNEL_FLOOR] = 0.0
    return kernel


def _luminance(image):
    """HxW float32 luminance in [0, 1] from a PIL image."""
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return rgb @ _LUMA_WEIGHTS


def _symbol_region(canonical):
    """(x0, y0, x1, y1) pixel box of the module area (quiet zone excluded)."""
    x0, y0 = canonical.origin
    side = canonical.modules * canonical.module_px
    return x0, y0, x0 + side, y0 + side


def _crop_symbol_luma(image, canonical):
    """Luminance of the symbol region, shaped (modules*px, modules*px)."""
    if image.size != canonical.image.size:
        raise ValueError(
            f"image size {image.size} does not match canonical canvas "
            f"{canonical.image.size}"
        )
    x0, y0, x1, y1 = _symbol_region(canonical)
    return _luminance(image)[y0:y1, x0:x1]


def compute_error_matrix(image, canonical):
    """Per-module scan-error scores for *image* against *canonical*.

    Returns a float32 array of shape (modules, modules): 0 where the module
    reads correctly (or is a function-pattern module — always excluded),
    growing toward ~1 as the Gaussian-center-weighted luminance error
    worsens. Pixel error per DiffQRCoder's SRL:
    ``2 * relu(gray - 0.45)`` on should-be-dark modules and
    ``2 * relu(0.65 - gray)`` on should-be-light ones.
    """
    gray = _crop_symbol_luma(image, canonical)
    n = canonical.modules
    px = canonical.module_px

    target_dark = np.asarray(canonical.matrix, dtype=bool)
    if target_dark.shape != (n, n):
        raise ValueError(
            f"canonical matrix shape {target_dark.shape} != ({n}, {n})"
        )

    # Per-pixel error, broadcast from the per-module target.
    dark_pixels = np.repeat(np.repeat(target_dark, px, axis=0), px, axis=1)
    error = np.where(
        dark_pixels,
        2.0 * np.maximum(gray - SRL_DARK_THRESHOLD, 0.0),
        2.0 * np.maximum(SRL_LIGHT_THRESHOLD - gray, 0.0),
    ).astype(np.float32)

    # Gaussian-center weighted mean per module.
    kernel = gaussian_center_kernel(px)
    weights = kernel / kernel.sum()
    blocks = error.reshape(n, px, n, px)
    matrix = np.einsum("ipjq,pq->ij", blocks, weights).astype(np.float32)

    # Function patterns are never scored (and therefore never blended).
    function_mask = np.asarray(canonical.function_mask, dtype=bool)
    matrix[function_mask] = 0.0
    return matrix


def blend_failing_modules(image, canonical, error_matrix,
                          strength_ramp=DEFAULT_STRENGTH_RAMP):
    """Alpha-blend the failing modules of *image* toward target luminance.

    Every data/ECC module with a positive error is blended toward
    ``TARGET_DARK_LUMA``/``TARGET_LIGHT_LUMA``; the blend alpha ramps
    linearly over ``strength_ramp`` = (min_alpha, max_alpha) with the
    module's error relative to the worst module, and is shaped by the
    Gaussian center kernel so module borders keep the artwork. Function
    patterns have error 0 by construction and are never touched.

    Returns a new RGB image (the input is not modified). Deterministic,
    CPU-only, ~milliseconds at 768x768.
    """
    lo, hi = strength_ramp
    if not (0.0 <= lo <= hi <= 1.0):
        raise ValueError(f"strength_ramp must satisfy 0 <= lo <= hi <= 1, got {strength_ramp}")

    error_matrix = np.asarray(error_matrix, dtype=np.float32)
    n = canonical.modules
    px = canonical.module_px
    if error_matrix.shape != (n, n):
        raise ValueError(
            f"error_matrix shape {error_matrix.shape} != ({n}, {n})"
        )

    result = image.convert("RGB").copy()
    max_error = float(error_matrix.max())
    if max_error <= 0.0:
        return result  # nothing failing — no-op copy

    # Per-module alpha in [lo, hi], zero where the module reads correctly.
    module_alpha = np.where(
        error_matrix > 0.0,
        lo + (hi - lo) * (error_matrix / max_error),
        0.0,
    ).astype(np.float32)

    # Spatial profile: full strength at module centers, fading to the border.
    profile = gaussian_center_kernel(px)

    # Per-pixel alpha over the symbol region.
    alpha = (
        np.repeat(np.repeat(module_alpha, px, axis=0), px, axis=1)
        * np.tile(profile, (n, n))
    )

    target_dark = np.asarray(canonical.matrix, dtype=bool)
    target_luma = np.where(target_dark, TARGET_DARK_LUMA, TARGET_LIGHT_LUMA)
    target_pixels = np.repeat(
        np.repeat(target_luma.astype(np.float32), px, axis=0), px, axis=1
    )

    x0, y0, x1, y1 = _symbol_region(canonical)
    pixels = np.asarray(result, dtype=np.float32)
    region = pixels[y0:y1, x0:x1, :]
    blended = (
        region * (1.0 - alpha[..., None])
        + target_pixels[..., None] * alpha[..., None]
    )
    pixels[y0:y1, x0:x1, :] = blended

    out = Image.fromarray(np.clip(np.round(pixels), 0, 255).astype(np.uint8), "RGB")

    failing = int((error_matrix > 0).sum())
    logger.debug(
        "Module blend: %s/%s modules blended (max error %.3f, ramp %s)",
        failing, n * n, max_error, strength_ramp,
    )
    return out


def count_failing_modules(error_matrix, threshold=0.0):
    """Number of modules with error above *threshold* (observability helper)."""
    return int((np.asarray(error_matrix) > threshold).sum())
