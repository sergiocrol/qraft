import os
import base64
import torch
from PIL import Image
from io import BytesIO
import uuid
import requests
import time
from ..utils.qr_processor import QRProcessor
from ..utils.model_downloader import MODEL_REGISTRY, get_model_hf_id
from ..utils.url_guard import (
    _assert_https_url,
    _assert_public_host,
    _decode_data_url,
    _read_capped,
)
from ..utils.scan_verifier import (
    verify as verify_scan,
    decode_any as decode_qr_payload,
    STRICTNESS_TABLE,
)
from ..utils.qr_canonical import render_canonical_qr, decode_then_canonicalize, fit_to_canvas
from ..utils.module_repair import compute_error_matrix, blend_failing_modules
from ..presets import get_preset, apply_prompt_scaffold, apply_negative_scaffold
from ..config import Config
from ..constants import (
    DEFAULT_MODEL_KEY,
    DEFAULT_NEGATIVE_PROMPT,
    DEFAULT_CONTROLNET_CONDITIONING_SCALE,
    DEFAULT_CONTROL_GUIDANCE_START,
    DEFAULT_CONTROL_GUIDANCE_END,
    DEFAULT_NUM_INFERENCE_STEPS,
    DEFAULT_GUIDANCE_SCALE,
    DEFAULT_SAMPLER,
    DEFAULT_HEIGHT,
    DEFAULT_WIDTH,
    DEFAULT_S3_BUCKET,
    DEFAULT_AWS_REGION,
    DEFAULT_SCAN_STRICTNESS,
    DEFAULT_PIPELINE,
    V2_DEFAULT_HEIGHT,
    V2_DEFAULT_WIDTH,
    DEFAULT_SCAN_REPAIR_BUDGET_S,
    V2_REPAIR_STRENGTH,
    V2_REPAIR_STEPS,
    V2_REROLL_MONSTER_BUMP,
    V2_MONSTER_SCALE_CAP,
    V2_REROLL_SEED_OFFSET,
    REPAIR_STAGE_MODULE_BLEND,
    REPAIR_STAGE_LATENT_SRPG,
    REPAIR_STAGE_REROLL,
    V2_HIRES_FACTOR,
    V2_HIRES_STRENGTH,
    V2_HIRES_STEPS,
    V2_HIRES_CN_FACTOR,
)
from diffusers import StableDiffusionControlNetPipeline, ControlNetModel as DiffusersControlNetModel
from diffusers.schedulers import (
    DDIMScheduler,
    DPMSolverMultistepScheduler,
    EulerAncestralDiscreteScheduler,
    EulerDiscreteScheduler,
    LMSDiscreteScheduler,
    PNDMScheduler,
    UniPCMultistepScheduler,
    HeunDiscreteScheduler,
    KDPM2DiscreteScheduler,
    KDPM2AncestralDiscreteScheduler,
    DEISMultistepScheduler,
    DPMSolverSinglestepScheduler
)
from ..utils.logging import get_logger

logger = get_logger(__name__)

# Pillow decompression-bomb guard for untrusted QR images (plan 005): the
# pipeline never takes inputs above 1024x1024, so cap decoding at ~4 MP.
Image.MAX_IMAGE_PIXELS = 1024 * 1024 * 4


def _resolve_config(config=None):
    """Return a config dict.

    Priority: explicit *config* arg → Flask ``current_app.config`` → ``Config`` class attrs.
    """
    if config is not None:
        return config
    try:
        from flask import current_app
        return current_app.config
    except RuntimeError:
        pass
    return {k: getattr(Config, k) for k in dir(Config) if k.isupper() and not k.startswith('_')}


def _ensure_results_dir(config):
    """Results directory from *config*; creates it if it doesn't exist."""
    results_dir = config.get('RESULTS_DIR', './results')
    try:
        os.makedirs(results_dir, exist_ok=True)
    except OSError as e:
        logger.warning(f"Cannot create {results_dir}: {e}. Using /tmp/results instead")
        results_dir = '/tmp/results'
        os.makedirs(results_dir, exist_ok=True)
    return results_dir


