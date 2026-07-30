import {
  API_ENDPOINTS,
  TIMEOUT_CONFIG,
  DEFAULT_CONTROLNET_PARAMS,
  IMAGE_CONSTRAINTS,
} from '@repo/qr-constants';

export const API = {
  QR_GENERATION: API_ENDPOINTS.QR_GENERATION,
  JOBS_STATS: API_ENDPOINTS.JOBS_STATS,
  GALLERY_EXAMPLES: API_ENDPOINTS.GALLERY_EXAMPLES,
} as const;

/** How many gallery examples the processing screen rotates through. */
export const GALLERY_EXAMPLES_COUNT = 8;

// client onle api routes
export const CLIENT_API_ROUTES = {
  UPLOAD_QR: '/api/upload-qr',
  ENDPOINT_STATUS: '/api/endpoint/status',
  ENDPOINT_METRICS: '/api/endpoint/metrics',
  ENDPOINT_WAKE: '/api/endpoint/wake',
  ENDPOINT_SCALE: '/api/endpoint/scale',
  ENDPOINT_INSTANCE_TYPE: '/api/endpoint/instance-type',
  AUTH_BASE: '/api/auth',
  AUTH_CHALLENGE: '/api/auth/challenge',
  AUTH_VERIFY: '/api/auth/verify',
} as const;

// build job status url for a given job id
export function qrGenerationStatusUrl(jobId: string): string {
  return `${API.QR_GENERATION}/${jobId}/status`;
}

// build job cancel url for a given job id
export function qrGenerationCancelUrl(jobId: string): string {
  return `${API.QR_GENERATION}/${jobId}`;
}

export const API_REQUEST_TIMEOUT_MS = TIMEOUT_CONFIG.API_REQUEST;

export const ENDPOINT_STATUS_POLL_MS = 60_000;

export const ENDPOINT_STATUS_DEFAULT_POLL_MS = 30_000;

export const JOB_POLL_INTERVAL_MS = 8_000;

export const PROMPT_MIN_LENGTH = 30;

export const DEFAULT_QR_PLACEHOLDER_URL = 'https://testsite.com/qr/ABC12EFD';

export const ADMIN_TOKEN_STORAGE_KEY = 'adminToken';

/**
 * GPU options the admin panel can switch the endpoint between. g5 is the
 * preferred hardware; g4dn is the fallback when g5 capacity is unavailable
 * in eu-west-1 (recurring drought).
 */
export const GPU_INSTANCE_OPTIONS = [
  {
    value: 'ml.g5.xlarge',
    gpu: 'A10G · 24 GB',
    note: 'Faster generations — capacity can be scarce during the day',
  },
  {
    value: 'ml.g4dn.xlarge',
    gpu: 'T4 · 16 GB',
    note: 'Slower, but provisions reliably',
  },
] as const;

export const STAGING_BANNER_MESSAGE =
  'Staging environment — testing against the staging engine';

export const QR_DEFAULTS = {
  WIDTH: IMAGE_CONSTRAINTS.MAX_DIMENSION,
  COLOR_DARK: '#000000',
  COLOR_LIGHT: '#FFFFFF',
} as const;

// form default overrides
export const FORM_DEFAULTS = {
  numImagesPerPrompt: IMAGE_CONSTRAINTS.MAX_IMAGES_PER_PROMPT,
  numInferenceSteps: 40,
  controlnetScale1: 1.0,
  controlnetScale2: DEFAULT_CONTROLNET_PARAMS.controlnetConditioningScale[1],
  guidanceStart1: DEFAULT_CONTROLNET_PARAMS.controlGuidanceStart[0],
  guidanceStart2: DEFAULT_CONTROLNET_PARAMS.controlGuidanceStart[1],
  guidanceEnd1: DEFAULT_CONTROLNET_PARAMS.controlGuidanceEnd[0],
  guidanceEnd2: DEFAULT_CONTROLNET_PARAMS.controlGuidanceEnd[1],
  negativePrompt: DEFAULT_CONTROLNET_PARAMS.negativePrompt,
  sampler: DEFAULT_CONTROLNET_PARAMS.sampler,
  model: DEFAULT_CONTROLNET_PARAMS.model,
  guidanceScale: 8.5,
  promptEnhancement: true,
} as const;
