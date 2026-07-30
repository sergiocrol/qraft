import type { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (
    process.env.LOG_LEVEL !== "debug" &&
    process.env.NODE_ENV !== "development"
  ) {
    return next();
  }

  if (!req.headers["x-request-id"]) {
    req.headers["x-request-id"] = uuidv4();
  }

  const startTime = Date.now();

  console.log(`${req.method} ${req.url}`);

  const originalJson = res.json;
  res.json = function (body: any) {
    const duration = Date.now() - startTime;
    console.log(`${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`);

    return originalJson.call(this, body);
  };

  next();
};
