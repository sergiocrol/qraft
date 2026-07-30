import os
import torch
import time
from diffusers import (
    ControlNetModel,
    StableDiffusionControlNetPipeline,
    StableDiffusionControlNetImg2ImgPipeline,
    DPMSolverMultistepScheduler,
)
from ..utils.logging import get_logger
from ..utils.model_downloader import download_model_from_s3, is_model_cached, MODEL_REGISTRY, get_model_hf_id
import platform
import numpy as np
from PIL import Image

logger = get_logger(__name__)


def _initialize_cuda():
    """Initialize CUDA properly if available"""
    if torch.cuda.is_available():
        try:
            torch.cuda.init()
            torch.cuda.empty_cache()

            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            torch.backends.cudnn.benchmark = True

            gpu_props = torch.cuda.get_device_properties(0)
            logger.info(f"CUDA initialized successfully")
            logger.info(f"GPU: {gpu_props.name}")
            logger.info(f"GPU Memory: {gpu_props.total_memory / 1024**3:.1f} GB")

            return True
        except Exception as e:
            logger.error(f"CUDA initialization failed: {e}")
            return False
    return False


def _warmup_pipeline(pipe, device):
    """Run a minimal inference to warm up the pipeline"""
    try:
        logger.info("Running warmup inference...")
        start_time = time.time()

        dummy_image = Image.fromarray(np.zeros((64, 64, 3), dtype=np.uint8))
        # At build time diffusers wraps a controlnet list into a
        # MultiControlNetModel (sub-nets under .nets), so isinstance(..., list)
        # is never true on a built pipeline and would undercount to 1 —
        # the warmup call is then rejected by the image-count check.
        controlnet = pipe.controlnet
        if hasattr(controlnet, "nets"):
            num_controls = len(controlnet.nets)
        elif isinstance(controlnet, (list, tuple)):
            num_controls = len(controlnet)
        else:
            num_controls = 1
        control_images = [dummy_image] * num_controls

        with torch.no_grad():
            _ = pipe(
                prompt="warmup",
                negative_prompt="",
                image=control_images,
                num_inference_steps=1,
                height=64,
                width=64,
                guidance_scale=1.0,
                controlnet_conditioning_scale=[0.1] * num_controls if num_controls > 1 else 0.1
            )

        if device == "cuda":
            torch.cuda.empty_cache()

        warmup_time = time.time() - start_time
        logger.info(f"Warmup completed successfully in {warmup_time:.2f} seconds")

    except Exception as e:
        logger.warning(f"Warmup failed (non-critical): {e}")


def _apply_optimizations(pipe, app):
    """Apply memory & performance optimizations to a pipeline"""
    if not app.config.get('ENABLE_ATTENTION_SLICING', False):
        logger.info("  SDPA attention active (PyTorch native)")
    else:
        pipe.enable_attention_slicing()

    if app.config.get('ENABLE_VAE_SLICING', True):
        pipe.enable_vae_slicing()

    if app.config.get('ENABLE_VAE_TILING', True):
        pipe.enable_vae_tiling()