class QRControlNetInference:
    def __init__(self, model_name=None, pre_loaded_pipe=None,
                 pipeline_manager=None, config=None):
        """Initialize QRControlNet inference.

        Args:
            model_name: Name of the model to use.
            pre_loaded_pipe: Pre-loaded pipeline (optimised inference).
            pipeline_manager: PipelineManager for runtime model switching.
            config: Optional config dict.  When omitted, falls back to
                    Flask ``current_app.config`` or ``Config`` class.
        """
        self.pipeline_manager = pipeline_manager
        self.pre_loaded = pre_loaded_pipe is not None or pipeline_manager is not None
        self._config = _resolve_config(config)

        self.controlnet_model = self._config.get('CONTROLNET_MODEL', 'monster-labs/control_v1p_sd15_qrcode_monster')
        self.controlnet_two_model = self._config.get('CONTROLNET_TWO_MODEL', 'latentcat/control_v1p_sd15_brightness')

        if pipeline_manager is not None:
            logger.info("Using PipelineManager (runtime model switching enabled)")
            self.pipe = pipeline_manager.get_pipeline()
            self.device = pipeline_manager.device
            self.model = pipeline_manager.current_model_key or self._config.get('MODEL_KEY', DEFAULT_MODEL_KEY)

            logger.info("PipelineManager configuration:")
            logger.info("  Device: %s", self.device)
            logger.info("  Default model: %s", self.model)
        elif self.pre_loaded:
            logger.info("Using pre-loaded optimized pipeline")
            self.pipe = pre_loaded_pipe
            self.device = str(pre_loaded_pipe.device)
            self.model = self._config.get('MODEL_KEY', DEFAULT_MODEL_KEY)

            logger.info("Pre-loaded pipeline configuration:")
            logger.info("  Device: %s", self.device)
            logger.info("  Model: %s", self.model)
        else:
            logger.info("Initializing new pipeline (not using pre-loaded models)")

            import subprocess
            logger.info("GPU information:")
            try:
                subprocess.run(["nvidia-smi"], check=False)
            except Exception:
                logger.warning("Failed to run nvidia-smi")

            logger.info("CUDA available: %s", torch.cuda.is_available())
            logger.info("CUDA device count: %s", torch.cuda.device_count())
            if torch.cuda.is_available():
                logger.info("CUDA device: %s", torch.cuda.get_device_name(0))
                self.device = "cuda"
            else:
                self.device = "cpu"

            logger.info("Using device: %s", self.device)

            self.set_model(model_name)
            self.pipe = None
            self.load_model()

        self.qr_processor = QRProcessor()
        logger.info("QR processor initialized")

        self.s3_client = None
        self.s3_bucket = None
        self.initialize_s3()

    def initialize_s3(self):
        """Initialize S3 client for saving images."""
        try:
            import boto3
            self.s3_bucket = self._config.get('AWS_S3_BUCKET', DEFAULT_S3_BUCKET)
            aws_region = self._config.get('AWS_REGION', DEFAULT_AWS_REGION)
            self.s3_client = boto3.client('s3', region_name=aws_region)
            logger.info(f"S3 client initialized: bucket={self.s3_bucket}, region={aws_region}")
        except ImportError:
            logger.warning("boto3 not available, S3 upload disabled")
            self.s3_client = None
        except Exception as e:
            logger.warning(f"Failed to initialize S3 client: {e}")
            self.s3_client = None

    def upload_image_to_s3(self, image, filename):
        """Upload PIL image to S3 and return the URL."""
        if not self.s3_client or not self.s3_bucket:
            logger.warning("S3 client not available, cannot upload image")
            return None

        try:
            img_buffer = BytesIO()
            image.save(img_buffer, format='PNG', optimize=True, quality=95)
            img_buffer.seek(0)

            s3_key = f"output/{filename}"

            self.s3_client.upload_fileobj(
                img_buffer,
                self.s3_bucket,
                s3_key,
                ExtraArgs={
                    'ContentType': 'image/png',
                    'CacheControl': 'max-age=31536000',  # 1 year cache
                    'Metadata': {
                        'generated-by': 'controlnet-qr-service',
                        'timestamp': str(int(time.time()))
                    }
                }
            )

            aws_region = self._config.get('AWS_REGION', DEFAULT_AWS_REGION)
            s3_url = f"https://{self.s3_bucket}.s3.{aws_region}.amazonaws.com/{s3_key}"
            logger.info(f"Uploaded image to S3: {s3_url}")
            return s3_url

        except Exception as e:
            logger.error(f"Failed to upload image to S3: {e}")
            return None

    def set_model(self, model_name=None):
        """Set the base model to use for generation.

        When a PipelineManager is available, this switches the active pipeline
        to the requested model (loading from S3 on first use if needed).
        """
        default_key = self._config.get('MODEL_KEY', DEFAULT_MODEL_KEY)
        if self.pipeline_manager is not None:
            model_key = (model_name or default_key).lower().strip()
            if model_key not in MODEL_REGISTRY:
                logger.warning(f"Model '{model_key}' not in MODEL_REGISTRY, using {default_key}")
                model_key = default_key
            logger.info(f"Switching pipeline to '{model_key}'")
            self.pipe = self.pipeline_manager.get_pipeline(model_key)
            self.model = model_key
            return self.model

        if self.pre_loaded:
            logger.info(f"Model already pre-loaded: {self.model}")
            return self.model

        model_key = (model_name or default_key).lower().strip()
        if model_key not in MODEL_REGISTRY:
            logger.warning(f"Model '{model_key}' not in MODEL_REGISTRY, using {default_key}")
            model_key = default_key
        self.model = get_model_hf_id(model_key)
        logger.info(f"Using model: {self.model}")
        return self.model

    def load_model(self):
        """Load the model pipeline."""
        if self.pre_loaded:
            logger.info("Model already pre-loaded, skipping load_model()")
            return

        logger.info("Loading controlnet models...")

        controlnet = DiffusersControlNetModel.from_pretrained(
            self.controlnet_model,
            torch_dtype=torch.float16 if self.device == "cuda" else torch.float32
        )

        controlnet_two = DiffusersControlNetModel.from_pretrained(
            self.controlnet_two_model,
            torch_dtype=torch.float16 if self.device == "cuda" else torch.float32
        )

        logger.info("Loading stable diffusion pipeline...")
        self.pipe = StableDiffusionControlNetPipeline.from_pretrained(
            self.model,
            controlnet=[controlnet, controlnet_two],
            torch_dtype=torch.float16 if self.device == "cuda" else torch.float32
        )

        self.pipe.scheduler = DPMSolverMultistepScheduler.from_config(
            self.pipe.scheduler.config,
            algorithm_type="dpmsolver++",
            use_karras_sigmas=True
        )

        self.pipe = self.pipe.to(self.device)

        logger.info("Model loading complete")

    def get_scheduler(self, sampler_name="dpm++_2m_karras"):
        """Get a scheduler instance by name."""
        config = self.pipe.scheduler.config

        schedulers = {
            "ddim": (DDIMScheduler, {}),
            "pndm": (PNDMScheduler, {}),
            "lms": (LMSDiscreteScheduler, {}),
            "euler": (EulerDiscreteScheduler, {}),
            "euler_a": (EulerAncestralDiscreteScheduler, {}),
            "dpm++_2m": (DPMSolverMultistepScheduler, {"algorithm_type": "dpmsolver++"}),
            "dpm++_2m_karras": (DPMSolverMultistepScheduler, {"algorithm_type": "dpmsolver++", "use_karras_sigmas": True}),
            "dpm++_sde": (DPMSolverMultistepScheduler, {"algorithm_type": "dpmsolver++", "solver_order": 2, "use_karras_sigmas": True}),
            "dpm++_sde_karras": (DPMSolverMultistepScheduler, {"algorithm_type": "dpmsolver++", "solver_order": 2, "use_karras_sigmas": True}),
            "heun": (HeunDiscreteScheduler, {}),
            "dpm_2": (KDPM2DiscreteScheduler, {}),
            "dpm_2_a": (KDPM2AncestralDiscreteScheduler, {}),
            "unipc": (UniPCMultistepScheduler, {}),
            "deis": (DEISMultistepScheduler, {}),
            "dpm_fast": (DPMSolverSinglestepScheduler, {})
        }

        if sampler_name.lower() not in schedulers:
            logger.warning("Sampler %s not recognized, defaulting to 'dpm++_2m_karras'", sampler_name)
            sampler_name = "dpm++_2m_karras"

        scheduler_class, params = schedulers[sampler_name.lower()]
        return scheduler_class.from_config(config, **params)

    def load_qr_code_from_url(self, url):
        """Load a QR code from a URL.

        SSRF / resource-exhaustion guards (see ``..utils.url_guard``): https
        only, host must resolve to a public address, response is streamed
        under a byte cap, and Pillow decoding runs under MAX_IMAGE_PIXELS.
        """
        logger.debug("Loading QR code from URL: %s", url)

        try:
            if url.startswith('data:image'):
                data = _decode_data_url(url)
                image = Image.open(BytesIO(data)).convert("RGB")
                logger.debug("Loaded QR code from data URL with size: %s", image.size)
                return image

            parsed_url = _assert_https_url(url)
            _assert_public_host(parsed_url.hostname)

            response = requests.get(url, stream=True, timeout=10)
            response.raise_for_status()

            ctype = response.headers.get("Content-Type", "")
            if ctype and not ctype.lower().startswith("image/"):
                raise ValueError(f"Unexpected content type for QR image: {ctype}")

            data = _read_capped(response.iter_content(8192))
            image = Image.open(BytesIO(data)).convert("RGB")
            logger.debug("Loaded QR code from URL with size: %s", image.size)
            return image

        except requests.exceptions.Timeout:
            raise Exception(f"Timeout while downloading QR code from {url}")
        except requests.exceptions.RequestException as e:
            raise Exception(f"Failed to download QR code from {url}: {str(e)}")
        except Exception as e:
            raise Exception(f"Failed to load QR code from URL {url}: {str(e)}")

    def _decode_expected_content(self, qr_image, qr_url):
        """Best-effort decode of an *input* QR so results can be verified.

        Returns the payload string or None. Never raises — scan verification
        is metadata-only and must not affect generation (plan 008).
        """
        try:
            payload = decode_qr_payload(qr_image)
            if payload:
                logger.debug("Decoded expected QR content from %s", qr_url)
            else:
                logger.info("Input QR from %s not decodable; scan verification skipped", qr_url)
            return payload
        except Exception as e:
            logger.warning("Input QR decode failed for %s (ignored): %s", qr_url, e)
            return None

    def _scan_image_metadata(self, image, expected_content, scan_strictness):
        """Scan-verify a generated image; returns flat metadata fields.

        Fields are None/empty when verification is not computable (unknown
        expected content) or errored. Never raises — generation must not fail
        because verification did (plan 008).
        """
        fields = {
            "scan_verified": None,
            "scan_score": None,
            "decoders_passed": [],
        }
        if not expected_content:
            return fields
        try:
            report = verify_scan(image, expected_content, scan_strictness)
            fields.update(report.to_metadata())
        except Exception as e:
            logger.warning("Scan verification errored (ignored): %s", e)
        return fields

    def _generate_v1_image(self, i, prompt, qr_url, conditioning_scales, description,
                           use_alternative, num_generations, base_params, base_seed,
                           guess_mode, results_dir, unique_id, width, height,
                           scan_strictness, expected_content_cache,
                           generated_images, output_data):
        """One v1 image — the per-image loop body of generate(), extracted
        verbatim (plan 008 Phase 3; ``continue`` became ``return``). The v1
        path is the public default and must stay byte-for-byte identical.
        """
        logger.info("Generating image %s/%s: %s", i + 1, num_generations, description)
        logger.debug("QR URL: %s, conditioning scales: %s, use_alternative: %s", qr_url, conditioning_scales, use_alternative)

        try:
            qr_image = self.load_qr_code_from_url(qr_url)

        except Exception as e:
            logger.warning("Error loading QR code from %s: %s", qr_url, e)
            return

        if qr_url not in expected_content_cache:
            expected_content_cache[qr_url] = self._decode_expected_content(qr_image, qr_url)
        expected_content = expected_content_cache[qr_url]

        if base_seed is not None:
            variation_seed = base_seed + i
            torch.manual_seed(variation_seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed(variation_seed)
                torch.cuda.manual_seed_all(variation_seed)
            logger.debug("Set variation seed to: %s", variation_seed)
        else:
            variation_seed = "random"

        params = base_params.copy()
        params["controlnet_conditioning_scale"] = conditioning_scales

        # Resize QR image directly to output dimensions in a single step.
        # Use NEAREST interpolation to preserve the sharp black/white edges
        # of the QR code — LANCZOS creates anti-aliased transitions that
        # weaken the ControlNet conditioning signal and reduce scannability.
        qr_image_processed = qr_image.resize((width, height), Image.NEAREST)

        qr_input_path = os.path.join(results_dir, f'qr_input_{unique_id}_{i+1}_{description}.png')
        qr_image_processed.save(qr_input_path)
        logger.debug("Saved QR input to %s", qr_input_path)

        try:
            logger.debug("Running inference for generation %s...", i + 1)

            if self.pre_loaded and self.device == "cuda":
                torch.cuda.empty_cache()

            result = self.pipe(
                prompt=prompt,
                image=[qr_image_processed, qr_image_processed],
                guess_mode=[guess_mode, guess_mode],
                **params
            )

            generated_image = result.images[0]
            generated_images.append(generated_image)

            timestamp = int(time.time())
            filename = f"qr_generated_{unique_id}_{i+1}_{timestamp}.png"

            local_output_path = os.path.join(results_dir, filename)
            generated_image.save(local_output_path)
            output_data["output_paths"].append(local_output_path)
            logger.debug("Saved locally: %s", local_output_path)

            s3_url = self.upload_image_to_s3(generated_image, filename)

            if s3_url:
                output_data["images"].append(s3_url)
                output_data["image_urls"].append(s3_url)
                logger.info("Image available at: %s", s3_url)
            else:
                logger.warning("S3 upload failed, falling back to base64")
                buffered = BytesIO()
                generated_image.save(buffered, format="PNG")
                img_str = base64.b64encode(buffered.getvalue()).decode()
                output_data["images"].append(f"data:image/png;base64,{img_str}")

            scan_fields = self._scan_image_metadata(
                generated_image, expected_content, scan_strictness
            )

            generation_info = {
                "index": i + 1,
                "qr_url": qr_url,
                "description": description,
                "conditioning_scales": conditioning_scales,
                "uses_alternative_scales": use_alternative,
                "qr_input_path": qr_input_path,
                "output_path": local_output_path,
                "s3_url": s3_url,
                "seed": variation_seed
            }
            generation_info.update(scan_fields)
            output_data["generations"].append(generation_info)

            # Parallel to output_data["images"] — the per-image metadata
            # contract consumed by the API/client (plan 008).
            output_data["images_metadata"].append({
                "index": i + 1,
                "pipeline": "v1",
                "seed": variation_seed,
                "conditioning_scales": conditioning_scales,
                "expected_content": expected_content,
                "scan_strictness": scan_strictness if expected_content else None,
                "repair_stage_used": None,
                **scan_fields,
            })

            logger.info("Successfully generated image %s: %s", i + 1, description)

        except Exception as e:
            logger.exception("Error generating image %s (%s): %s", i + 1, description, e)
            return

    def _get_img2img_pipe(self):
        """img2img pipeline sharing the active txt2img pipe's components.

        Used by the repair ladder's latent rung and the hires stage (plan
        008). Returns None (with a warning) when it cannot be built — those
        stages then degrade gracefully instead of failing the generation.
        """
        try:
            if self.pipeline_manager is not None:
                return self.pipeline_manager.get_img2img_pipeline(self.model)

            cached = getattr(self, "_img2img_wrapper", None)
            if cached is not None and cached[0] is self.pipe:
                wrapper = cached[1]
                wrapper.scheduler = self.pipe.scheduler  # follow sampler swaps
                return wrapper

            # NOTE: pipe.components already includes `controlnet` — passing
            # it again raises "got multiple values for keyword argument".
            from diffusers import StableDiffusionControlNetImg2ImgPipeline
            wrapper = StableDiffusionControlNetImg2ImgPipeline(
                **self.pipe.components,
                requires_safety_checker=False,
            )
            wrapper.scheduler = self.pipe.scheduler
            self._img2img_wrapper = (self.pipe, wrapper)
            return wrapper
        except Exception as e:
            logger.warning(
                "img2img pipeline unavailable (%s); latent repair / hires disabled", e
            )
            return None

    def _load_latent_repair(self):
        """Lazy import of the torch-only SRPG repair module (None if unavailable).

        Kept lazy so this module (and the CPU test suite) never needs the
        latent-repair dependency stack at import time.
        """
        try:
            from . import latent_repair
            return latent_repair
        except Exception as e:
            logger.warning("Latent repair module unavailable (%s); rung skipped", e)
            return None

    @staticmethod
    def _scan_rank(scan_fields):
        """Orderable quality of a scan result (unknown scores rank lowest)."""
        score = scan_fields.get("scan_score")
        return -1.0 if score is None else score

    def _repair_ladder(self, image, scan_fields, canonical, expected_content,
                       scan_strictness, preset, v2_prompt, params, guess_mode,
                       variation_seed):
        """Stage 3 (plan 008 Phase 4): bounded repair ladder for a failed image.

        Rungs, cheapest first, each followed by re-verification:
          a. module blend — deterministic CPU luminance correction
             (``app/utils/module_repair``), ~milliseconds;
          b. latent SRPG repair — img2img re-noise/denoise under
             Scanning-Robust Perceptual Guidance (+ optional SR-MPGD polish),
             skipped for ``relaxed`` strictness (see STRICTNESS_TABLE);
          c. directed re-roll — regenerate with the qrcode_monster scale
             bumped by +0.15 (capped at 1.65) and a fresh seed.

        The ladder stops at the first rung whose output verifies, and runs
        under the wall-clock budget ``Config.SCAN_REPAIR_BUDGET_S`` (checked
        before the expensive rungs b/c). Returns
        ``(image, scan_fields, last_rung_run, events)`` where the returned
        image is never scan-scored worse than the stage-1 input.
        """
        budget_s = float(self._config.get(
            'SCAN_REPAIR_BUDGET_S', DEFAULT_SCAN_REPAIR_BUDGET_S))
        deadline = time.monotonic() + budget_s

        best_image, best_fields = image, scan_fields
        current_image = image  # input to the next rung: best-so-far artwork
        last_rung = None
        events = []

        def record(rung, candidate_image, fields, extra=None):
            nonlocal best_image, best_fields, current_image, last_rung
            last_rung = rung
            event = {
                "rung": rung,
                "scan_verified": fields.get("scan_verified"),
                "scan_score": fields.get("scan_score"),
            }
            if extra:
                event.update(extra)
            events.append(event)
            if self._scan_rank(fields) >= self._scan_rank(best_fields):
                current_image = candidate_image
            if fields.get("scan_verified") or (
                    self._scan_rank(fields) > self._scan_rank(best_fields)):
                best_image, best_fields = candidate_image, fields
            logger.info(
                "Repair rung %s: scan_verified=%s scan_score=%s",
                rung, fields.get("scan_verified"), fields.get("scan_score"),
            )
            return bool(fields.get("scan_verified"))

        # --- Rung a: module blend (CPU, always affordable) ------------------
        try:
            error_matrix = compute_error_matrix(current_image, canonical)
            blended = blend_failing_modules(current_image, canonical, error_matrix)
            fields = self._scan_image_metadata(
                blended, expected_content, scan_strictness)
            if record(REPAIR_STAGE_MODULE_BLEND, blended, fields):
                return best_image, best_fields, last_rung, events
        except Exception as e:
            logger.warning("Module-blend rung failed (ignored): %s", e)

        # --- Rung b: latent SRPG repair (GPU) --------------------------------
        allow_latent = STRICTNESS_TABLE.get(
            scan_strictness, {}).get("allow_latent_repair", True)
        if not allow_latent:
            logger.info("Latent repair skipped (strictness=%s)", scan_strictness)
        elif time.monotonic() >= deadline:
            logger.warning(
                "Repair budget (%.0fs) exhausted before latent repair", budget_s)
        else:
            latent_repair = self._load_latent_repair()
            img2img = self._get_img2img_pipe() if latent_repair else None
            if latent_repair and img2img is not None:
                try:
                    repaired = latent_repair.run_latent_repair(
                        img2img,
                        current_image,
                        canonical,
                        prompt=v2_prompt,
                        negative_prompt=params.get("negative_prompt"),
                        monster_scale=preset["monster_scale"],
                        guidance_scale=params.get(
                            "guidance_scale", DEFAULT_GUIDANCE_SCALE),
                        strength=V2_REPAIR_STRENGTH,
                        num_inference_steps=V2_REPAIR_STEPS,
                        seed=variation_seed if isinstance(variation_seed, int) else None,
                        srmpgd_iterations=int(self._config.get(
                            'V2_SRMPGD_ITERATIONS', 0)),
                    )
                    fields = self._scan_image_metadata(
                        repaired, expected_content, scan_strictness)
                    if record(REPAIR_STAGE_LATENT_SRPG, repaired, fields):
                        return best_image, best_fields, last_rung, events
                except Exception as e:
                    logger.warning("Latent-repair rung failed (ignored): %s", e)

        # --- Rung c: directed re-roll (last resort) --------------------------
        if time.monotonic() >= deadline:
            logger.warning(
                "Repair budget (%.0fs) exhausted before re-roll", budget_s)
            return best_image, best_fields, last_rung, events

        try:
            reroll_params = params.copy()
            monster = min(
                preset["monster_scale"] + V2_REROLL_MONSTER_BUMP,
                V2_MONSTER_SCALE_CAP,
            )
            reroll_params["controlnet_conditioning_scale"] = [
                monster, preset["brightness_scale"],
            ]

            if isinstance(variation_seed, int):
                reroll_seed = variation_seed + V2_REROLL_SEED_OFFSET
                torch.manual_seed(reroll_seed)
                if torch.cuda.is_available():
                    torch.cuda.manual_seed(reroll_seed)
                    torch.cuda.manual_seed_all(reroll_seed)
            else:
                reroll_seed = "random"

            if self.pre_loaded and self.device == "cuda":
                torch.cuda.empty_cache()

            result = self.pipe(
                prompt=v2_prompt,
                image=[canonical.image, canonical.image],
                guess_mode=[guess_mode, guess_mode],
                **reroll_params
            )
            rerolled = result.images[0]
            fields = self._scan_image_metadata(
                rerolled, expected_content, scan_strictness)
            record(
                REPAIR_STAGE_REROLL, rerolled, fields,
                extra={"monster_scale": monster, "seed": reroll_seed},
            )
        except Exception as e:
            logger.warning("Re-roll rung failed (ignored): %s", e)

        return best_image, best_fields, last_rung, events

    def _hires_stage(self, image, scan_fields, canonical, expected_content,
                     scan_strictness, preset, v2_prompt, params):
        """Stage 4 (plan 008 Phase 5): img2img x1.5 upscale, then re-verify.

        Runs when the container flag ``Config.V2_HIRES`` is on: denoise the
        (768-class) image at strength 0.40 for 20 steps at x1.5 size with
        both ControlNets re-applied at 0.8x the preset scales, conditioned on
        the canonical QR NEAREST-upscaled to match. The upscale is accepted
        only if it doesn't degrade the scan verdict: a verified input must
        stay verified; an unverified input must not score worse. Otherwise
        the input image ships and ``hires_dropped`` is True.

        Returns ``(image, scan_fields, hires_applied, hires_dropped)``.
        ``hires_dropped`` is True only when the upscale was attempted and
        rejected (or crashed) — not when the stage is disabled/unavailable.
        """
        if not self._config.get('V2_HIRES', True):
            logger.debug("Hires stage disabled (V2_HIRES=False)")
            return image, scan_fields, False, False

        img2img = self._get_img2img_pipe()
        if img2img is None:
            logger.warning("Hires stage skipped: img2img pipeline unavailable")
            return image, scan_fields, False, False

        target_w = int(round(image.width * V2_HIRES_FACTOR / 8)) * 8
        target_h = int(round(image.height * V2_HIRES_FACTOR / 8)) * 8

        try:
            # NEAREST keeps the canonical module edges sharp for the CNs.
            control_hi = canonical.image.resize((target_w, target_h), Image.NEAREST)

            logger.info(
                "Hires stage: %sx%s -> %sx%s (strength=%.2f, steps=%s, CNs at %.1fx)",
                image.width, image.height, target_w, target_h,
                V2_HIRES_STRENGTH, V2_HIRES_STEPS, V2_HIRES_CN_FACTOR,
            )

            if self.pre_loaded and self.device == "cuda":
                torch.cuda.empty_cache()

            result = img2img(
                prompt=v2_prompt,
                image=image,
                control_image=[control_hi, control_hi],
                height=target_h,
                width=target_w,
                strength=V2_HIRES_STRENGTH,
                num_inference_steps=V2_HIRES_STEPS,
                guidance_scale=params.get("guidance_scale", DEFAULT_GUIDANCE_SCALE),
                negative_prompt=params.get("negative_prompt"),
                controlnet_conditioning_scale=[
                    preset["monster_scale"] * V2_HIRES_CN_FACTOR,
                    preset["brightness_scale"] * V2_HIRES_CN_FACTOR,
                ],
                control_guidance_start=[
                    preset["monster_window"][0], preset["brightness_window"][0],
                ],
                control_guidance_end=[
                    preset["monster_window"][1], preset["brightness_window"][1],
                ],
            )
            hires_image = result.images[0]
        except Exception as e:
            logger.warning("Hires stage failed (%s); returning the pre-hires image", e)
            return image, scan_fields, False, True

        hires_fields = self._scan_image_metadata(
            hires_image, expected_content, scan_strictness
        )

        base_verified = scan_fields.get("scan_verified")
        hires_verified = hires_fields.get("scan_verified")
        if base_verified is None:
            accept = True  # verification incomputable — nothing to protect
        elif base_verified is True:
            accept = hires_verified is True
        else:
            accept = hires_verified is True or (
                self._scan_rank(hires_fields) >= self._scan_rank(scan_fields)
            )

        if accept:
            logger.info(
                "Hires accepted (scan_verified=%s, score=%s)",
                hires_verified, hires_fields.get("scan_score"),
            )
            return hires_image, hires_fields, True, False

        logger.info(
            "Hires dropped: upscale broke scanning (verified %s -> %s, "
            "score %s -> %s); returning the %sx%s image",
            base_verified, hires_verified,
            scan_fields.get("scan_score"), hires_fields.get("scan_score"),
            image.width, image.height,
        )
        return image, scan_fields, False, True

    def _prepare_canonical_v2(self, qr_content, base_qr_code, width, height):
        """v2 stage 0: canonical conditioning QR + expected content.

        Preference order per plan 008: render ``qr_content`` directly; else
        decode ``base_qr_code[0]`` (fetched through the plan-005 SSRF guard)
        and re-render its payload. Returns ``(CanonicalQR, expected_content)``
        or ``(None, None)`` — the caller then falls back to the v1 path.
        """
        canvas_px = min(width, height)
        canonical = None
        if qr_content:
            try:
                canonical = render_canonical_qr(qr_content, canvas_px=canvas_px)
            except ValueError as e:
                logger.warning(
                    "qr_content not canonically renderable (%s); trying base_qr_code", e
                )
        if canonical is None and base_qr_code:
            try:
                input_image = self.load_qr_code_from_url(base_qr_code[0])
                canonical = decode_then_canonicalize(input_image, canvas_px=canvas_px)
            except Exception as e:
                logger.warning("base_qr_code canonicalization fallback failed: %s", e)
        if canonical is None:
            return None, None
        if (width, height) != (canonical.image.width, canonical.image.height):
            canonical = fit_to_canvas(canonical, width, height)
        logger.info(
            "Canonical QR ready: version=%s ecc=%s module_px=%s (content %r)",
            canonical.version, canonical.ecc, canonical.module_px, canonical.content,
        )
        return canonical, canonical.content

    def _generate_v2_image(self, i, num_images, prompt, canonical, expected_content,
                           preset, scan_strictness, base_params, base_seed,
                           guess_mode, results_dir, unique_id,
                           generated_images, output_data):
        """One v2 image: stages 1-4 — generate on the canonical QR at the
        (clamped, 768-class) canvas with preset-owned parameters, verify, on
        failed verification run the bounded repair ladder (module blend ->
        latent SRPG -> directed re-roll; see ``_repair_ladder``), then the
        hires upscale behind ``V2_HIRES`` (see ``_hires_stage``).

        Stage 0 (canonicalization) runs once in generate().
        """
        logger.info(
            "Generating v2 image %s/%s (preset=%s)", i + 1, num_images, preset["name"]
        )

        if base_seed is not None:
            variation_seed = base_seed + i
            torch.manual_seed(variation_seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed(variation_seed)
                torch.cuda.manual_seed_all(variation_seed)
            logger.debug("Set variation seed to: %s", variation_seed)
        else:
            variation_seed = "random"

        params = base_params.copy()
        params["controlnet_conditioning_scale"] = [
            preset["monster_scale"], preset["brightness_scale"],
        ]
        params["control_guidance_start"] = [
            preset["monster_window"][0], preset["brightness_window"][0],
        ]
        params["control_guidance_end"] = [
            preset["monster_window"][1], preset["brightness_window"][1],
        ]
        params["num_inference_steps"] = preset["steps"]
        params["guidance_scale"] = preset["guidance_scale"]
        params["negative_prompt"] = apply_negative_scaffold(preset, params["negative_prompt"])
        v2_prompt = apply_prompt_scaffold(preset, prompt)

        qr_image_processed = canonical.image

        qr_input_path = os.path.join(results_dir, f'qr_input_{unique_id}_v2_canonical.png')
        if i == 0:
            qr_image_processed.save(qr_input_path)
            logger.debug("Saved canonical QR input to %s", qr_input_path)

        try:
            logger.debug("Running v2 inference for generation %s...", i + 1)

            if self.pre_loaded and self.device == "cuda":
                torch.cuda.empty_cache()

            result = self.pipe(
                prompt=v2_prompt,
                image=[qr_image_processed, qr_image_processed],
                guess_mode=[guess_mode, guess_mode],
                **params
            )

            generated_image = result.images[0]

            scan_fields = self._scan_image_metadata(
                generated_image, expected_content, scan_strictness
            )

            # Stage 3 (plan 008 Phase 4): repair ladder on failed verification
            # (None = verification not computable -> nothing to repair against).
            repair_stage_used = None
            repair_events = []
            if scan_fields["scan_verified"] is False:
                logger.info(
                    "v2 image %s failed verification (score=%s); starting repair ladder",
                    i + 1, scan_fields["scan_score"],
                )
                (generated_image, scan_fields,
                 repair_stage_used, repair_events) = self._repair_ladder(
                    generated_image, scan_fields, canonical, expected_content,
                    scan_strictness, preset, v2_prompt, params, guess_mode,
                    variation_seed,
                )

            # Stage 4 (plan 008 Phase 5): hires upscale behind V2_HIRES.
            (generated_image, scan_fields,
             hires_applied, hires_dropped) = self._hires_stage(
                generated_image, scan_fields, canonical, expected_content,
                scan_strictness, preset, v2_prompt, params,
            )

            generated_images.append(generated_image)

            timestamp = int(time.time())
            filename = f"qr_generated_{unique_id}_{i+1}_{timestamp}.png"

            local_output_path = os.path.join(results_dir, filename)
            generated_image.save(local_output_path)
            output_data["output_paths"].append(local_output_path)
            logger.debug("Saved locally: %s", local_output_path)

            s3_url = self.upload_image_to_s3(generated_image, filename)

            if s3_url:
                output_data["images"].append(s3_url)
                output_data["image_urls"].append(s3_url)
                logger.info("Image available at: %s", s3_url)
            else:
                logger.warning("S3 upload failed, falling back to base64")
                buffered = BytesIO()
                generated_image.save(buffered, format="PNG")
                img_str = base64.b64encode(buffered.getvalue()).decode()
                output_data["images"].append(f"data:image/png;base64,{img_str}")

            generation_info = {
                "index": i + 1,
                "pipeline": "v2",
                "style_preset": preset["name"],
                "conditioning_scales": params["controlnet_conditioning_scale"],
                "control_guidance_start": params["control_guidance_start"],
                "control_guidance_end": params["control_guidance_end"],
                "num_inference_steps": params["num_inference_steps"],
                "qr_input_path": qr_input_path,
                "output_path": local_output_path,
                "s3_url": s3_url,
                "seed": variation_seed,
                "repair_stage_used": repair_stage_used,
                "repair_ladder": repair_events,
                "hires_applied": hires_applied,
                "hires_dropped": hires_dropped,
                "output_size": [generated_image.width, generated_image.height],
            }
            generation_info.update(scan_fields)
            output_data["generations"].append(generation_info)

            # Parallel to output_data["images"] — the per-image metadata
            # contract consumed by the API/client (plan 008).
            output_data["images_metadata"].append({
                "index": i + 1,
                "pipeline": "v2",
                "style_preset": preset["name"],
                "seed": variation_seed,
                "conditioning_scales": params["controlnet_conditioning_scale"],
                "expected_content": expected_content,
                "scan_strictness": scan_strictness,
                "repair_stage_used": repair_stage_used,
                "hires_dropped": hires_dropped,
                **scan_fields,
            })

            logger.info(
                "Successfully generated v2 image %s (scan_verified=%s)",
                i + 1, scan_fields["scan_verified"],
            )

        except Exception as e:
            logger.exception("Error generating v2 image %s: %s", i + 1, e)
            return

    def generate(self, prompt, **kwargs):
        """Generate QR-conditioned images and upload results to S3."""
        preview = (prompt[:80] + "...") if prompt and len(prompt) > 80 else (prompt or "")
        logger.info("Starting generation with prompt: %s", preview)
        logger.debug("kwargs: %s", kwargs)

        # v2-pipeline fields (plan 008); absent -> exact v1 behavior.
        pipeline = kwargs.pop("pipeline", None) or DEFAULT_PIPELINE
        qr_content = kwargs.pop("qr_content", None)
        style_preset = kwargs.pop("style_preset", None)
        scan_strictness = kwargs.pop("scan_strictness", None) or DEFAULT_SCAN_STRICTNESS
        v2_preset = get_preset(style_preset) if pipeline == "v2" else None

        requested_model = kwargs.pop("model", None)
        if pipeline == "v2" and v2_preset["model"] and requested_model in (None, DEFAULT_MODEL_KEY):
            # The schema always fills `model` with the default key, so only an
            # explicit non-default request beats the preset's checkpoint.
            requested_model = v2_preset["model"]
        if requested_model:
            self.set_model(requested_model)

        # Prompt enhancement (plan 009). Pop ALWAYS — the flag must never
        # reach the pipe kwargs. Runs after model/preset resolution (the CLIP
        # budget needs the final pipe's tokenizer and the resolved preset) and
        # before the seed block, so SD reproducibility is untouched. The
        # enhanced prompt stays container-internal: output_data carries no
        # prompt text (transparency contract).
        prompt_enhancement = kwargs.pop("prompt_enhancement", False)
        if prompt_enhancement:
            from .prompt_enhancer import get_enhancer
            enhancement = get_enhancer(self._config).enhance(
                prompt,
                preset=v2_preset,
                clip_tokenizer=getattr(self.pipe, "tokenizer", None),
            )
            logger.info(
                "Prompt enhancement: source=%s reason=%s latency=%.2fs",
                enhancement.source, enhancement.reason, enhancement.latency_s,
            )
            logger.info("Prompt enhancement: original=%s", prompt)
            logger.info("Prompt enhancement: final=%s", enhancement.prompt)
            prompt = enhancement.prompt

        base_qr_code = kwargs.get("base_qr_code")
        if not base_qr_code:
            raise ValueError("base_qr_code parameter is required. Please provide a list of QR code URLs.")

        if isinstance(base_qr_code, str):
            base_qr_code = [base_qr_code]
        elif not isinstance(base_qr_code, list):
            raise ValueError("base_qr_code must be a string URL or list of URLs.")

        if len(base_qr_code) < 1 or len(base_qr_code) > 3:
            raise ValueError("base_qr_code must contain between 1 and 3 URLs.")

        num_images_per_prompt = kwargs.get("num_images_per_prompt")
        logger.info("QR URLs provided: %s, images requested: %s", len(base_qr_code), num_images_per_prompt)

        user_conditioning_scales = kwargs.get("controlnet_conditioning_scale", DEFAULT_CONTROLNET_CONDITIONING_SCALE)
        generations = self.qr_processor.plan_qr_generations(
            base_qr_code,
            num_images_per_prompt,
            user_conditioning_scales
        )

        plan_summary = self.qr_processor.get_generation_plan_summary(generations)
        logger.debug("Generation plan: %s", plan_summary)

        seed = kwargs.get("seed", None)
        base_seed = seed
        if seed is not None:
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed(seed)
                torch.cuda.manual_seed_all(seed)
            logger.debug("Set base seed to: %s", seed)

        sampler = kwargs.get("sampler", DEFAULT_SAMPLER)
        if sampler:
            self.pipe.scheduler = self.get_scheduler(sampler)
            logger.debug("Using sampler: %s", sampler)

        start = kwargs.get("control_guidance_start")
        end = kwargs.get("control_guidance_end")

        height = kwargs.get("height", DEFAULT_HEIGHT)
        width = kwargs.get("width", DEFAULT_WIDTH)

        if pipeline == "v2":
            # v2 generates in SD 1.5's native 768 regime; callers may pin
            # smaller dims, larger ones are clamped (plan 008).
            height = min(height, V2_DEFAULT_HEIGHT)
            width = min(width, V2_DEFAULT_WIDTH)

        height = (height // 8) * 8
        width = (width // 8) * 8
        results_dir = _ensure_results_dir(self._config)

        base_params = {
            "negative_prompt": kwargs.get("negative_prompt", DEFAULT_NEGATIVE_PROMPT),
            "num_inference_steps": kwargs.get("num_inference_steps", DEFAULT_NUM_INFERENCE_STEPS),
            "control_guidance_start": DEFAULT_CONTROL_GUIDANCE_START if start is None else (start if isinstance(start, list) else [start, start]),
            "control_guidance_end": DEFAULT_CONTROL_GUIDANCE_END if end is None else (end if isinstance(end, list) else [end, end]),
            "height": height,
            "width": width,
            "guidance_scale": kwargs.get("guidance_scale", DEFAULT_GUIDANCE_SCALE),
            "eta": 0.0,
            "num_images_per_prompt": 1,
        }

        guess_mode = kwargs.get("guess_mode", False)

        # Scan verification (plan 008): metadata only — never changes images.
        expected_content_cache = {}

        # v2 stage 0: canonical conditioning input (once per request). When
        # nothing is canonicalizable the whole request falls back to the v1
        # conditioning path (per-image scan metadata still applies).
        canonical = None
        expected_content_v2 = None
        if pipeline == "v2":
            canonical, expected_content_v2 = self._prepare_canonical_v2(
                qr_content, base_qr_code, width, height
            )
            if canonical is None:
                logger.warning(
                    "v2: no canonicalizable QR input (qr_content missing/invalid "
                    "and base_qr_code undecodable); falling back to the v1 path"
                )
                pipeline = "v1"

        logger.debug("Base parameter values: %s", base_params)

        generated_images = []
        unique_id = str(uuid.uuid4())[:8]

        output_data = {
            "images": [],
            "image_urls": [],
            "output_paths": [],
            "generations": [],
            "images_metadata": [],
            "input_qr_urls": base_qr_code,
            "num_images_per_prompt": len(generations),
            "seed": base_seed if base_seed else "random",
            "qr_source": "s3_urls",
            "num_images_generated": 0,
            "generation_plan": plan_summary,
            "using_pre_loaded_model": self.pre_loaded,
            "s3_bucket": self.s3_bucket
        }

        if pipeline == "v2":
            output_data["pipeline"] = "v2"
            output_data["style_preset"] = v2_preset["name"]
            output_data["qr_content"] = expected_content_v2
            output_data["canonical_qr"] = canonical.to_metadata()

        # torch.inference_mode() is stricter than torch.no_grad() and provides
        # slightly better performance by disabling autograd and version counting.
        with torch.inference_mode():
            if pipeline == "v2":
                for i in range(len(generations)):
                    self._generate_v2_image(
                        i, len(generations), prompt, canonical, expected_content_v2,
                        v2_preset, scan_strictness, base_params, base_seed,
                        guess_mode, results_dir, unique_id,
                        generated_images, output_data,
                    )
            else:
                for i, (qr_url, conditioning_scales, description, use_alternative) in enumerate(generations):
                    self._generate_v1_image(
                        i, prompt, qr_url, conditioning_scales, description,
                        use_alternative, len(generations), base_params, base_seed,
                        guess_mode, results_dir, unique_id, width, height,
                        scan_strictness, expected_content_cache,
                        generated_images, output_data,
                    )

        output_data["num_images_generated"] = len(output_data["images"])

        if output_data["num_images_generated"] == 0:
            raise RuntimeError("Failed to generate any images")

        if output_data["images"]:
            output_data["image"] = output_data["images"][0]
        if output_data["output_paths"]:
            output_data["output_path"] = output_data["output_paths"][0]

        logger.info("Successfully generated %s images", output_data["num_images_generated"])
        if output_data.get("image_urls"):
            for idx, url in enumerate(output_data["image_urls"], 1):
                logger.info("S3 URL %s: %s", idx, url)
        else:
            logger.warning("No S3 URLs generated (using base64 fallback)")

        return output_data


_model = None


def get_model():
    """Get or create the model instance.

    When running inside Flask the config is taken from ``current_app.config``
    and injected into the inference class so it never has to look it up itself.
    """
    global _model

    if _model is None:
        try:
            from flask import current_app
            cfg = current_app.config
            if hasattr(current_app, 'pipeline_manager') and current_app.pipeline_manager is not None:
                logger.info("Using PipelineManager from Flask app")
                _model = QRControlNetInference(pipeline_manager=current_app.pipeline_manager, config=cfg)
            elif hasattr(current_app, 'pipe') and current_app.pipe is not None:
                logger.info("Using pre-loaded pipeline from Flask app")
                _model = QRControlNetInference(pre_loaded_pipe=current_app.pipe, config=cfg)
            else:
                logger.info("No pre-loaded pipeline found, creating new instance")
                _model = QRControlNetInference(config=cfg)
        except (ImportError, RuntimeError):
            logger.info("Not in Flask context, creating new instance")
            _model = QRControlNetInference()

    return _model
