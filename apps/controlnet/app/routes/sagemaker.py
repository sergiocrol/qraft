from flask import Blueprint, jsonify, current_app
from botocore.exceptions import ClientError
from ..utils.logging import get_logger
from ..utils.validation import validate_schema
from ..schemas.generate import SageMakerRequestSchema
from ..constants import (
    DEFAULT_NEGATIVE_PROMPT_SHORT,
    DEFAULT_CONTROLNET_CONDITIONING_SCALE,
    DEFAULT_CONTROL_GUIDANCE_START,
    DEFAULT_CONTROL_GUIDANCE_END,
    DEFAULT_HEIGHT,
    DEFAULT_WIDTH,
    DEFAULT_SAMPLER,
    DEFAULT_GUIDANCE_SCALE,
    DEFAULT_MODEL_KEY,
    DEFAULT_SAGEMAKER_ENDPOINT_NAME,
)
import boto3
import json
import os
import time

logger = get_logger(__name__)
sagemaker_bp = Blueprint('sagemaker', __name__)

@sagemaker_bp.route('/generate/async', methods=['POST'])
@validate_schema(SageMakerRequestSchema)
def generate_async(data):
  """Submit an async inference request to the SageMaker endpoint.

  Flow: validate → invoke_endpoint_async → return InferenceId + OutputLocation.
  The caller polls /generate/async/status/<id> or /generate/async/result/<id>.
  """
  try:
    prompt = data["prompt"]
    logger.info(f"Submitting async generation request with prompt: {prompt[:50]}...")
    runtime = boto3.client('sagemaker-runtime')
    payload = {
      "prompt": prompt,
      "negative_prompt": data.get("negative_prompt", DEFAULT_NEGATIVE_PROMPT_SHORT),
      "num_inference_steps": data.get("num_inference_steps", current_app.config['NUM_INFERENCE_STEPS']),
      "controlnet_conditioning_scale": data.get("controlnet_conditioning_scale", DEFAULT_CONTROLNET_CONDITIONING_SCALE),
      "control_guidance_start": data.get("control_guidance_start", DEFAULT_CONTROL_GUIDANCE_START),
      "control_guidance_end": data.get("control_guidance_end", DEFAULT_CONTROL_GUIDANCE_END),
      "height": data.get("height", DEFAULT_HEIGHT),
      "width": data.get("width", DEFAULT_WIDTH),
      "sampler": data.get("sampler", DEFAULT_SAMPLER),
      "guidance_scale": data.get("guidance_scale", DEFAULT_GUIDANCE_SCALE),
      "model": data.get("model", DEFAULT_MODEL_KEY),
    }
    # v2-pipeline fields (plan 008) + prompt_enhancement (plan 009): forward
    # only when present so absent fields keep the container defaults.
    for v2_field in ("pipeline", "qr_content", "style_preset", "scan_strictness", "prompt_enhancement"):
      if data.get(v2_field) is not None:
        payload[v2_field] = data[v2_field]
    endpoint_name = current_app.config.get('SAGEMAKER_ENDPOINT_NAME', 'controlnet-qr-endpoint')
    response = runtime.invoke_endpoint_async(
      EndpointName=endpoint_name,
      ContentType="application/json",
      Accept="application/json",
      InputLocation=json.dumps(payload)
    )

    output_location = response['OutputLocation']

    logger.info(f"Successfully submitted async request. Output will be available at: {output_location}")

    return jsonify({
      "message": "Async image generation request submitted successfully",
      "request_id": response['InferenceId'],
      "output_location": output_location,
      "status": "PROCESSING"
    })
  
  except Exception as e:
    logger.exception(f"Error submitting async generation request: {str(e)}")
    return jsonify({"error": f"Async generation request failed: {str(e)}"}), 500
  