class PipelineManager:
    """Manages multiple SD base-model pipelines sharing the same ControlNet models.

    On startup only ControlNet models are loaded. Base-model pipelines are built
    lazily when first requested and cached in memory. When S3 model loading is
    enabled, the base model weights are downloaded from S3 on first use.

    On a ml.g5.xlarge (24 GB VRAM) a single SD1.5 pipeline uses ~3-4 GB.
    Two cached pipelines fit comfortably; three is tight. The manager keeps
    a simple LRU eviction: when a third model is requested it unloads the
    least-recently-used pipeline.
    """

    MAX_CACHED_PIPELINES = 2

    def __init__(self, controlnet_list, device, torch_dtype, common_args, app):
        self.controlnet_list = controlnet_list
        self.device = device
        self.torch_dtype = torch_dtype
        self.common_args = common_args
        self.app = app
        self.s3_model_loading = app.config.get('ENABLE_S3_MODEL_LOADING', False)

        # model_key -> pipeline
        self._cache: dict[str, StableDiffusionControlNetPipeline] = {}
        # ordered list of model keys, most-recently-used last
        self._lru: list[str] = []
        # model_key -> img2img wrapper sharing the cached pipeline's modules
        # (plan 008). Wrappers hold no weights of their own, so they neither
        # count against MAX_CACHED_PIPELINES nor participate in the LRU; they
        # are dropped together with their base pipeline on eviction.
        self._img2img_cache: dict[str, StableDiffusionControlNetImg2ImgPipeline] = {}

    @property
    def current_model_key(self):
        """The most recently used model key, or None."""
        return self._lru[-1] if self._lru else None

    def get_pipeline(self, model_key: str | None = None) -> StableDiffusionControlNetPipeline:
        """Return a pipeline for the given model key, loading it if necessary."""
        if not model_key:
            model_key = self.app.config.get('MODEL_KEY', 'epicrealism')

        # Normalise
        model_key = model_key.lower().strip()

        # Cache hit
        if model_key in self._cache:
            logger.info(f"Pipeline cache hit for '{model_key}'")
            self._touch_lru(model_key)
            return self._cache[model_key]

        # Cache miss — build a new pipeline
        logger.info(f"Pipeline cache miss for '{model_key}', loading...")
        pipe = self._build_pipeline(model_key)
        self._cache[model_key] = pipe
        self._touch_lru(model_key)

        # Evict if we're over the limit
        while len(self._cache) > self.MAX_CACHED_PIPELINES:
            self._evict_oldest()

        return pipe

    def get_img2img_pipeline(self, model_key: str | None = None) -> StableDiffusionControlNetImg2ImgPipeline:
        """img2img pipeline for *model_key*, sharing the txt2img components.

        Built lazily from the cached txt2img pipeline's already-loaded
        modules (``**pipe.components`` — which already includes
        ``controlnet``, so it must not be passed again), so VRAM is shared,
        not doubled. Used by the plan-008 repair ladder (latent SRPG rung)
        and the v2 hires stage.
        """
        base = self.get_pipeline(model_key)  # normalizes the key + LRU touch
        key = self.current_model_key

        wrapper = self._img2img_cache.get(key)
        if wrapper is None:
            logger.info(f"Building img2img wrapper for '{key}' (shared components)")
            wrapper = StableDiffusionControlNetImg2ImgPipeline(
                **base.components,
                requires_safety_checker=False,
            )
            self._img2img_cache[key] = wrapper

        # generate() swaps the base scheduler per request; keep in lockstep.
        # Requests are sequential (max 1 concurrent invocation), so sharing
        # the scheduler instance is safe — every pipeline call re-seeds it
        # via set_timesteps().
        wrapper.scheduler = base.scheduler
        return wrapper

    def _resolve_hf_id(self, model_key: str) -> str:
        """Resolve model_key to a HuggingFace model ID, downloading from S3 if needed.

        A model that is registered but whose weights were never uploaded to S3
        falls back to the default model instead of failing the whole request
        (only the default's prefix is guaranteed to exist). The fallback is
        logged so operators can see a requested model was substituted.
        """
        default_key = self.app.config.get('MODEL_KEY', 'epicrealism')

        if model_key in MODEL_REGISTRY:
            if not self.s3_model_loading:
                return get_model_hf_id(model_key)
            try:
                return download_model_from_s3(model_key)
            except (FileNotFoundError, ValueError) as e:
                if model_key == default_key:
                    raise  # the default itself is missing — nothing to fall back to
                logger.warning(
                    "Model '%s' unavailable in S3 (%s); falling back to default '%s'",
                    model_key, e, default_key,
                )
                return download_model_from_s3(default_key)

        logger.warning(f"Unknown model_key '{model_key}', falling back to '{default_key}'")
        if self.s3_model_loading:
            return download_model_from_s3(default_key)
        return get_model_hf_id(default_key)

    def _build_pipeline(self, model_key: str) -> StableDiffusionControlNetPipeline:
        hf_id = self._resolve_hf_id(model_key)
        logger.info(f"Building pipeline for '{model_key}' ({hf_id})...")
        build_start = time.time()

        # Base models downloaded from S3 might have .bin weights (not safetensors),
        # so we don't force use_safetensors for the pipeline load.
        pipeline_args = {**self.common_args}
        pipeline_args.pop('use_safetensors', None)

        pipe = StableDiffusionControlNetPipeline.from_pretrained(
            hf_id,
            controlnet=self.controlnet_list,
            safety_checker=None,
            requires_safety_checker=False,
            **pipeline_args
        )

        pipe = pipe.to(self.device)

        scheduler = DPMSolverMultistepScheduler.from_pretrained(
            hf_id,
            subfolder="scheduler",
            use_karras_sigmas=True,
            thresholding=False,
            algorithm_type="dpmsolver++",
            solver_type="midpoint",
            solver_order=2,
            lower_order_final=True,
        )
        pipe.scheduler = scheduler

        _apply_optimizations(pipe, self.app)

        elapsed = time.time() - build_start
        logger.info(f"Pipeline for '{model_key}' ready in {elapsed:.1f}s")

        if self.device == "cuda":
            allocated = torch.cuda.memory_allocated(0) / 1024**3
            reserved = torch.cuda.memory_reserved(0) / 1024**3
            logger.info(f"GPU memory: {allocated:.1f} GB allocated, {reserved:.1f} GB reserved")

        return pipe

    def _touch_lru(self, model_key: str):
        if model_key in self._lru:
            self._lru.remove(model_key)
        self._lru.append(model_key)

    def _evict_oldest(self):
        if not self._lru:
            return
        oldest = self._lru.pop(0)
        self._img2img_cache.pop(oldest, None)  # wrapper dies with its base
        pipe = self._cache.pop(oldest, None)
        if pipe is not None:
            logger.info(f"Evicting pipeline for '{oldest}' to free memory")
            del pipe
            if self.device == "cuda":
                torch.cuda.empty_cache()


