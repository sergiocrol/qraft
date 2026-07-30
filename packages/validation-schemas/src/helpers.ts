import { z } from "zod";
import { QRGenerationRequestSchema } from "./index";

// Validation helper functions for clean API usage

/**
 * Validates QR generation request data
 * @param data - Unknown data to validate
 * @returns Validated QR generation request
 * @throws ZodError if validation fails
 */
export const validateQRRequest = (data: unknown) => {
  return QRGenerationRequestSchema.parse(data);
};

/**
 * Safely validates QR generation request data
 * @param data - Unknown data to validate
 * @returns Success object with data or error object
 */
export const safeValidateQRRequest = (data: unknown) => {
  return QRGenerationRequestSchema.safeParse(data);
};

/**
 * Creates a validation middleware for Express
 * @param schema - Zod schema to validate against
 * @returns Express middleware function
 */
export const createValidationMiddleware = <T extends z.ZodTypeAny>(
  schema: T
) => {
  return (req: any, res: any, next: any) => {
    try {
      const validatedData = schema.parse(req.body);
      req.validatedBody = validatedData;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            message: "Validation failed",
            code: "VALIDATION_ERROR",
            details: error.errors.reduce((acc: any, err) => {
              const path = err.path.join(".");
              acc[path] = err.message;
              return acc;
            }, {}),
          },
        });
      }

      return res.status(500).json({
        success: false,
        error: {
          message: "Internal validation error",
          code: "INTERNAL_ERROR",
        },
      });
    }
  };
};

/**
 * Validates URL format
 * @param url - URL string to validate
 * @returns True if valid URL
 */
export const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

/**
 * Validates that a number is divisible by another number
 * @param value - Number to check
 * @param divisor - Number to divide by
 * @returns True if divisible
 */
export const isDivisibleBy = (value: number, divisor: number): boolean => {
  return value % divisor === 0;
};

/**
 * Formats Zod errors into a user-friendly format
 * @param error - ZodError instance
 * @returns Formatted error object
 */
export const formatZodError = (error: z.ZodError) => {
  return {
    message: "Validation failed",
    code: "VALIDATION_ERROR",
    details: error.errors.reduce((acc: Record<string, string>, err) => {
      const path = err.path.join(".");
      acc[path] = err.message;
      return acc;
    }, {}),
  };
};

/**
 * Type guard to check if an error is a ZodError
 * @param error - Error to check
 * @returns True if error is ZodError
 */
export const isZodError = (error: unknown): error is z.ZodError => {
  return error instanceof z.ZodError;
};
