#!/usr/bin/env python
"""
SageMaker Deployment Script for ControlNet QR Generator

Usage:
    python deploy_sagemaker.py                  # Deploy to production
    python deploy_sagemaker.py --staging        # Deploy to staging endpoint
    python deploy_sagemaker.py --staging --instance-type ml.g4dn.xlarge  # Test cheaper instance
"""

import json
import os
import sys
import argparse
import boto3
from sagemaker import Model, Session
from sagemaker.async_inference import AsyncInferenceConfig
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR / ".env.production")


def parse_args():
    parser = argparse.ArgumentParser(description="Deploy ControlNet QR to SageMaker")
    parser.add_argument("--staging", action="store_true", help="Deploy to staging endpoint instead of production")
    parser.add_argument("--instance-type", type=str, default=None, help="Override instance type (e.g. ml.g4dn.xlarge)")
    parser.add_argument("--image-tag", type=str, default="latest", help="Docker image tag to deploy (default: latest)")
    parser.add_argument(
        "--update-only",
        action="store_true",
        help=(
            "Update an existing endpoint to a new image without deleting/recreating it. "
            "SageMaker performs a rolling blue/green update — no downtime."
        ),
    )
    return parser.parse_args()


def deploy_endpoint(staging=False, instance_type_override=None, image_tag="latest"):
    env_label = "STAGING" if staging else "PRODUCTION"
    print(f"🚀 Deploying ControlNet QR ({env_label})...")
    
    boto_session = boto3.Session()
    sagemaker_session = Session(boto_session=boto_session)
    region = boto_session.region_name
    
    role = os.environ.get("SAGEMAKER_ROLE_ARN")
    if not role:
        raise ValueError("SAGEMAKER_ROLE_ARN not found. Make sure to source .env.production first")
    
    bucket = os.environ.get("AWS_S3_BUCKET")
    if not bucket:
        raise ValueError("AWS_S3_BUCKET not found. Make sure to source .env.production first")
    
    ssm = boto_session.client('ssm')
    admin_token = None
    
    try:
        print("🔐 Retrieving ADMIN_API_TOKEN from Parameter Store...")
        response = ssm.get_parameter(
            Name='/qr-controlnet/production/ADMIN_API_TOKEN',
            WithDecryption=True
        )
        admin_token = response['Parameter']['Value']
        print("✅ ADMIN_API_TOKEN retrieved successfully")
    except ssm.exceptions.ParameterNotFound:
        print("⚠️  ADMIN_API_TOKEN not found in Parameter Store")
        print("   Using token from environment variable as fallback")
        admin_token = os.environ.get('ADMIN_API_TOKEN')
        if not admin_token:
            print("❌ No ADMIN_API_TOKEN found. Admin endpoints will not work!")
    except Exception as e:
        print(f"⚠️  Error retrieving ADMIN_API_TOKEN: {e}")
        print("   Using token from environment variable as fallback")
        admin_token = os.environ.get('ADMIN_API_TOKEN')
    
    # Use different names for staging vs production
    if staging:
        endpoint_name = os.environ.get("SAGEMAKER_STAGING_ENDPOINT_NAME")
        model_name = os.environ.get("SAGEMAKER_STAGING_MODEL_NAME", "controlnet-qr-model-staging")
        if not endpoint_name:
            raise ValueError("SAGEMAKER_STAGING_ENDPOINT_NAME env var is required for staging deploy")
        output_path = f"s3://{bucket}/controlnet-qr-outputs-staging/"
    else:
        endpoint_name = os.environ.get("SAGEMAKER_ENDPOINT_NAME")
        model_name = os.environ.get("SAGEMAKER_MODEL_NAME", "controlnet-qr-model")
        if not endpoint_name:
            raise ValueError("SAGEMAKER_ENDPOINT_NAME env var is required for production deploy")
        output_path = f"s3://{bucket}/controlnet-qr-outputs/"
    
    # Determine instance type
    default_instance = "ml.g5.xlarge"
    instance_type = instance_type_override or os.environ.get("SAGEMAKER_INSTANCE_TYPE", default_instance)
    
    model_artifacts = f"s3://{bucket}/models/model.tar.gz"
    
    print(f"🔧 Environment: {env_label}")
    print(f"🔧 Endpoint: {endpoint_name}")
    print(f"🔧 Instance type: {instance_type}")
    print(f"🔧 Image tag: {image_tag}")
    print(f"📁 Model artifacts: {model_artifacts}")
    print(f"📤 Output path: {output_path}")

    # Check if model artifacts exist
    s3_client = boto_session.client('s3')
    try:
        s3_client.head_object(Bucket=bucket, Key="models/model.tar.gz")
        print("✅ Model artifacts found")
    except:
        print("⚠️  WARNING: Model artifacts not found at specified path")
        print(f"   Expected: {model_artifacts}")
        print("   Make sure model.tar.gz exists in your S3 bucket")
        response = input("Continue anyway? (y/n): ")
        if response.lower() != 'y':
            print("Deployment cancelled")
            return
    
    account = boto_session.client("sts").get_caller_identity()["Account"]
    repository_name = os.environ.get("AWS_ECR_REPOSITORY_NAME", "controlnet-ai-qr-generator")
    image_uri = f"{account}.dkr.ecr.{region}.amazonaws.com/{repository_name}:{image_tag}"
    
    model_env = {
        "MODEL": os.environ.get("MODEL", "emilianJR/epiCRealism"),
        "CONTROLNET_MODEL": os.environ.get("CONTROLNET_MODEL", "monster-labs/control_v1p_sd15_qrcode_monster"),
        "CONTROLNET_TWO_MODEL": os.environ.get("CONTROLNET_TWO_MODEL", "latentcat/control_v1p_sd15_brightness"),
        "DEVICE": "cuda",
        "NUM_INFERENCE_STEPS": "30",
        "RESULTS_DIR": "/tmp/results",
        "ENABLE_EXTENDED_METRICS": "true",
        "WARMUP_ON_LOAD": "true",
        # AWS configuration
        "AWS_REGION": region,
        "AWS_S3_BUCKET": bucket,
    }
    
    # S3 model loading: download base model from S3 at startup (enables runtime model switching)
    if os.environ.get("ENABLE_S3_MODEL_LOADING", "").lower() == "true":
        model_key = os.environ.get("MODEL_KEY", "epicrealism")
        model_env["ENABLE_S3_MODEL_LOADING"] = "True"
        model_env["MODEL_KEY"] = model_key
        model_env["MODEL_S3_BUCKET"] = bucket
        model_env["MODEL_S3_PREFIX"] = os.environ.get("MODEL_S3_PREFIX", "sd-models")
        print(f"   S3 model loading: ON (MODEL_KEY={model_key})")

    # Prompt enhancement (plan 009): expose the ops kill-switch and the S3
    # prefix so a `--update-only` redeploy can flip enhancement off without
    # touching the image or the request path.
    model_env["PROMPT_ENHANCEMENT_ENABLED"] = os.environ.get("PROMPT_ENHANCEMENT_ENABLED", "True")
    model_env["PROMPT_ENHANCER_S3_PREFIX"] = os.environ.get("PROMPT_ENHANCER_S3_PREFIX", "llm-models")

    if admin_token:
        model_env["ADMIN_API_TOKEN"] = admin_token

    model = Model(
        image_uri=image_uri,
        model_data=model_artifacts,
        role=role,
        name=model_name,
        env=model_env,
        sagemaker_session=sagemaker_session
    )
    
    async_config = AsyncInferenceConfig(
        output_path=output_path,
        max_concurrent_invocations_per_instance=1,
    )
    
    sm_client = boto_session.client('sagemaker')
    try:
        sm_client.describe_endpoint(EndpointName=endpoint_name)
        print(f"⚠️  Endpoint {endpoint_name} already exists")
        response = input("Delete and recreate? (y/n): ")
        if response.lower() == 'y':
            print(f"🗑️  Deleting existing endpoint...")
            sm_client.delete_endpoint(EndpointName=endpoint_name)
            waiter = sm_client.get_waiter('endpoint_deleted')
            waiter.wait(EndpointName=endpoint_name)
            print(f"✅ Endpoint deleted")
    except sm_client.exceptions.ClientError:
        pass
    
    try:
        print(f"Checking if endpoint config exists...")
        sm_client.describe_endpoint_config(EndpointConfigName=endpoint_name)
        print(f"Deleting existing endpoint config: {endpoint_name}")
        sm_client.delete_endpoint_config(EndpointConfigName=endpoint_name)
    except sm_client.exceptions.ClientError:
        print(f"Endpoint config {endpoint_name} doesn't exist, nothing to delete.")
        pass
    
    print(f"🚀 Deploying endpoint ({env_label})...")
    predictor = model.deploy(
        endpoint_name=endpoint_name,
        instance_type=instance_type,
        initial_instance_count=1,
        async_inference_config=async_config,
    )
    
    setup_autoscaling(endpoint_name, boto_session)

    # Scale down to 0 after deployment for cost savings
    print(f"💰 Scaling down to 0 instances for cost savings...")
    scale_endpoint_to_zero(endpoint_name, boto_session)
    
    print(f"✅ Endpoint deployed successfully!")
    print(f"📊 Endpoint: {endpoint_name}")
    print(f"📊 Instance type: {instance_type}")
    print(f"📊 Environment: {env_label}")
    print(f"⏱️  Scale-in cooldown: 60 minutes")
    print(f"🎯 Ready for extended usage sessions")
    
    info_filename = "deployment_info_staging.json" if staging else "deployment_info.json"
    deployment_info = {
        "endpoint_name": endpoint_name,
        "model_name": model_name,
        "environment": env_label.lower(),
        "instance_type": instance_type,
        "image_tag": image_tag,
        "deployed_at": datetime.now().isoformat(),
        "initial_instance_count": 1,
        "current_instance_count": 0,
        "scale_in_cooldown_minutes": 60,
        "features": {
            "extended_warmup": True,
            "instance_status_api": True,
            "activation_requests": True,
            "admin_api_protected": admin_token is not None
        }
    }
    
    with open(info_filename, "w") as f:
        json.dump(deployment_info, f, indent=2)
    
    print(f"📝 Deployment info saved to {info_filename}")
    
    return predictor


