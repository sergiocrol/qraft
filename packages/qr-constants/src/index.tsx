// ===================================
// CONTROLNET-SPECIFIC CONSTANTS
// ===================================

// Supported samplers (from your ControlNet implementation)
export const SUPPORTED_SAMPLERS = [
  "ddim",
  "pndm",
  "lms",
  "euler",
  "euler_a",
  "dpm++_2m",
  "dpm++_2m_karras",
  "dpm++_sde",
  "dpm++_sde_karras",
  "heun",
  "dpm_2",
  "dpm_2_a",
  "unipc",
  "deis",
  "dpm_fast",
] as const;

// Supported models (from your ControlNet implementation)
export const SUPPORTED_MODELS = [
  "epicrealism",
  "ghostmix",
  "dreamshaper",
  "realistic_vision",
  "rev_animated",
  "anything_v5",
  "meinamix",
  "absolute_reality",
  "cyberrealistic",
] as const;

// Job statuses
export const JOB_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;

// ===================================
// V2 PIPELINE CONSTANTS (plan 008)
// ===================================

// Generation pipelines: "v1" is the legacy behavior (the container's default
// when the field is absent), "v2" is the scannable-by-construction pipeline
export const SUPPORTED_PIPELINES = ["v1", "v2"] as const;

// Style presets, mapped server-side (apps/controlnet/app/presets.py)
export const STYLE_PRESETS = [
  "illustration",
  "photo",
  "cyberpunk",
  "watercolor",
  "architecture",
  "none",
] as const;

// Scan verification strictness (maps to repair budget + acceptance rules)
export const SCAN_STRICTNESS = ["relaxed", "standard", "strict"] as const;

// Max length of the text encoded into the canonical QR (keeps the QR at
// version <=8 with a comfortable ECC budget)
export const QR_CONTENT_MAX_LENGTH = 90;

// ===================================
// DEFAULT CONTROLNET PARAMETERS
// ===================================

// Default values from your ControlNet setup
export const DEFAULT_CONTROLNET_PARAMS = {
  numInferenceSteps: 30,
  controlnetConditioningScale: [1.25, 0.1] as const,
  controlGuidanceStart: [0, 0.1] as const,
  controlGuidanceEnd: [1, 1] as const,
  height: 1024,
  width: 1024,
  sampler: "dpm++_2m_karras" as const,
  guidanceScale: 7,
  model: "epicrealism" as const,
  negativePrompt: "ugly, disfigured, low quality, blurry, nsfw, deformed, mutated, watermark, text, signature, logo, banner, extra digits, cropped, jpeg artifacts, username, error, sketch, duplicate, morbid, gross, out of frame, poorly drawn face, poorly drawn hands, mutation, missing arms, missing legs, extra arms, extra legs, fused fingers, too many fingers, long neck, low resolution, bad anatomy, bad proportions, cloned face, oversaturated",
} as const;

// Alternative conditioning scales (from your QRProcessor)
export const ALTERNATIVE_CONDITIONING_SCALES = [
  [1.45, 0.1],
  [1.0, 0.15],
  [1.35, 0.05],
  [1.15, 0.2],
] as const;

// ===================================
// IMAGE PROCESSING CONSTANTS
// ===================================

// Image constraints (from your ControlNet validation)
export const IMAGE_CONSTRAINTS = {
  MIN_DIMENSION: 512,
  MAX_DIMENSION: 1024,
  DIMENSION_MULTIPLE: 8,
  MAX_QR_CODES: 3,
  MAX_IMAGES_PER_PROMPT: 3,
  MAX_PROMPT_LENGTH: 1000,
  MAX_NEGATIVE_PROMPT_LENGTH: 1000,
} as const;

// Guidance scale constraints
export const GUIDANCE_CONSTRAINTS = {
  MIN_SCALE: 1.0,
  MAX_SCALE: 20.0,
  DEFAULT_SCALE: 7.0,
} as const;

