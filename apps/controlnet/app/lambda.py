import json
import boto3
import os
import uuid
import base64
import logging
from datetime import datetime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sagemaker_runtime = boto3.client('sagemaker-runtime')
s3_client = boto3.client('s3')

ENDPOINT_NAME = os.environ.get('SAGEMAKER_ENDPOINT_NAME', '')
STAGING_ENDPOINT_NAME = os.environ.get('SAGEMAKER_STAGING_ENDPOINT_NAME', '')
BUCKET_NAME = os.environ.get('AWS_S3_BUCKET', '')
S3_INPUT_PREFIX = os.environ.get('S3_INPUT_PREFIX', 'controlnet-qr-inputs')
S3_OUTPUT_PREFIX = os.environ.get('S3_OUTPUT_PREFIX', 'controlnet-qr-outputs')


def get_endpoint_name(environment=None):
    """Resolve the SageMaker endpoint name based on environment."""
    if environment == 'staging':
        return STAGING_ENDPOINT_NAME
    return ENDPOINT_NAME

def lambda_handler(event, context):
    logger.info(f"Received {event.get('httpMethod')} {event.get('path')}")
    
    http_method = event.get('httpMethod', '')
    path = event.get('path', '')
    
    if http_method == 'GET':
        path_parts = path.split('/')
        if len(path_parts) >= 3:
            if 'status' in path:
                request_id = path_parts[-1]
                return check_generation_status(request_id)
    
    if http_method == 'POST':
        return handle_generation_request(event)
    
    return {
        'statusCode': 400,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps({'error': 'Invalid request type'})
    }

