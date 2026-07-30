import type {
  QRGenerationRequest,
  QRGenerationResult,
  QRJobCreateResponse,
  QRJobStatusResponse,
  QRJobCancelResponse,
  JobStatus,
  ErrorDetails,
  HealthCheck,
  SystemHealth,
  JobStats,
} from '@repo/shared-types';

import type {
  SupportedSampler,
  SupportedModel,
  ErrorCode,
  HttpStatusCode,
} from '@repo/qr-constants';

export type {
  QRGenerationRequest,
  QRGenerationResult,
  QRJobCreateResponse,
  QRJobStatusResponse,
  QRJobCancelResponse,
  JobStatus,
  ErrorDetails,
  HealthCheck,
  SystemHealth,
  JobStats,
  SupportedSampler,
  SupportedModel,
  ErrorCode,
  HttpStatusCode,
};
export interface EndpointStatus {
  endpointName: string;
  status:
    | 'InService'
    | 'OutOfService'
    | 'Creating'
    | 'Updating'
    | 'RollingBack'
    | 'Deleting'
    | 'Failed';
  currentInstanceCount: number;
  desiredInstanceCount: number;
  instanceType?: string;
  isScaling: boolean;
  isAvailable: boolean;
  lastUpdated: string;
  estimatedStartupTime?: number;
  healthCheck: 'healthy' | 'unhealthy';
}

export interface ChangeInstanceTypeResponse {
  message: string;
  endpointName: string;
  instanceType: string;
  previousInstanceType?: string;
  changed: boolean;
  estimatedTime?: string;
}

export interface WakeEndpointRequest {
  userEmail: string;
  reason?: string;
}

export interface WakeEndpointResponse {
  message: string;
  userEmail: string;
  estimatedResponseTime: string;
}

export interface ScaleEndpointResponse {
  message: string;
  endpointName: string;
  targetInstanceCount: number;
  estimatedTime: string;
}

export interface EndpointMetrics {
  endpointName: string;
  timeRange: {
    start: string;
    end: string;
  };
  invocations: Array<{
    timestamp: string;
    count: number;
  }>;
  latency: Array<{
    timestamp: string;
    averageMs: number;
  }>;
}

export interface GenerationFormData extends Omit<QRGenerationRequest, 'baseQrCode'> {
  qrUrl: string;
}

export interface QRExample {
  imageUrl: string;
  prompt: string;
  tip?: string;
}

export interface FunFact {
  title: string;
  content: string;
}

export interface ClientQRJobStatus extends QRJobStatusResponse {}
