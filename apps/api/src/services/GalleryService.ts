import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getConfig } from "../utils/environment";

export interface GalleryExample {
  imageUrl: string;
  prompt: string;
}

/**
 * How gallery examples are recovered from S3, with no database involved:
 *
 * Every generation leaves two small JSON files behind in the assets bucket —
 * the relay Lambda uploads the request payload (which carries the prompt) to
 * `controlnet-qr-inputs/<uuid>.json`, and SageMaker async writes the result
 * to `controlnet-qr-outputs/<uuid>.out` (which carries the final image URLs).
 * The two UUIDs do NOT match (the deployed relay doesn't pass InferenceId),
 * but the result echoes the request's `base_qr_code` URLs back as
 * `input_qr_urls`, and those user-QR filenames are unique per job — so the
 * base QR URL is an exact join key between prompt and images.
 */

/** Skip records above this size: an oversized .out still holds base64 images
 * (a result that was never status-polled) and an oversized input holds an
 * inlined QR instead of URLs — neither is worth downloading. */
const MAX_RECORD_FILE_BYTES = 256 * 1024;

const CACHE_TTL_MS = 30 * 60 * 1000;

const S3_READ_CONCURRENCY = 10;

/** Longest prompt worth showing in the "while you wait" card. */
const MAX_PROMPT_LENGTH = 600;

interface AsyncInputRecord {
  baseQrUrl: string;
  prompt: string;
}

interface AsyncResultRecord {
  baseQrUrl: string;
  imageUrl: string;
}

/** Minimal S3 surface used, so tests can inject a stub. */
export interface S3ClientLike {
  send(command: any): Promise<any>;
}

export class GalleryService {
  private s3Client: S3ClientLike;
  private bucketName: string;
  private inputPrefix: string;
  private outputPrefix: string;

  private cache: { examples: GalleryExample[]; fetchedAt: number } | null =
    null;
  private refreshPromise: Promise<GalleryExample[]> | null = null;

  constructor(s3Client?: S3ClientLike) {
    const config = getConfig();
    this.s3Client =
      s3Client ??
      new S3Client({ region: config.aws.region || "eu-west-1" });
    this.bucketName = config.s3.bucketName;
    this.inputPrefix = config.s3.asyncInputPrefix;
    this.outputPrefix = config.s3.asyncOutputPrefix;
  }

  /** Random sample of real past generations (image + the prompt that made it). */
  async getRandomExamples(count: number): Promise<GalleryExample[]> {
    const pool = await this.getPool();
    return shuffle(pool).slice(0, count);
  }

  private async getPool(): Promise<GalleryExample[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.examples;
    }

    // Deduplicate concurrent rebuilds (cold Lambda burst, poll storms).
    if (!this.refreshPromise) {
      this.refreshPromise = this.buildPool().finally(() => {
        this.refreshPromise = null;
      });
    }

    try {
      const examples = await this.refreshPromise;
      this.cache = { examples, fetchedAt: Date.now() };
      return examples;
    } catch (error) {
      // Serve a stale pool over an empty error if we ever had one.
      if (this.cache) return this.cache.examples;
      throw error;
    }
  }

  private async buildPool(): Promise<GalleryExample[]> {
    const [inputKeys, outputKeys] = await Promise.all([
      this.listKeys(`${this.inputPrefix}/`, ".json", MAX_RECORD_FILE_BYTES),
      this.listKeys(`${this.outputPrefix}/`, ".out", MAX_RECORD_FILE_BYTES),
    ]);

    const [inputs, results] = await Promise.all([
      mapWithLimit(inputKeys, S3_READ_CONCURRENCY, (key) =>
        this.readInputRecord(key),
      ),
      mapWithLimit(outputKeys, S3_READ_CONCURRENCY, (key) =>
        this.readResultRecord(key),
      ),
    ]);

    const promptByBaseQr = new Map<string, string>();
    for (const input of inputs) {
      if (input) promptByBaseQr.set(input.baseQrUrl, input.prompt);
    }

    const examples: GalleryExample[] = [];
    for (const result of results) {
      if (!result) continue;
      const prompt = promptByBaseQr.get(result.baseQrUrl);
      if (prompt) examples.push({ imageUrl: result.imageUrl, prompt });
    }

    return examples;
  }

  private async listKeys(
    prefix: string,
    suffix: string,
    maxSize?: number,
  ): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const object of response.Contents ?? []) {
        if (!object.Key?.endsWith(suffix)) continue;
        if (maxSize && (object.Size ?? 0) > maxSize) continue;
        keys.push(object.Key);
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return keys;
  }

  /** The relay's request payload: prompt + base QR URL(s). Null when it isn't
   * a usable generation request (e.g. legacy rescue payloads carry no prompt). */
  private async readInputRecord(
    key: string,
  ): Promise<AsyncInputRecord | null> {
    const payload = await this.readJson(key);
    if (!payload) return null;

    const prompt =
      typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return null;

    const baseQrUrl = firstHttpUrl(payload.base_qr_code);
    if (!baseQrUrl) return null;

    return { baseQrUrl, prompt };
  }

  /** The SageMaker result: pick one representative image URL. Null for failed
   * generations or results that were never converted from base64 to URLs. */
  private async readResultRecord(
    key: string,
  ): Promise<AsyncResultRecord | null> {
    const result = await this.readJson(key);
    if (!result) return null;
    if (result.status === "failed" || result.error) return null;

    const baseQrUrl = firstHttpUrl(result.input_qr_urls);
    if (!baseQrUrl) return null;

    const images: unknown[] = Array.isArray(result.images)
      ? result.images
      : [];
    const imageUrls = images.filter(isHttpUrl) as string[];
    if (imageUrls.length === 0) return null;

    return { baseQrUrl, imageUrl: pickBestImage(imageUrls, result) };
  }

  private async readJson(key: string): Promise<any | null> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      const body = await response.Body?.transformToString?.();
      if (!body) return null;
      return JSON.parse(body);
    } catch {
      // One unreadable record shouldn't sink the whole pool.
      return null;
    }
  }
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function firstHttpUrl(value: unknown): string | null {
  const list = Array.isArray(value) ? value : [value];
  const first = list.find(isHttpUrl);
  return first ?? null;
}

/**
 * Prefer the image the container scan-verified with the highest score (the
 * per-image entries in `images_metadata`/`generations` are index-aligned with
 * `images`); fall back to the first image for old-format results.
 */
function pickBestImage(imageUrls: string[], result: any): string {
  const metadata: any[] = Array.isArray(result.images_metadata)
    ? result.images_metadata
    : Array.isArray(result.generations)
      ? result.generations
      : [];

  let best = imageUrls[0]!;
  let bestScore = -1;

  for (const entry of metadata) {
    if (!entry || entry.scan_verified !== true) continue;
    const index = typeof entry.index === "number" ? entry.index - 1 : -1;
    const imageUrl = imageUrls[index];
    if (!imageUrl) continue;
    const score = typeof entry.scan_score === "number" ? entry.scan_score : 0;
    if (score > bestScore) {
      bestScore = score;
      best = imageUrl;
    }
  }

  return best;
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}