def handle_generation_request(event):
    """Handle the initial generation request"""
    try:
        request_body = json.loads(event.get('body', '{}'))

        request_id = str(uuid.uuid4())

        # Legacy SR-MPGD rescue pass-through. The March-era prod API
        # (qr-controlnet-api-prod-api, route /api/qr-rescue) POSTs to /generate
        # with action=="rescue" and NO prompt, so it must branch off before the
        # prompt validation below. This branch reconstructs the one lost in the
        # 2026-07-05 relay clobber (the deployed relay had drifted; no published
        # versions existed). Only the pre-plan-008 container on the PRODUCTION
        # endpoint understands action=="rescue" — the v2 container has no
        # action dispatch, so rescue against staging fails inside the container.
        if request_body.get('action') == 'rescue':
            return handle_rescue_request(request_body, request_id)

        # Validate required parameters
        prompt = request_body.get('prompt')
        if not prompt:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'Prompt is required'})
            }
        
        base_qr_code = request_body.get('base_qr_code')
        if not base_qr_code:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'base_qr_code parameter is required'})
            }
        
        # Ensure base_qr_code is a list
        if isinstance(base_qr_code, str):
            base_qr_code = [base_qr_code]
        elif not isinstance(base_qr_code, list):
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'base_qr_code must be a string URL or list of URLs'})
            }
        
        # Validate base_qr_code list length
        if len(base_qr_code) < 1 or len(base_qr_code) > 3:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'base_qr_code must contain between 1 and 3 URLs'})
            }
        
        # Validate num_images_per_prompt if provided
        num_images_per_prompt = request_body.get('num_images_per_prompt')
        if num_images_per_prompt is not None:
            if num_images_per_prompt < 1 or num_images_per_prompt > 3:
                return {
                    'statusCode': 400,
                    'headers': {'Content-Type': 'application/json'},
                    'body': json.dumps({'error': 'num_images_per_prompt must be between 1 and 3'})
                }
        
        # =====================================================================
        # WARNING — payload field whitelist / DEPLOYMENT DRIFT HAZARD
        #
        # This relay Lambda WHITELISTS request fields: anything not copied
        # into `payload` below is silently dropped before it reaches the
        # SageMaker endpoint. When the container gains a new request field,
        # it must be added here too.
        #
        # The deployed function is NOT managed by IaC — it was uploaded by
        # hand and may have drifted from this file. Editing this file does
        # NOTHING in staging/prod until the function is redeployed with:
        #
        #     make deploy-relay-lambda      (RELAY_LAMBDA_NAME from .env)
        #
        # Before redeploying, diff the deployed code against this file
        # (`aws lambda get-function --function-name $RELAY_LAMBDA_NAME`,
        # download the code zip, diff) and reconcile any drift — see the
        # plan-008 STOP condition. The v2 pipeline fields added below
        # (pipeline / qr_content / style_preset / scan_strictness) and the
        # plan-009 prompt_enhancement flag do not work in staging/prod until
        # that redeploy has happened.
        # =====================================================================
        # Build the payload with all parameters
        payload = {
            "prompt": prompt,
            "base_qr_code": base_qr_code,
            "negative_prompt": request_body.get("negative_prompt", "ugly, disfigured, low quality, blurry, nsfw, deformed, mutated, watermark, text, signature, logo, banner, extra digits, cropped, jpeg artifacts, username, error, sketch, duplicate, morbid, gross, out of frame, poorly drawn face, poorly drawn hands, mutation, missing arms, missing legs, extra arms, extra legs, fused fingers, too many fingers, long neck, low resolution, bad anatomy, bad proportions, cloned face, oversaturated"),
            "num_inference_steps": request_body.get("num_inference_steps", 40),
            "controlnet_conditioning_scale": request_body.get("controlnet_conditioning_scale", [1.25, 0.1]),
            "control_guidance_start": request_body.get("control_guidance_start", [0.0, 0.1]),
            "control_guidance_end": request_body.get("control_guidance_end", [1.0, 1.0]),
            "height": request_body.get("height", 1024),
            "width": request_body.get("width", 1024),
            "guidance_scale": request_body.get("guidance_scale", 7.0),
            "sampler": request_body.get("sampler", "dpm++_2m_karras"),
        }
        
        # Add optional parameters
        if num_images_per_prompt is not None:
            payload["num_images_per_prompt"] = num_images_per_prompt
        
        model = request_body.get("model")
        if model:
            payload["model"] = model
        
        seed = request_body.get("seed")
        if seed:
            payload["seed"] = seed
        
        guess_mode = request_body.get("guess_mode")
        if guess_mode is not None:
            payload["guess_mode"] = guess_mode

        prompt_enhancement = request_body.get("prompt_enhancement")
        if prompt_enhancement is not None:
            payload["prompt_enhancement"] = prompt_enhancement

        # v2 pipeline fields (plan 008) — forwarded only when present so the
        # container's own defaults rule for absent fields (pipeline defaults
        # to "v1" there). See the drift warning above: these pass-throughs
        # are inert until the function is redeployed.
        pipeline = request_body.get("pipeline")
        if pipeline:
            payload["pipeline"] = pipeline

        qr_content = request_body.get("qr_content")
        if qr_content:
            payload["qr_content"] = qr_content

        style_preset = request_body.get("style_preset")
        if style_preset:
            payload["style_preset"] = style_preset

        scan_strictness = request_body.get("scan_strictness")
        if scan_strictness:
            payload["scan_strictness"] = scan_strictness

        # Resolve environment (staging or production)
        environment = request_body.get("environment")
        endpoint_name = get_endpoint_name(environment)
        
        # Store the request payload in S3
        s3_key = f"{S3_INPUT_PREFIX}/{request_id}.json"
        s3_client.put_object(
            Bucket=BUCKET_NAME,
            Key=s3_key,
            Body=json.dumps(payload),
            ContentType='application/json'
        )
        
        input_location = f"s3://{BUCKET_NAME}/{s3_key}"
        
        logger.info(f"Invoking SageMaker async endpoint: {endpoint_name} (env={environment or 'production'})")
        logger.info(f"Payload contains {len(base_qr_code)} QR code URLs")
        logger.info(f"Requested images: {num_images_per_prompt or 'auto'}")

        response = sagemaker_runtime.invoke_endpoint_async(
            EndpointName=endpoint_name,
            ContentType='application/json',
            InputLocation=input_location,
            InferenceId=request_id
        )
        
        output_location = response.get('OutputLocation', '')
        logger.info(f"SageMaker OutputLocation: {output_location}")
        
        return {
            'statusCode': 202,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'requestId': request_id,
                'status': 'PROCESSING',
                'outputLocation': output_location,
                'message': 'Request submitted successfully',
                'statusCheckUrl': f"/generate/status/{request_id}",
                'inputQrUrls': base_qr_code,
                'numQrCodes': len(base_qr_code),
                'requestedImages': num_images_per_prompt or len(base_qr_code)
            })
        }
        
    except Exception as e:
        logger.error(f"Error processing request: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'message': 'Error processing the request'
            })
        }

