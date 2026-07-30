import { scan } from 'qr-scanner-wechat';
import type { ImageScanMetadata } from '@repo/shared-types';
import type { QRAnalysisResult } from '@/components/generation/GenerationPage';

export const analyzeQRScannability = async (imageUrls: string[]) => {
  const results = [];

  for (const [index, url] of imageUrls.entries()) {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });

      const startTime = performance.now();
      try {
        const result = await scan(img);

        const decodeTime = performance.now() - startTime;
        results.push({
          index,
          url,
          scannable: !!result?.text,
          decodeTime,
          data: result,
          quality: calculateQualityAdvanced(result.text, decodeTime),
        });
      } catch (scanError: any) {
        const decodeTime = performance.now() - startTime;
        results.push({
          index,
          url,
          scannable: false,
          decodeTime,
          error: scanError.message,
          quality: 0,
        });
      }
    } catch (error: any) {
      results.push({
        index,
        url,
        scannable: false,
        error: error.message,
        quality: 0,
      });
    }
  }

  return results.sort((a, b) => b.quality - a.quality);
};

const calculateQualityAdvanced = (result: string | null, decodeTime: number) => {
  if (!result) return 0;

  const timeScore = Math.max(0, (2000 - decodeTime) / 2000);
  const dataScore = result ? 1 : 0;
  const cornerScore = result ? 1 : 0.5;

  return timeScore * 0.4 + dataScore * 0.4 + cornerScore * 0.2;
};

/**
 * Picks the best image index from server scan metadata (plan 008): verified
 * beats unverified, then higher scanScore wins. Returns null when the
 * metadata is absent, misaligned, or carries no signal (nothing verified,
 * all scores 0) — callers fall back to the client-side analysis then.
 */
const rankByServerMetadata = (
  images: string[],
  metadata?: ImageScanMetadata[]
): string | null => {
  if (!metadata || metadata.length !== images.length) return null;

  const hasSignal = metadata.some(
    (m) => m?.scanVerified === true || (m?.scanScore ?? 0) > 0
  );
  if (!hasSignal) return null;

  let bestIndex = 0;
  for (let i = 1; i < metadata.length; i++) {
    const best = metadata[bestIndex];
    const candidate = metadata[i];
    const bestVerified = best?.scanVerified === true ? 1 : 0;
    const candidateVerified = candidate?.scanVerified === true ? 1 : 0;
    const bestScore = best?.scanScore ?? 0;
    const candidateScore = candidate?.scanScore ?? 0;

    if (
      candidateVerified > bestVerified ||
      (candidateVerified === bestVerified && candidateScore > bestScore)
    ) {
      bestIndex = i;
    }
  }
  return images[bestIndex];
};

export const analyzeAndReorderImages = async (
  images: string[],
  imagesMetadata?: ImageScanMetadata[]
): Promise<QRAnalysisResult> => {
  // Server verification (real decoders, run on the full-resolution image
  // during generation) is authoritative when present; the in-browser scan
  // below only decides for jobs generated without scan metadata.
  const serverBest = rankByServerMetadata(images, imagesMetadata);
  if (serverBest) {
    return {
      bestImageUrl: serverBest,
      reorderedImages: reorderImagesForDisplay(images, serverBest),
      analysisResults: [],
      scannableCount: imagesMetadata!.filter((m) => m?.scanVerified === true).length,
    };
  }

  const analysisResults = await analyzeQRScannability(images);

  const bestResult = analysisResults[0].scannable
    ? analysisResults[0]
    : analysisResults[analysisResults.length - 1];
  const bestImageUrl = bestResult?.url || images[images.length - 1];

  const scannableCount = analysisResults.filter((result) => result.scannable).length;

  const reorderedImages = reorderImagesForDisplay(images, bestImageUrl);

  return {
    bestImageUrl,
    reorderedImages,
    analysisResults,
    scannableCount,
  };
};

export const reorderImagesForDisplay = (images: string[], bestImageUrl: string): string[] => {
  const bestIndex = images.indexOf(bestImageUrl);
  if (bestIndex === -1) return images;

  const reordered = [...images];

  if (images.length === 3 && bestIndex !== 1) {
    [reordered[1], reordered[bestIndex]] = [reordered[bestIndex], reordered[1]];
  }

  return reordered;
};
