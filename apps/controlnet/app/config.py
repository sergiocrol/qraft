# app/config.py
import os
import torch

from .constants import (
    DEFAULT_AWS_REGION,
    DEFAULT_S3_BUCKET,
    DEFAULT_SAGEMAKER_ENDPOINT_NAME,
    DEFAULT_SAGEMAKER_STAGING_ENDPOINT_NAME,
)

class Config:
    """Application configuration (env-driven). For fixed defaults see app.constants."""
    # Debug mode
    DEBUG = os.environ.get('DEBUG', 'False') == 'True'
    
    # Logging level
    LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')
    
    # Model configurations
    MODEL = os.environ.get('MODEL', "emilianJR/epiCRealism")
    CONTROLNET_MODEL = os.environ.get('CONTROLNET_MODEL', "monster-labs/control_v1p_sd15_qrcode_monster")
    CONTROLNET_TWO_MODEL = os.environ.get('CONTROLNET_TWO_MODEL', "latentcat/control_v1p_sd15_brightness")
    
    # Device configuration
    DEVICE = os.environ.get('DEVICE', 'cuda' if torch.cuda.is_available() else 'cpu')
    
    # Offline mode - set to True when models are pre-downloaded in Docker image
    OFFLINE_MODE = os.environ.get('HF_HUB_OFFLINE', '0') == '1'
    
    # Cache directory for models (used in offline mode)
    MODEL_CACHE_DIR = os.environ.get('MODEL_CACHE_DIR', '/root/.cache/huggingface/hub')
    
    # Performance settings
    NUM_INFERENCE_STEPS = int(os.environ.get('NUM_INFERENCE_STEPS', 30))
    
    # Memory optimization settings
    ENABLE_CPU_OFFLOAD = os.environ.get('ENABLE_CPU_OFFLOAD', 'auto')  # 'auto', 'true', 'false'
    ENABLE_ATTENTION_SLICING = os.environ.get('ENABLE_ATTENTION_SLICING', 'False') == 'True'  # Disabled: conflicts with SDPA
    ENABLE_VAE_SLICING = os.environ.get('ENABLE_VAE_SLICING', 'True') == 'True'
    ENABLE_VAE_TILING = os.environ.get('ENABLE_VAE_TILING', 'True') == 'True'
    ENABLE_WARMUP = os.environ.get('ENABLE_WARMUP', 'True') == 'True'
    ENABLE_TORCH_COMPILE = os.environ.get('ENABLE_TORCH_COMPILE', 'False') == 'True'  # Experimental
    
    # Output settings
    RESULTS_DIR = os.environ.get('RESULTS_DIR', './results')
    
    # S3 model loading (staging: download base model from S3 instead of baking it in)
    ENABLE_S3_MODEL_LOADING = os.environ.get('ENABLE_S3_MODEL_LOADING', 'False') == 'True'
    MODEL_KEY = os.environ.get('MODEL_KEY', 'epicrealism')
    MODEL_S3_BUCKET = os.environ.get('MODEL_S3_BUCKET', DEFAULT_S3_BUCKET)
    MODEL_S3_PREFIX = os.environ.get('MODEL_S3_PREFIX', 'sd-models')
    
    # AWS (output bucket = generated images; MODEL_S3_BUCKET = model assets)
    AWS_REGION = os.environ.get('AWS_REGION', DEFAULT_AWS_REGION)
    AWS_S3_BUCKET = os.environ.get('AWS_S3_BUCKET', DEFAULT_S3_BUCKET)
    
    # WeChat QR decoder model files (plan 008 scan verification). NOTE:
    # app/utils/scan_verifier.py reads the env var directly (it must stay
    # importable without torch, which this module imports); this entry mirrors
    # it for log_config() visibility.
    WECHAT_MODEL_DIR = os.environ.get('WECHAT_MODEL_DIR', '/opt/program/wechat_models')

    # v2 repair ladder (plan 008 Phase 4). SCAN_REPAIR_BUDGET_S is the
    # wall-clock budget per image for the whole ladder (module blend ->
    # latent SRPG -> directed re-roll); rungs are skipped once it is spent.
    # V2_SRMPGD_ITERATIONS enables the optional SR-MPGD latent polish at the
    # end of the SRPG repair (0 = off, DiffQRCoder's own default).
    SCAN_REPAIR_BUDGET_S = float(os.environ.get('SCAN_REPAIR_BUDGET_S', '90'))
    V2_SRMPGD_ITERATIONS = int(os.environ.get('V2_SRMPGD_ITERATIONS', '0'))

    # v2 hires stage (plan 008 Phase 5): final img2img x1.5 upscale
    # (768 -> 1152) with both ControlNets at 0.8x the preset scales. When the
    # upscale breaks scanning, the verified 768 image ships instead and the
    # image's metadata carries `hires_dropped: true`.
    V2_HIRES = os.environ.get('V2_HIRES', 'True') == 'True'

    # Prompt enhancement (plan 009). PROMPT_ENHANCEMENT_ENABLED is the ops
    # kill-switch: when False the enhancer returns the original prompt
    # verbatim regardless of the request flag (and fresh instances never load
    # the LLM). Weights sync from MODEL_S3_BUCKET under
    # PROMPT_ENHANCER_S3_PREFIX/<key>/ when ENABLE_S3_MODEL_LOADING is on.
    PROMPT_ENHANCEMENT_ENABLED = os.environ.get('PROMPT_ENHANCEMENT_ENABLED', 'True') == 'True'
    PROMPT_ENHANCER_S3_PREFIX = os.environ.get('PROMPT_ENHANCER_S3_PREFIX', 'llm-models')
    PROMPT_ENHANCER_TIMEOUT_S = float(os.environ.get('PROMPT_ENHANCER_TIMEOUT_S', '4.0'))

    # SageMaker
    SAGEMAKER_ENDPOINT_NAME = os.environ.get('SAGEMAKER_ENDPOINT_NAME', DEFAULT_SAGEMAKER_ENDPOINT_NAME)
    SAGEMAKER_STAGING_ENDPOINT_NAME = os.environ.get('SAGEMAKER_STAGING_ENDPOINT_NAME', DEFAULT_SAGEMAKER_STAGING_ENDPOINT_NAME)
    SAGEMAKER_PROGRAM = os.environ.get('SAGEMAKER_PROGRAM', 'serve.py')
    SAGEMAKER_SUBMIT_DIRECTORY = os.environ.get('SAGEMAKER_SUBMIT_DIRECTORY', '/opt/program')
    
    # Admin API
    ADMIN_API_TOKEN = os.environ.get('ADMIN_API_TOKEN', '')

    @classmethod
    def validate_required(cls):
        """Warn loudly when security-critical env vars are missing in production."""
        from .utils.logging import get_logger
        logger = get_logger(__name__)
        missing = []
        if not cls.AWS_S3_BUCKET:
            missing.append('AWS_S3_BUCKET')
        if not cls.ADMIN_API_TOKEN:
            missing.append('ADMIN_API_TOKEN')
        if missing:
            logger.warning(
                "SECURITY: The following required env vars are NOT set: %s. "
                "Admin endpoints and/or S3 operations will not work.",
                ", ".join(missing),
            )
    
    _SENSITIVE_KEYS = frozenset({
        'ADMIN_API_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    })

    @classmethod
    def log_config(cls):
        """Log configuration for debugging (sensitive values are masked)."""
        from .utils.logging import get_logger
        logger = get_logger(__name__)
        logger.info("Configuration:")
        for key in sorted(dir(cls)):
            if key.isupper():
                value = getattr(cls, key)
                if key in cls._SENSITIVE_KEYS:
                    value = "****" if value else "(not set)"
                logger.info(f"  {key}: {value}")