def handle_rescue_request(request_body, request_id):
    """Forward a legacy SR-MPGD rescue request to the SageMaker endpoint.

    Contract (from the deployed prod API's ControlNetService.submitRescue):
    caller sends {action:"rescue", image, qr_code, environment?, srmpgd_*…}
    and only needs the 202 body's outputLocation back — it polls that S3
    object itself for {rescued_image, rescue_time_seconds}.
    """
    try:
        image = request_body.get('image')
        qr_code = request_body.get('qr_code')
        if not image or not qr_code:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'image and qr_code are required for rescue'})
            }

        # Whitelist, same policy as generation: unknown fields are dropped.
        payload = {
            'action': 'rescue',
            'image': image,
            'qr_code': qr_code,
        }
        for field in (
            'srmpgd_num_iteration',
            'srmpgd_lr',
            'qrcode_module_size',
            'qrcode_padding',
            'scanning_robust_guidance_scale',
            'perceptual_guidance_scale',
        ):
            value = request_body.get(field)
            if value is not None:
                payload[field] = value

        environment = request_body.get('environment')
        endpoint_name = get_endpoint_name(environment)

        s3_key = f"{S3_INPUT_PREFIX}/{request_id}.json"
        s3_client.put_object(
            Bucket=BUCKET_NAME,
            Key=s3_key,
            Body=json.dumps(payload),
            ContentType='application/json'
        )

        input_location = f"s3://{BUCKET_NAME}/{s3_key}"

        logger.info(f"Invoking SageMaker async endpoint for rescue: {endpoint_name} (env={environment or 'production'})")

        response = sagemaker_runtime.invoke_endpoint_async(
            EndpointName=endpoint_name,
            ContentType='application/json',
            InputLocation=input_location,
            InferenceId=request_id
        )

        output_location = response.get('OutputLocation', '')
        logger.info(f"SageMaker rescue OutputLocation: {output_location}")

        return {
            'statusCode': 202,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'requestId': request_id,
                'status': 'PROCESSING',
                'outputLocation': output_location,
                'message': 'Rescue submitted successfully',
                'statusCheckUrl': f"/generate/status/{request_id}"
            })
        }

    except Exception as e:
        logger.error(f"Error processing rescue request: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'message': 'Error processing the rescue request'
            })
        }

