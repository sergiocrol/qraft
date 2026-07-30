"""
S3 based model downloader for dynamic base model loading

Instead of baking every SD1.5 base model into the Docker image (~2-4 GB each),
this module downloads the requested model from S3 into the HuggingFace cache
at container startup. ControlNet models are still baked in (they never change).

S3 layout expected:
    s3://{bucket}/sd-models/{model_key}/   (e.g. sd-models/ghostmix/)
        model_index.json
        unet/
        vae/
        text_encoder/
        tokenizer/
        scheduler/
        ...
"""

import os
import shutil
import time

import boto3
from botocore.config import Config as BotoConfig

from .logging import get_logger

# Use Config for env-driven defaults (single source for env var names)
try:
    from ..config import Config
    _DEFAULT_BUCKET = Config.MODEL_S3_BUCKET
    _DEFAULT_PREFIX = Config.MODEL_S3_PREFIX
    _DEFAULT_CACHE = Config.MODEL_CACHE_DIR
    _DEFAULT_REGION = Config.AWS_REGION
except ImportError:
    _DEFAULT_BUCKET = os.environ.get("MODEL_S3_BUCKET", "")
    _DEFAULT_PREFIX = os.environ.get("MODEL_S3_PREFIX", "sd-models")
    _DEFAULT_CACHE = os.environ.get("MODEL_CACHE_DIR", "/root/.cache/huggingface/hub")
    _DEFAULT_REGION = os.environ.get("AWS_REGION", "eu-west-1")

logger = get_logger(__name__)


MODEL_REGISTRY = {
    "ghostmix": {
        "hf_id": "digiplay/GhostMixV1.2VAE",
        "s3_key": "ghostmix",
        "description": "High quality mixed model for diverse artistic styles",
    },
    "dreamshaper": {
        "hf_id": "Lykon/DreamShaper",
        "s3_key": "dreamshaper",
        "description": "Stable Diffusion model optimized for artistic content",
    },
    "realistic_vision": {
        "hf_id": "SG161222/Realistic_Vision_V5.1_noVAE",
        "s3_key": "realistic_vision",
        "description": "Photorealistic model with high detail",
    },
    "rev_animated": {
        "hf_id": "stablediffusionapi/rev-animated",
        "s3_key": "rev_animated",
        "description": "Anime/illustration style with vivid colors",
    },
    "epicrealism": {
        "hf_id": "emilianJR/epiCRealism",
        "s3_key": "epicrealism",
        "description": "Hyper-realistic generation model",
    },
    "anything_v5": {
        "hf_id": "stablediffusionapi/anything-v5",
        "s3_key": "anything_v5",
        "description": "Anime/illustration style with vivid colors",
    },
    "meinamix": {
        "hf_id": "stablediffusionapi/meinamixv11",
        "s3_key": "meinamix",
        "description": "Colorful detailed compositions, artistic style",
    },
    "absolute_reality": {
        "hf_id": "digiplay/AbsoluteReality_v1.8.1",
        "s3_key": "absolute_reality",
        "description": "Sharp detail with vivid colors, artistic-realistic blend",
    },
    "cyberrealistic": {
        "hf_id": "stablediffusionapi/cyberrealistic-v32",
        "s3_key": "cyberrealistic",
        "description": "Great for cyberpunk/sci-fi themed generations",
    },
}


def _s3_client():
    region = os.environ.get("AWS_REGION", _DEFAULT_REGION)
    return boto3.client(
        "s3",
        region_name=region,
        config=BotoConfig(max_pool_connections=20),
    )


def _hf_cache_dir_for_model(hf_id: str, cache_root: str = _DEFAULT_CACHE) -> str:
    """Return the local directory where HuggingFace would cache a model
    
    HF cache layout: models--{org}--{name}/ with snapshot dirs inside.
    We store the raw model files directly in a `refs/main` snapshot structure
    so that `from_pretrained(..., local_files_only=True)` can find them.
    """
    safe_name = hf_id.replace("/", "--")
    return os.path.join(cache_root, f"models--{safe_name}")


def is_model_cached(model_key: str, cache_root: str = _DEFAULT_CACHE) -> bool:
    """Check if a model is already present in the local HF cache."""
    entry = MODEL_REGISTRY.get(model_key)
    if not entry:
        return False
    cache_dir = _hf_cache_dir_for_model(entry["hf_id"], cache_root)
    if not os.path.isdir(cache_dir):
        return False
    snapshots_dir = os.path.join(cache_dir, "snapshots")
    if not os.path.isdir(snapshots_dir):
        return False
    snapshots = os.listdir(snapshots_dir)
    if not snapshots:
        return False
    snapshot_path = os.path.join(snapshots_dir, snapshots[0])
    return os.path.isfile(os.path.join(snapshot_path, "model_index.json"))