// Control guidance start/end bounds (per-ControlNet tuple values, fraction of
// the denoising schedule) — shared by the Zod schema and the client sliders
export const GUIDANCE_RANGE = {
  MIN: 0,
  MAX: 1,
} as const;

// Inference steps constraints
export const INFERENCE_CONSTRAINTS = {
  MIN_STEPS: 1,
  MAX_STEPS: 100,
  DEFAULT_STEPS: 30,
  FAST_STEPS: 10,
  QUALITY_STEPS: 50,
} as const;

// Seed constraints
export const SEED_CONSTRAINTS = {
  MIN_SEED: 0,
  MAX_SEED: 4294967295, // 2^32 - 1
} as const;

// ===================================
// API CONSTANTS
// ===================================

// API endpoints
export const API_ENDPOINTS = {
  QR_GENERATION: "/api/qr-generation",
  HEALTH: "/api/health",
  HEALTH_READY: "/api/health/ready",
  HEALTH_LIVE: "/api/health/live",
  HEALTH_DETAILED: "/api/health/detailed",
  JOBS: "/api/jobs",
  JOBS_STATS: "/api/jobs/stats",
  UPLOAD_QR: "/api/upload-qr",
  AUTH: "/api/auth",
  ENDPOINT: "/api/endpoint",
  GALLERY: "/api/gallery",
  GALLERY_EXAMPLES: "/api/gallery/examples",
} as const;

// HTTP status codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

// ===================================
// ERROR CODES
// ===================================

// Error codes used throughout the API
export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  JOB_NOT_CANCELLABLE: "JOB_NOT_CANCELLABLE",
  CONTROLNET_SERVICE_ERROR: "CONTROLNET_SERVICE_ERROR",
  SERVICE_TIMEOUT: "SERVICE_TIMEOUT",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  PROCESSING_ERROR: "PROCESSING_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  ASYNC_PROCESSING_ERROR: "ASYNC_PROCESSING_ERROR",
} as const;

// ===================================
// CLIENT CONFIGURATION
// ===================================

// Default polling configuration for job status
export const DEFAULT_POLLING_CONFIG = {
  intervalMs: 10000,
  maxAttempts: 60,
  timeoutMs: 600000,
  initialDelayMs: 1000,
} as const;

// Request timeout configurations
export const TIMEOUT_CONFIG = {
  API_REQUEST: 30000,
  CONTROLNET_REQUEST: 300000,
  HEALTH_CHECK: 5000,
  FILE_UPLOAD: 60000,
} as const;

// Retry configurations
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY: 1000,
  MAX_DELAY: 10000,
  BACKOFF_FACTOR: 2,
} as const;

// ===================================
// JOB MANAGEMENT
// ===================================

// Job cleanup configurations
export const JOB_CONFIG = {
  CLEANUP_INTERVAL_MS: 300000,
  MAX_JOB_AGE_MS: 3600000,
  COMPLETED_JOB_RETENTION_MS: 3600000,
  FAILED_JOB_RETENTION_MS: 7200000,
} as const;

// Pagination defaults
export const PAGINATION_CONFIG = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 10,
  MAX_LIMIT: 100,
  MIN_LIMIT: 1,
} as const;

// ===================================
// ENVIRONMENT DEFAULTS
// ===================================

// Default environment configuration
export const DEFAULT_ENV_CONFIG = {
  PORT: 3001,
  NODE_ENV: "development",
  CONTROLNET_ENDPOINT: "http://localhost:8080",
  LOG_LEVEL: "INFO",
} as const;

// ===================================
// VALIDATION MESSAGES
// ===================================

