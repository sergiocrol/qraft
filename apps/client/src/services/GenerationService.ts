import { apiClient } from '@/lib/api/client';
import type {
  QRGenerationRequest,
  QRJobCreateResponse,
  QRJobStatusResponse,
  QRJobCancelResponse,
} from '@repo/shared-types';

import { API, CLIENT_API_ROUTES, qrGenerationStatusUrl, qrGenerationCancelUrl } from '@/lib/constants';
import { saveJobToken, getJobToken } from '@/lib/utils/jobStore';

/**
 * Axios headers carrying the per-job access token, when this browser has one.
 * The API returns 404 on status/cancel without a matching token.
 */
function jobTokenHeaders(jobId: string): Record<string, string> | undefined {
  const token = getJobToken(jobId);
  return token ? { 'X-Job-Token': token } : undefined;
}

export class GenerationService {
  private static instance: GenerationService;

  private constructor() {}

  public static getInstance(): GenerationService {
    if (!GenerationService.instance) {
      GenerationService.instance = new GenerationService();
    }
    return GenerationService.instance;
  }

  async generateQR(
    request: QRGenerationRequest & { environment?: 'production' | 'staging' }
  ): Promise<QRJobCreateResponse> {
    try {
      const response = await apiClient.getClient().post(API.QR_GENERATION, request);

      const jobData = response?.data?.data;

      if (!jobData?.jobId) {
        throw new Error('Invalid response from server - no job ID');
      }

      // The access token is only ever returned here; store it so the job
      // page (same browser) can authenticate its status polls and cancel.
      if (jobData.accessToken) {
        saveJobToken(jobData.jobId, jobData.accessToken);
      }

      return {
        jobId: jobData.jobId,
        status: jobData.status || 'pending',
        message: jobData.message || 'QR generation job created',
        estimatedTime: jobData.estimatedTime,
        statusUrl: jobData.statusUrl || qrGenerationStatusUrl(jobData.jobId),
      };
    } catch (error: any) {
      throw error;
    }
  }

  async getJobStatus(jobId: string): Promise<QRJobStatusResponse> {
    try {
      const response = await apiClient.getClient().get(qrGenerationStatusUrl(jobId), {
        headers: jobTokenHeaders(jobId),
      });

      const jobData = response.data?.data;

      if (!jobData.jobId) {
        throw new Error('Invalid job status response');
      }

      const normalizedResponse: QRJobStatusResponse = {
        jobId: jobData.jobId,
        status: jobData.status,
        progress: jobData.progress || 0,
        message: jobData.message,
        createdAt: jobData.createdAt,
        startedAt: jobData.startedAt,
        completedAt: jobData.completedAt,
        failedAt: jobData.failedAt,
        estimatedTimeRemaining: jobData.estimatedTimeRemaining,
        prompt: jobData.prompt,
        result: jobData.result,
        error: jobData.error,
      };

      return normalizedResponse;
    } catch (error: any) {
      throw error;
    }
  }

  async cancelJob(jobId: string): Promise<QRJobCancelResponse> {
    try {
      const response = await apiClient.getClient().delete(qrGenerationCancelUrl(jobId), {
        headers: jobTokenHeaders(jobId),
      });
      return response.data.data || response.data;
    } catch (error: any) {
      throw error;
    }
  }

  async getJobStats(): Promise<{ stats: import('@repo/shared-types').JobStats }> {
    try {
      const response = await apiClient.getClient().get(API.JOBS_STATS);
      return response.data.data || response.data;
    } catch (error: any) {
      throw error;
    }
  }

  async uploadQR(dataUrl: string, numImages: number): Promise<string> {
    const response = await apiClient.getClient().post(CLIENT_API_ROUTES.UPLOAD_QR, {
      qrDataUrl: dataUrl,
      numImages,
    });

    if (response.data.success && response.data.data?.url) {
      return response.data.data.url;
    }
    throw new Error('Failed to upload QR code');
  }
}

export const generationService = GenerationService.getInstance();
