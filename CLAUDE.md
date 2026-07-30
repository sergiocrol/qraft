# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Qraft.ai — turns a URL + text prompt into an artistic but scannable QR code, using Stable Diffusion with a dual ControlNet setup running on AWS SageMaker. Turborepo/pnpm monorepo (package name `qr-controlnet`).

## Commands

JS/TS workspace (pnpm 9, Node >=18, Turborepo):

```bash
pnpm install
pnpm dev              # turbo run dev (all apps)
pnpm build            # turbo run build
pnpm lint             # turbo run lint
pnpm check-types      # turbo run check-types
pnpm format           # prettier
```

API-specific (in `apps/api/`): `pnpm test` (vitest), `pnpm test -- <pattern>` for a single test, `pnpm test:watch`, `pnpm dev` (tsx watch), `pnpm dev:production` (NODE_ENV=production). In a fresh clone, build the `@repo/*` packages once first (`pnpm -r --filter '@repo/*' run build`) — the tests import `@repo/validation-schemas` from its built output.

Docker/deploy/ops go through the root `Makefile` (`make help` lists everything):

```bash
make dev              # all services via docker-compose (client :3000, api :3001, controlnet :8080)
make dev-controlnet   # only the ML container (needs NVIDIA GPU, ~10GB VRAM)
make test-local       # POST a real generation request to local controlnet
make test-api-server  # exercise the async job API, then: make poll-job JOB_ID=...
make deploy-sagemaker / deploy-api / deploy-client
make release IMAGE_VERSION=v1.1.0   # versioned prod release; make rollback ROLLBACK_TAG=...
```

Staging variants exist for most deploy/scale targets (`deploy-sagemaker-staging`, `scale-up-staging`, etc.). SD base models live in S3 (`make upload-sd-models`), controlled by `MODEL_S3_BUCKET` in `.env`.

## Architecture

Three apps, one flow: async job pipeline from browser → Lambda → GPU.

- **`apps/client/`** — Astro + React frontend (deployed to S3/CloudFront). Submits generation jobs and polls job status; shows a "wake" screen because SageMaker scale-from-zero takes ~3-4 min.
- **`apps/api/`** — Express app that runs both as a local server (`src/server.ts`) and as a Lambda (`src/lambda.ts`, Serverless Framework, `serverless.yml`). On a generation request it stores the job in DynamoDB (`services/DynamoJobStore.ts` / `JobManager.ts`), uploads the input QR to S3, and invokes the SageMaker **async** endpoint (`services/ControlNetService.ts`). Clients poll `GET /api/qr-generation/:jobId/status`.
- **`apps/controlnet/`** — Python/Flask inference container (SageMaker-compatible: `/ping`, `/invocations`; entrypoint `serve.py`, pipeline in `app/models/controlnet.py` and `app/services/inference.py`). Runs SD 1.5 with two simultaneous ControlNets: `qrcode_monster` (structure, conditioning scale ~1.35) + `brightness` (lighting, ~0.1). Base checkpoints are downloaded from S3 at runtime when `ENABLE_S3_MODEL_LOADING=True`. Same image is used locally (docker-compose) and on SageMaker (`deploy_sagemaker.py`).

- **`packages/`** — shared code consumed by both client and api as `@repo/*`: `shared-types`, `validation-schemas` (Zod), `qr-constants`, `typescript-config`. **Build these before deploying** (`pnpm -r --filter '@repo/*' run build` — the Makefile deploy targets do this).

Note the parameter-name boundary: the public API uses camelCase (`baseQrCode`, `numInferenceSteps`), while the controlnet container uses snake_case (`base_qr_code`, `num_inference_steps`).

## Environment

Each service has its own `.env` (root, `apps/api/.env`, `apps/client/.env`, `apps/controlnet/.env`) with `.env.example` templates; `make setup` creates minimal ones. AWS region defaults to `eu-west-1`.
