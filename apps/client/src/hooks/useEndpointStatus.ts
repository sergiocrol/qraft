import { useState, useEffect } from 'react';

import { endpointService } from '@/services/EndpointService';
import type { EndpointEnvironment } from '@/services/EndpointService';

import type { EndpointStatus } from '@/lib/api/types';
import { ENDPOINT_STATUS_DEFAULT_POLL_MS } from '@/lib/constants';

export const useEndpointStatus = (
  refreshInterval: number = ENDPOINT_STATUS_DEFAULT_POLL_MS,
  environment: EndpointEnvironment = 'production'
) => {
  const [status, setStatus] = useState<EndpointStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      setIsLoading(true);
      const data = await endpointService.getStatus(environment);
      setStatus(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch endpoint status');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, refreshInterval);
    return () => clearInterval(interval);
  }, [refreshInterval, environment]);

  return { status, isLoading, error, refetch: fetchStatus };
};
