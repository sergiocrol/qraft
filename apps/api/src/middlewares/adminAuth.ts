import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { JWT_ISSUER, JWT_EXPIRES_IN } from "../constants";
import { sendError, ERROR_CODES } from "../utils/response";

export interface AuthRequest extends Request {
  admin?: {
    role: string;
    iat: number;
  };
}

export const adminAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return sendError(
        req,
        res,
        "Unauthorized",
        ERROR_CODES.AUTH_UNAUTHORIZED,
        401,
      );
    }

    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      return sendError(
        req,
        res,
        "Invalid credentials",
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        401,
      );
    }

    try {
      const decoded = jwt.verify(token, jwtSecret, {
        issuer: JWT_ISSUER,
        maxAge: JWT_EXPIRES_IN,
      }) as { role: string; iat: number };

      if (decoded.role !== "admin") {
        return sendError(
          req,
          res,
          "Insufficient permissions",
          ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          403,
        );
      }

      req.admin = decoded;
      return next();
    } catch (jwtError) {
      return sendError(
        req,
        res,
        "Invalid or expired token",
        ERROR_CODES.AUTH_INVALID_TOKEN,
        401,
      );
    }
  } catch (error) {
    return sendError(
      req,
      res,
      "Authentication error",
      ERROR_CODES.AUTH_ERROR,
      500,
    );
  }
};
