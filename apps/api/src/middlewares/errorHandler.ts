import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { getConfig } from "../utils/environment";
import { sendError, ERROR_CODES } from "../utils/response";

export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (error instanceof ZodError) {
    const details = error.errors.reduce<Record<string, string>>((acc, err) => {
      const path = err.path.join(".");
      acc[path] = err.message;
      return acc;
    }, {});
    sendError(
      req,
      res,
      "Validation failed",
      ERROR_CODES.VALIDATION_ERROR,
      400,
      details,
    );
    return;
  }

  const config = getConfig();
  const message =
    config.nodeEnv === "development" ? error.message : "Internal server error";
  sendError(req, res, message, ERROR_CODES.INTERNAL_ERROR, 500);
};