def scale_endpoint_to_zero(endpoint_name, boto_session):
    """Scale endpoint to 0 instances after deployment"""
    sm_client = boto_session.client('sagemaker')
    
    try:
        print("⏳ Waiting for endpoint to be ready before scaling down...")
        waiter = sm_client.get_waiter('endpoint_in_service')
        waiter.wait(EndpointName=endpoint_name)
        
        sm_client.update_endpoint_weights_and_capacities(
            EndpointName=endpoint_name,
            DesiredWeightsAndCapacities=[{
                'VariantName': 'AllTraffic',
                'DesiredInstanceCount': 0
            }]
        )
        print("✅ Endpoint scaled to 0 instances")
        
    except Exception as e:
        print(f"⚠️  Warning: Could not scale to 0: {e}")
        print("   You can manually scale to 0 using: make scale-down")


def setup_autoscaling(endpoint_name, boto_session):
    """Configure autoscaling with extended cooldown"""
    
    print("⚙️  Setting up autoscaling with extended warmup...")
    
    app_autoscaling = boto_session.client('application-autoscaling')
    cloudwatch = boto_session.client('cloudwatch')
    
    resource_id = f"endpoint/{endpoint_name}/variant/AllTraffic"
    
    app_autoscaling.register_scalable_target(
        ServiceNamespace="sagemaker",
        ResourceId=resource_id,
        ScalableDimension="sagemaker:variant:DesiredInstanceCount",
        MinCapacity=0,
        MaxCapacity=3
    )
    
    app_autoscaling.put_scaling_policy(
        PolicyName=f"{endpoint_name}-TargetTracking-ExtendedWarmup",
        ServiceNamespace="sagemaker",
        ResourceId=resource_id,
        ScalableDimension="sagemaker:variant:DesiredInstanceCount",
        PolicyType="TargetTrackingScaling",
        TargetTrackingScalingPolicyConfiguration={
            "TargetValue": 0.3,
            "CustomizedMetricSpecification": {
                "MetricName": "ApproximateBacklogSizePerInstance",
                "Namespace": "AWS/SageMaker",
                "Dimensions": [{"Name": "EndpointName", "Value": endpoint_name}],
                "Statistic": "Average",
            },
            "ScaleInCooldown": 3600,  # 60 minutes
            "ScaleOutCooldown": 30    # 30 seconds
        }
    )
    
    response_step = app_autoscaling.put_scaling_policy(
        PolicyName=f"{endpoint_name}-WakeFromZero",
        ServiceNamespace="sagemaker",
        ResourceId=resource_id,
        ScalableDimension="sagemaker:variant:DesiredInstanceCount",
        PolicyType="StepScaling",
        StepScalingPolicyConfiguration={
            "AdjustmentType": "ChangeInCapacity",
            "MetricAggregationType": "Average",
            "Cooldown": 60,
            "StepAdjustments": [
                {
                    "MetricIntervalLowerBound": 0,
                    "ScalingAdjustment": 1
                }
            ]
        }
    )
    
    cloudwatch.put_metric_alarm(
        AlarmName=f"{endpoint_name}-HasBacklogWithoutCapacity",
        MetricName='HasBacklogWithoutCapacity',
        Namespace='AWS/SageMaker',
        Statistic='Average',
        EvaluationPeriods=1,
        DatapointsToAlarm=1,
        Threshold=1,
        ComparisonOperator='GreaterThanOrEqualToThreshold',
        TreatMissingData='missing',
        Dimensions=[
            {'Name': 'EndpointName', 'Value': endpoint_name},
        ],
        Period=30,
        AlarmActions=[response_step['PolicyARN']],
    )
    
    print("✅ Autoscaling configured:")
    print(f"   • Scale-out from 0→1: ~30-60 seconds")
    print(f"   • Scale-out from 1→2→3: ~30 seconds per step")
    print(f"   • Scale-in: 60 minutes cooldown")
    print(f"   • Max instances: 3")
    print(f"   • Instances stay warm for full work sessions")