def init_models(app):
    """Initialize ControlNet models and return a PipelineManager.

    ControlNet models are loaded once (shared by all base models).
    The default base model pipeline is built eagerly so the first
    request is fast. Additional base models are loaded on demand.
    """
    logger.info("=" * 50)
    logger.info("Starting model initialization...")
    logger.info("=" * 50)

    start_time = time.time()

    offline_mode = os.environ.get('HF_HUB_OFFLINE', '0') == '1'
    logger.info(f"Offline mode: {offline_mode}")

    device_preference = os.environ.get('DEVICE', 'cuda')
    logger.info(f"DEVICE: {device_preference}")

    cuda_available = False
    if device_preference != 'cpu':
        cuda_available = _initialize_cuda()

    if device_preference == 'cpu':
        device = "cpu"
        torch_dtype = torch.float32
        logger.info("Using CPU as per environment preference")
    elif device_preference == 'cuda' and cuda_available:
        device = "cuda"
        torch_dtype = torch.float16
        logger.info("Using CUDA with float16 precision")
    else:
        device = "cpu"
        torch_dtype = torch.float32
        logger.warning("Falling back to CPU")

    app.config['DEVICE'] = device
    logger.info(f"Platform: {platform.platform()}")

    try:
        qr_model = app.config['CONTROLNET_MODEL']
        brightness_model = app.config['CONTROLNET_TWO_MODEL']

        logger.info(f"QR ControlNet: {qr_model}")
        logger.info(f"Brightness ControlNet: {brightness_model}")

        s3_model_loading = app.config.get('ENABLE_S3_MODEL_LOADING', False)
        use_local_files = offline_mode or s3_model_loading

        # NOTE: 'resume_download' was removed here for diffusers 0.32 /
        # huggingface_hub >= 0.26 (deprecated kwarg; downloads always resume).
        common_args = {
            'torch_dtype': torch_dtype,
            'use_safetensors': True,
            'local_files_only': use_local_files,
        }

        if use_local_files:
            common_args['cache_dir'] = '/root/.cache/huggingface/hub'

        logger.info("Loading QR ControlNet model...")
        controlnet = None
        qr_load_time = time.time()

        try:
            controlnet = ControlNetModel.from_pretrained(
                qr_model, subfolder="v2", **common_args
            )
            logger.info(f"QR ControlNet loaded (with subfolder) in {time.time() - qr_load_time:.2f}s")
        except Exception as e:
            logger.warning(f"Failed with subfolder, trying without: {str(e)}")
            try:
                controlnet = ControlNetModel.from_pretrained(qr_model, **common_args)
                logger.info(f"QR ControlNet loaded (without subfolder) in {time.time() - qr_load_time:.2f}s")
            except Exception as e2:
                logger.error(f"Failed to load QR ControlNet: {str(e2)}")
                raise RuntimeError("Failed to load QR ControlNet model")

        logger.info("Loading Brightness ControlNet model...")
        controlnet_two = None
        brightness_load_time = time.time()

        try:
            controlnet_two = ControlNetModel.from_pretrained(brightness_model, **common_args)
            logger.info(f"Brightness ControlNet loaded in {time.time() - brightness_load_time:.2f}s")
            controlnet_list = [controlnet, controlnet_two]
        except Exception as e:
            logger.warning(f"Failed to load Brightness ControlNet: {str(e)}")
            logger.warning("Proceeding with QR ControlNet only")
            controlnet_list = [controlnet]

        manager = PipelineManager(
            controlnet_list=controlnet_list,
            device=device,
            torch_dtype=torch_dtype,
            common_args=common_args,
            app=app,
        )

        default_key = app.config.get('MODEL_KEY', 'epicrealism')
        logger.info(f"Pre-loading default base model: '{default_key}'")
        default_pipe = manager.get_pipeline(default_key)

        if app.config.get('ENABLE_WARMUP', True):
            _warmup_pipeline(default_pipe, device)
        else:
            logger.info("Warmup skipped (ENABLE_WARMUP=False)")

        total_time = time.time() - start_time
        logger.info("=" * 50)
        logger.info(f"Model initialization completed in {total_time:.2f} seconds")
        logger.info("=" * 50)

        return manager

    except Exception as e:
        logger.error(f"Error initializing models: {str(e)}")
        logger.error(f"Make sure models are pre-downloaded if running in offline mode")
        raise RuntimeError(f"Failed to initialize models: {str(e)}")
