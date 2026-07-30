import { Router } from "express";
import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";

import { QRGenerationRequestSchema } from "@repo/validation-schemas";
import { createValidationMiddleware } from "@repo/validation-schemas";

import { JobManager } from "../services/JobManager";
import { requireJobId } from "../middlewares/requireJobId";
import {
  jobStatusPath,
  RATE_LIMIT_GENERATION_WINDOW_MS,
  RATE_LIMIT_GENERATION_MAX,
  RATE_LIMIT_STATUS_WINDOW_MS,
  RATE_LIMIT_STATUS_MAX,
} from "../constants";
import { sendSuccess, sendError, ERROR_CODES } from "../utils/response";

const router: Router = Router();

/**
 * Caller-provided per-job token: X-Job-Token header, with ?token= as a
 * fallback so plain status URLs stay usable. Compared against the job's
 * persisted accessToken by JobManager.verifyJobToken.
 */
function providedJobToken(req: Request): string {
  const headerToken = req.header("X-Job-Token");
  if (headerToken) return headerToken;
  return typeof req.query.token === "string" ? req.query.token : "";
}

const qrGenerationLimiter = rateLimit({
  windowMs: RATE_LIMIT_GENERATION_WINDOW_MS,
  max: RATE_LIMIT_GENERATION_MAX,
  message: "Generation limit exceeded. Please wait before generating more QRs.",
});

/**
 * @route   POST /api/qr-generation
 * @desc    Create a new QR generation job
 * @access  Public (rate limit: 5rq x 5min)
 * @body    {Object} QRGenerationRequest - Generation parameters
 * @returns {Object} Job ID and status URL
 */
router.post(
  "/",
  qrGenerationLimiter,
  createValidationMiddleware(QRGenerationRequestSchema),
  async (req: Request, res: Response) => {
    try {
      const jobManager = req.app.locals.jobManager as JobManager;
      const validatedData = (req as any).validatedBody;

      const job = await jobManager.createJob(validatedData);

      if (job.id.startsWith("tmp_")) {
        return sendSuccess(
          req,
          res,
          {
            jobId: job.id,
            status: job.status,
            message: "QR generation job created successfully",
            estimatedTime: "2-5 minutes",
            statusUrl: jobStatusPath(job.id),
            temporary: true,
            // Returned only here: the creating client stores the token and
            // must present it (X-Job-Token) to poll status or cancel.
            accessToken: job.accessToken,
          },
          202,
        );
      }
      return sendSuccess(req, res, jobManager.createJobResponse(job), 202);
    } catch (error) {
      return sendError(
        req,
        res,
        error instanceof Error ? error.message : "Failed to create job",
        ERROR_CODES.JOB_CREATION_ERROR,
        500,
      );
    }
  },
);

const statusCheckLimiter = rateLimit({
  windowMs: RATE_LIMIT_STATUS_WINDOW_MS,
  max: RATE_LIMIT_STATUS_MAX,
  message: "Too many status check requests",
});

/**
 * @route   GET /api/qr-generation/:jobId/status
 * @access  Job owner (rate limited; requires the job's access token via
 *          X-Job-Token header or ?token= query param)
 * @param   jobId - Job identifier
 */
router.get(
  "/:jobId/status",
  statusCheckLimiter,
  requireJobId,
  async (req: Request, res: Response) => {
    try {
      const jobManager = req.app.locals.jobManager as JobManager;
      const jobId = req.params.jobId!;

      const job = await jobManager.getJob(jobId);

      if (!job) {
        return sendError(
          req,
          res,
          "Job not found",
          ERROR_CODES.JOB_NOT_FOUND,
          404,
        );
      }

      if (!jobManager.verifyJobToken(job, providedJobToken(req))) {
        // 404 (not 403) so job existence is never confirmed to non-owners.
        return sendError(
          req,
          res,
          "Job not found",
          ERROR_CODES.JOB_NOT_FOUND,
          404,
        );
      }

      return sendSuccess(req, res, {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        message: job.message,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        failedAt: job.failedAt,
        estimatedTimeRemaining: job.estimatedTimeRemaining,
        result: job.result,
        error: job.error,
        prompt: job.requestData?.prompt,
      });
    } catch (error) {
      return sendError(
        req,
        res,
        error instanceof Error ? error.message : "Failed to get job status",
        ERROR_CODES.JOB_STATUS_ERROR,
        500,
      );
    }
  },
);

/**
 * @route   DELETE /api/qr-generation/:jobId
 * @access  Job owner (requires the job's access token via X-Job-Token header
 *          or ?token= query param)
 * @param   jobId - Job identifier
 */
router.delete("/:jobId", requireJobId, async (req: Request, res: Response) => {
  try {
    const jobManager = req.app.locals.jobManager as JobManager;
    const jobId = req.params.jobId!;

    const job = await jobManager.getJob(jobId);

    if (!job) {
      return sendError(
        req,
        res,
        "Job not found",
        ERROR_CODES.JOB_NOT_FOUND,
        404,
      );
    }

    if (!jobManager.verifyJobToken(job, providedJobToken(req))) {
      // 404 (not 403) so job existence is never confirmed to non-owners.
      return sendError(
        req,
        res,
        "Job not found",
        ERROR_CODES.JOB_NOT_FOUND,
        404,
      );
    }

    const cancelled = await jobManager.cancelJob(jobId);
    if (!cancelled) {
      return sendError(
        req,
        res,
        "Job not found or cannot be cancelled",
        ERROR_CODES.JOB_NOT_CANCELLABLE,
        400,
      );
    }

    return sendSuccess(req, res, {
      jobId,
      status: "cancelled",
      message: "Job cancelled successfully",
      cancelledAt: new Date().toISOString(),
    });
  } catch (error) {
    return sendError(
      req,
      res,
      error instanceof Error ? error.message : "Failed to cancel job",
      ERROR_CODES.JOB_CANCELLATION_ERROR,
      500,
    );
  }
});

export { router as qrGenerationRoutes };
