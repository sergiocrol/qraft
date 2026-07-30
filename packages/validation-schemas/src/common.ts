import { z } from "zod";
import { PAGINATION_CONFIG, JOB_STATUSES } from "@repo/qr-constants";

// Error response schema
export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
    details: z.record(z.any()).optional(),
  }),
  requestId: z.string().optional(),
});

// Success response schema (generic)
export const SuccessResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
    requestId: z.string().optional(),
  });

// Job status enum schema
export const JobStatusSchema = z.enum(JOB_STATUSES);

// Job statistics schema
export const JobStatsSchema = z.object({
  total: z.number(),
  pending: z.number(),
  processing: z.number(),
  completed: z.number(),
  failed: z.number(),
  cancelled: z.number(),
});

// Health check schema
export const HealthCheckSchema = z.object({
  status: z.enum(["healthy", "unhealthy", "degraded", "unknown"]),
  message: z.string(),
  responseTime: z.number().optional(),
  timestamp: z.string().optional(),
  details: z.record(z.any()).optional(),
});

// System health schema
export const SystemHealthSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.enum(["healthy", "unhealthy", "degraded"]),
    timestamp: z.string(),
    uptime: z.number().optional(),
    version: z.string().optional(),
    checks: z.record(HealthCheckSchema),
  }),
  requestId: z.string().optional(),
});

// Export inferred types
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type JobStats = z.infer<typeof JobStatsSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type SystemHealth = z.infer<typeof SystemHealthSchema>;
