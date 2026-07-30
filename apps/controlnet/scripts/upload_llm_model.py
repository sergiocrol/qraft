#!/usr/bin/env python3
"""
Download the prompt-enhancer LLM (plan 009) from HuggingFace and upload to S3.
Usage: python scripts/upload_llm_model.py [<hf_model_id> <s3_key>]
Defaults: Qwen/Qwen2.5-1.5B-Instruct -> llm-models/qwen2.5-1.5b-instruct/
"""
import os
import subprocess
import sys
import tempfile

from huggingface_hub import snapshot_download

DEFAULT_HF_ID = "Qwen/Qwen2.5-1.5B-Instruct"
DEFAULT_S3_KEY = "qwen2.5-1.5b-instruct"

# Only what transformers needs at runtime (weights + tokenizer + configs);
# skips repo extras like original checkpoints or GGUF variants.
ALLOW_PATTERNS = [
    "*.safetensors",
    "*.safetensors.index.json",
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
]


def main():
    if len(sys.argv) not in (1, 3):
        print("Usage: python scripts/upload_llm_model.py [<hf_model_id> <s3_key>]", file=sys.stderr)
        sys.exit(1)

    hf_model_id = sys.argv[1] if len(sys.argv) == 3 else DEFAULT_HF_ID
    s3_key = sys.argv[2] if len(sys.argv) == 3 else DEFAULT_S3_KEY
    bucket = os.environ.get("MODEL_S3_BUCKET")
    if not bucket:
        print("Error: MODEL_S3_BUCKET environment variable is required", file=sys.stderr)
        sys.exit(1)
    prefix = os.environ.get("PROMPT_ENHANCER_S3_PREFIX", "llm-models")
    s3_uri = f"s3://{bucket}/{prefix}/{s3_key}/"

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"Downloading {hf_model_id} to {tmpdir}...")
        snapshot_download(
            hf_model_id,
            local_dir=tmpdir,
            allow_patterns=ALLOW_PATTERNS,
        )
        print(f"Uploading to {s3_uri}...")
        subprocess.run(
            ["aws", "s3", "sync", tmpdir, s3_uri, "--exclude", ".cache/*"],
            check=True,
        )
    print(f"Done. LLM at {s3_uri}")


if __name__ == "__main__":
    main()
