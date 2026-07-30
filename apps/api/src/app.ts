import {
  loadEnvironment,
  validateEnvironment,
  getConfig,
} from "./utils/environment";
import { API_ENDPOINTS } from "./constants";

loadEnvironment();
validateEnvironment();

import express, { Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { errorHandler } from "./middlewares/errorHandler";
import { sendError, ERROR_CODES } from "./utils/response";
import { requestLogger } from "./middlewares/requestLogger";
import { healthRoutes } from "./routes/health";
import { qrGenerationRoutes } from "./routes/qrGeneration";
import { jobRoutes } from "./routes/jobs";
import { endpointRoutes } from "./routes/endpoint";
import { JobManager } from "./services/JobManager";
import { ControlNetService } from "./services/ControlNetService";
import { uploadRoutes } from "./routes/qrUpload";
import { authRoutes } from "./routes/auth";
import { galleryRoutes } from "./routes/gallery";
import { GalleryService } from "./services/GalleryService";

const app: Express = express();
const config = getConfig();

const controlNetService = new ControlNetService();
const jobManager = new JobManager(controlNetService);
const galleryService = new GalleryService();

app.use(
  helmet({
    contentSecurityPolicy: config.nodeEnv === "production",
  }),
);

app.use(
  cors({
    origin: config.allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID", "X-Job-Token"],
  }),
);

if (config.nodeEnv !== "test") {
  const morganFormat = config.nodeEnv === "production" ? "combined" : "dev";
  app.use(morgan(morganFormat));
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(requestLogger);

app.locals.jobManager = jobManager;
app.locals.controlNetService = controlNetService;
app.locals.galleryService = galleryService;
app.locals.config = config;

app.use(API_ENDPOINTS.HEALTH, healthRoutes);
app.use(API_ENDPOINTS.QR_GENERATION, qrGenerationRoutes);
app.use(API_ENDPOINTS.JOBS, jobRoutes);
app.use(API_ENDPOINTS.UPLOAD_QR, uploadRoutes);
app.use(API_ENDPOINTS.AUTH, authRoutes);
app.use(API_ENDPOINTS.ENDPOINT, endpointRoutes);
app.use(API_ENDPOINTS.GALLERY, galleryRoutes);

app.get("/", (req, res) => {
  res.json({
    name: "QR ControlNet API",
    version: "1.0.0",
    environment: config.nodeEnv,
    status: "running",
    endpoints: {
      health: API_ENDPOINTS.HEALTH,
      qrGeneration: API_ENDPOINTS.QR_GENERATION,
      jobs: API_ENDPOINTS.JOBS,
      upload: API_ENDPOINTS.UPLOAD_QR,
      endpoint: API_ENDPOINTS.ENDPOINT,
      gallery: API_ENDPOINTS.GALLERY,
    },
  });
});

app.use("*", (req, res) => {
  sendError(req, res, "Route not found", ERROR_CODES.ROUTE_NOT_FOUND, 404, {
    path: req.originalUrl,
  });
});

app.use(errorHandler);

export { app as default, jobManager, controlNetService, config };
