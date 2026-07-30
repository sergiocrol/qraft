import axios, { AxiosInstance, AxiosError } from "axios";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromEnv } from "@aws-sdk/credential-providers";
import type {
  QRGenerationRequest,
  ControlNetServiceResponse,
} from "@repo/shared-types";
import { TIMEOUT_CONFIG } from "@repo/qr-constants";
import { AppConfig, getConfig } from "../utils/environment";

interface ControlNetErrorResponse {
  error?: string;
  message?: string;
  traceback?: string;
  [key: string]: any;
}

interface ControlNetSuccessResponse {
  images?: string[];
  image?: string;
  image_urls?: string[];
  output_paths?: string[];
  output_path?: string;
  num_images_generated?: number;
  processing_time_seconds?: number;
  generation_plan?: Record<string, any>;
  generations?: any[];
  input_qr_urls?: string[];
  qr_source?: string;
  s3_bucket?: string;
  images_metadata?: Array<Record<string, any>>;
  message?: string;
  [key: string]: any;
}

interface ApiGatewayErrorResponse {
  error?: string;
  message?: string;
  [key: string]: any;
}

interface ApiGatewayGenerationResponse {
  requestId?: string;
  request_id?: string;
  status?: string;
  outputLocation?: string;
  output_location?: string;
  message?: string;
  statusCheckUrl?: string;
  status_check_url?: string;
  resultUrl?: string;
  result_url?: string;
  inputQrUrls?: string[];
  input_qr_urls?: string[];
  numQrCodes?: number;
  num_qr_codes?: number;
  requestedImages?: number;
  requested_images?: number;
  [key: string]: any;
}

interface ApiGatewayStatusResponse {
  status: string;
  requestId?: string;
  request_id?: string;
  message: string;
  resultUrl?: string;
  result_url?: string;
  [key: string]: any;
}

interface ApiGatewayResultResponse {
  status: string;
  requestId?: string;
  request_id?: string;
  images: string[];
  image_urls?: string[];
  numImagesGenerated?: number;
  num_images_generated?: number;
  seed?: any;
  qrSource?: string;
  qr_source?: string;
  generations?: any[];
  generationPlan?: any;
  generation_plan?: any;
  outputPaths?: string[];
  output_paths?: string[];
  inputQrUrls?: string[];
  input_qr_urls?: string[];
  image?: string;
  s3_bucket?: string;
  [key: string]: any;
}

export class ControlNetService {
  private client: AxiosInstance;
  private apiGatewayEndpoint: string;
  private config: AppConfig;
  private signer?: SignatureV4;
  private isAwsApiGateway: boolean;

