#!/usr/bin/env python3
import os
import sys
import logging
import torch
import time

# Configure logging before anything else (process-level setup)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
from app.utils.logging import get_logger
logger = get_logger(__name__)

# Log system information
logger.info("="*60)
logger.info("Starting SageMaker Inference Container")
logger.info("="*60)
logger.info(f"Python version: {sys.version}")
logger.info(f"PyTorch version: {torch.__version__}")
logger.info(f"CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    logger.info(f"CUDA version: {torch.version.cuda}")
    logger.info(f"GPU count: {torch.cuda.device_count()}")
    for i in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(i)
        logger.info(f"GPU {i}: {props.name} ({props.total_memory / 1024**3:.1f} GB)")

# Environment information
logger.info("Environment variables:")
for key in ['MODEL', 'CONTROLNET_MODEL', 'CONTROLNET_TWO_MODEL', 'DEVICE', 
            'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE']:
    logger.info(f"  {key}: {os.environ.get(key, 'not set')}")

# Pre-initialize CUDA if available to avoid lazy loading during first inference
if torch.cuda.is_available() and os.environ.get('DEVICE', 'cuda') != 'cpu':
    logger.info("Pre-initializing CUDA...")
    try:
        torch.cuda.init()
        # Allocate a small tensor to ensure CUDA is fully initialized
        dummy = torch.zeros(1, device='cuda')
        del dummy
        torch.cuda.empty_cache()
        logger.info("✓ CUDA pre-initialized successfully")
    except Exception as e:
        logger.error(f"✗ CUDA pre-initialization failed: {e}")

# Import Flask app
logger.info("Importing Flask application...")
app_start_time = time.time()

try:
    from app import create_app
    
    # Create the Flask app - this will also initialize models
    logger.info("Creating Flask app and loading models...")
    app = create_app()
    
    app_load_time = time.time() - app_start_time
    logger.info(f"✓ Flask app created and models loaded in {app_load_time:.2f} seconds")
    
    if torch.cuda.is_available():
        for i in range(torch.cuda.device_count()):
            allocated = torch.cuda.memory_allocated(i) / 1024**3
            reserved = torch.cuda.memory_reserved(i) / 1024**3
            logger.info(f"GPU {i} memory: {allocated:.1f} GB allocated, {reserved:.1f} GB reserved")
    
except Exception as e:
    logger.error(f"✗ Failed to create Flask app: {e}")
    import traceback
    logger.error(traceback.format_exc())

    logger.info("Creating minimal Flask app for health checks...")
    from flask import Flask, Response
    import json
    
    app = Flask(__name__)
    
    init_error = str(e)

    @app.route('/ping', methods=['GET'])
    def ping():
        return Response(
            response=json.dumps({"status": "unhealthy", "error": init_error}),
            status=503,
            mimetype='application/json'
        )

logger.info("="*60)
logger.info("Container initialization complete")
logger.info("="*60)

if __name__ == "__main__":
    port = int(os.environ.get('PORT', 8080))
    logger.info(f"Starting Flask server on port {port}...")
    app.run(host="0.0.0.0", port=port, debug=False)