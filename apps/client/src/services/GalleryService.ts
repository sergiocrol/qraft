import { apiClient } from '@/lib/api/client';
import type { QRExample } from '@/lib/api/types';

import { API } from '@/lib/constants';

/**
 * Random examples of real past generations (image + the prompt that produced
 * it), served by the API straight from the S3 generation records — nothing is
 * hardcoded, so the pool grows as people create new QRs.
 */
export class GalleryService {
  private static instance: GalleryService;

  private constructor() {}

  public static getInstance(): GalleryService {
    if (!GalleryService.instance) {
      GalleryService.instance = new GalleryService();
    }
    return GalleryService.instance;
  }

  async getExamples(count: number): Promise<QRExample[]> {
    const response = await apiClient.getClient().get(API.GALLERY_EXAMPLES, {
      params: { count },
    });

    const examples = response.data?.data?.examples;
    return Array.isArray(examples) ? examples : [];
  }
}

export const galleryService = GalleryService.getInstance();
