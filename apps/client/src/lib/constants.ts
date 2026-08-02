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

export const DEFAULT_QR_PLACEHOLDER_URL = 'https://qraft.ai/e2e';

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
  // QR Monster conditioning. 1.0 is too weak to hold the code — the image
  // wins and the modules dissolve. 1.35 is what the v2 style presets already
  // use server-side, so this stops the slider from showing a number the
  // pipeline disagrees with.
  //
  // It only *takes effect* on the v1 lane (/staging, and the fallback v2 takes
  // when a QR cannot be canonicalized): on v2 the preset owns the conditioning
  // scales and the request value is ignored.
  controlnetScale1: 1.35,
  controlnetScale2: DEFAULT_CONTROLNET_PARAMS.controlnetConditioningScale[1],
  guidanceStart1: DEFAULT_CONTROLNET_PARAMS.controlGuidanceStart[0],
  guidanceStart2: DEFAULT_CONTROLNET_PARAMS.controlGuidanceStart[1],
  guidanceEnd1: DEFAULT_CONTROLNET_PARAMS.controlGuidanceEnd[0],
  guidanceEnd2: DEFAULT_CONTROLNET_PARAMS.controlGuidanceEnd[1],
  negativePrompt: DEFAULT_CONTROLNET_PARAMS.negativePrompt,
  sampler: DEFAULT_CONTROLNET_PARAMS.sampler,
  // DreamShaper rather than the shared default (epiCRealism). Measured with
  // every other parameter held constant: a markedly better mean scan score
  // across a fixed prompt set, ahead or level on every subject, and needing
  // less work from the scan-repair ladder. Its painterly bias carries QR
  // modules that epiCRealism's photorealism exposes as pasted-on.
  //
  // Set here rather than in the server-side preset table so that an explicit
  // model choice in the request still wins.
  model: 'dreamshaper',
  guidanceScale: 8.5,
  promptEnhancement: true,
  // Neutral by default. Every other preset prepends and appends a style
  // scaffold to the user's own words, so defaulting to one would quietly
  // rewrite "a photograph of my dog" into an illustration of it.
  stylePreset: 'none',
} as const;

/**
 * Styles offered by the v2 pipeline (server-side `app/presets.py`).
 *
 * Each preset picks a checkpoint AND wraps the prompt in a scaffold, so the
 * hint text says what it will do to the user's words rather than pretending
 * it is only a look. `none` is listed first because it is the honest default:
 * it is the one preset with an empty scaffold, so the prompt is generated
 * exactly as typed.
 */
export const STYLE_PRESET_OPTIONS = [
  { value: 'none', label: 'Neutral', hint: 'Your prompt, untouched' },
  { value: 'illustration', label: 'Illustration', hint: 'Storybook linework, rich colour' },
  { value: 'photo', label: 'Photo', hint: 'Natural light, shallow depth of field' },
  { value: 'cyberpunk', label: 'Cyberpunk', hint: 'Neon, rain-slick, high contrast' },
  { value: 'watercolor', label: 'Watercolour', hint: 'Soft washes and paper texture' },
  { value: 'architecture', label: 'Architecture', hint: 'Geometry, shadow, golden hour' },
] as const;
