# Variables
# ==============================================================================
DOCKER_COMPOSE_FILE := docker-compose.yml
DOCKER_COMPOSE := docker-compose -f $(DOCKER_COMPOSE_FILE)
PROJECT_NAME := qr-controlnet
AWS_REGION := $(shell grep AWS_REGION .env 2>/dev/null | cut -d '=' -f2 || grep AWS_REGION apps/controlnet/.env 2>/dev/null | cut -d '=' -f2 || echo "eu-west-1")
AWS_ACCOUNT_ID := $(shell aws sts get-caller-identity --query Account --output text 2>/dev/null)
ECR_REPOSITORY := $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
CONTROLNET_IMAGE := $(ECR_REPOSITORY)/controlnet-ai-qr-generator:latest

# Colors for output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[0;33m
BLUE := \033[0;34m
CYAN := \033[0;36m
RESET := \033[0m

.DEFAULT_GOAL := help

# Environment & Dev
# ==============================================================================
.PHONY: setup
setup: ## Initial project setup
	@echo "Setting up project..."
	@if [ ! -f .env ]; then \
		echo "Creating minimal .env for Docker Compose..."; \
		echo "AWS_REGION=eu-west-1" > .env; \
		echo "Please edit .env with your AWS credentials"; \
	fi
	@if [ ! -f apps/controlnet/.env ]; then \
		echo "Creating apps/controlnet/.env..."; \
		echo "AWS_REGION=eu-west-1" > apps/controlnet/.env; \
		echo "Please edit apps/controlnet/.env with your AWS credentials"; \
	fi

.PHONY: check-env
check-env: ## Check required environment variables
	@echo "$(BLUE)Checking environment variables...$(RESET)"
	@if [ -z "$(AWS_ACCOUNT_ID)" ]; then \
		echo "$(RED)Error: Unable to get AWS Account ID. Please configure AWS credentials.$(RESET)"; \
		exit 1; \
	fi
	@echo "$(GREEN)AWS Account ID: $(AWS_ACCOUNT_ID)$(RESET)"
	@echo "$(GREEN)AWS Region: $(AWS_REGION)$(RESET)"

.PHONY: dev
dev: ## Start all development services
	@echo "$(BLUE)Starting development environment...$(RESET)"
	$(DOCKER_COMPOSE) up --build -d
	@echo "$(GREEN)Development environment started!$(RESET)"
	@echo "$(CYAN)ControlNet API: http://localhost:8080 | API Gateway: http://localhost:3001 | Client: http://localhost:3000$(RESET)"

.PHONY: dev-controlnet
dev-controlnet: ## Start only ControlNet service
	@echo "$(BLUE)Starting ControlNet service...$(RESET)"
	$(DOCKER_COMPOSE) up --build -d controlnet
	@echo "$(GREEN)ControlNet at http://localhost:8080$(RESET)"

.PHONY: stop
stop: ## Stop all services
	@echo "$(YELLOW)Stopping all services...$(RESET)"
	$(DOCKER_COMPOSE) --profile with-cache --profile with-db down
	@echo "$(GREEN)All services stopped.$(RESET)"

.PHONY: restart
restart: stop dev ## Restart all services

.PHONY: logs
logs: ## Show logs for all services
	$(DOCKER_COMPOSE) logs -f

.PHONY: logs-controlnet
logs-controlnet: ## Show logs for ControlNet service
	$(DOCKER_COMPOSE) logs -f controlnet

# Build
# ==============================================================================
.PHONY: build
build: ## Build all Docker images
	@echo "$(BLUE)Building all Docker images...$(RESET)"
	$(DOCKER_COMPOSE) build
	@echo "$(GREEN)All images built successfully!$(RESET)"

.PHONY: build-controlnet
build-controlnet: ## Build only ControlNet Docker image
	@echo "$(BLUE)Building ControlNet image...$(RESET)"
	$(DOCKER_COMPOSE) build controlnet
	@echo "$(GREEN)ControlNet image built successfully!$(RESET)"

# Testing
# ==============================================================================
.PHONY: test-health
test-health: ## Test health endpoints
	@echo "$(BLUE)Testing service health...$(RESET)"
	@curl -f http://localhost:8080/ping && echo "$(GREEN) ✓ ControlNet API healthy$(RESET)" || echo "$(RED) ✗ ControlNet API unhealthy$(RESET)"
	@curl -f http://localhost:3001/health 2>/dev/null && echo "$(GREEN) ✓ API Gateway healthy$(RESET)" || echo "$(YELLOW) - API Gateway not available$(RESET)"

.PHONY: test-local
test-local: ## Run test QR generation against local ControlNet (run make dev-controlnet first)
	@echo "$(BLUE)Testing local QR generation...$(RESET)"
	@if ! curl -f http://localhost:8080/ping >/dev/null 2>&1; then \
		echo "$(RED)ControlNet not available. Run 'make dev-controlnet' first.$(RESET)"; exit 1; \
	fi
	@curl -X POST http://localhost:8080/invocations \
		-H "Content-Type: application/json" \
		-d '{"prompt":"A japanese small village full of cherry blosom trees and snowy landscape","base_qr_code":["https://$(MODEL_S3_BUCKET).s3.$(AWS_REGION).amazonaws.com/user-qr-codes/test/qr2.png"],"num_images_per_prompt":3,"negative_prompt":"ugly, disfigured, low quality, blurry, nsfw","sampler":"dpm++_2m_karras","model":"dreamshaper","controlnet_conditioning_scale":[1.35,0.1],"control_guidance_start":[0.1,0.1],"control_guidance_end":[0.9,0.98],"guidance_scale":7,"num_inference_steps":60,"height":1024,"width":1024,"seed":12345}' \
		--output test_response.json \
		--write-out "\n$(GREEN)Response status: %{http_code}$(RESET)\n"
	@if [ -f test_response.json ]; then \
		echo "$(GREEN)Response saved to test_response.json$(RESET)"; \
		grep -q '"images"' test_response.json 2>/dev/null && echo "$(GREEN)✓ Response contains image data$(RESET)" || true; \
		grep -q '"error"' test_response.json 2>/dev/null && (echo "$(RED)✗ API error:$(RESET)"; cat test_response.json | head -3) || true; \
	fi

.PHONY: test-sagemaker
test-sagemaker: ## Test SageMaker production endpoint
	@echo "$(BLUE)Testing SageMaker endpoint...$(RESET)"
	@cd apps/controlnet/test_client && python test_sagemaker_local.py \
		--endpoint "https://runtime.sagemaker.$(AWS_REGION).amazonaws.com/endpoints/controlnet-qr-endpoint/invocations" \
		--prompt "A QR code in Van Gogh style" \
		--steps 20

.PHONY: test-api-server
test-api-server: ## Test running API server (production mode)
	@echo "$(BLUE)Testing API server at http://localhost:3001...$(RESET)"
	@if ! curl -f http://localhost:3001/api/health >/dev/null 2>&1; then \
		echo "$(RED)API not available. Start with 'turbo run dev:production --filter api'$(RESET)"; exit 1; \
	fi
	@curl -X POST http://localhost:3001/api/qr-generation \
		-H "Content-Type: application/json" \
		-d '{"prompt":"A japanese small village full of cherry blosom trees and snowy landscape","baseQrCode":["https://$(MODEL_S3_BUCKET).s3.$(AWS_REGION).amazonaws.com/user-qr-codes/test/qr3.png","https://$(MODEL_S3_BUCKET).s3.$(AWS_REGION).amazonaws.com/user-qr-codes/test/qr2.png"],"numImagesPerPrompt":3,"negativePrompt":"ugly, disfigured, low quality, blurry, nsfw","sampler":"dpm++_2m_karras","model":"dreamshaper","controlnetConditioningScale":[1.4,0.1],"controlGuidanceStart":[0,0.1],"controlGuidanceEnd":[1,1],"guidanceScale":7,"numInferenceSteps":40,"height":1024,"width":1024}' \
		--output api_server_response.json \
		--write-out "\n$(GREEN)Response status: %{http_code}$(RESET)\n"
	@if [ -f api_server_response.json ] && grep -q '"jobId"' api_server_response.json 2>/dev/null; then \
		JOB_ID=$$(cat api_server_response.json | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4); \
		echo "$(GREEN)Job created: $$JOB_ID — poll with: make poll-job JOB_ID=$$JOB_ID$(RESET)"; \
	fi

.PHONY: poll-job
poll-job: ## Poll job status until completion (make poll-job JOB_ID=your-job-id)
	@if [ -z "$(JOB_ID)" ]; then echo "$(RED)Usage: make poll-job JOB_ID=your-job-id$(RESET)"; exit 1; fi
	@echo "$(BLUE)Polling job $(JOB_ID)...$(RESET)"
	@for i in $$(seq 1 100); do \
		curl -s http://localhost:3001/api/qr-generation/$(JOB_ID)/status --output /tmp/job_status.json; \
		STATUS=$$(cat /tmp/job_status.json | grep -o '"status":"[^"]*"' | cut -d'"' -f4); \
		echo "$(CYAN)$$i: $$STATUS$(RESET)"; \
		[ "$$STATUS" = "completed" ] && echo "$(GREEN)Job completed$(RESET)" && cat /tmp/job_status.json && break; \
		[ "$$STATUS" = "failed" ] && echo "$(RED)Job failed$(RESET)" && cat /tmp/job_status.json && break; \
		sleep 10; \
	done

# The plan-008 QR quality eval (operator tuning tool — never run in CI: a
# full matrix is GPU time and money). Wraps apps/controlnet/eval/run_eval.py
# against the local docker-compose container; pass extra flags via EVAL_ARGS
# (e.g. make eval-qr EVAL_ARGS="--limit 2 --seeds 1001") and use
# `--target staging --api-url ...` directly on the script for cloud runs.
.PHONY: eval-qr
eval-qr: ## Run the QR quality eval vs local ControlNet (writes apps/controlnet/eval/{results.json,report.html})
	@echo "$(BLUE)Running plan-008 QR quality eval (local target)...$(RESET)"
	@if ! curl -f http://localhost:8080/ping >/dev/null 2>&1; then \
		echo "$(RED)ControlNet not available. Run 'make dev-controlnet' first.$(RESET)"; exit 1; \
	fi
	@python3 apps/controlnet/eval/run_eval.py --target local $(EVAL_ARGS)
	@echo "$(GREEN)Eval complete — open apps/controlnet/eval/report.html$(RESET)"

# AWS / ECR / S3 Models
# ==============================================================================
.PHONY: aws-login
aws-login: check-env ## Login to AWS ECR
	@echo "$(BLUE)Logging in to AWS ECR...$(RESET)"
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin $(ECR_REPOSITORY)
	@echo "$(GREEN)Logged in to ECR$(RESET)"

.PHONY: create-ecr-repo
create-ecr-repo: check-env ## Create ECR repository if missing
	@aws ecr describe-repositories --repository-names controlnet-ai-qr-generator --region $(AWS_REGION) >/dev/null 2>&1 || \
		aws ecr create-repository --repository-name controlnet-ai-qr-generator --region $(AWS_REGION)
	@echo "$(GREEN)ECR repository ready$(RESET)"

.PHONY: push-controlnet
push-controlnet: check-env aws-login create-ecr-repo ## Build and push ControlNet image to ECR (latest)
	@echo "$(BLUE)Building and pushing ControlNet image...$(RESET)"
	@cd apps/controlnet && docker build --platform linux/amd64 -t controlnet-ai-qr-generator:latest .
	@docker tag controlnet-ai-qr-generator:latest $(CONTROLNET_IMAGE)
	@docker push $(CONTROLNET_IMAGE)
	@echo "$(GREEN)Pushed: $(CONTROLNET_IMAGE)$(RESET)"
	@echo "$(YELLOW)Ensure base models are on S3: make upload-sd-models$(RESET)"

STAGING_TAG ?= staging
CONTROLNET_STAGING_IMAGE := $(ECR_REPOSITORY)/controlnet-ai-qr-generator:$(STAGING_TAG)

.PHONY: push-controlnet-staging
push-controlnet-staging: check-env aws-login create-ecr-repo ## Build and push ControlNet staging image
	@echo "$(BLUE)Building and pushing ControlNet staging ($(STAGING_TAG))...$(RESET)"
	@cd apps/controlnet && docker build --platform linux/amd64 -t controlnet-ai-qr-generator:$(STAGING_TAG) .
	@docker tag controlnet-ai-qr-generator:$(STAGING_TAG) $(CONTROLNET_STAGING_IMAGE)
	@docker push $(CONTROLNET_STAGING_IMAGE)
	@echo "$(GREEN)Pushed: $(CONTROLNET_STAGING_IMAGE)$(RESET)"

MODEL_S3_BUCKET ?= $(shell grep '^MODEL_S3_BUCKET=' .env 2>/dev/null | cut -d '=' -f2)
MODEL_S3_PREFIX ?= sd-models

.PHONY: upload-sd-model
upload-sd-model: ## Upload one SD model (make upload-sd-model HF_MODEL_ID=digiplay/GhostMixV1.2VAE S3_KEY=ghostmix)
	@if [ -z "$(MODEL_S3_BUCKET)" ]; then \
		echo "$(RED)Error: MODEL_S3_BUCKET is required. Set it in your .env or pass it: MODEL_S3_BUCKET=your-bucket make upload-sd-model ...$(RESET)"; exit 1; \
	fi
	@if [ -z "$(HF_MODEL_ID)" ] || [ -z "$(S3_KEY)" ]; then \
		echo "$(RED)Usage: make upload-sd-model HF_MODEL_ID=... S3_KEY=...$(RESET)"; exit 1; \
	fi
	@cd apps/controlnet && pip install -q -r requirements.txt && \
		MODEL_S3_BUCKET="$(MODEL_S3_BUCKET)" MODEL_S3_PREFIX="$(MODEL_S3_PREFIX)" \
		python scripts/upload_sd_model.py "$(HF_MODEL_ID)" "$(S3_KEY)"
	@echo "$(GREEN)Uploaded to s3://$(MODEL_S3_BUCKET)/$(MODEL_S3_PREFIX)/$(S3_KEY)/$(RESET)"

PROMPT_ENHANCER_S3_PREFIX ?= llm-models

.PHONY: upload-llm-model
upload-llm-model: ## Upload the prompt-enhancer LLM to S3 (plan 009; defaults to Qwen2.5-1.5B-Instruct)
	@if [ -z "$(MODEL_S3_BUCKET)" ]; then \
		echo "$(RED)Error: MODEL_S3_BUCKET is required. Set it in your .env or pass it: MODEL_S3_BUCKET=your-bucket make upload-llm-model$(RESET)"; exit 1; \
	fi
	@cd apps/controlnet && \
		PY=$$([ -f venv/bin/python ] && echo ./venv/bin/python || echo python) && \
		{ $$PY -c "import huggingface_hub" 2>/dev/null || $$PY -m pip install -q huggingface_hub; } && \
		MODEL_S3_BUCKET="$(MODEL_S3_BUCKET)" PROMPT_ENHANCER_S3_PREFIX="$(PROMPT_ENHANCER_S3_PREFIX)" \
		$$PY scripts/upload_llm_model.py
	@echo "$(GREEN)Uploaded prompt-enhancer LLM to s3://$(MODEL_S3_BUCKET)/$(PROMPT_ENHANCER_S3_PREFIX)/$(RESET)"

.PHONY: upload-sd-models
upload-sd-models: ## Upload all registered SD models to S3
	@echo "$(BLUE)Uploading all registered base models to S3...$(RESET)"
	@$(MAKE) upload-sd-model HF_MODEL_ID="digiplay/GhostMixV1.2VAE" S3_KEY="ghostmix"
	@$(MAKE) upload-sd-model HF_MODEL_ID="Lykon/DreamShaper" S3_KEY="dreamshaper"
	@$(MAKE) upload-sd-model HF_MODEL_ID="SG161222/Realistic_Vision_V5.1_noVAE" S3_KEY="realistic_vision"
	@$(MAKE) upload-sd-model HF_MODEL_ID="stablediffusionapi/rev-animated" S3_KEY="rev_animated"
	@$(MAKE) upload-sd-model HF_MODEL_ID="emilianJR/epiCRealism" S3_KEY="epicrealism"
	@$(MAKE) upload-sd-model HF_MODEL_ID="stablediffusionapi/anything-v5" S3_KEY="anything_v5"
	@$(MAKE) upload-sd-model HF_MODEL_ID="stablediffusionapi/meinamixv11" S3_KEY="meinamix"
	@$(MAKE) upload-sd-model HF_MODEL_ID="digiplay/AbsoluteReality_v1.8.1" S3_KEY="absolute_reality"
	@$(MAKE) upload-sd-model HF_MODEL_ID="stablediffusionapi/cyberrealistic-v32" S3_KEY="cyberrealistic"
	@echo "$(GREEN)All models uploaded!$(RESET)"

.PHONY: list-sd-models
list-sd-models: ## List SD models in S3
	@aws s3 ls s3://$(MODEL_S3_BUCKET)/$(MODEL_S3_PREFIX)/ --human-readable

# Deployment
# ==============================================================================
.PHONY: deploy-sagemaker
deploy-sagemaker: push-controlnet ## Deploy to SageMaker production
	@echo "$(BLUE)Deploying to SageMaker (PRODUCTION)...$(RESET)"
	@cd apps/controlnet && \
		PY=$$([ -f venv/bin/python ] && echo ./venv/bin/python || echo python) && \
		ENABLE_S3_MODEL_LOADING=True MODEL_KEY=epicrealism $$PY deploy_sagemaker.py
	@echo "$(GREEN)SageMaker production deployed$(RESET)"

STAGING_INSTANCE_TYPE ?= ml.g5.xlarge
STAGING_MODEL_KEY ?= epicrealism

.PHONY: deploy-sagemaker-staging
deploy-sagemaker-staging: push-controlnet-staging ## Deploy to SageMaker staging
	@echo "$(BLUE)Deploying to SageMaker (STAGING)...$(RESET)"
	@cd apps/controlnet && \
		PY=$$([ -f venv/bin/python ] && echo ./venv/bin/python || echo python) && \
		ENABLE_S3_MODEL_LOADING=True MODEL_KEY=$(STAGING_MODEL_KEY) $$PY deploy_sagemaker.py --staging --image-tag $(STAGING_TAG) --instance-type $(STAGING_INSTANCE_TYPE)
	@echo "$(GREEN)SageMaker staging deployed$(RESET)"

.PHONY: teardown-staging
teardown-staging: ## Delete staging SageMaker endpoint
	@aws sagemaker delete-endpoint --endpoint-name controlnet-qr-endpoint-staging --region $(AWS_REGION) 2>/dev/null && echo "$(GREEN)Staging endpoint deleted$(RESET)" || echo "$(YELLOW)Staging endpoint not found$(RESET)"
	@aws sagemaker delete-endpoint-config --endpoint-config-name controlnet-qr-endpoint-staging --region $(AWS_REGION) 2>/dev/null || true
	@aws sagemaker delete-model --model-name controlnet-qr-model-staging --region $(AWS_REGION) 2>/dev/null || true

.PHONY: deploy-client
deploy-client: ## Build workspace packages + client and deploy to S3
	@pnpm -r --filter '@repo/*' run build
	@cd apps/client && bash deploy-to-s3.sh
	@echo "$(GREEN)Client deployed$(RESET)"

.PHONY: deploy-client-netlify
deploy-client-netlify: ## Build workspace packages + client and deploy to Netlify (run `netlify login` once first)
	@pnpm -r --filter '@repo/*' run build
	@cd apps/client && bash deploy-to-netlify.sh
	@echo "$(GREEN)Client deployed to Netlify$(RESET)"

.PHONY: deploy-api
deploy-api: ## Deploy API to AWS Lambda (Serverless, prod)
	@pnpm -r --filter '@repo/*' run build
	@cd apps/api && npx serverless deploy --stage prod
	@echo "$(GREEN)API deployed$(RESET)"

.PHONY: deploy-api-staging
deploy-api-staging: ## Deploy API to AWS Lambda (staging)
	@pnpm -r --filter '@repo/*' run build
	@cd apps/api && npx serverless deploy --stage staging
	@echo "$(GREEN)API (staging) deployed$(RESET)"

# The API-Gateway relay Lambda (apps/controlnet/app/lambda.py) is hand-managed:
# no other deploy target touches it, so edits to lambda.py (e.g. new payload
# whitelist fields) are inert in staging/prod until this target runs. Before
# deploying, diff the DEPLOYED code against the repo copy and reconcile drift
# (plan-008 STOP condition): aws lambda get-function --function-name
# $(RELAY_LAMBDA_NAME) --query 'Code.Location', download the zip, diff.
# RELAY_LAMBDA_NAME comes from the environment or .env (see .env.example).
RELAY_LAMBDA_NAME ?= $(shell grep RELAY_LAMBDA_NAME .env 2>/dev/null | cut -d '=' -f2)

.PHONY: deploy-relay-lambda
deploy-relay-lambda: check-env ## Deploy the API-Gateway relay Lambda from apps/controlnet/app/lambda.py (RELAY_LAMBDA_NAME from .env)
	@if [ -z "$(RELAY_LAMBDA_NAME)" ]; then \
		echo "$(RED)Error: RELAY_LAMBDA_NAME is required. Set it in your .env or pass it: RELAY_LAMBDA_NAME=your-relay-function make deploy-relay-lambda$(RESET)"; exit 1; \
	fi
	@echo "$(BLUE)Deploying relay lambda ($(RELAY_LAMBDA_NAME)) from apps/controlnet/app/lambda.py...$(RESET)"
	@# The deployed function's Handler is `lambda_function.lambda_handler` (AWS's
	@# default). The module inside the zip MUST therefore be named
	@# `lambda_function.py`, NOT `lambda.py` — otherwise every invocation dies with
	@# `Runtime.ImportModuleError: No module named 'lambda_function'` and API
	@# Gateway returns 502. Do not "simplify" this back to `zip -j ... lambda.py`.
	@ZIPDIR=$$(mktemp -d) && \
		cp apps/controlnet/app/lambda.py $$ZIPDIR/lambda_function.py && \
		zip -q -j $$ZIPDIR/relay-lambda.zip $$ZIPDIR/lambda_function.py && \
		aws lambda update-function-code \
			--function-name "$(RELAY_LAMBDA_NAME)" \
			--zip-file fileb://$$ZIPDIR/relay-lambda.zip \
			--region $(AWS_REGION) > /dev/null && \
		rm -rf $$ZIPDIR
	@echo "$(GREEN)Relay lambda $(RELAY_LAMBDA_NAME) updated from apps/controlnet/app/lambda.py$(RESET)"

# Scaling (manual)
# ==============================================================================
.PHONY: scale-up
scale-up: ## Scale production endpoint to 1 instance
	@echo "Suspending scale-in to prevent premature scale-down during startup..."
	@aws application-autoscaling register-scalable-target \
		--service-namespace sagemaker \
		--resource-id endpoint/controlnet-qr-endpoint/variant/AllTraffic \
		--scalable-dimension sagemaker:variant:DesiredInstanceCount \
		--suspended-state '{"DynamicScalingInSuspended":true}'
	@aws sagemaker update-endpoint-weights-and-capacities \
		--endpoint-name controlnet-qr-endpoint \
		--desired-weights-and-capacities VariantName=AllTraffic,DesiredInstanceCount=1
	@echo "$(GREEN)Scaling to 1 instance (scale-in suspended for 60 min)$(RESET)"

.PHONY: scale-down
scale-down: ## Scale production endpoint to 0 instances
	@echo "Re-enabling scale-in..."
	@aws application-autoscaling register-scalable-target \
		--service-namespace sagemaker \
		--resource-id endpoint/controlnet-qr-endpoint/variant/AllTraffic \
		--scalable-dimension sagemaker:variant:DesiredInstanceCount \
		--suspended-state '{"DynamicScalingInSuspended":false}'
	@aws sagemaker update-endpoint-weights-and-capacities \
		--endpoint-name controlnet-qr-endpoint \
		--desired-weights-and-capacities VariantName=AllTraffic,DesiredInstanceCount=0
	@echo "$(GREEN)Scaling to 0 instances$(RESET)"

.PHONY: scaling-status
scaling-status: ## Show current endpoint instance count
	@aws sagemaker describe-endpoint --endpoint-name controlnet-qr-endpoint \
		--query 'ProductionVariants[0].{Current:CurrentInstanceCount,Desired:DesiredInstanceCount}' --output table

.PHONY: scale-up-staging
scale-up-staging: ## Scale staging endpoint to 1 instance
	@echo "Suspending scale-in to prevent premature scale-down during startup..."
	@aws application-autoscaling register-scalable-target \
		--service-namespace sagemaker \
		--resource-id endpoint/controlnet-qr-endpoint-staging/variant/AllTraffic \
		--scalable-dimension sagemaker:variant:DesiredInstanceCount \
		--suspended-state '{"DynamicScalingInSuspended":true}'
	@aws sagemaker update-endpoint-weights-and-capacities \
		--endpoint-name controlnet-qr-endpoint-staging \
		--desired-weights-and-capacities VariantName=AllTraffic,DesiredInstanceCount=1
	@echo "$(GREEN)Staging scaling to 1 (scale-in suspended for 60 min)$(RESET)"

.PHONY: scale-down-staging
scale-down-staging: ## Scale staging endpoint to 0
	@echo "Re-enabling scale-in..."
	@aws application-autoscaling register-scalable-target \
		--service-namespace sagemaker \
		--resource-id endpoint/controlnet-qr-endpoint-staging/variant/AllTraffic \
		--scalable-dimension sagemaker:variant:DesiredInstanceCount \
		--suspended-state '{"DynamicScalingInSuspended":false}'
	@aws sagemaker update-endpoint-weights-and-capacities \
		--endpoint-name controlnet-qr-endpoint-staging \
		--desired-weights-and-capacities VariantName=AllTraffic,DesiredInstanceCount=0
	@echo "$(GREEN)Staging scaled to 0$(RESET)"

# Versioned release & rollback
# ==============================================================================
IMAGE_VERSION ?= $(shell git describe --tags --abbrev=0 2>/dev/null)
ECR_REPO_NAME ?= controlnet-ai-qr-generator

.PHONY: check-version
check-version:
	@if [ -z "$(IMAGE_VERSION)" ]; then \
		echo "$(RED)IMAGE_VERSION not set and no git tags. Use: make <target> IMAGE_VERSION=v1.1.0$(RESET)"; exit 1; \
	fi
	@echo "$(GREEN)Image version: $(IMAGE_VERSION)$(RESET)"

.PHONY: tag-rollback
tag-rollback: check-env
	@ROLLBACK_TAG="rollback-$$(date +%Y%m%d-%H%M%S)"; \
	TMPFILE=$$(mktemp); \
	aws ecr batch-get-image --repository-name $(ECR_REPO_NAME) --region $(AWS_REGION) --image-ids imageTag=latest --query 'images[0].imageManifest' --output text 2>/dev/null > $$TMPFILE; \
	MANIFEST_CONTENT=$$(cat $$TMPFILE); rm -f $$TMPFILE; \
	if [ -z "$$MANIFEST_CONTENT" ] || [ "$$MANIFEST_CONTENT" = "None" ]; then \
		echo "$(YELLOW)No :latest in ECR$(RESET)"; \
	else \
		aws ecr put-image --repository-name $(ECR_REPO_NAME) --region $(AWS_REGION) --image-tag "$$ROLLBACK_TAG" --image-manifest "$$MANIFEST_CONTENT" > /dev/null 2>&1 && \
		echo "$(GREEN)Rollback tag: $$ROLLBACK_TAG — use: make rollback ROLLBACK_TAG=$$ROLLBACK_TAG$(RESET)"; \
	fi

.PHONY: push-controlnet-versioned
push-controlnet-versioned: check-env check-version aws-login create-ecr-repo
	@echo "$(BLUE)Building and pushing $(IMAGE_VERSION)...$(RESET)"
	@cd apps/controlnet && docker build --platform linux/amd64 -t $(ECR_REPO_NAME):$(IMAGE_VERSION) .
	@docker tag $(ECR_REPO_NAME):$(IMAGE_VERSION) $(ECR_REPOSITORY)/$(ECR_REPO_NAME):$(IMAGE_VERSION)
	@docker push $(ECR_REPOSITORY)/$(ECR_REPO_NAME):$(IMAGE_VERSION)
	@docker tag $(ECR_REPO_NAME):$(IMAGE_VERSION) $(ECR_REPOSITORY)/$(ECR_REPO_NAME):latest
	@docker push $(ECR_REPOSITORY)/$(ECR_REPO_NAME):latest
	@echo "$(GREEN)Pushed $(IMAGE_VERSION) and :latest$(RESET)"

.PHONY: deploy-sagemaker-update
deploy-sagemaker-update: check-env check-version
	@cd apps/controlnet && \
		PY=$$([ -f venv/bin/python ] && echo ./venv/bin/python || echo python) && \
		ENABLE_S3_MODEL_LOADING=True MODEL_KEY=epicrealism $$PY deploy_sagemaker.py --image-tag $(IMAGE_VERSION) --update-only
	@echo "$(GREEN)Production updated to $(IMAGE_VERSION)$(RESET)"

.PHONY: deploy-sagemaker-update-staging
deploy-sagemaker-update-staging: check-env check-version
	@cd apps/controlnet && \
		PY=$$([ -f venv/bin/python ] && echo ./venv/bin/python || echo python) && \
		ENABLE_S3_MODEL_LOADING=True MODEL_KEY=$(STAGING_MODEL_KEY) $$PY deploy_sagemaker.py --staging --image-tag $(IMAGE_VERSION) --update-only
	@echo "$(GREEN)Staging updated to $(IMAGE_VERSION)$(RESET)"

.PHONY: release
release: tag-rollback push-controlnet-versioned deploy-sagemaker-update ## Full production release (make release IMAGE_VERSION=v1.1.0)
	@echo "$(GREEN)Release $(IMAGE_VERSION) is live$(RESET)"
	@echo "$(CYAN)Rollback: make rollback ROLLBACK_TAG=<tag from above>$(RESET)"

.PHONY: release-staging
release-staging: push-controlnet-versioned deploy-sagemaker-update-staging ## Staging release (make release-staging IMAGE_VERSION=v1.1.0-rc1)
	@echo "$(GREEN)Staging release $(IMAGE_VERSION) complete$(RESET)"

ROLLBACK_TAG ?=

.PHONY: rollback
rollback: check-env ## Rollback production (make rollback ROLLBACK_TAG=rollback-YYYYMMDD-HHMMSS)
	@if [ -z "$(ROLLBACK_TAG)" ]; then echo "$(RED)Usage: make rollback ROLLBACK_TAG=...$(RESET)"; echo "Tags: make list-image-tags"; exit 1; fi
	@echo "$(YELLOW)Rolling back to $(ROLLBACK_TAG)$(RESET)"
	@cd apps/controlnet && \
		PY=$$([ -f venv/bin/python ] && echo ./venv/bin/python || echo python) && \
		ENABLE_S3_MODEL_LOADING=True $$PY deploy_sagemaker.py --image-tag $(ROLLBACK_TAG) --update-only
	@echo "$(GREEN)Rolled back to $(ROLLBACK_TAG)$(RESET)"

.PHONY: rollback-staging
rollback-staging: check-env
	@if [ -z "$(ROLLBACK_TAG)" ]; then echo "$(RED)Usage: make rollback-staging ROLLBACK_TAG=...$(RESET)"; exit 1; fi
	@cd apps/controlnet && \
		PY=$$([ -f venv/bin/python ] && echo ./venv/bin/python || echo python) && \
		ENABLE_S3_MODEL_LOADING=True $$PY deploy_sagemaker.py --staging --image-tag $(ROLLBACK_TAG) --update-only
	@echo "$(GREEN)Staging rolled back to $(ROLLBACK_TAG)$(RESET)"

.PHONY: list-image-tags
list-image-tags: check-env ## List ECR image tags
	@aws ecr describe-images --repository-name $(ECR_REPO_NAME) --region $(AWS_REGION) \
		--query 'reverse(sort_by(imageDetails, &imagePushedAt))[*].{Tags:imageTags[0],Pushed:imagePushedAt}' --output table 2>/dev/null || echo "$(RED)No images or ECR not accessible$(RESET)"

# Quick & API
# ==============================================================================
.PHONY: quick-start
quick-start: setup dev-controlnet test-health ## Setup + start ControlNet + health check
	@echo "$(GREEN)ControlNet ready at http://localhost:8080$(RESET)"

.PHONY: quick-test
quick-test: test-health test-local ## Health check + local test

.PHONY: quick-deploy
quick-deploy: push-controlnet deploy-sagemaker ## Build, push, deploy to SageMaker

.PHONY: start-api-production
start-api-production: ## Start API server in production mode (Ctrl+C to stop)
	@echo "$(BLUE)Starting API (production mode)...$(RESET)"
	turbo run dev:production --filter api

# Help
# ==============================================================================
.PHONY: help
help: ## Show this help
	@echo "$(BLUE)$(PROJECT_NAME) — targets$(RESET)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-28s$(RESET) %s\n", $$1, $$2}' | sort
	@echo ""
	@echo "$(YELLOW)Release:$(RESET) make release IMAGE_VERSION=v1.1.0"
	@echo "$(YELLOW)Rollback:$(RESET) make rollback ROLLBACK_TAG=rollback-YYYYMMDD-HHMMSS"
