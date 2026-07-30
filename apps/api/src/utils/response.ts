import type { Request, Response } from "express";
import type { ApiError } from "@repo/shared-types";

// Get the request ID from headers
export function getRequestId(req: Request): string | undefined {
  return req.headers["x-request-id"] as string | undefined;
}

export function sendSuccess<T>(
  req: Request,
  res: Response,
  data: T,
  statusCode: number = 200,
): Response {
  const requestId = getRequestId(req);
  const body = {
    success: true as const,
    data,
    ...(requestId && { requestId }),
  };
  return res.status(statusCode).json(body);
}

export function sendError(
  req: Request,
  res: Response,
  message: string,
  code: string,
  statusCode: number = 500,
  details?: Record<string, unknown>,
): Response {
  const requestId = getRequestId(req);
  const body: ApiError = {
    success: false,
    error: {
      message,
      code,
      ...(details && { details }),
    },
    ...(requestId && { requestId }),
  };
  return res.status(statusCode).json(body);
}

export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  JOB_CREATION_ERROR: "JOB_CREATION_ERROR",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  MISSING_JOB_ID: "MISSING_JOB_ID",
  JOB_STATUS_ERROR: "JOB_STATUS_ERROR",
  JOB_CANCELLATION_ERROR: "JOB_CANCELLATION_ERROR",
  JOB_NOT_CANCELLABLE: "JOB_NOT_CANCELLABLE",
  JOBS_FETCH_ERROR: "JOBS_FETCH_ERROR",
  STATS_ERROR: "STATS_ERROR",
  JOB_DETAILS_ERROR: "JOB_DETAILS_ERROR",
  READINESS_CHECK_FAILED: "READINESS_CHECK_FAILED",
  HEALTH_CHECK_ERROR: "HEALTH_CHECK_ERROR",
  ENDPOINT_STATUS_ERROR: "ENDPOINT_STATUS_ERROR",
  ENDPOINT_METRICS_ERROR: "ENDPOINT_METRICS_ERROR",
  ENDPOINT_WAKE_ERROR: "ENDPOINT_WAKE_ERROR",
  ENDPOINT_SCALE_ERROR: "ENDPOINT_SCALE_ERROR",
  ENDPOINT_INSTANCE_TYPE_ERROR: "ENDPOINT_INSTANCE_TYPE_ERROR",
  AUTH_MISSING_CREDENTIALS: "AUTH_MISSING_CREDENTIALS",
  AUTH_INVALID_CHALLENGE: "AUTH_INVALID_CHALLENGE",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_FAILED: "AUTH_FAILED",
  AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
  AUTH_INSUFFICIENT_PERMISSIONS: "AUTH_INSUFFICIENT_PERMISSIONS",
  AUTH_INVALID_TOKEN: "AUTH_INVALID_TOKEN",
  AUTH_ERROR: "AUTH_ERROR",
  UPLOAD_ERROR: "UPLOAD_ERROR",
  GALLERY_ERROR: "GALLERY_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
} as const;
