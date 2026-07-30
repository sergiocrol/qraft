import type { ErrorDetails } from "../common";
import type { ErrorCode, HttpStatusCode } from "@repo/qr-constants";

export interface ApiResponse<T> {
  success: true;
  data: T;
  error?: string;
  requestId?: string;
}

export interface ApiError {
  success: false;
  error: ErrorDetails;
  requestId?: string;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

export type { ErrorCode, HttpStatusCode };

export interface RequestHeaders {
  "Content-Type"?: string;
  Authorization?: string;
  "X-Request-ID"?: string;
  "User-Agent"?: string;
  [key: string]: string | undefined;
}

export interface ClientConfig {
  baseUrl: string;
  timeout?: number;
  defaultHeaders?: RequestHeaders;
  retries?: number;
}
