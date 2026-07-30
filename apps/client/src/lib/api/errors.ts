/**
 * Normalize API error payload to a string message.
 * Handles both legacy shape (error: string) and current shape (error: { message, code }).
 */
export function getApiErrorMessage(
  responseData: unknown,
  fallback: string = 'Request failed',
): string {
  if (responseData == null || typeof responseData !== 'object') {
    return fallback;
  }
  const data = responseData as { error?: string | { message?: string; code?: string } };
  const err = data.error;
  if (typeof err === 'string') {
    return err;
  }
  if (err && typeof err === 'object' && typeof err.message === 'string') {
    return err.message;
  }
  return fallback;
}
