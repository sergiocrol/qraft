import { Router } from "express";
import type { Request, Response } from "express";
import { JobManager } from "../services/JobManager";
import { requireJobId } from "../middlewares/requireJobId";
import { adminAuth } from "../middlewares/adminAuth";
import { sendSuccess, sendError, ERROR_CODES } from "../utils/response";

const router: Router = Router();

// All /api/jobs* routes are admin-only: they enumerate every user's job,
// including prompts, QR source URLs and generated results.
router.use(adminAuth);

/**
 * @route   GET /api/jobs
 * @desc    List all jobs with pagination and optional status filter
 * @access  Admin (Bearer JWT)
 * @query   {number} page - Page number (default: 1)
 * @query   {number} limit - Items per page (default: 10)
 * @query   {string} status - Filter by job status
 * @returns {Object} Paginated list of jobs
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const jobManager = req.app.locals.jobManager as JobManager;

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = (page - 1) * limit;

    const { jobs, total: totalJobs } = await jobManager.getJobsPaginated({
      limit,
      offset,
      status: req.query.status as any,
    });

    return sendSuccess(req, res, {
      jobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        progress: job.progress,
        message: job.message,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        failedAt: job.failedAt,
        requestSummary: {
          prompt: job.requestData.prompt.substring(0, 100) + "...",
          baseQrCodeCount: job.requestData.baseQrCode?.length || 0,
          numImagesPerPrompt: job.requestData.numImagesPerPrompt,
          model: job.requestData.model,
        },
        resultSummary: job.result
          ? {
              numImagesGenerated: job.result.numImagesGenerated,
              processingTimeSeconds: job.result.processingTimeSeconds,
              qrSource: job.result.qrSource,
            }
          : undefined,
        error: job.error,
      })),
      pagination: {
        page,
        limit,
        total: totalJobs,
        pages: Math.ceil(totalJobs / limit),
        hasNext: page * limit < totalJobs,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    return sendError(
      req,
      res,
      "Failed to get jobs",
      ERROR_CODES.JOBS_FETCH_ERROR,
      500,
    );
  }
});

/**
 * @route   GET /api/jobs/stats
 * @desc    Get aggregated job statistics
 * @access  Admin (Bearer JWT)
 * @returns {Object} Job statistics including counts by status and rates
 */
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const jobManager = req.app.locals.jobManager as JobManager;
    const stats = await jobManager.getJobStats();

    return sendSuccess(req, res, {
      ...stats,
      timestamp: new Date().toISOString(),
      completionRate:
        stats.total > 0
          ? ((stats.completed / stats.total) * 100).toFixed(1) + "%"
          : "0%",
      failureRate:
        stats.total > 0
          ? ((stats.failed / stats.total) * 100).toFixed(1) + "%"
          : "0%",
      activeJobs: stats.pending + stats.processing,
    });
  } catch (error) {
    return sendError(
      req,
      res,
      "Failed to get job statistics",
      ERROR_CODES.STATS_ERROR,
      500,
    );
  }
});

/**
 * @route   GET /api/jobs/:jobId
 * @access  Admin (Bearer JWT)
 * @param   jobId - Job identifier
 */
router.get("/:jobId", requireJobId, async (req: Request, res: Response) => {
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

    // Explicitly omit the per-job accessToken: even the admin surface must
    // never echo the secret that grants status/cancel access.
    const { accessToken: _accessToken, ...jobDetails } = job;

    return sendSuccess(req, res, {
      job: {
        ...jobDetails,
        requestData: job.requestData,
        result: job.result,
      },
    });
  } catch (error) {
    return sendError(
      req,
      res,
      "Failed to get job details",
      ERROR_CODES.JOB_DETAILS_ERROR,
      500,
    );
  }
});

export { router as jobRoutes };
