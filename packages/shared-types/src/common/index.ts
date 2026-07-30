import {
  SupportedSampler,
  SupportedModel,
  JobStatus,
} from "@repo/qr-constants";

export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type { SupportedSampler as SamplerType };
export type { SupportedModel as ModelType };
export type { JobStatus };

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ErrorDetails {
  message: string;
  code?: string;
  details?: Record<string, any>;
}
