import dotenv from "dotenv";
import path from "path";
import fs from "fs";

export function loadEnvironment(): void {
  const nodeEnv = process.env.NODE_ENV || "development";
  const appDir = path.resolve(__dirname, "../..");

  const envFiles = [
    path.join(appDir, ".env"),
    path.join(appDir, `.env.${nodeEnv}`),
    path.join(appDir, ".env.local"),
  ];

  envFiles.forEach((envPath) => {
    if (fs.existsSync(envPath)) {
      const result = dotenv.config({ path: envPath });
      if (result.error && process.env.NODE_ENV === "development") {
        console.warn(
          `Warning loading ${path.basename(envPath)}: ${result.error.message}`,
        );
      }
    }
  });
}

export function validateEnvironment(): void {
  const nodeEnv = process.env.NODE_ENV || "development";

  const requiredVars: Record<string, string[]> = {
    development: ["NODE_ENV", "PORT", "CONTROLNET_ENDPOINT"],
    production: [
      "NODE_ENV",
      "PORT",
      "CONTROLNET_ENDPOINT",
      "ALLOWED_ORIGINS",
      "AWS_REGION",
      "JWT_SECRET",
      "S3_BUCKET_NAME",
      "S3_PUBLIC_DOMAIN",
      "CLIENT_URL",
    ],
    test: ["NODE_ENV"],
  };

  const required = requiredVars[nodeEnv] || requiredVars.development || [];
  const missing = required.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
}

export interface AppConfig {
  // Server configuration
  port: number;
  host: string;
  nodeEnv: string;

  // External services
  controlnetEndpoint: string;

  // Security & CORS
  allowedOrigins: string[];
  jwtSecret?: string;
  apiKey?: string;

  // Timeouts (in milliseconds)
  requestTimeout: number;
  controlnetTimeout: number;
  healthCheckTimeout: number;

  // Job management
  jobCleanupInterval: number;
  maxJobAge: number;
  completedJobRetention: number;
  failedJobRetention: number;

  // DynamoDB
  dynamoTableName: string;

  // Rate limits
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;

  // Logging
  logLevel: string;

  // AWS
  aws: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };

  // s3
  s3: {
    bucketName: string;
    userQrPrefix: string;
    outputPrefix: string;
    inputPrefix: string;
    publicDomain: string;
    /**
     * Prefixes the API-Gateway relay Lambda uses for SageMaker async
     * invocations: request payloads (with prompts) and result `.out` files.
     * The gallery endpoint joins them to serve real prompt+image examples.
     */
    asyncInputPrefix: string;
    asyncOutputPrefix: string;
  };

  // Email (optional. Used by EmailService)
  adminEmail: string;
  emailFrom: string;
  clientUrl: string;

  // SageMaker (optional. Used by EndpointStatusService)
  sagemakerEndpointName: string;
  sagemakerStagingEndpointName: string;
  /** Endpoint status cache TTL in ms. Used by EndpointStatusService. */
  endpointStatusCacheTtlMs: number;
}

export function getConfig(): AppConfig {
  return {
    // Server config
    port: parseInt(process.env.PORT || "3001"),
    host: process.env.HOST || "0.0.0.0",
    nodeEnv: process.env.NODE_ENV || "development",

    // Ext services (controlnet)
    controlnetEndpoint:
      process.env.CONTROLNET_ENDPOINT || "http://localhost:8080",

    // Security & CORS
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",") || [
      "http://localhost:3000",
    ],
    jwtSecret: process.env.JWT_SECRET,
    apiKey: process.env.API_KEY,

    // Timeouts
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || "30000"),
    controlnetTimeout: parseInt(process.env.CONTROLNET_TIMEOUT || "300000"),
    healthCheckTimeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT || "5000"),

    // Job management
    jobCleanupInterval: parseInt(
      process.env.JOB_CLEANUP_INTERVAL_MS || "300000",
    ),
    maxJobAge: parseInt(process.env.MAX_JOB_AGE_MS || "3600000"),
    completedJobRetention: parseInt(
      process.env.COMPLETED_JOB_RETENTION_MS || "3600000",
    ),
    failedJobRetention: parseInt(
      process.env.FAILED_JOB_RETENTION_MS || "7200000",
    ),

    // DynamoDB table name
    dynamoTableName:
      process.env.DYNAMODB_TABLE_NAME || "qr-controlnet-api-local-jobs",

    // Rate limits
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"), // 15 minutes
    rateLimitMaxRequests: parseInt(
      process.env.RATE_LIMIT_MAX_REQUESTS || "100",
    ),

    // Logging level
    logLevel: process.env.LOG_LEVEL || "info",

    // AWS config
    aws: {
      region: process.env.AWS_REGION || "eu-west-1",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },

    // S3 config
    s3: {
      bucketName: process.env.S3_BUCKET_NAME || "",
      userQrPrefix: process.env.S3_USER_QR_PREFIX || "",
      outputPrefix: process.env.S3_OUTPUT_PREFIX || "",
      inputPrefix: process.env.S3_INPUT_PREFIX || "",
      publicDomain: process.env.S3_PUBLIC_DOMAIN || "",
      asyncInputPrefix:
        process.env.S3_ASYNC_INPUT_PREFIX || "controlnet-qr-inputs",
      asyncOutputPrefix:
        process.env.S3_ASYNC_OUTPUT_PREFIX || "controlnet-qr-outputs",
    },

    // Email (used by EmailService)
    adminEmail: process.env.ADMIN_EMAIL || "",
    emailFrom: process.env.EMAIL_FROM || process.env.ADMIN_EMAIL || "",
    clientUrl: process.env.CLIENT_URL || "http://localhost:3000",

    // SageMaker (used by EndpointStatusService)
    sagemakerEndpointName:
      process.env.SAGEMAKER_ENDPOINT_NAME || "",
    sagemakerStagingEndpointName:
      process.env.SAGEMAKER_STAGING_ENDPOINT_NAME || "",
    endpointStatusCacheTtlMs: parseInt(
      process.env.ENDPOINT_STATUS_CACHE_TTL_MS || "30000",
    ),
  };
}

/**
 * Format milliseconds to a short human-readable duration (e.g. 300000 -> "5m", 3600000 -> "1h").
 * Used for health/detailed config labels.
 */
export function formatMsToDurationLabel(ms: number): string {
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
}
