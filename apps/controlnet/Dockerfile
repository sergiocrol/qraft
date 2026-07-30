# ControlNet QR Generator
# ControlNet models are baked into the image (they're shared across all base models).
# Base SD models are downloaded from S3 at startup, allowing runtime model switching
# without rebuilding the image. Set MODEL_KEY env var to pick the default base model.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel as builder

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libgl1-mesa-glx \
    build-essential \
    ninja-build \
    git \
    git-lfs \
    curl \
    && rm -rf /var/lib/apt/lists/* && \
    git lfs install

# Set CUDA environment variables
ENV CUDA_HOME=/usr/local/cuda
ENV PATH=${CUDA_HOME}/bin:${PATH}
ENV LD_LIBRARY_PATH=${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}

# Set up directories expected by SageMaker
RUN mkdir -p /opt/ml/model \
    /opt/ml/input/data \
    /opt/ml/model/code \
    /opt/ml/output \
    /opt/program

# Set the working directory
WORKDIR /opt/program

# Copy requirements and install dependencies
COPY requirements.txt /opt/program/
RUN pip install --no-cache-dir -r requirements.txt

# ControlNet model args (shared by all base models, so we bake them in)
ARG CONTROLNET_MODEL_ARG="monster-labs/control_v1p_sd15_qrcode_monster"
ARG CONTROLNET_TWO_MODEL_ARG="latentcat/control_v1p_sd15_brightness"
ARG RESULTS_DIR_ARG=""

ENV CONTROLNET_MODEL=${CONTROLNET_MODEL_ARG} \
    CONTROLNET_TWO_MODEL=${CONTROLNET_TWO_MODEL_ARG} \
    TRANSFORMERS_CACHE=/root/.cache/huggingface/hub \
    HF_HOME=/root/.cache/huggingface

# Create cache directory
RUN mkdir -p /root/.cache/huggingface/hub

# Download ControlNet models only (base SD model comes from S3 at startup)
RUN echo "Downloading ControlNet model 1..." && \
    python -c "from diffusers import ControlNetModel; import torch; import os; \
    ControlNetModel.from_pretrained(os.environ['CONTROLNET_MODEL'], \
    torch_dtype=torch.float16, use_safetensors=True)"

RUN echo "Downloading ControlNet model 2..." && \
    python -c "from diffusers import ControlNetModel; import torch; import os; \
    ControlNetModel.from_pretrained(os.environ['CONTROLNET_TWO_MODEL'], \
    torch_dtype=torch.float16, use_safetensors=True)"

# Verify downloads and show cache size
RUN echo "ControlNet model downloads complete. Cache size:" && \
    du -sh /root/.cache/huggingface/hub/

# Remove unnecessary files to reduce image size
RUN find /root/.cache/huggingface -name "*.msgpack" -delete && \
    find /root/.cache/huggingface -name "*.h5" -delete && \
    find /root/.cache/huggingface -name "*.ckpt" -delete 2>/dev/null || true

# WeChat QR detector/super-resolution models for in-container scan
# verification (plan 008, app/utils/scan_verifier.py). Pinned to a commit of
# github.com/WeChatCV/opencv_3rdparty (branch wechat_qrcode) so builds are
# reproducible. Location is overridable at runtime via WECHAT_MODEL_DIR.
ARG WECHAT_MODELS_COMMIT=3487ef7cde71d93c6a01bb0b84aa0f22c6128f6b
RUN mkdir -p /opt/program/wechat_models && \
    cd /opt/program/wechat_models && \
    for f in detect.prototxt detect.caffemodel sr.prototxt sr.caffemodel; do \
        curl -fsSL -o "$f" \
        "https://raw.githubusercontent.com/WeChatCV/opencv_3rdparty/${WECHAT_MODELS_COMMIT}/$f"; \
    done && \
    ls -la /opt/program/wechat_models

# Copy the QR code templates
COPY app/qrs /opt/program/qrs

# Copy the application code
COPY . /opt/program/

# Create a symlink to ensure code is accessible via both paths
RUN ln -s /opt/program /opt/ml/model/code

# Port used by the SageMaker container
EXPOSE 8080

# Environment variables
# NOTE: No HF_HUB_OFFLINE=1 — we need network access for S3 model downloads
ARG MODEL_KEY_ARG="epicrealism"

ENV MODEL=${MODEL_KEY_ARG} \
    MODEL_KEY=${MODEL_KEY_ARG} \
    CONTROLNET_MODEL=${CONTROLNET_MODEL_ARG} \
    CONTROLNET_TWO_MODEL=${CONTROLNET_TWO_MODEL_ARG} \
    RESULTS_DIR=${RESULTS_DIR_ARG} \
    NVIDIA_VISIBLE_DEVICES=all  \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    PYTHONUNBUFFERED=TRUE \
    PYTHONDONTWRITEBYTECODE=TRUE \
    PATH="/opt/program:${PATH}" \
    ENABLE_S3_MODEL_LOADING=True \
    WECHAT_MODEL_DIR=/opt/program/wechat_models

# Command to run when container starts
ENTRYPOINT ["python", "-m", "serve"]
