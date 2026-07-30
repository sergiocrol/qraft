import { z } from "zod";
import type { QRGenerationRequest } from "@repo/shared-types";
import {
  SUPPORTED_SAMPLERS,
  SUPPORTED_MODELS,
  SUPPORTED_PIPELINES,
  STYLE_PRESETS,
  SCAN_STRICTNESS,
  QR_CONTENT_MAX_LENGTH,
  IMAGE_CONSTRAINTS,
  INFERENCE_CONSTRAINTS,
  GUIDANCE_CONSTRAINTS,
  GUIDANCE_RANGE,
  SEED_CONSTRAINTS,
  DEFAULT_CONTROLNET_PARAMS,
  VALIDATION_MESSAGES,
} from "@repo/qr-constants";
import { ZodTuple } from "zod/v4";

// baseQrCode element validator: legitimate values are always https URLs under
// the app's own S3 public domain (produced by /api/upload-qr), so the boundary
// can be strict. The shared package doesn't know the runtime S3_PUBLIC_DOMAIN,
// so this stays host-agnostic but rejects non-https schemes and obvious
// internal targets; full IP-range blocking happens at the container fetch sink
// where DNS resolution occurs.
const qrUrl = z
  .string()
  .url(VALIDATION_MESSAGES.INVALID_URL)
  .refine((u) => {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "https:") return false;
      const host = parsed.hostname.toLowerCase();
      // reject localhost / obvious internal hosts at the boundary
      if (host === "localhost" || host.endsWith(".localhost")) return false;
      if (host === "169.254.169.254") return false; // cloud metadata
      return true;
    } catch {
      return false;
    }
  }, "QR code URL must be a public https URL");

// QR Generation Request Schema
export const QRGenerationRequestSchema = z.object({
  // Core parameters
  prompt: z
    .string()
    .min(1, VALIDATION_MESSAGES.PROMPT_REQUIRED)
    .max(
      IMAGE_CONSTRAINTS.MAX_PROMPT_LENGTH,
      VALIDATION_MESSAGES.PROMPT_TOO_LONG
    ),

  baseQrCode: z
    .array(qrUrl)
    .min(1, VALIDATION_MESSAGES.QR_CODE_REQUIRED)
    .max(
      IMAGE_CONSTRAINTS.MAX_QR_CODES,
      VALIDATION_MESSAGES.QR_CODE_MAX_EXCEEDED
    ),

  numImagesPerPrompt: z
    .number()
    .int()
    .min(1)
    .max(IMAGE_CONSTRAINTS.MAX_IMAGES_PER_PROMPT)
    .optional(),

  // Generation parameters
  negativePrompt: z
    .string()
    .max(IMAGE_CONSTRAINTS.MAX_NEGATIVE_PROMPT_LENGTH)
    .default(DEFAULT_CONTROLNET_PARAMS.negativePrompt),

  numInferenceSteps: z
    .number()
    .int()
    .min(INFERENCE_CONSTRAINTS.MIN_STEPS)
    .max(INFERENCE_CONSTRAINTS.MAX_STEPS, VALIDATION_MESSAGES.INVALID_STEPS)
    .default(DEFAULT_CONTROLNET_PARAMS.numInferenceSteps),

  controlnetConditioningScale: z
    .tuple([z.number().min(0).max(2), z.number().min(0).max(2)])
    .default([...DEFAULT_CONTROLNET_PARAMS.controlnetConditioningScale]),

  controlGuidanceStart: z
    .tuple([
      z.number().min(GUIDANCE_RANGE.MIN).max(GUIDANCE_RANGE.MAX),
      z.number().min(GUIDANCE_RANGE.MIN).max(GUIDANCE_RANGE.MAX),
    ])
    .default([...DEFAULT_CONTROLNET_PARAMS.controlGuidanceStart]),

  controlGuidanceEnd: z
    .tuple([
      z.number().min(GUIDANCE_RANGE.MIN).max(GUIDANCE_RANGE.MAX),
      z.number().min(GUIDANCE_RANGE.MIN).max(GUIDANCE_RANGE.MAX),
    ])
    .default([...DEFAULT_CONTROLNET_PARAMS.controlGuidanceEnd]),

  // Image parameters
  height: z
    .number()
    .int()
    .min(IMAGE_CONSTRAINTS.MIN_DIMENSION)
    .max(IMAGE_CONSTRAINTS.MAX_DIMENSION)
    .refine(
      (val) => val % IMAGE_CONSTRAINTS.DIMENSION_MULTIPLE === 0,
      VALIDATION_MESSAGES.INVALID_DIMENSIONS
    )
    .default(DEFAULT_CONTROLNET_PARAMS.height),

  width: z
    .number()
    .int()
    .min(IMAGE_CONSTRAINTS.MIN_DIMENSION)
    .max(IMAGE_CONSTRAINTS.MAX_DIMENSION)
    .refine(
      (val) => val % IMAGE_CONSTRAINTS.DIMENSION_MULTIPLE === 0,
      VALIDATION_MESSAGES.INVALID_DIMENSIONS
    )
    .default(DEFAULT_CONTROLNET_PARAMS.width),

  // Model parameters
  sampler: z
    .enum(SUPPORTED_SAMPLERS)
    .default(DEFAULT_CONTROLNET_PARAMS.sampler),

  guidanceScale: z
    .number()
    .min(GUIDANCE_CONSTRAINTS.MIN_SCALE)
    .max(GUIDANCE_CONSTRAINTS.MAX_SCALE, VALIDATION_MESSAGES.INVALID_GUIDANCE)
    .default(DEFAULT_CONTROLNET_PARAMS.guidanceScale),

  model: z.enum(SUPPORTED_MODELS).default(DEFAULT_CONTROLNET_PARAMS.model),

  seed: z
    .number()
    .int()
    .min(SEED_CONSTRAINTS.MIN_SEED)
    .max(SEED_CONSTRAINTS.MAX_SEED, VALIDATION_MESSAGES.INVALID_SEED)
    .optional(),

  // Advanced parameters
  guessMode: z.boolean().default(false),

  promptEnhancement: z.boolean().default(true),

  // Environment routing (staging vs production)
  environment: z.enum(["production", "staging"]).optional(),

  // v2 pipeline fields (plan 008). Deliberately NO defaults: an absent field
  // must stay absent so the container's own default ("v1") rules.
  pipeline: z.enum(SUPPORTED_PIPELINES).optional(),

  qrContent: z.string().min(1).max(QR_CONTENT_MAX_LENGTH).optional(),

  stylePreset: z.enum(STYLE_PRESETS).optional(),

  scanStrictness: z.enum(SCAN_STRICTNESS).optional(),
});

