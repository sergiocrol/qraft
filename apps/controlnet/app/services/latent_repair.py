"""Latent-space scanning-robust repair — v2 repair-ladder rung (b) (plan 008).

Re-noises a generated-but-unscannable QR artwork with img2img (strength
~0.40) under the qrcode_monster ControlNet and denoises it with
**Scanning-Robust Perceptual Guidance (SRPG)**: at each denoising step the
latents take a gradient step against

    lambda1 * ScanningRobustLoss  +  lambda2 * LPIPS(vs. the pre-repair image)

so modules are pulled back toward decodable luminance while the artwork is
anchored perceptually. An optional **SR-MPGD** polish (plain latent gradient
descent on the final clean latents) runs before the last decode.

-----------------------------------------------------------------------------
Attribution (MIT)
-----------------------------------------------------------------------------
The Scanning Robust Loss formulation (per-module Gaussian-center filtering,
the 2*relu(gray-0.45)/2*relu(0.65-gray) luminance error, the center-region
wrong-module mask), the SRPG loss combination (lambda1 * SRL + lambda2 *
perceptual, GRADIENT_SCALE trick) and the SR-MPGD latent gradient-descent
scheme are adapted from **DiffQRCoder**:

    "DiffQRCoder: Diffusion-based Aesthetic QR Code Generation with
    Scanning Robustness Guided Iterative Refinement", WACV 2025.
    Jia-Wei Liao, Winston Wang, Tzu-Sian Wang, Li-Xuan Peng, Ju-Hsian Weng,
    Cheng-Fu Chou, Jun-Cheng Chen.
    Repository: https://github.com/jwliao1209/DiffQRCoder
    (MIT License, per the repository; adapted from commit
    e24ea73ee2e13c7e6e87cb422e8b11784e70ae00)
    Paper: https://arxiv.org/abs/2409.06355

Adaptation notes — what deliberately differs from upstream:

- Upstream implements SRPG inside a full vendored copy of
  ``StableDiffusionControlNetPipeline`` (score added to ``noise_pred`` each
  step, manual DDIM update). We vendor **only the loss/guidance math** and
  drive the *stock* diffusers 0.32 ``StableDiffusionControlNetImg2ImgPipeline``
  through its ``callback_on_step_end`` hook: each step applies the SR-MPGD
  latent gradient-descent update to the post-step latents, and the final
  step runs the optional multi-iteration SR-MPGD polish.
- Upstream's stage 2 re-denoises from fresh noise over the full schedule with
  the stage-1 result only as the perceptual reference; per plan 008 we
  re-noise the stage-1 image itself (img2img, strength ~0.40), which keeps
  more of the artwork.
- The perceptual term uses the packaged LPIPS (``lpips``, VGG backbone)
  instead of upstream's hand-rolled VGG16 feature loss; plan 008 sets
  lambda2 = 3.
- Function-pattern modules (finders/timing/alignment/format) are excluded
  from the SRL via ``CanonicalQR.function_mask`` (upstream only crops the
  quiet-zone padding); the Gaussian kernel sigma scales with module size
  (upstream: fixed sigma 1.5 at module size 20) — both shared with
  ``app/utils/module_repair.py`` so rung (a) and rung (b) score identically.

This module is **container-only**: it imports torch (and lazily lpips) and
must never be imported by the shared utils or at inference-module import
time. GPU behavior (VRAM headroom for the decode backprop at 768^2, wall
time, guidance every-Nth-step degrade) is validated on the GPU box, not on
CPU hosts.
"""

import numpy as np
import torch
import torch.nn.functional as F

from ..utils.logging import get_logger
from ..utils.module_repair import (
    SRL_DARK_THRESHOLD,
    SRL_LIGHT_THRESHOLD,
    gaussian_center_kernel,
)

logger = get_logger(__name__)

# Upstream numerics (DiffQRCoder): loss is scaled up before backprop and the
# gradient scaled back down — keeps fp16 gradients out of the denormal range.
GRADIENT_SCALE = 100.0

# Plan-008 guidance weights: lambda1 (SRL) = 500, lambda2 (LPIPS) = 3.
DEFAULT_SRL_WEIGHT = 500.0
DEFAULT_LPIPS_WEIGHT = 3.0

DEFAULT_STRENGTH = 0.40
DEFAULT_NUM_INFERENCE_STEPS = 40  # x strength 0.40 => ~16 denoise steps
DEFAULT_GUIDANCE_LR = 0.05        # per-step latent GD step size
DEFAULT_SRMPGD_LR = 0.1           # upstream srmpgd_lr default

# Rec. 601 luma weights, matching upstream convert_to_gray.
_LUMA_WEIGHTS = (0.2999, 0.587, 0.1114)


def _module_filter(x, weight, module_px):
    """conv2d of a (B,1,H,W) map with one (px,px) kernel at stride=px."""
    return F.conv2d(x, weight, stride=module_px)


