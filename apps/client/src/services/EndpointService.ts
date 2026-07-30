import { apiClient } from '@/lib/api/client';
import type {
  EndpointStatus,
  EndpointMetrics,
  WakeEndpointRequest,
  WakeEndpointResponse,
  ScaleEndpointResponse,
  ChangeInstanceTypeResponse,
} from '@/lib/api/types';

import { CLIENT_API_ROUTES } from '@/lib/constants';

export type EndpointEnvironment = 'production' | 'staging';

export class EndpointService {
  private static instance: EndpointService;

  private constructor() {}

  public static getInstance(): EndpointService {
    if (!EndpointService.instance) {
      EndpointService.instance = new EndpointService();
    }
    return EndpointService.instance;
  }

  async getStatus(environment: EndpointEnvironment = 'production'): Promise<EndpointStatus> {
    const params = environment === 'staging' ? { env: 'staging' } : {};
    const response = await apiClient.getClient().get(CLIENT_API_ROUTES.ENDPOINT_STATUS, { params });
    return response.data.data;
  }

  async getMetrics(environment: EndpointEnvironment = 'production'): Promise<EndpointMetrics> {
    const params = environment === 'staging' ? { env: 'staging' } : {};
    const response = await apiClient.getClient().get(CLIENT_API_ROUTES.ENDPOINT_METRICS, {
      params,
    });
    return response.data.data;
  }

  /**
   * Request endpoint activation. Deliberately not self-service: the API
   * emails the admin, who reviews the request and scales the endpoint up
   * from the admin panel.
   */
  async requestActivation(
    request: WakeEndpointRequest,
    environment: EndpointEnvironment = 'production'
  ): Promise<WakeEndpointResponse> {
    const params = environment === 'staging' ? { env: 'staging' } : {};
    const response = await apiClient
      .getClient()
      .post(CLIENT_API_ROUTES.ENDPOINT_WAKE, request, { params });
    return response.data.data;
  }

  async scaleEndpoint(
    instanceCount: number,
    adminToken: string,
    environment: EndpointEnvironment = 'production'
  ): Promise<ScaleEndpointResponse> {
    const client = apiClient.getClient();
    const originalAuth = client.defaults.headers.common['Authorization'];
    try {
      client.defaults.headers.common['Authorization'] = `Bearer ${adminToken}`;
      const response = await client.post(CLIENT_API_ROUTES.ENDPOINT_SCALE, {
        instanceCount,
        environment,
      });
      return response.data.data;
    } finally {
      client.defaults.headers.common['Authorization'] = originalAuth;
    }
  }

  /**
   * Switch the endpoint GPU (blue/green: the old hardware serves until the
   * new instance is ready; SageMaker rolls back if capacity is unavailable).
   */
  async changeInstanceType(
    instanceType: string,
    adminToken: string,
    environment: EndpointEnvironment = 'production'
  ): Promise<ChangeInstanceTypeResponse> {
    const client = apiClient.getClient();
    const originalAuth = client.defaults.headers.common['Authorization'];
    try {
      client.defaults.headers.common['Authorization'] = `Bearer ${adminToken}`;
      const response = await client.post(CLIENT_API_ROUTES.ENDPOINT_INSTANCE_TYPE, {
        instanceType,
        environment,
      });
      return response.data.data;
    } finally {
      client.defaults.headers.common['Authorization'] = originalAuth;
    }
  }
}

export const endpointService = EndpointService.getInstance();
