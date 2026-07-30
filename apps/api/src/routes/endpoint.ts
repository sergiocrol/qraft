import { Router, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";

import { adminAuth, AuthRequest } from "../middlewares/adminAuth";

import {
  endpointStatusService,
  EndpointEnvironment,
} from "../services/EndpointStatusService";
import { emailService } from "../services/EmailService";
import {
  RATE_LIMIT_WAKE_WINDOW_MS,
  RATE_LIMIT_WAKE_MAX,
  ALLOWED_INSTANCE_TYPES,
  AllowedInstanceType,
} from "../constants";
import { sendSuccess, sendError, ERROR_CODES } from "../utils/response";

const router: Router = Router();

/** Parse the ?env= query param, defaulting to production */
function parseEnvironment(req: Request): EndpointEnvironment {
  const env = req.query.env as string | undefined;
  return env === "staging" ? "staging" : "production";
}

const wakeLimiter = rateLimit({
  windowMs: RATE_LIMIT_WAKE_WINDOW_MS,
  max: RATE_LIMIT_WAKE_MAX,
  message: "Too many wake requests, please try again later",
});

/**
 * @route   GET /api/endpoint/status
 * @desc    Get current endpoint status
 * @access  Public
 */
router.get("/status", async (req: Request, res: Response) => {
  try {
    const environment = parseEnvironment(req);
    const status = await endpointStatusService.getEndpointStatus(environment);
    return sendSuccess(req, res, status);
  } catch (error: any) {
    console.error("Error getting endpoint status:", error);
    return sendError(
      req,
      res,
      "Failed to get endpoint status",
      ERROR_CODES.ENDPOINT_STATUS_ERROR,
      500,
    );
  }
});

/**
 * @route   GET /api/endpoint/metrics
 * @desc    Get endpoint metrics from CloudWatch
 * @access  Public
 */
router.get("/metrics", async (req: Request, res: Response) => {
  try {
    const environment = parseEnvironment(req);
    const metrics = await endpointStatusService.getEndpointMetrics(environment);
    return sendSuccess(req, res, metrics);
  } catch (error: any) {
    console.error("Error getting endpoint metrics:", error);
    return sendError(
      req,
      res,
      "Failed to get endpoint metrics",
      ERROR_CODES.ENDPOINT_METRICS_ERROR,
      500,
    );
  }
});

/**
 * @route   POST /api/endpoint/wake
 * @desc    Request endpoint activation: emails the admin, who scales the
 *          endpoint up from the admin panel. Deliberately NOT self-service —
 *          visitors can never start GPU instances directly, only ask.
 * @access  Public (rate limited)
 * @body    { userEmail: string, reason?: string }
 */
router.post("/wake", wakeLimiter, async (req: Request, res: Response) => {
  try {
    const { userEmail, reason } = req.body ?? {};

    if (typeof userEmail !== "string" || !userEmail.includes("@")) {
      return sendError(
        req,
        res,
        "Valid email address is required",
        ERROR_CODES.BAD_REQUEST,
        400,
      );
    }

    await emailService.sendActivationRequest({
      userEmail: userEmail.slice(0, 254),
      reason:
        typeof reason === "string" && reason.trim()
          ? reason.slice(0, 500)
          : "No reason provided",
      requestedAt: new Date().toISOString(),
      ipAddress: req.ip ?? "unknown",
    });

    return sendSuccess(req, res, {
      message: "Activation request sent to administrator",
      userEmail,
      estimatedResponseTime: "1-2 hours during business hours",
    });
  } catch (error: any) {
    console.error("Error sending activation request:", error);
    // Deliberately generic: never echo error.message to visitors (F13).
    return sendError(
      req,
      res,
      "Failed to send activation request",
      ERROR_CODES.ENDPOINT_WAKE_ERROR,
      500,
    );
  }
});

/**
 * @route   POST /api/endpoint/scale
 * @desc    Scale the endpoint to specific instance count
 * @access  Private (admin only) - for now using simple token auth
 */
router.post("/scale", adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { instanceCount, environment: bodyEnv } = req.body;
    const environment: EndpointEnvironment =
      bodyEnv === "staging" ? "staging" : "production";

    if (
      typeof instanceCount !== "number" ||
      instanceCount < 0 ||
      instanceCount > 3
    ) {
      return sendError(
        req,
        res,
        "Invalid instance count. Must be between 0 and 3",
        ERROR_CODES.BAD_REQUEST,
        400,
      );
    }

    const result = await endpointStatusService.scaleEndpoint(
      instanceCount,
      environment,
    );

    return sendSuccess(req, res, result);
  } catch (error: any) {
    console.error("Error scaling endpoint:", error);
    return sendError(
      req,
      res,
      error.message || "Failed to scale endpoint",
      ERROR_CODES.ENDPOINT_SCALE_ERROR,
      500,
    );
  }
});

/**
 * @route   POST /api/endpoint/instance-type
 * @desc    Switch the endpoint GPU (blue/green update). The old hardware
 *          keeps serving until the new instance is InService, and SageMaker
 *          rolls back automatically if the requested type has no capacity —
 *          the admin escape hatch for ml.g5.xlarge droughts.
 * @access  Private (admin only)
 */
router.post(
  "/instance-type",
  adminAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { instanceType, environment: bodyEnv } = req.body ?? {};
      const environment: EndpointEnvironment =
        bodyEnv === "staging" ? "staging" : "production";

      if (
        typeof instanceType !== "string" ||
        !ALLOWED_INSTANCE_TYPES.includes(instanceType as AllowedInstanceType)
      ) {
        return sendError(
          req,
          res,
          `Invalid instance type. Allowed: ${ALLOWED_INSTANCE_TYPES.join(", ")}`,
          ERROR_CODES.BAD_REQUEST,
          400,
        );
      }

      const result = await endpointStatusService.changeInstanceType(
        instanceType as AllowedInstanceType,
        environment,
      );

      return sendSuccess(req, res, result);
    } catch (error: any) {
      console.error("Error changing instance type:", error);
      return sendError(
        req,
        res,
        error.message || "Failed to change instance type",
        ERROR_CODES.ENDPOINT_INSTANCE_TYPE_ERROR,
        500,
      );
    }
  },
);

/**
 * @route   GET /api/endpoint/health
 * @desc    Health check for the endpoint status API
 * @access  Public
 */
router.get("/health", (req: Request, res: Response) => {
  return sendSuccess(req, res, {
    status: "healthy",
    service: "endpoint-status-api",
    timestamp: new Date().toISOString(),
  });
});

export { router as endpointRoutes };