def _to_gray(image):
    """(B,3,H,W) [0,1] -> (B,1,H,W) luminance, upstream weights."""
    r, g, b = image[:, 0], image[:, 1], image[:, 2]
    gray = _LUMA_WEIGHTS[0] * r + _LUMA_WEIGHTS[1] * g + _LUMA_WEIGHTS[2] * b
    return gray.unsqueeze(1)


class ScanningRobustLoss:
    """DiffQRCoder's SRL against a known module matrix (see header).

    Differences from upstream's ``ScanningRobustLoss``: the target comes as
    the canonical module matrix (no center-pixel extraction needed) and
    function-pattern modules are masked out entirely.
    """

    def __init__(self, canonical, device):
        px = canonical.module_px
        self.module_px = px

        kernel = gaussian_center_kernel(px)  # peak-normalized, floored — as upstream
        self.gaussian_weight = torch.tensor(
            kernel, dtype=torch.float32, device=device
        ).reshape(1, 1, px, px)

        # Upstream RegionMeanFilter: mean over the center box of radius
        # ceil(px/6) — the "does this module still read wrong?" probe.
        center = px // 2
        radius = max(1, int(np.ceil(px / 6)))
        box = np.zeros((px, px), dtype=np.float32)
        box[center - radius : center + radius, center - radius : center + radius] = 1.0
        self.center_weight = torch.tensor(
            box / box.sum(), dtype=torch.float32, device=device
        ).reshape(1, 1, px, px)

        self.target_dark = torch.tensor(
            np.asarray(canonical.matrix, dtype=bool), device=device
        )
        self.scoreable = ~torch.tensor(
            np.asarray(canonical.function_mask, dtype=bool), device=device
        )
        dark_px = self.target_dark.to(torch.float32)
        self.dark_pixels = (
            dark_px.repeat_interleave(px, dim=0)
            .repeat_interleave(px, dim=1)
            .reshape(1, 1, *[s * px for s in self.target_dark.shape])
        )

    def __call__(self, image01):
        """SRL over the symbol-region crop *image01* ((1,3,S,S), [0,1])."""
        gray = _to_gray(image01.float())
        error = (
            2.0 * torch.relu(gray - SRL_DARK_THRESHOLD) * self.dark_pixels
            + 2.0 * torch.relu(SRL_LIGHT_THRESHOLD - gray) * (1.0 - self.dark_pixels)
        )
        sample_error = _module_filter(error, self.gaussian_weight, self.module_px)

        with torch.no_grad():
            center_mean = _module_filter(
                gray.detach(), self.center_weight, self.module_px
            )[0, 0]
            wrong = (self.target_dark & (center_mean > SRL_DARK_THRESHOLD)) | (
                ~self.target_dark & (center_mean < SRL_LIGHT_THRESHOLD)
            )
            mask = (wrong & self.scoreable).to(torch.float32).reshape(
                1, 1, *wrong.shape
            )

        return torch.mean(sample_error * mask)


def _load_lpips(device):
    """LPIPS(VGG) on *device*, or None (SRL-only guidance) when unavailable.

    lpips pulls VGG16 weights through torchvision on first construction; in
    an offline container without the cache this fails — degrade rather than
    fail the repair.
    """
    try:
        import lpips as lpips_lib

        model = lpips_lib.LPIPS(net="vgg", verbose=False).to(device)
        model.requires_grad_(False)
        return model
    except Exception as e:  # pragma: no cover - container/runtime specific
        logger.warning("LPIPS unavailable (%s); SRPG degrades to SRL-only", e)
        return None


class ScanningRobustPerceptualGuidance:
    """SRPG loss (lambda1 * SRL + lambda2 * LPIPS) over the symbol region."""

    def __init__(self, canonical, ref_image, device,
                 srl_weight=DEFAULT_SRL_WEIGHT, lpips_weight=DEFAULT_LPIPS_WEIGHT):
        self.srl = ScanningRobustLoss(canonical, device)
        self.srl_weight = float(srl_weight)
        self.lpips_weight = float(lpips_weight)
        self.lpips = _load_lpips(device) if lpips_weight > 0 else None

        x0, y0 = canonical.origin
        side = canonical.modules * canonical.module_px
        self.crop = (y0, y0 + side, x0, x0 + side)

        ref = np.asarray(ref_image.convert("RGB"), dtype=np.float32) / 255.0
        ref = torch.tensor(ref, device=device).permute(2, 0, 1).unsqueeze(0)
        self.ref_pm1 = (self._crop_symbol(ref) * 2.0 - 1.0)  # [-1,1] for LPIPS

    def _crop_symbol(self, image):
        t, b, l, r = self.crop
        return image[:, :, t:b, l:r]

    def compute_loss(self, decoded_pm1):
        """SRPG loss for a decoded (1,3,H,W) image in [-1,1] (differentiable)."""
        sym_pm1 = self._crop_symbol(decoded_pm1.float())
        sym01 = (sym_pm1 / 2.0 + 0.5).clamp(0.0, 1.0)
        loss = self.srl_weight * self.srl(sym01)
        if self.lpips is not None and self.lpips_weight > 0:
            loss = loss + self.lpips_weight * self.lpips(sym_pm1, self.ref_pm1).mean()
        return loss