def _sync_s3_prefix_to_hf_cache(
    hf_id: str,
    bucket: str,
    s3_prefix: str,
    cache_root: str,
    sentinel: str,
    label: str,
) -> None:
    """Download every object under an S3 prefix into an HF-cache snapshot dir.

    Builds the `models--org--name/snapshots/s3download` layout that
    `from_pretrained(..., local_files_only=True)` expects. `sentinel` is the
    file that must exist after the sync (model_index.json for diffusers
    pipelines, config.json for transformers models): an empty or incomplete
    S3 prefix downloads "successfully" without it, which later makes
    from_pretrained() fail with a confusing HF-hub error — detect it here,
    tear down the half-built cache entry so it can't poison a retry or a
    local_files_only load, and raise so the caller can fall back.
    """
    cache_dir = _hf_cache_dir_for_model(hf_id, cache_root)

    snapshot_hash = "s3download"
    snapshot_dir = os.path.join(cache_dir, "snapshots", snapshot_hash)
    refs_dir = os.path.join(cache_dir, "refs")

    os.makedirs(snapshot_dir, exist_ok=True)
    os.makedirs(refs_dir, exist_ok=True)

    with open(os.path.join(refs_dir, "main"), "w") as f:
        f.write(snapshot_hash)

    client = _s3_client()

    logger.info(f"Downloading {label} from s3://{bucket}/{s3_prefix} ...")
    start = time.time()
    total_bytes = 0
    file_count = 0

    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=s3_prefix):
        for obj in page.get("Contents", []):
            s3_key = obj["Key"]
            relative = s3_key[len(s3_prefix):]
            if not relative or relative.endswith("/"):
                continue

            local_path = os.path.join(snapshot_dir, relative)
            os.makedirs(os.path.dirname(local_path), exist_ok=True)

            client.download_file(bucket, s3_key, local_path)
            total_bytes += obj["Size"]
            file_count += 1

            if file_count % 20 == 0:
                logger.info(f"  ... downloaded {file_count} files ({total_bytes / 1024**2:.0f} MB)")

    elapsed = time.time() - start
    logger.info(
        f"{label} downloaded: {file_count} files, "
        f"{total_bytes / 1024**3:.2f} GB in {elapsed:.1f}s "
        f"({total_bytes / 1024**2 / max(elapsed, 1e-6):.1f} MB/s)"
    )

    if not os.path.isfile(os.path.join(snapshot_dir, sentinel)):
        shutil.rmtree(cache_dir, ignore_errors=True)
        raise FileNotFoundError(
            f"{label} has no usable weights at "
            f"s3://{bucket}/{s3_prefix} ({file_count} files, no {sentinel})"
        )


def download_model_from_s3(
    model_key: str,
    bucket: str = _DEFAULT_BUCKET,
    prefix: str = _DEFAULT_PREFIX,
    cache_root: str = _DEFAULT_CACHE,
) -> str:
    """Download a base model from S3 into the HF cache

    Returns the HF model ID that can be passed to from_pretrained()
    """
    entry = MODEL_REGISTRY.get(model_key)
    if not entry:
        raise ValueError(
            f"Unknown model '{model_key}'. Available: {list(MODEL_REGISTRY.keys())}"
        )

    hf_id = entry["hf_id"]

    if is_model_cached(model_key, cache_root):
        logger.info(f"Model '{model_key}' ({hf_id}) already cached locally, skipping download")
        return hf_id

    _sync_s3_prefix_to_hf_cache(
        hf_id,
        bucket,
        f"{prefix}/{entry['s3_key']}/",
        cache_root,
        sentinel="model_index.json",
        label=f"Model '{model_key}'",
    )

    return hf_id


def is_llm_cached(hf_id: str, cache_root: str = _DEFAULT_CACHE) -> bool:
    """Check if a transformers LLM is already present in the local HF cache."""
    cache_dir = _hf_cache_dir_for_model(hf_id, cache_root)
    snapshots_dir = os.path.join(cache_dir, "snapshots")
    if not os.path.isdir(snapshots_dir):
        return False
    snapshots = os.listdir(snapshots_dir)
    if not snapshots:
        return False
    return os.path.isfile(os.path.join(snapshots_dir, snapshots[0], "config.json"))


def download_llm_from_s3(
    hf_id: str,
    s3_key: str,
    bucket: str = _DEFAULT_BUCKET,
    prefix: str = "llm-models",
    cache_root: str = _DEFAULT_CACHE,
) -> str:
    """Download a transformers LLM (plan 009 prompt enhancer) from S3 into
    the HF cache. Sentinel is config.json (transformers layout, not the
    diffusers model_index.json). Returns the HF model ID for from_pretrained().
    """
    if is_llm_cached(hf_id, cache_root):
        logger.info(f"LLM '{hf_id}' already cached locally, skipping download")
        return hf_id

    _sync_s3_prefix_to_hf_cache(
        hf_id,
        bucket,
        f"{prefix}/{s3_key}/",
        cache_root,
        sentinel="config.json",
        label=f"LLM '{hf_id}'",
    )

    return hf_id


def get_model_hf_id(model_key: str) -> str:
    """Return the HF model ID for a given model key"""
    entry = MODEL_REGISTRY.get(model_key)
    if not entry:
        raise ValueError(
            f"Unknown model '{model_key}'. Available: {list(MODEL_REGISTRY.keys())}"
        )
    return entry["hf_id"]


def list_available_models() -> dict:
    """Return the full model registry (useful for health/info endpoints)."""
    return {
        key: {
            "hf_id": val["hf_id"],
            "description": val["description"],
        }
        for key, val in MODEL_REGISTRY.items()
    }
