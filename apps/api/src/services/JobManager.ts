import crypto from "crypto";

import {
  QRJob,
  QRGenerationRequest,
  QRGenerationResult,
  JobStatus,
  GenerationPlan,
  GenerationDetail,
  ImageScanMetadata,
} from "@repo/shared-types";
import { ControlNetService } from "./ControlNetService";
import { AppConfig, getConfig } from "../utils/environment";
import { DynamoJobStore, AsyncQRJob } from "./DynamoJobStore";

export class JobManager {
  private jobStore: DynamoJobStore;
  private config: AppConfig;

  constructor(private controlNetService: ControlNetService) {
    this.config = getConfig();

    this.jobStore = new DynamoJobStore({
      tableName: this.config.dynamoTableName,
      region: this.config.aws.region || "eu-west-1",
      maxJobAgeSec: Math.floor(this.config.maxJobAge / 1000),
      completedJobRetentionSec: Math.floor(
        this.config.completedJobRetention / 1000,
      ),
      failedJobRetentionSec: Math.floor(this.config.failedJobRetention / 1000),
    });
  }

  /**
   * start() and stop() are no longer needed since DynamoDB TTL
   * handles job expiration automatically. Kept as no-ops for
   * backward compatibility with existing callers.
   */
  start(): void {
    // No-op: DynamoDB TTL replaces the in-memory cleanup interval
  }

  stop(): void {
    // No-op: nothing to clean up
  }

  async createJob(request: QRGenerationRequest): Promise<AsyncQRJob> {
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    // Job ids are weakly random and enumerable; this unguessable token is the
    // actual ownership boundary for the public status/cancel endpoints. It is
    // returned once, in the create response, and never from read endpoints.
    const accessToken = crypto.randomUUID();

    const job: AsyncQRJob = {
      id: tempId,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      requestData: request,
      accessToken,
    };

    await this.jobStore.putJob(job);

    // Submit to the generation service in-band. In Lambda, any work deferred past the
    // HTTP response is frozen and may never run, so the submission must complete here.
    // processJobAsync catches its own submission errors and persists the job as
    // "failed", so awaiting it does not throw for a SageMaker failure.
    await this.processJobAsync(tempId);

    // Return the freshest persisted job so the response reflects the submitted state.
    return (await this.jobStore.getJob(tempId)) ?? job;
  }

  async getJob(jobId: string): Promise<AsyncQRJob | undefined> {
    const job = await this.jobStore.getJob(jobId);

    if (!job) return undefined;

    if (job.status === "processing" && job.outputLocation) {
      try {
        await this.updateJobStatusFromApiGateway(jobId);
      } catch (error) {
        console.error(`Failed to update status for job ${jobId}:`, error);
      }
    }

    return this.jobStore.getJob(jobId);
  }

  async getAllJobs(filters?: {
    status?: JobStatus;
    limit?: number;
    offset?: number;
  }): Promise<AsyncQRJob[]> {
    return this.jobStore.getAllJobs(filters);
  }

  async getJobsPaginated(filters: {
    status?: JobStatus;
    limit: number;
    offset: number;
  }): Promise<{ jobs: AsyncQRJob[]; total: number }> {
    return this.jobStore.getJobsPaginated(filters);
  }

  async getJobStats() {
    return this.jobStore.getJobStats();
  }

  /**
   * Constant-time check that a caller-provided token matches the job's
   * accessToken. Jobs without a persisted token (created before tokens
   * existed) always fail: the token — not the weakly random job id — is the
   * ownership boundary.
   */
  verifyJobToken(job: AsyncQRJob, providedToken: string | undefined): boolean {
    if (!job.accessToken || !providedToken) return false;

    const expected = Buffer.from(job.accessToken);
    const provided = Buffer.from(providedToken);
    return (
      expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided)
    );
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const job = await this.jobStore.getJob(jobId);
    if (!job || job.status === "completed" || job.status === "failed") {
      return false;
    }