def run_latent_repair(
    pipe,
    image,
    canonical,
    prompt,
    negative_prompt=None,
    monster_scale=1.35,
    guidance_scale=7.0,
    strength=DEFAULT_STRENGTH,
    num_inference_steps=DEFAULT_NUM_INFERENCE_STEPS,
    seed=None,
    srl_weight=DEFAULT_SRL_WEIGHT,
    lpips_weight=DEFAULT_LPIPS_WEIGHT,
    guidance_lr=DEFAULT_GUIDANCE_LR,
    guidance_every=1,
    srmpgd_iterations=0,
    srmpgd_lr=DEFAULT_SRMPGD_LR,
):
    """SRPG-guided img2img repair of *image* toward *canonical*'s QR.

    Args:
        pipe: a ``StableDiffusionControlNetImg2ImgPipeline`` sharing the
            loaded [qrcode_monster, brightness] MultiControlNet (see
            ``PipelineManager.get_img2img_pipeline``). Repair conditions on
            qrcode_monster only — the brightness scale is set to 0.
        image: the stage-1 PIL image that failed verification.
        canonical: the ``CanonicalQR`` the image was generated from.
        guidance_every: apply the per-step update every Nth step (>1 is the
            documented degrade knob if SRPG is too slow / OOMs on the GPU).
        srmpgd_iterations: extra SR-MPGD polish iterations on the final
            latents (0 = off, upstream's default).

    Returns the repaired PIL image. Raises only for programmer errors; the
    caller (repair ladder) guards runtime failures.
    """
    if not (0.0 < strength <= 1.0):
        raise ValueError(f"strength must be in (0, 1], got {strength}")
    if guidance_every < 1:
        raise ValueError(f"guidance_every must be >= 1, got {guidance_every}")

    device = pipe._execution_device
    vae = pipe.vae
    scaling_factor = vae.config.scaling_factor
    srpg = ScanningRobustPerceptualGuidance(
        canonical, image, device, srl_weight=srl_weight, lpips_weight=lpips_weight
    )

    nan_warned = {"done": False}

    def _guided_update(latents, iterations, lr):
        """*iterations* SR-MPGD gradient-descent steps on *latents*."""
        original_dtype = latents.dtype
        lat = latents.detach().clone().requires_grad_(True)
        for _ in range(iterations):
            decoded = vae.decode(lat / scaling_factor).sample
            loss = srpg.compute_loss(decoded) * GRADIENT_SCALE
            grad = torch.autograd.grad(loss, lat)[0] / GRADIENT_SCALE
            if not torch.isfinite(grad).all():
                if not nan_warned["done"]:
                    logger.warning("SRPG gradient non-finite; skipping update")
                    nan_warned["done"] = True
                break
            lat = (lat - lr * grad).detach().requires_grad_(True)
        return lat.detach().to(original_dtype)

    def _callback(cb_pipe, step_index, timestep, callback_kwargs):
        latents = callback_kwargs["latents"]
        is_last = step_index >= cb_pipe._num_timesteps - 1
        if not is_last and step_index % guidance_every != 0:
            return {}
        with torch.enable_grad():
            latents = _guided_update(latents, 1, guidance_lr)
            if is_last and srmpgd_iterations > 0:
                latents = _guided_update(latents, srmpgd_iterations, srmpgd_lr)
        return {"latents": latents}

    generator = None
    if seed is not None:
        generator = torch.Generator(device=device).manual_seed(int(seed))

    control = canonical.image
    is_multi = isinstance(getattr(pipe, "controlnet", None), (list, tuple)) or (
        hasattr(pipe.controlnet, "nets")
    )
    if is_multi:
        num_nets = len(pipe.controlnet.nets) if hasattr(pipe.controlnet, "nets") else len(pipe.controlnet)
        control_image = [control] * num_nets
        # qrcode_monster only: zero out every other net (the brightness CN).
        conditioning = [float(monster_scale)] + [0.0] * (num_nets - 1)
        window_start = [0.0] * num_nets
        window_end = [1.0] * num_nets
    else:
        control_image = control
        conditioning = float(monster_scale)
        window_start = 0.0
        window_end = 1.0

    logger.info(
        "Latent SRPG repair: strength=%.2f steps=%s monster=%.2f "
        "(srl=%.0f lpips=%.1f srmpgd=%s)",
        strength, num_inference_steps, monster_scale,
        srl_weight, lpips_weight, srmpgd_iterations,
    )

    # generate() runs under torch.inference_mode(); autograd needs it OFF for
    # every tensor the guidance touches, so the whole call is re-wrapped.
    with torch.inference_mode(mode=False):
        result = pipe(
            prompt=prompt,
            image=image,
            control_image=control_image,
            strength=strength,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
            negative_prompt=negative_prompt,
            generator=generator,
            controlnet_conditioning_scale=conditioning,
            control_guidance_start=window_start,
            control_guidance_end=window_end,
            callback_on_step_end=_callback,
            callback_on_step_end_tensor_inputs=["latents"],
        )
    return result.images[0]
