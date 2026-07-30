import { API_ENDPOINTS } from "@repo/qr-constants";

// Re-export API path constants for route mounting and response building
export { API_ENDPOINTS };

// Build the status URL path for a QR generation job (e.g. for response statusUrl).
export function jobStatusPath(jobId: string): string {
  return `${API_ENDPOINTS.QR_GENERATION}/${jobId}/status`;
}

/** Endpoint status API path (for statusUrl in wake/scale responses). */
export const ENDPOINT_STATUS_PATH = `${API_ENDPOINTS.ENDPOINT}/status`;

// GPU instance types the admin panel may switch the endpoint between.
// ml.g5.xlarge (A10G 24GB) is faster, but eu-west-1 capacity is intermittent;
// ml.g4dn.xlarge (T4 16GB) provisions reliably (2026-07-06 capacity incident).
export const ALLOWED_INSTANCE_TYPES = [
  "ml.g5.xlarge",
  "ml.g4dn.xlarge",
] as const;
export type AllowedInstanceType = (typeof ALLOWED_INSTANCE_TYPES)[number];

// Prod endpoint autoscaling shape, restored by the scheduled cron after an
// instance-type change (AWS requires deregistering the scalable target —
// which deletes its policies — before update-endpoint).
export const AUTOSCALING_MIN_CAPACITY = 0;
export const AUTOSCALING_MAX_CAPACITY = 3;

// Auth & JWT
export const JWT_ISSUER = "qr-generator-api";
export const JWT_EXPIRES_IN = "24h";
export const JWT_EXPIRES_IN_SECONDS = 86400;

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_CLEANUP_INTERVAL_MS = 60000;

// Rate kimits
export const RATE_LIMIT_GENERATION_WINDOW_MS = 5 * 60 * 1000;
export const RATE_LIMIT_GENERATION_MAX = 5;

export const RATE_LIMIT_STATUS_WINDOW_MS = 1 * 60 * 1000;
export const RATE_LIMIT_STATUS_MAX = 30;

export const RATE_LIMIT_WAKE_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_WAKE_MAX = 5;

export const RATE_LIMIT_AUTH_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_AUTH_MAX = 10;

// One generation uploads a handful of QR PNGs, so allow a few uploads per
// generation (5 generations x 4 QRs per window) while still stopping abuse.
export const RATE_LIMIT_UPLOAD_WINDOW_MS = 5 * 60 * 1000;
export const RATE_LIMIT_UPLOAD_MAX = 20;

// Gallery examples (fetched once per processing screen)
export const RATE_LIMIT_GALLERY_WINDOW_MS = 5 * 60 * 1000;
export const RATE_LIMIT_GALLERY_MAX = 30;

export const GALLERY_EXAMPLES_DEFAULT_COUNT = 6;
export const GALLERY_EXAMPLES_MAX_COUNT = 12;