// Job creation response schema
export const QRJobCreateResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    jobId: z.string(),
    status: z.literal("pending"),
    message: z.string(),
    estimatedTime: z.string().optional(),
    statusUrl: z.string(),
  }),
  requestId: z.string().optional(),
});

// Job status response schema
export const QRJobStatusResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    jobId: z.string(),
    status: z.enum([
      "pending",
      "processing",
      "completed",
      "failed",
      "cancelled",
    ]),
    progress: z.number().min(0).max(100).optional(),
    message: z.string().optional(),
    createdAt: z.string(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    failedAt: z.string().optional(),
    estimatedTimeRemaining: z.string().optional(),

    // Result when completed
    result: z
      .object({
        images: z.array(z.string()),
        outputPaths: z.array(z.string()),
        numImagesGenerated: z.number(),
        processingTimeSeconds: z.number().optional(),
        generationPlan: z.record(z.any()).optional(),
      })
      .optional(),

    // Error when failed
    error: z
      .object({
        message: z.string(),
        code: z.string().optional(),
        details: z.record(z.any()).optional(),
      })
      .optional(),
  }),
  requestId: z.string().optional(),
});

// Job cancellation response schema
export const QRJobCancelResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    jobId: z.string(),
    status: z.literal("cancelled"),
    message: z.string(),
    cancelledAt: z.string().optional(),
  }),
  requestId: z.string().optional(),
});

// Export inferred types
export type QRGenerationRequestInput = z.infer<
  typeof QRGenerationRequestSchema
>;
export type QRJobCreateResponse = z.infer<typeof QRJobCreateResponseSchema>;
export type QRJobStatusResponse = z.infer<typeof QRJobStatusResponseSchema>;
export type QRJobCancelResponse = z.infer<typeof QRJobCancelResponseSchema>;
