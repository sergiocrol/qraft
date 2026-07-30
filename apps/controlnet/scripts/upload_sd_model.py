#!/usr/bin/env python3
"""
Download a Stable Diffusion model from HuggingFace and upload to S3.
Usage: python scripts/upload_sd_model.py <hf_model_id> <s3_key>
Example: python scripts/upload_sd_model.py digiplay/GhostMixV1.2VAE ghostmix
"""
import os
import subprocess
import sys
import tempfile

import torch
from diffusers import StableDiffusionPipeline


def main():
    if len(sys.argv) != 3:
        print("Usage: python scripts/upload_sd_model.py <hf_model_id> <s3_key>", file=sys.stderr)
        print("Example: python scripts/upload_sd_model.py digiplay/GhostMixV1.2VAE ghostmix", file=sys.stderr)
        sys.exit(1)

    hf_model_id = sys.argv[1]
    s3_key = sys.argv[2]
    bucket = os.environ.get("MODEL_S3_BUCKET")
    if not bucket:
        print("Error: MODEL_S3_BUCKET environment variable is required", file=sys.stderr)
        sys.exit(1)
    prefix = os.environ.get("MODEL_S3_PREFIX", "sd-models")
    s3_uri = f"s3://{bucket}/{prefix}/{s3_key}/"

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"Downloading {hf_model_id} to {tmpdir}...")
        try:
            pipe = StableDiffusionPipeline.from_pretrained(
                hf_model_id,
                torch_dtype=torch.float16,
                safety_checker=None,
                requires_safety_checker=False,
            )
        except (OSError, EnvironmentError):
            print("Safetensors not found, falling back to .bin weights...")
            pipe = StableDiffusionPipeline.from_pretrained(
                hf_model_id,
                torch_dtype=torch.float16,
                safety_checker=None,
                requires_safety_checker=False,
                use_safetensors=False,
            )
        pipe.save_pretrained(tmpdir)
        print(f"Uploading to {s3_uri}...")
        subprocess.run(
            [
                "aws", "s3", "sync", tmpdir, s3_uri,
                "--exclude", "*.msgpack",
                "--exclude", "*.h5",
                "--exclude", "*.ckpt",
            ],
            check=True,
        )
    print(f"Done. Model at {s3_uri}")


if __name__ == "__main__":
    main()
