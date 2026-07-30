import type { JobStatus } from "../common";

export type HealthStatus = "healthy" | "unhealthy" | "degraded" | "unknown";

export interface HealthCheck {
  status: HealthStatus;
  message: string;
  responseTime?: number;
  timestamp?: string;
  details?: Record<string, any>;
}

export interface SystemHealth {
  status: HealthStatus;
  timestamp: string;
  uptime?: number;
  version?: string;
  checks: Record<string, HealthCheck>;
}

export interface SystemInfo {
  status: HealthStatus;
  timestamp: string;
  uptime: number;
  version: string;

  environment: {
    nodeVersion: string;
    platform: string;
    nodeEnv: string;
  };

  memory: {
    rss: string;
    heapTotal: string;
    heapUsed: string;
    external: string;
  };

  config: {
    port: number;
    controlnetEndpoint: string;
    requestTimeout: string;
    jobCleanupInterval: string;
    maxJobAge: string;
  };

  jobManager: {
    stats: JobStats;
    isRunning: boolean;
  };

  controlNet: {
    endpoint: string;
    info: any;
  };
}

export interface JobStats {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface JobFilters {
  status?: JobStatus;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
}

export interface QRJobSummary {
  id: string;
  status: JobStatus;
  progress?: number;
  message?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  estimatedTimeRemaining?: string;
  result?: {
    numImagesGenerated: number;
    processingTimeSeconds?: number;
    hasImages: boolean;
    outputPaths: string[];
  };
  error?: {
    message: string;
    code?: string;
  };
}

export interface ServiceStatus {
  name: string;
  status: HealthStatus;
  url?: string;
  lastChecked: string;
  responseTime?: number;
  error?: string;
}

export interface SystemMetrics {
  timestamp: string;
  cpu: {
    usage: number;
    loadAverage: number[];
  };
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  jobs: JobStats;
  requests: {
    total: number;
    errors: number;
    averageResponseTime: number;
  };
}