// Common validation error messages
export const VALIDATION_MESSAGES = {
  PROMPT_REQUIRED: "Prompt is required",
  PROMPT_TOO_LONG: `Prompt must be less than ${IMAGE_CONSTRAINTS.MAX_PROMPT_LENGTH} characters`,
  QR_CODE_REQUIRED: "At least one QR code URL is required",
  QR_CODE_MAX_EXCEEDED: `Maximum ${IMAGE_CONSTRAINTS.MAX_QR_CODES} QR code URLs allowed`,
  INVALID_URL: "Must be a valid URL",
  INVALID_DIMENSIONS:
    "Height and width must be between 512 and 1024 and divisible by 8",
  INVALID_STEPS: `Inference steps must be between ${INFERENCE_CONSTRAINTS.MIN_STEPS} and ${INFERENCE_CONSTRAINTS.MAX_STEPS}`,
  INVALID_GUIDANCE: `Guidance scale must be between ${GUIDANCE_CONSTRAINTS.MIN_SCALE} and ${GUIDANCE_CONSTRAINTS.MAX_SCALE}`,
  INVALID_SEED: `Seed must be between ${SEED_CONSTRAINTS.MIN_SEED} and ${SEED_CONSTRAINTS.MAX_SEED}`,
} as const;

// ===================================
// MODEL-SPECIFIC CONSTANTS
// ===================================

// Model metadata and configurations
export const MODEL_CONFIG = {
  ghostmix: {
    name: "GhostMix",
    description: "High-quality mixed model for diverse artistic styles",
    recommendedSteps: 30,
    maxDimensions: 1024,
  },
  dreamshaper: {
    name: "DreamShaper",
    description: "Stable Diffusion model optimized for artistic content",
    recommendedSteps: 30,
    maxDimensions: 1024,
  },
  realistic_vision: {
    name: "Realistic Vision",
    description: "Photorealistic model with high detail",
    recommendedSteps: 30,
    maxDimensions: 1024,
  },
  rev_animated: {
    name: "RevAnimated",
    description: "Anime/illustration style with vivid colors",
    recommendedSteps: 30,
    maxDimensions: 1024,
  },
  epicrealism: {
    name: "epiCRealism",
    description: "Hyper-realistic generation model",
    recommendedSteps: 30,
    maxDimensions: 1024,
  },
  anything_v5: {
    name: "Anything V5",
    description: "Anime/illustration style with vivid colors",
    recommendedSteps: 30,
    maxDimensions: 1024,
  },
  meinamix: {
    name: "MeinaMix",
    description: "Colorful detailed compositions, artistic style",
    recommendedSteps: 30,
    maxDimensions: 1024,
  },
  absolute_reality: {
    name: "AbsoluteReality",
    description: "Sharp detail with vivid colors, artistic-realistic blend",
    recommendedSteps: 30,
    maxDimensions: 1024,
  },
  cyberrealistic: {
    name: "CyberRealistic",
    description: "Great for cyberpunk/sci-fi themed generations",
    recommendedSteps: 30,
    maxDimensions: 1024,
  },
} as const;

// Sampler metadata and recommendations
export const SAMPLER_CONFIG = {
  "dpm++_2m_karras": {
    name: "DPM++ 2M Karras",
    description: "High quality, good speed (recommended)",
    recommendedSteps: 25,
    quality: "high",
  },
  euler_a: {
    name: "Euler Ancestral",
    description: "Good quality, creative results",
    recommendedSteps: 30,
    quality: "medium",
  },
  ddim: {
    name: "DDIM",
    description: "Fast and stable",
    recommendedSteps: 20,
    quality: "medium",
  },
  dpm_fast: {
    name: "DPM Fast",
    description: "Fastest generation, lower quality",
    recommendedSteps: 10,
    quality: "fast",
  },
} as const;

// ===================================
// TYPE EXPORTS (for TypeScript)
// ===================================

// Export types derived from the constants
export type SupportedSampler = (typeof SUPPORTED_SAMPLERS)[number];
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type SupportedPipeline = (typeof SUPPORTED_PIPELINES)[number];
export type StylePreset = (typeof STYLE_PRESETS)[number];
export type ScanStrictness = (typeof SCAN_STRICTNESS)[number];
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export type ApiEndpoint = (typeof API_ENDPOINTS)[keyof typeof API_ENDPOINTS];
export type HttpStatusCode = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];