  constructor() {
    this.config = getConfig();
    this.apiGatewayEndpoint = this.config.controlnetEndpoint;

    this.isAwsApiGateway =
      this.apiGatewayEndpoint.includes("execute-api") &&
      this.apiGatewayEndpoint.includes("amazonaws.com");

    if (this.isAwsApiGateway) {
      this.initializeAwsSigner();
    }

    this.client = axios.create({
      baseURL: this.apiGatewayEndpoint,
      timeout: TIMEOUT_CONFIG.CONTROLNET_REQUEST,
      headers: this.isAwsApiGateway
        ? {}
        : {
            "Content-Type": "application/json",
            "User-Agent": "QR-ControlNet-API/1.0.0",
          },
      transformRequest: this.isAwsApiGateway ? [(data) => data] : undefined,
    });

    this.client.interceptors.request.use(
      async (config) => {
        if (this.isAwsApiGateway && this.signer) {
          return await this.signRequest(config);
        }

        return config;
      },
      (error) => Promise.reject(error),
    );

    this.client.interceptors.response.use(
      (response) => {
        return response;
      },
      (error) => this.handleError(error),
    );
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    details?: any;
    responseTime?: number;
  }> {
    const startTime = Date.now();

    try {
      const response = await this.client.get("/ping", {
        timeout: TIMEOUT_CONFIG.HEALTH_CHECK,
      });

      const responseTime = Date.now() - startTime;

      return {
        healthy: response.status === 200,
        details: response.data,
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      return {
        healthy: false,
        details: error instanceof Error ? error.message : "Unknown error",
        responseTime,
      };
    }
  }

  async submitQRGeneration(request: QRGenerationRequest): Promise<{
    requestId: string;
    statusCheckUrl: string;
    resultUrl: string;
    outputLocation: string;
  }> {
    try {
      const apiGatewayRequest = this.transformRequest(request);

      const response = await this.client.post<ApiGatewayGenerationResponse>(
        "/generate",
        apiGatewayRequest,
      );

      if (this.isErrorResponse(response.data)) {
        throw new Error(
          (response.data as any).error ||
            (response.data as any).message ||
            "API Gateway service error",
        );
      }

      let result = response.data as ApiGatewayGenerationResponse;

      if (typeof result === "string") {
        try {
          result = JSON.parse(result);
        } catch (parseError) {
          console.error("Failed to parse JSON response:", parseError);
          throw new Error("Invalid JSON response from API Gateway");
        }
      }

      const requestId = result.requestId || result.request_id;
      const statusCheckUrl = result.statusCheckUrl || result.status_check_url;
      const resultUrl = result.resultUrl || result.result_url;
      const outputLocation = result.outputLocation || result.output_location;

      if (!requestId) {
        const fallbackRequestId = result.message || `async_${Date.now()}`;

        return {
          requestId: fallbackRequestId,
          statusCheckUrl:
            statusCheckUrl || `/generate/status/${fallbackRequestId}`,
          resultUrl: resultUrl || `/generate/result/${fallbackRequestId}`,
          outputLocation: outputLocation || "",
        };
      }

      return {
        requestId,
        statusCheckUrl: statusCheckUrl || `/generate/status/${requestId}`,
        resultUrl: resultUrl || `/generate/result/${requestId}`,
        outputLocation: outputLocation || "",
      };
    } catch (error) {
      console.error("QR generation submission failed:", error);

      if (axios.isAxiosError(error)) {
        throw this.createServiceError(error);
      }
      throw error;
    }
  }

  async checkQRGenerationStatus(
    requestId: string,
  ): Promise<{ status: string; isComplete: boolean; resultUrl?: string }> {
    try {
      const response = await this.client.get<ApiGatewayStatusResponse>(
        `/generate/status/${requestId}`,
      );

      let result = response.data;

      if (typeof result === "string") {
        try {
          result = JSON.parse(result);
        } catch (parseError) {
          console.error("Failed to parse JSON response:", parseError);
          throw new Error("Invalid JSON response from API Gateway");
        }
      }

      const status = result.status;
      const resultUrl = result.resultUrl || result.result_url;

      const isComplete = status === "COMPLETED" || status === "completed";

      return {
        status,
        isComplete,
        resultUrl,
      };
    } catch (error) {
      console.error(`Status check failed for ${requestId}:`, error);

      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          try {
            await this.getQRGenerationResult(requestId);
            return {
              status: "COMPLETED",
              isComplete: true,
            };
          } catch (resultError) {
            return {
              status: "PROCESSING",
              isComplete: false,
            };
          }
        }

        throw this.createServiceError(error);
      }
      throw error;
    }
  }

  async checkQRGenerationStatusByOutputLocation(
    outputLocation: string,
  ): Promise<{ status: string; isComplete: boolean }> {
    try {
      if (!outputLocation) {
        return { status: "PROCESSING", isComplete: false };
      }

      if (!outputLocation.startsWith("s3://")) {
        throw new Error(`Invalid S3 URL format: ${outputLocation}`);
      }

      const s3Url = outputLocation.replace("s3://", "");

      const firstSlashIndex = s3Url.indexOf("/");

      if (firstSlashIndex === -1) {
        throw new Error(`Invalid S3 URL format - no path: ${outputLocation}`);
      }

      const bucket = s3Url.substring(0, firstSlashIndex);
      const key = s3Url.substring(firstSlashIndex + 1);

      const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");

      const s3Client = new S3Client({
        region: this.config.aws.region || "eu-west-1",
      });

      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { status: "COMPLETED", isComplete: true };
      } catch (s3Error: any) {
        if (
          s3Error.name === "NoSuchKey" ||
          s3Error.$metadata?.httpStatusCode === 404
        ) {
          return { status: "PROCESSING", isComplete: false };
        } else {
          console.error("Unexpected S3 error checking job status:", s3Error);
          return { status: "PROCESSING", isComplete: false };
        }
      }
    } catch (outerError) {
      console.error("Error checking QR generation status by output location:", outerError);
      return { status: "PROCESSING", isComplete: false };
    }
  }

  async getQRGenerationResult(
    requestId: string,
  ): Promise<ControlNetServiceResponse> {
    try {
      const response = await this.client.get<ApiGatewayResultResponse>(
        `/generate/result/${requestId}`,
      );

      let result = response.data;

      if (typeof result === "string") {
        try {
          result = JSON.parse(result);
        } catch (parseError) {
          console.error("Failed to parse JSON response:", parseError);
          throw new Error("Invalid JSON response from API Gateway");
        }
      }

      const numImagesGenerated =
        result.numImagesGenerated || result.num_images_generated || 0;
      const qrSource = result.qrSource || result.qr_source;
      const outputPaths = result.outputPaths || result.output_paths;
      const inputQrUrls = result.inputQrUrls || result.input_qr_urls;
      const generationPlan = result.generationPlan || result.generation_plan;
      const imageUrls = result.image_urls || [];
      const s3Bucket = result.s3_bucket;

      return this.transformResponse({
        ...result,
        num_images_generated: numImagesGenerated,
        qr_source: qrSource,
        output_paths: outputPaths,
        input_qr_urls: inputQrUrls,
        generation_plan: generationPlan,
        image_urls: imageUrls,
        s3_bucket: s3Bucket,
      });
    } catch (error) {
      console.error(`Failed to get results for ${requestId}:`, error);

      if (axios.isAxiosError(error)) {
        throw this.createServiceError(error);
      }
      throw error;
    }
  }

  async getQRGenerationResultByOutputLocation(
    outputLocation: string,
  ): Promise<ControlNetServiceResponse> {
    try {
      if (!outputLocation.startsWith("s3://")) {
        throw new Error(`Invalid S3 URL format: ${outputLocation}`);
      }

      const s3Url = outputLocation.replace("s3://", "");
      const firstSlashIndex = s3Url.indexOf("/");
      const bucket = s3Url.substring(0, firstSlashIndex);
      const key = s3Url.substring(firstSlashIndex + 1);

      const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

      const s3Client = new S3Client({
        region: this.config.aws.region || "eu-west-1",
      });

      const getCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await s3Client.send(getCommand);

      if (!response.Body) {
        throw new Error("Empty response from S3");
      }

      const streamToString = (stream: any) =>
        new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () =>
            resolve(Buffer.concat(chunks).toString("utf-8")),
          );
        });

      const resultText = await streamToString(response.Body);
      const result = JSON.parse(resultText);

      const imageUrls = result.image_urls || [];

      return this.transformResponse({
        ...result,
        num_images_generated:
          result.num_images_generated || result.numImagesGenerated || 0,
        qr_source: result.qr_source || result.qrSource,
        output_paths: result.output_paths || result.outputPaths,
        input_qr_urls: result.input_qr_urls || result.inputQrUrls,
        generation_plan: result.generation_plan || result.generationPlan,
        image_urls: imageUrls,
        s3_bucket: result.s3_bucket,
      });
    } catch (error) {
      console.error("Error getting results from S3:", error);
      throw new Error(
        `Failed to get results from S3: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  private initializeAwsSigner() {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = this.config.aws.region || "eu-west-1";

    if (!accessKeyId || !secretAccessKey) {
      return;
    }

    try {
      this.signer = new SignatureV4({
        credentials: fromEnv(),
        region: region,
        service: "execute-api",
        sha256: Sha256,
      });
    } catch (error) {
      console.error("Failed to initialize signer:", error);
    }
  }

  private async signRequest(config: any) {
    if (!this.signer) {
      return config;
    }

    try {
      const fullUrl = `${config.baseURL}${config.url}`;
      const url = new URL(fullUrl);

      const body = config.data ? JSON.stringify(config.data) : undefined;

      const request = {
        method: config.method?.toUpperCase() || "POST",
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          host: url.hostname,
          "content-type": "application/json",
        },
        protocol: "https",
        body: body,
      };

      const signedRequest = await this.signer.sign(request);

      config.headers = { ...signedRequest.headers };
      config.data = body;
      config.transformRequest = [(data: any) => data];

      return config;
    } catch (error: any) {
      throw new Error(`Failed to sign AWS request: ${error.message}`);
    }
  }

  private transformRequest(request: QRGenerationRequest): any {
    const transformed: any = {
      prompt: request.prompt,
      base_qr_code: request.baseQrCode,
      num_images_per_prompt: request.numImagesPerPrompt,
      negative_prompt: request.negativePrompt,
      num_inference_steps: request.numInferenceSteps,
      controlnet_conditioning_scale: request.controlnetConditioningScale,
      control_guidance_start: request.controlGuidanceStart,
      control_guidance_end: request.controlGuidanceEnd,
      height: request.height,
      width: request.width,
      sampler: request.sampler,
      guidance_scale: request.guidanceScale,
      model: request.model,
      seed: request.seed,
      guess_mode: request.guessMode,
      prompt_enhancement: request.promptEnhancement,
    };

    if (request.environment === "staging") {
      transformed.environment = "staging";
    }

    // v2 pipeline fields (plan 008): forwarded only when present, so an
    // absent field stays absent and the container's own default ("v1") rules.
    if (request.pipeline !== undefined) {
      transformed.pipeline = request.pipeline;
    }

    if (request.qrContent !== undefined) {
      transformed.qr_content = request.qrContent;
    }

    if (request.stylePreset !== undefined) {
      transformed.style_preset = request.stylePreset;
    }

    if (request.scanStrictness !== undefined) {
      transformed.scan_strictness = request.scanStrictness;
    }

    return transformed;
  }

  private transformResponse(
    response: ControlNetSuccessResponse,
  ): ControlNetServiceResponse {
    const finalImages = response.image_urls?.length
      ? response.image_urls
      : response.images || (response.image ? [response.image] : []);

    return {
      images: finalImages,
      image_urls: response.image_urls || [],
      output_paths:
        response.output_paths ||
        (response.output_path ? [response.output_path] : []),
      num_images_generated: response.num_images_generated || 0,
      processing_time_seconds: response.processing_time_seconds,
      generation_plan: response.generation_plan,
      generations: response.generations,
      input_qr_urls: response.input_qr_urls,
      qr_source: response.qr_source,
      s3_bucket: response.s3_bucket,
      images_metadata: response.images_metadata,
    };
  }

  private isErrorResponse(
    data: ControlNetSuccessResponse | ControlNetErrorResponse,
  ): data is ControlNetErrorResponse {
    return (
      !!(data as ControlNetErrorResponse).error ||
      (!!(data as ControlNetErrorResponse).message && !(data as any).status)
    );
  }

  private handleError(error: AxiosError): Promise<never> {
    if (error.code === "ECONNABORTED") {
      return Promise.reject(new Error("ControlNet service timeout"));
    }

    if (error.code === "ECONNREFUSED") {
      return Promise.reject(
        new Error("ControlNet service unavailable - connection refused"),
      );
    }

    if (error.response?.status === 503) {
      return Promise.reject(new Error("ControlNet service unavailable"));
    }

    if (error.response?.status === 502) {
      return Promise.reject(new Error("ControlNet service bad gateway"));
    }

    return Promise.reject(error);
  }

  private createServiceError(error: AxiosError): Error {
    const errorData = error.response?.data as
      | ControlNetErrorResponse
      | undefined;

    const message =
      errorData?.error ||
      errorData?.message ||
      error.message ||
      "ControlNet service error";

    const serviceError = new Error(message);

    (serviceError as any).code = "CONTROLNET_SERVICE_ERROR";
    (serviceError as any).status = error.response?.status || 500;
    (serviceError as any).originalError = error;

    if (errorData?.traceback && this.config.nodeEnv === "development") {
      (serviceError as any).traceback = errorData.traceback;
    }

    return serviceError;
  }
}
