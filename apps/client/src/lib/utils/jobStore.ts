/**
 * Extracts the job ID from the current URL.
 * Reads /j?id={jobId} and /staging/j?id={jobId}; falls back to the legacy
 * path form /j/{jobId} for old links. The query form is required because the
 * site is statically hosted (output: 'static', S3 website) — only /j and
 * /staging/j exist as objects, so a path segment after them 404s.
 */
export function getJobIdFromPath(): string | null {
  if (typeof window === 'undefined') return null;

  const id = new URLSearchParams(window.location.search).get('id');
  if (id && /^[a-zA-Z0-9_-]+$/.test(id)) return id;

  const path = window.location.pathname;
  const match = path.match(/\/(?:staging\/)?j\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Builds the job page URL for a given job ID and environment. Jobs submitted
 * with the v2 pipeline (the /lab page) carry `p=v2` so the job page can link
 * "generate again" back to /lab instead of the v1 /staging form.
 */
export function getJobPageUrl(
  jobId: string,
  environment: 'production' | 'staging' = 'production',
  pipeline?: string
): string {
  // Trailing slash is required: pages build as directories (j/index.html) and
  // the S3 website 302 from /j -> /j/ drops the query string (losing ?id=).
  const basePath = environment === 'staging' ? '/staging/j/' : '/j/';
  const params = new URLSearchParams({ id: jobId });
  if (pipeline === 'v2') params.set('p', 'v2');
  return `${basePath}?${params.toString()}`;
}

/**
 * Returns the form page URL for a given environment (and pipeline: v2 jobs
 * originate from /lab).
 */
export function getFormPageUrl(
  environment: 'production' | 'staging' = 'production',
  pipeline?: string
): string {
  // v2 is the default prod pipeline (homepage); /lab is the staging v2 lane.
  if (pipeline === 'v2') return environment === 'staging' ? '/lab' : '/';
  return environment === 'staging' ? '/staging' : '/';
}

/**
 * Reads the pipeline marker from the current job page URL ("v2" or null).
 */
export function getPipelineFromPath(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('p');
}

// Per-job access tokens, keyed by job id (same localStorage convention as
// ADMIN_TOKEN_STORAGE_KEY). The API returns the token once, in the create
// response, and requires it (X-Job-Token) to poll status or cancel.
const JOB_TOKEN_KEY_PREFIX = 'jobToken:';

/**
 * Persist the access token for a job so the job page (same browser) can
 * poll/cancel after the create -> redirect navigation.
 */
export function saveJobToken(jobId: string, token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${JOB_TOKEN_KEY_PREFIX}${jobId}`, token);
  } catch {
    // localStorage unavailable (private mode / quota): polling without a
    // token will get a 404 and the job page shows "not found".
  }
}

/**
 * Look up the stored access token for a job. Returns null when this browser
 * did not create the job (or storage is unavailable).
 */
export function getJobToken(jobId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(`${JOB_TOKEN_KEY_PREFIX}${jobId}`);
  } catch {
    return null;
  }
}