@sagemaker_bp.route('/generate/async/status/<request_id>', methods=['GET'])
def check_async_status(request_id):
    """Check whether an async inference job has completed.

    SageMaker async inference doesn't have a ``describe_job`` API.
    Instead we probe the S3 output location: if the result object exists
    the job is COMPLETED; if it doesn't, we check for a failure file;
    otherwise we report PROCESSING.
    """
    try:
        output_bucket = current_app.config.get('AWS_S3_BUCKET')
        if not output_bucket:
            endpoint_name = current_app.config.get(
                'SAGEMAKER_ENDPOINT_NAME', DEFAULT_SAGEMAKER_ENDPOINT_NAME
            )
            sm = boto3.client('sagemaker')
            ep = sm.describe_endpoint(EndpointName=endpoint_name)
            output_bucket = ep['EndpointArn'].split(':')[4]

        s3_client = boto3.client('s3')
        result_key = f"controlnet-qr-outputs/{request_id}/output.json"
        failure_key = f"controlnet-qr-outputs/{request_id}/failure.json"

        try:
            resp = s3_client.get_object(Bucket=output_bucket, Key=result_key)
            result = json.loads(resp['Body'].read().decode())
            return jsonify({"status": "COMPLETED", "result": result})
        except ClientError as e:
            if e.response['Error']['Code'] != 'NoSuchKey':
                raise

        try:
            s3_client.head_object(Bucket=output_bucket, Key=failure_key)
            return jsonify({"status": "FAILED", "request_id": request_id})
        except ClientError:
            pass

        return jsonify({"status": "PROCESSING", "request_id": request_id})

    except Exception as e:
        logger.exception(f"Error checking async request status: {str(e)}")
        return jsonify({"error": f"Failed to check request status: {str(e)}"}), 500
  
@sagemaker_bp.route('/generate/async/result/<request_id>', methods=['GET'])
def get_async_result(request_id):
    """Fetch the completed result from S3 for an async inference job.

    Looks up the async output config from the SageMaker endpoint and
    tries to read the output object.  If the object doesn't exist yet,
    returns a PROCESSING response.
    """
    try:
        s3_client = boto3.client('s3')

        endpoint_name = current_app.config.get(
            'SAGEMAKER_ENDPOINT_NAME', DEFAULT_SAGEMAKER_ENDPOINT_NAME
        )
        sagemaker_client = boto3.client('sagemaker')
        endpoint_response = sagemaker_client.describe_endpoint(
            EndpointName=endpoint_name
        )
        output_bucket = current_app.config.get('AWS_S3_BUCKET')
        if not output_bucket:
            output_bucket = endpoint_response['EndpointArn'].split(':')[4]

        key = f"controlnet-qr-outputs/{request_id}/output.json"
        logger.info(f"Looking for result in s3://{output_bucket}/{key}")

        try:
            response = s3_client.get_object(
                Bucket=output_bucket,
                Key=key
            )

            result = json.loads(response['Body'].read().decode())

            if 'image' in result and result['image']:
                import base64
                try:
                    base64.b64decode(result['image'])
                    logger.info("Successfully validated base64 image data")
                except Exception as img_error:
                    logger.error(f"Invalid base64 image data: {str(img_error)}")
                    result['image_valid'] = False
                else:
                    result['image_valid'] = True

                result['image_size_bytes'] = len(result['image'])

                result['s3_reference'] = {
                    'bucket': output_bucket,
                    'key': key
                }

                if 'output_path' in result:
                    filename = os.path.basename(result['output_path'])
                    image_key = f"controlnet-qr-outputs/{request_id}/{filename}"

                    try:
                        s3_client.head_object(Bucket=output_bucket, Key=image_key)
                        result['image_file_s3'] = f"s3://{output_bucket}/{image_key}"
                    except ClientError:
                        logger.warning(f"Image file not found in S3: {image_key}")
                        result['image_file_s3'] = None

            return jsonify({
                "status": "COMPLETED",
                "result": result,
                "request_id": request_id,
                "timestamp": int(time.time())
            })

        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                logger.info(f"Result not yet available for request_id: {request_id}")
                return jsonify({
                    "status": "PROCESSING",
                    "message": "Result not available yet, processing in progress",
                    "request_id": request_id
                })
            logger.error(f"Error fetching result from S3: {e}")
            return jsonify({
                "status": "ERROR",
                "error": f"Failed to fetch result: {str(e)}",
                "request_id": request_id
            }), 500

        except Exception as fetch_error:
            logger.error(f"Error fetching result from S3: {str(fetch_error)}")
            return jsonify({
                "status": "ERROR",
                "error": f"Failed to fetch result: {str(fetch_error)}",
                "request_id": request_id
            }), 500

    except Exception as e:
        logger.exception(f"Error retrieving async result: {str(e)}")
        return jsonify({
            "error": f"Failed to retrieve result: {str(e)}",
            "request_id": request_id
        }), 500