def check_generation_status(request_id):
    """Check the status and return complete results if ready"""
    try:
        # Check for .out file with the request_id
        out_file_key = f"{S3_OUTPUT_PREFIX}/{request_id}.out"
        
        try:
            # Try to get the .out file
            response = s3_client.get_object(Bucket=BUCKET_NAME, Key=out_file_key)
            result_data = json.loads(response['Body'].read().decode('utf-8'))
            logger.info(f"Found result file: {out_file_key}")
            
            # Check if this is a failed generation
            if result_data.get('status') == 'failed' or result_data.get('error'):
                logger.info(f"Generation failed for {request_id}")
                return {
                    'statusCode': 200,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({
                        'status': 'FAILED',
                        'requestId': request_id,
                        'message': result_data.get('error', 'Generation failed'),
                        'error': result_data.get('error', 'Unknown error')
                    })
                }
            
            # Process successful generation
            logger.info(f"Processing successful generation for {request_id}")
            
            # Handle both old single-image format and new multi-image format
            images = result_data.get('images', [])
            if not images:
                # Fallback to old format
                single_image = result_data.get('image')
                if single_image:
                    images = [single_image]
            
            if not images:
                return {
                    'statusCode': 200,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({
                        'status': 'FAILED',
                        'requestId': request_id,
                        'message': 'Result file found but contains no images',
                        'error': 'No images in result'
                    })
                }
            
            # Convert base64 images to S3 URLs
            logger.info(f"Converting {len(images)} base64 images to S3 URLs...")
            image_urls = []
            
            for i, base64_image in enumerate(images):
                try:
                    # Remove data:image/png;base64, prefix if present
                    if base64_image.startswith('data:image'):
                        base64_data = base64_image.split(',', 1)[1]
                    else:
                        base64_data = base64_image
                    
                    # Decode base64 to binary
                    image_binary = base64.b64decode(base64_data)
                    
                    # Generate unique filename
                    image_filename = f"output_{request_id}_{i+1}.png"
                    image_key = f"output/{image_filename}"
                    
                    # Upload to S3
                    s3_client.put_object(
                        Bucket=BUCKET_NAME,
                        Key=image_key,
                        Body=image_binary,
                        ContentType='image/png',
                        CacheControl='max-age=31536000'  # Cache for 1 year
                    )
                    
                    # Generate public URL
                    image_url = f"https://{BUCKET_NAME}.s3.amazonaws.com/{image_key}"
                    image_urls.append(image_url)
                    
                    logger.info(f"Saved image {i+1} to S3: {image_key}")
                    
                except Exception as image_error:
                    logger.error(f"Error processing image {i+1}: {str(image_error)}")
                    # Continue with other images even if one fails
                    continue
            
            if not image_urls:
                return {
                    'statusCode': 200,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    'body': json.dumps({
                        'status': 'FAILED',
                        'requestId': request_id,
                        'message': 'Failed to process any images',
                        'error': 'Image processing failed'
                    })
                }
            
            # Build comprehensive response with S3 URLs
            response_data = {
                'status': 'COMPLETED',
                'requestId': request_id,
                'message': 'Generation completed successfully',
                'images': image_urls,  # Array of S3 URLs instead of base64
                'numImagesGenerated': len(image_urls),
                'seed': result_data.get('seed'),
                'qrSource': result_data.get('qr_source', 'unknown'),
            }
            
            # Include generation details if available
            if 'generations' in result_data:
                response_data['generations'] = result_data['generations']
            
            if 'generation_plan' in result_data:
                response_data['generationPlan'] = result_data['generation_plan']
            
            # Update output paths to point to S3 URLs
            response_data['outputPaths'] = image_urls
            
            # Include input QR URLs if available
            if 'input_qr_urls' in result_data:
                response_data['inputQrUrls'] = result_data['input_qr_urls']
            
            # For backward compatibility, include the first image URL as 'image'
            response_data['image'] = image_urls[0] if image_urls else None
            
            # Update the .out file to replace base64 with URLs (optional optimization)
            try:
                updated_result_data = result_data.copy()
                updated_result_data['images'] = image_urls
                updated_result_data['image'] = image_urls[0] if image_urls else None
                updated_result_data['output_paths'] = image_urls
                
                # Save updated file (without base64 data)
                s3_client.put_object(
                    Bucket=BUCKET_NAME,
                    Key=out_file_key,
                    Body=json.dumps(updated_result_data),
                    ContentType='application/json'
                )
                logger.info(f"Updated .out file with S3 URLs: {out_file_key}")
            except Exception as update_error:
                logger.warning(f"Failed to update .out file: {str(update_error)}")
                # Don't fail the request if we can't update the file
            
            logger.info(f"Successfully processed {len(image_urls)} images for request {request_id}")
            
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps(response_data)
            }
            
        except s3_client.exceptions.NoSuchKey:
            # File doesn't exist yet - still processing
            logger.info(f"Output file not found for {request_id} - still processing")
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({
                    'status': 'PROCESSING',
                    'requestId': request_id,
                    'message': 'Generation in progress'
                })
            }
            
    except Exception as e:
        logger.error(f"Error checking status for {request_id}: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'message': 'Error checking generation status'
            })
        }