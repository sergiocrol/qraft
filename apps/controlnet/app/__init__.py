from flask import Flask, request, jsonify, Response
from marshmallow import ValidationError
import json
import time
from .services import inference
from .config import Config
from .utils.logging import get_logger
from .schemas.generate import InvocationRequestSchema
from .models.controlnet import init_models

logger = get_logger(__name__)

def create_app(config_class=Config):
    """Create and configure the Flask application"""
    app = Flask(__name__)
    app.config.from_object(config_class)
    
    if hasattr(config_class, 'validate_required'):
        config_class.validate_required()
    if hasattr(config_class, 'log_config'):
        config_class.log_config()
    
    logger.info("Initializing models in Flask app context...")
    init_start = time.time()
    
    with app.app_context():
        try:
            app.pipeline_manager = init_models(app)
            app.pipe = app.pipeline_manager.get_pipeline()
            logger.info(f"✓ Models initialized in app context in {time.time() - init_start:.2f}s")
        except Exception as e:
            logger.error(f"✗ Failed to initialize models: {e}")
            app.pipeline_manager = None
            app.pipe = None
    
    # Pre-warm the prompt-enhancer LLM (plan 009) in a daemon thread so the
    # ~30-60s first load hides inside the 3-4 min endpoint wake. Does not
    # touch /ping readiness; prewarm() never raises.
    if app.config.get('PROMPT_ENHANCEMENT_ENABLED'):
        import threading
        from .services.prompt_enhancer import get_enhancer
        threading.Thread(
            target=get_enhancer(app.config).prewarm,
            name="prompt-enhancer-prewarm",
            daemon=True,
        ).start()

    # Register blueprints
    from .routes.sagemaker import sagemaker_bp
    app.register_blueprint(sagemaker_bp)
    
    @app.route("/ping", methods=['GET'])
    def ping():
        """Container-level health check for SageMaker.

        SageMaker calls GET /ping to determine if the inference container is
        ready to accept traffic.  This checks whether the ML model pipeline
        is loaded and responsive.

        This is distinct from /api/endpoint/health (served by apps/api),
        which reports the health of the endpoint-status API service itself.
        """
        try:
            model_loaded = app.pipe is not None
            model = inference.get_model()
            
            if model_loaded and model is not None:
                return Response(
                    response=json.dumps({"status": "healthy", "model_loaded": True}), 
                    status=200,
                    mimetype='application/json'
                )
            else:
                return Response(
                    response=json.dumps({"status": "unhealthy", "model_loaded": False}), 
                    status=503,
                    mimetype='application/json'
                )
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            return Response(
                response=json.dumps({"status": "unhealthy", "error": str(e)}), 
                status=503,
                mimetype='application/json'
            )
    
    _invocation_schema = InvocationRequestSchema()

    @app.route('/invocations', methods=['POST'])
    def invoke():
        """SageMaker inference endpoint.

        Validates the JSON payload via InvocationRequestSchema (string-or-list
        base_qr_code, defaults from app.constants) and delegates to
        ``model.generate()``.
        """
        inference_start = time.time()

        try:
            if request.content_type != 'application/json':
                return Response(
                    response=json.dumps({"error": "Unsupported content type"}),
                    status=415,
                    mimetype='application/json'
                )

            raw = request.get_json()
            if not raw:
                return Response(
                    response=json.dumps({"error": "Invalid JSON data"}),
                    status=400,
                    mimetype='application/json'
                )

            try:
                data = _invocation_schema.load(raw)
            except ValidationError as ve:
                return Response(
                    response=json.dumps({"error": ve.messages}),
                    status=400,
                    mimetype='application/json'
                )

            logger.info(f"Received inference request with prompt: {data['prompt'][:50]}...")

            model = inference.get_model()

            if model is None:
                return Response(
                    response=json.dumps({"error": "Model not initialized"}),
                    status=503,
                    mimetype='application/json'
                )

            logger.info(
                f"Inference parameters: {len(data['base_qr_code'])} QR codes, "
                f"{data['num_images_per_prompt']} images requested"
            )

            generation_start = time.time()
            result = model.generate(
                prompt=data['prompt'],
                base_qr_code=data['base_qr_code'],
                num_images_per_prompt=data['num_images_per_prompt'],
                negative_prompt=data['negative_prompt'],
                num_inference_steps=data['num_inference_steps'],
                controlnet_conditioning_scale=data['controlnet_conditioning_scale'],
                control_guidance_start=data.get('control_guidance_start'),
                control_guidance_end=data.get('control_guidance_end'),
                height=data['height'],
                width=data['width'],
                sampler=data['sampler'],
                guidance_scale=data['guidance_scale'],
                model=data.get('model'),
                seed=data.get('seed'),
                guess_mode=data.get('guess_mode', False),
                prompt_enhancement=data.get('prompt_enhancement', False),
                # v2-pipeline fields (plan 008); the schema defaults keep
                # absent fields on the exact v1 path.
                pipeline=data.get('pipeline'),
                qr_content=data.get('qr_content'),
                style_preset=data.get('style_preset'),
                scan_strictness=data.get('scan_strictness'),
            )

            generation_time = time.time() - generation_start
            total_time = time.time() - inference_start

            result['generation_time_seconds'] = round(generation_time, 2)
            result['total_time_seconds'] = round(total_time, 2)

            logger.info(f"✓ Inference completed successfully in {total_time:.2f}s (generation: {generation_time:.2f}s)")

            return Response(
                response=json.dumps(result),
                status=200,
                mimetype='application/json'
            )

        except Exception as e:
            import traceback
            error_traceback = traceback.format_exc()
            logger.error(f"Error during invocation: {str(e)}")
            logger.error(f"Traceback: {error_traceback}")

            return Response(
                response=json.dumps({
                    "error": "Internal server error"
                }),
                status=500,
                mimetype='application/json'
            )
    
    return app