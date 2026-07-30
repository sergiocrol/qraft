import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import serverless from "serverless-http";

/**
 * CORS headers for API Gateway responses, computed per-request from ALLOWED_ORIGINS so the
 * allowlist enforced by the Express `cors` middleware (app.ts) isn't overwritten by a static
 * wildcard. Reused for OPTIONS, response modifier, and error responses.
 */
function corsHeadersFor(event: APIGatewayProxyEvent): Record<string, string> {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reqOrigin = event.headers?.origin || event.headers?.Origin || "";
  const allowAll = allowed.includes("*");
  const originHeader = allowAll
    ? "*"
    : allowed.includes(reqOrigin)
      ? reqOrigin
      : allowed[0] || "";

  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization,X-Request-ID,X-Job-Token",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Max-Age": "86400",
  };

  if (originHeader) headers["Access-Control-Allow-Origin"] = originHeader;
  // Only advertise credentials support when echoing a specific origin (not with "*") —
  // browsers reject the combination of "*" with Allow-Credentials: true.
  if (originHeader !== "*") {
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
  }

  return headers;
}

let app: any;
let isInitialized = false;
let initError: Error | null = null;

async function initializeApp() {
  if (isInitialized) return;

  try {
    const { loadEnvironment, validateEnvironment } = await import(
      "./utils/environment"
    );
    loadEnvironment();

    try {
      validateEnvironment();
    } catch (validationError) {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          "Environment validation warning:",
          validationError instanceof Error
            ? validationError.message
            : "Unknown error"
        );
      }
    }

    const appModule = await import("./app");
    app = appModule.default;

    isInitialized = true;
  } catch (error) {
    console.error(
      "Failed to initialize Lambda:",
      error instanceof Error ? error.message : "Unknown error"
    );
    initError =
      error instanceof Error
        ? error
        : new Error("Unknown initialization error");
    throw initError;
  }
}

let serverlessHandler: any;

function createServerlessHandler() {
  if (!app) {
    throw new Error("App not initialized");
  }

  if (!serverlessHandler) {
    serverlessHandler = serverless(app, {
      binary: false,
      request: (
        request: any,
        event: APIGatewayProxyEvent,
        context: Context
      ) => {
        request.lambda = { event, context };

        request.headers["x-request-id"] = context.awsRequestId;
      },
      response: (
        response: any,
        event: APIGatewayProxyEvent,
        context: Context
      ) => ({
        ...response,
        headers: {
          ...response.headers,
          ...corsHeadersFor(event),
        },
      }),
    });
  }

  return serverlessHandler;
}

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  try {
    if (process.env.LOG_LEVEL === "debug") {
      console.log("Lambda Request:", {
        method: event.httpMethod,
        path: event.path,
        requestId: context.awsRequestId,
      });
    }

    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeadersFor(event),
        body: "",
      };
    }

    if (!isInitialized && !initError) {
      await initializeApp();
    }

    if (initError) {
      console.error("App initialization failed:", initError);
      return {
        statusCode: 503,
        headers: {
          "Content-Type": "application/json",
          ...corsHeadersFor(event),
        },
        body: JSON.stringify({
          success: false,
          error: {
            message: "Service initialization failed",
            code: "INITIALIZATION_ERROR",
            details: initError.message,
          },
        }),
      };
    }

    const handler = createServerlessHandler();

    const result = (await handler(event, context)) as APIGatewayProxyResult;

    if (process.env.LOG_LEVEL === "debug") {
      console.log("Lambda Response:", {
        statusCode: result.statusCode,
        requestId: context.awsRequestId,
        remainingTime: context.getRemainingTimeInMillis(),
        bodyLength: result.body?.length || 0,
        hasBody: !!result.body,
      });
    }

    return result;
  } catch (error) {
    console.error("Lambda error:", {
      message: error instanceof Error ? error.message : "Unknown error",
      requestId: context.awsRequestId,
    });

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeadersFor(event),
      },
      body: JSON.stringify({
        success: false,
        error: {
          message: "Internal server error",
          code: "LAMBDA_ERROR",
        },
        requestId: context.awsRequestId,
      }),
    };
  }
};
