import { useState, useEffect, useCallback, useRef } from 'react';

import { generationService } from '@/services/GenerationService';

import type { QRJobStatusResponse } from '@repo/shared-types';

interface UseJobPollingOptions {
  /** Whether polling is enabled. Default: true */
  enabled?: boolean;
  /** Poll interval in ms. Default: 2000 */
  interval?: number;
  /** Max retries before giving up on transient errors. Default: 15 */
  maxErrorRetries?: number;
  onComplete?: (job: QRJobStatusResponse) => void;
  onError?: (error: Error) => void;
  /** Called on each retryable error with the error and current retry count */
  onRetryableError?: (error: Error, retryCount: number) => void;
}

export const useJobPolling = (jobId: string | null, options: UseJobPollingOptions = {}) => {
  const {
    enabled = true,
    interval = 2000,
    maxErrorRetries = 15,
    onComplete,
    onError,
    onRetryableError,
  } = options;

  const [job, setJob] = useState<QRJobStatusResponse | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const errorCountRef = useRef(0);

  const pollJob = useCallback(async () => {
    if (!jobId) return;

    try {
      const status = await generationService.getJobStatus(jobId);
      setJob(status);

      setErrorCount(0);
      errorCountRef.current = 0;

      if (status.status === 'completed') {
        setIsPolling(false);
        onComplete?.(status);
      } else if (status.status === 'failed') {
        setIsPolling(false);
        const errorMessage = status.error?.message || 'Job failed';
        onError?.(new Error(errorMessage));
      }
    } catch (error: any) {
      errorCountRef.current += 1;
      setErrorCount(errorCountRef.current);

      console.warn(
        `Job polling error (attempt ${errorCountRef.current}/${maxErrorRetries}):`,
        error
      );

      onRetryableError?.(error, errorCountRef.current);

      if (errorCountRef.current >= maxErrorRetries) {
        console.error(`Job polling failed after ${maxErrorRetries} attempts`);
        setIsPolling(false);
        onError?.(
          new Error(`Failed to get job status after ${maxErrorRetries} attempts: ${error.message}`)
        );
      }
    }
  }, [jobId, maxErrorRetries, onComplete, onError, onRetryableError]);

  useEffect(() => {
    if (!enabled || !jobId) return;

    setErrorCount(0);
    errorCountRef.current = 0;
    setIsPolling(true);

    pollJob();

    const intervalId = setInterval(() => {
      if (job?.status === 'completed' || job?.status === 'failed') {
        clearInterval(intervalId);
        return;
      }

      if (errorCountRef.current < maxErrorRetries) {
        pollJob();
      } else {
        clearInterval(intervalId);
      }
    }, interval);

    return () => {
      clearInterval(intervalId);
      setIsPolling(false);
      setErrorCount(0);
      errorCountRef.current = 0;
    };
  }, [enabled, jobId, interval, pollJob, job?.status, maxErrorRetries]);

  return {
    job,
    isPolling,
    errorCount,
    maxErrorRetries,
  };
};
