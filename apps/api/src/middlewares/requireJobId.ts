import type { Request, Response, NextFunction } from "express";
import { sendError, ERROR_CODES } from "../utils/response";

// Middleware that ensures req.params.jobId is present and non-empty
export function requireJobId(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  const jobId = req.params.jobId;
  if (!jobId || typeof jobId !== "string" || jobId.trim() === "") {
    return sendError(
      req,
      res,
      "Job ID is required",
      ERROR_CODES.MISSING_JOB_ID,
      400,
    );
  }
  next();
}