    await this.updateJobStatus(jobId, "cancelled", {
      completedAt: new Date().toISOString(),
      message: "Job cancelled by user",
    });
    return true;
  }

  private static readonly MAX_STATUS_CHECK_FAILURES = 15;

  // A SageMaker container that 500s writes nothing to the success output path,
  // so the poller can't see the failure directly — this wall-clock cap is the
  // backstop that flips such a job to "failed" instead of spinning at ~95%.
  // Overridable via GENERATION_TIMEOUT_MS: lower it where the endpoint stays
  // warm (failures surface sooner); keep it above the cold-start + queue +
  // inference budget where the endpoint scales from zero. Default 10 min.
  private static readonly MAX_PROCESSING_TIME_MS = ((): number => {
    const raw = Number(process.env.GENERATION_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
  })();

  private async updateJobStatusFromApiGateway(jobId: string): Promise<void> {
    const job = await this.jobStore.getJob(jobId);

    if (!job || !job.outputLocation) {
      return;
    }

    const elapsed = job.startedAt
      ? Date.now() - new Date(job.startedAt).getTime()
      : 0;
    if (elapsed > JobManager.MAX_PROCESSING_TIME_MS) {
      console.error(
        `Job ${jobId} timed out after ${Math.round(elapsed / 1000)}s`,
      );
      await this.updateJobStatus(jobId, "failed", {
        failedAt: new Date().toISOString(),
        progress: 0,
        error: {
          message: "Generation timed out. Please try again.",
          code: "GENERATION_TIMEOUT",
        },
      });
      return;
    }

    try {
      const statusResult =
        await this.controlNetService.checkQRGenerationStatusByOutputLocation(
          job.outputLocation,
        );

      const now = new Date().toISOString();

      if (statusResult.isComplete) {
        const result =
          await this.controlNetService.getQRGenerationResultByOutputLocation(
            job.outputLocation,
          );

        const transformedResult: QRGenerationResult = {
          images: result.images || [],
          outputPaths: result.output_paths || [],
          numImagesGenerated: result.num_images_generated || 0,
          processingTimeSeconds: result.processing_time_seconds,
          generationPlan: this.transformGenerationPlan(result.generation_plan),
          generations: this.transformGenerations(result.generations),
          inputQrUrls: result.input_qr_urls || [],
          qrSource: result.qr_source || "",
          imagesMetadata: this.transformImagesMetadata(result.images_metadata),
        };

        await this.updateJobStatus(jobId, "completed", {
          completedAt: now,
          progress: 100,
          message: "Image generation completed successfully",
          result: transformedResult,
          lastStatusCheck: now,
          statusCheckFailCount: 0,
        });
      } else {
        const progressPercent = this.estimateProgress(job);
        await this.updateJobStatus(jobId, "processing", {
          progress: progressPercent,
          message: `Processing via API Gateway...`,
          lastStatusCheck: now,
          statusCheckFailCount: 0,
        });
      }
    } catch (error) {
      const failCount = (job.statusCheckFailCount || 0) + 1;
      console.error(
        `Failed to update job status from API Gateway (${jobId}), ` +
          `attempt ${failCount}/${JobManager.MAX_STATUS_CHECK_FAILURES}:`,
        error,
      );

      if (failCount >= JobManager.MAX_STATUS_CHECK_FAILURES) {
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";
        await this.updateJobStatus(jobId, "failed", {
          failedAt: new Date().toISOString(),
          progress: 0,
          error: {
            message: `Generation failed after ${failCount} status check attempts: ${errorMsg}`,
            code: "STATUS_CHECK_FAILED",
          },
          statusCheckFailCount: failCount,
        });
        return;
      }

      const progressPercent = this.estimateProgress(job);
      const isEarlyStage = progressPercent < 60;

      await this.updateJobStatus(jobId, job.status, {
        lastStatusCheck: new Date().toISOString(),
        progress: progressPercent,
        statusCheckFailCount: failCount,
        message: isEarlyStage
          ? "Processing your artistic QR code..."
          : "Finalizing generation...",
      });
    }
  }

  private estimateProgress(job: AsyncQRJob): number {
    if (!job.startedAt) return 30;

    const elapsed = Date.now() - new Date(job.startedAt).getTime();
    const estimatedTotal = 4 * 60 * 1000;

    let progress = 30 + (elapsed / estimatedTotal) * 60;

    const randomFactor = Math.random() * 5;
    progress = Math.min(progress + randomFactor, 95);

    return Math.round(progress);
  }

  private async processJobAsync(jobId: string): Promise<void> {
    const job = await this.jobStore.getJob(jobId);
    if (!job) return;

    try {
      await this.updateJobStatus(jobId, "processing", {
        startedAt: new Date().toISOString(),
        progress: 10,
        message: "Submitting your request...",
      });

      const submissionResult = await this.controlNetService.submitQRGeneration(
        job.requestData,
      );

      const realJobId = submissionResult.requestId;

      await this.updateJobStatus(jobId, "processing", {
        progress: 30,
        message: "Submitted to generation service, processing...",
        apiGatewayRequestId: realJobId,
        outputLocation: submissionResult.outputLocation,
      });
    } catch (error) {
      console.error(`Async job ${jobId} submission failed:`, error);

      await this.updateJobStatus(jobId, "failed", {
        failedAt: new Date().toISOString(),
        progress: 0,
        error: {
          message: error instanceof Error ? error.message : "Processing failed",
          code: "PROCESSING_ERROR",
        },
      });
    }
  }

  createJobResponse(job: AsyncQRJob): any {
    return {
      jobId: job.id,
      status: job.status,
      message: job.id.startsWith("tmp_")
        ? "QR generation job created, getting assignment..."
        : "QR generation job created successfully",
      estimatedTime: "2-5 minutes",
      statusUrl: `/api/qr-generation/${job.id}/status`,
      // Only the create response carries the token; the creating client
      // stores it and must present it on status/cancel requests.
      accessToken: job.accessToken,
    };
  }

  private transformGenerationPlan(
    rawPlan: Record<string, any> | undefined,
  ): GenerationPlan | undefined {
    if (!rawPlan || typeof rawPlan !== "object") {
      return undefined;
    }

    try {
      const plan: GenerationPlan = {
        totalGenerations: this.safeNumber(
          rawPlan.total_generations || rawPlan.totalGenerations,
          0,
        ),
        uniqueUrls: this.safeNumber(
          rawPlan.unique_urls || rawPlan.uniqueUrls,
          0,
        ),
        userScaleCount: this.safeNumber(
          rawPlan.user_scale_count || rawPlan.userScaleCount,
          0,
        ),
        alternativeScaleCount: this.safeNumber(
          rawPlan.alternative_scale_count || rawPlan.alternativeScaleCount,
          0,
        ),
        details: this.transformGenerationDetails(rawPlan.details),
      };

      return plan;
    } catch (error) {
      console.warn("Failed to transform generation plan:", error);
      return undefined;
    }
  }

  private transformGenerationDetails(rawDetails: any): GenerationDetail[] {
    if (!Array.isArray(rawDetails)) {
      return [];
    }

    return rawDetails.map((detail, index) => {
      try {
        return {
          index: this.safeNumber(detail.index, index + 1),
          url: this.safeString(detail.url),
          scales: this.safeScales(detail.scales),
          description: this.safeString(
            detail.description,
            `generation_${index + 1}`,
          ),
          usesAlternativeScales: Boolean(
            detail.uses_alternative_scales || detail.usesAlternativeScales,
          ),
        };
      } catch (error) {
        console.warn(
          `Failed to transform generation detail at index ${index}:`,
          error,
        );
        return {
          index: index + 1,
          url: "",
          scales: [1.0, 0.1] as [number, number],
          description: `generation_${index + 1}`,
          usesAlternativeScales: false,
        };
      }
    });
  }

  private transformGenerations(
    rawGenerations: any[] | undefined,
  ): GenerationDetail[] | undefined {
    if (!Array.isArray(rawGenerations)) {
      return undefined;
    }

    return this.transformGenerationDetails(rawGenerations);
  }

  /**
   * Per-image scan metadata (plan 008): container snake_case -> camelCase,
   * same convention as processingTimeSeconds/generationPlan. Absent or
   * malformed input maps to undefined (jobs from container images that
   * predate scan verification); `null` values are preserved because they
   * mean "not measured", which is distinct from a failed verification.
   */
  private transformImagesMetadata(
    rawMetadata: any[] | undefined,
  ): ImageScanMetadata[] | undefined {
    if (!Array.isArray(rawMetadata)) {
      return undefined;
    }

    return rawMetadata.map((entry) => {
      const raw = entry && typeof entry === "object" ? entry : {};

      const scanVerified = raw.scan_verified ?? raw.scanVerified;
      const scanScore = raw.scan_score ?? raw.scanScore;
      const decodersPassed = raw.decoders_passed ?? raw.decodersPassed;
      const repairStageUsed = raw.repair_stage_used ?? raw.repairStageUsed;

      const metadata: ImageScanMetadata = {
        scanVerified: typeof scanVerified === "boolean" ? scanVerified : null,
        scanScore:
          typeof scanScore === "number" && !isNaN(scanScore)
            ? scanScore
            : null,
        decodersPassed: Array.isArray(decodersPassed)
          ? decodersPassed.map((decoder: any) => this.safeString(decoder))
          : [],
        repairStageUsed:
          typeof repairStageUsed === "string" ? repairStageUsed : null,
      };

      if (typeof raw.seed === "number" && !isNaN(raw.seed)) {
        metadata.seed = raw.seed;
      }

      return metadata;
    });
  }

  private safeNumber(value: any, defaultValue: number = 0): number {
    const num = Number(value);
    return isNaN(num) ? defaultValue : num;
  }

  private safeString(value: any, defaultValue: string = ""): string {
    return typeof value === "string" ? value : String(value || defaultValue);
  }

  private safeScales(value: any): [number, number] {
    if (Array.isArray(value) && value.length >= 2) {
      return [this.safeNumber(value[0], 1.0), this.safeNumber(value[1], 0.1)];
    }
    return [1.0, 0.1];
  }

  private async updateJobStatus(
    jobId: string,
    status: JobStatus,
    updates: Partial<AsyncQRJob> = {},
  ): Promise<void> {
    const job = await this.jobStore.getJob(jobId);
    if (!job) return;

    const updatedJob: AsyncQRJob = {
      ...job,
      ...updates,
      status,
      updatedAt: new Date().toISOString(),
    };

    await this.jobStore.putJob(updatedJob);
  }
}
