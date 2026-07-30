import { Router } from "express";
import type { Request, Response } from "express";
import { ControlNetService } from "../services/ControlNetService";
import { JobManager } from "../services/JobManager";
import { getConfig, formatMsToDurationLabel } from "../utils/environment";
import { sendSuccess, sendError, ERROR_CODES } from "../utils/response";

const router: Router = Router();

/**
 * @route   GET /api/health
 * @access  Public
 */
router.get("/", async (req: Request, res: Response) => {
  return sendSuccess(req, res, {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * @route   GET /api/health/ready
 * @desc    Validates dependencies (e.g. ControlNet)
 * @access  Public
 */
router.get("/ready", async (req: Request, res: Response) => {
  try {
    const controlNetService = req.app.locals
      .controlNetService as ControlNetService;
    const healthCheck = await controlNetService.healthCheck();

    const isReady = healthCheck.healthy;

    return sendSuccess(
      req,
      res,
      {
        status: isReady ? "ready" : "not_ready",
        timestamp: new Date().toISOString(),
        checks: {
          controlnet: healthCheck,
        },
      },
      isReady ? 200 : 503,
    );
  } catch (error) {
    return sendError(
      req,
      res,
      "Readiness check failed",
      ERROR_CODES.READINESS_CHECK_FAILED,
      503,
    );
  }
});

/**
 * @route   GET /api/health/live
 * @access  Public
 */
router.get("/live", (req: Request, res: Response) => {
  return sendSuccess(req, res, {
    status: "alive",
    timestamp: new Date().toISOString(),
  });
});

/**
 * @route   GET /api/health/detailed
 * @desc    Memory, config, job stats, ControlNet health
 * @access  Public
 */
router.get("/detailed", async (req: Request, res: Response) => {
  try {
    const config = getConfig();

    const controlNetService = req.app.locals
      .controlNetService as ControlNetService;
    const jobManager = req.app.locals.jobManager as JobManager;

    const [controlNetHealth] = await Promise.allSettled([
      controlNetService.healthCheck(),
    ]);

    const jobStats = await jobManager.getJobStats();

    const memoryUsage = process.memoryUsage();
    const formatBytes = (bytes: number) =>
      `${Math.round(bytes / 1024 / 1024)}MB`;

    return sendSuccess(req, res, {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),

      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        nodeEnv: config.nodeEnv,
      },

      memory: {
        rss: formatBytes(memoryUsage.rss),
        heapTotal: formatBytes(memoryUsage.heapTotal),
        heapUsed: formatBytes(memoryUsage.heapUsed),
        external: formatBytes(memoryUsage.external),
      },

      config: {
        port: config.port,
        controlnetEndpoint: config.controlnetEndpoint,
        requestTimeout: config.requestTimeout,
        jobCleanupInterval: formatMsToDurationLabel(config.jobCleanupInterval),
        maxJobAge: formatMsToDurationLabel(config.maxJobAge),
      },

      jobManager: {
        stats: jobStats,
        isRunning: true,
      },

      controlNet: {
        endpoint: config.controlnetEndpoint,
        health:
          controlNetHealth.status === "fulfilled"
            ? controlNetHealth.value
            : null,
      },
    });
  } catch (error) {
    return sendError(
      req,
      res,
      "Failed to get detailed health information",
      ERROR_CODES.HEALTH_CHECK_ERROR,
      500,
    );
  }
});

export { router as healthRoutes };