def update_endpoint_rolling(staging=False, image_tag="latest"):
    """Update an existing SageMaker endpoint to a new image (rolling, no downtime).

    SageMaker creates new instances with the new image, waits until they are
    healthy, then terminates the old ones. Autoscaling policies attached to the
    endpoint resource ID are preserved automatically.
    """
    env_label = "STAGING" if staging else "PRODUCTION"
    print(f"🔄 Rolling update of ControlNet endpoint ({env_label}) to image tag: {image_tag}")

    boto_session = boto3.Session()
    region = boto_session.region_name
    sm_client = boto_session.client("sagemaker")

    role = os.environ.get("SAGEMAKER_ROLE_ARN")
    if not role:
        raise ValueError("SAGEMAKER_ROLE_ARN not found. Make sure to source .env.production first")

    bucket = os.environ.get("AWS_S3_BUCKET")
    if not bucket:
        raise ValueError("AWS_S3_BUCKET not found. Make sure to source .env.production first")

    if staging:
        endpoint_name = os.environ.get("SAGEMAKER_STAGING_ENDPOINT_NAME")
        if not endpoint_name:
            raise ValueError("SAGEMAKER_STAGING_ENDPOINT_NAME env var is required for staging update")
    else:
        endpoint_name = os.environ.get("SAGEMAKER_ENDPOINT_NAME")
        if not endpoint_name:
            raise ValueError("SAGEMAKER_ENDPOINT_NAME env var is required for production update")

    account = boto_session.client("sts").get_caller_identity()["Account"]
    repository_name = os.environ.get("AWS_ECR_REPOSITORY_NAME", "controlnet-ai-qr-generator")
    image_uri = f"{account}.dkr.ecr.{region}.amazonaws.com/{repository_name}:{image_tag}"

    # Verify the endpoint exists before attempting an update
    try:
        sm_client.describe_endpoint(EndpointName=endpoint_name)
    except sm_client.exceptions.ClientError:
        raise RuntimeError(
            f"Endpoint '{endpoint_name}' does not exist. "
            "Run a full deploy first (without --update-only)."
        )

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    new_model_name = f"{endpoint_name}-model-{timestamp}"
    new_config_name = f"{endpoint_name}-config-{timestamp}"

    print(f"🔧 New model:  {new_model_name}")
    print(f"🔧 New config: {new_config_name}")
    print(f"🔧 Image URI:  {image_uri}")

    # --- Resolve ADMIN_API_TOKEN from Parameter Store (same as full deploy) ---
    ssm = boto_session.client("ssm")
    admin_token = None
    param_name = "/qr-controlnet/production/ADMIN_API_TOKEN" if not staging else "/qr-controlnet/staging/ADMIN_API_TOKEN"
    try:
        admin_token = ssm.get_parameter(Name=param_name, WithDecryption=True)["Parameter"]["Value"]
        print("✅ ADMIN_API_TOKEN retrieved from Parameter Store")
    except Exception:
        admin_token = os.environ.get("ADMIN_API_TOKEN")

    model_env = {
        "MODEL": os.environ.get("MODEL", "emilianJR/epiCRealism"),
        "CONTROLNET_MODEL": os.environ.get("CONTROLNET_MODEL", "monster-labs/control_v1p_sd15_qrcode_monster"),
        "CONTROLNET_TWO_MODEL": os.environ.get("CONTROLNET_TWO_MODEL", "latentcat/control_v1p_sd15_brightness"),
        "DEVICE": "cuda",
        "NUM_INFERENCE_STEPS": "30",
        "RESULTS_DIR": "/tmp/results",
        "ENABLE_EXTENDED_METRICS": "true",
        "WARMUP_ON_LOAD": "true",
        "AWS_REGION": region,
        "AWS_S3_BUCKET": bucket,
    }
    if os.environ.get("ENABLE_S3_MODEL_LOADING", "").lower() == "true":
        model_key = os.environ.get("MODEL_KEY", "epicrealism")
        model_env["ENABLE_S3_MODEL_LOADING"] = "True"
        model_env["MODEL_KEY"] = model_key
        model_env["MODEL_S3_BUCKET"] = bucket
        model_env["MODEL_S3_PREFIX"] = os.environ.get("MODEL_S3_PREFIX", "sd-models")
    # Prompt enhancement (plan 009) kill-switch — the primary lever for a
    # soft-off via --update-only.
    model_env["PROMPT_ENHANCEMENT_ENABLED"] = os.environ.get("PROMPT_ENHANCEMENT_ENABLED", "True")
    model_env["PROMPT_ENHANCER_S3_PREFIX"] = os.environ.get("PROMPT_ENHANCER_S3_PREFIX", "llm-models")
    if admin_token:
        model_env["ADMIN_API_TOKEN"] = admin_token

    # --- Create new Model resource ---
    print("📦 Creating new SageMaker Model resource...")
    sm_client.create_model(
        ModelName=new_model_name,
        PrimaryContainer={"Image": image_uri, "Environment": model_env},
        ExecutionRoleArn=role,
    )
    print(f"✅ Model created: {new_model_name}")

    # --- Copy ProductionVariants from current endpoint config ---
    current_endpoint = sm_client.describe_endpoint(EndpointName=endpoint_name)
    current_config_name = current_endpoint["EndpointConfigName"]
    current_config = sm_client.describe_endpoint_config(EndpointConfigName=current_config_name)

    variants = current_config["ProductionVariants"]
    for v in variants:
        v["ModelName"] = new_model_name
        # Remove read-only fields that can't be re-submitted
        for key in ("VariantStatus", "CurrentServerlessConfig"):
            v.pop(key, None)

    # --- Create new EndpointConfig ---
    print("📋 Creating new EndpointConfig...")
    new_config_args = {
        "EndpointConfigName": new_config_name,
        "ProductionVariants": variants,
    }
    if "AsyncInferenceConfig" in current_config:
        new_config_args["AsyncInferenceConfig"] = current_config["AsyncInferenceConfig"]
    if "KmsKeyId" in current_config:
        new_config_args["KmsKeyId"] = current_config["KmsKeyId"]

    sm_client.create_endpoint_config(**new_config_args)
    print(f"✅ EndpointConfig created: {new_config_name}")

    # --- Trigger rolling update ---
    print(f"🚀 Triggering rolling endpoint update for '{endpoint_name}'...")
    sm_client.update_endpoint(EndpointName=endpoint_name, EndpointConfigName=new_config_name)

    print("⏳ Waiting for endpoint to reach InService (this takes ~5-10 min)...")
    waiter = sm_client.get_waiter("endpoint_in_service")
    waiter.wait(EndpointName=endpoint_name, WaiterConfig={"Delay": 30, "MaxAttempts": 40})

    print(f"✅ Endpoint '{endpoint_name}' is now running image: {image_tag}")

    info_filename = "deployment_info_staging.json" if staging else "deployment_info.json"
    deployment_info = {
        "endpoint_name": endpoint_name,
        "model_name": new_model_name,
        "endpoint_config": new_config_name,
        "environment": env_label.lower(),
        "image_tag": image_tag,
        "image_uri": image_uri,
        "deployed_at": datetime.now().isoformat(),
        "update_type": "rolling",
    }
    with open(info_filename, "w") as f:
        json.dump(deployment_info, f, indent=2)

    print(f"📝 Deployment info saved to {info_filename}")


if __name__ == "__main__":
    args = parse_args()
    if args.update_only:
        update_endpoint_rolling(
            staging=args.staging,
            image_tag=args.image_tag,
        )
    else:
        deploy_endpoint(
            staging=args.staging,
            instance_type_override=args.instance_type,
            image_tag=args.image_tag,
        )