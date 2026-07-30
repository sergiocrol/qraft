import { Router } from "express";
import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import { getConfig } from "../utils/environment";
import {
  RATE_LIMIT_UPLOAD_WINDOW_MS,
  RATE_LIMIT_UPLOAD_MAX,
} from "../constants";
import { sendSuccess, sendError, ERROR_CODES } from "../utils/response";

const router: Router = Router();

const config = getConfig();
const s3Client = new S3Client({
  region: config.aws.region || "eu-west-1",
});

const uploadLimiter = rateLimit({
  windowMs: RATE_LIMIT_UPLOAD_WINDOW_MS,
  max: RATE_LIMIT_UPLOAD_MAX,
  message: "Upload limit exceeded. Please wait before uploading more QRs.",
});

// This endpoint only ever receives client-rendered QR PNGs, which are far
// smaller than 2 MB. Anything that is not a PNG, or is oversized, is abuse of
// the public bucket, so reject it before touching S3.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * @route   POST /api/qr-upload
 * @desc    Upload a QR code image to S3
 * @access  Public (rate limited; PNG only, max 2 MB)
 * @body    {string} qrDataUrl - Base64 encoded QR code image
 * @returns {Object} S3 URL and upload details
 */
router.post("/", uploadLimiter, async (req: Request, res: Response) => {
  try {
    const { qrDataUrl } = req.body;

    if (!qrDataUrl || typeof qrDataUrl !== "string") {
      return sendError(
        req,
        res,
        "No QR code data provided",
        ERROR_CODES.BAD_REQUEST,
        400,
      );
    }

    const base64Data = qrDataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    if (
      buffer.length > MAX_UPLOAD_BYTES ||
      !buffer.subarray(0, 8).equals(PNG_MAGIC)
    ) {
      return sendError(
        req,
        res,
        "Invalid or oversized image",
        ERROR_CODES.BAD_REQUEST,
        400,
      );
    }

    const uniqueId = uuidv4().slice(0, 8);
    const timestamp = Date.now();
    const filename = `${config.s3.userQrPrefix}/qr_${uniqueId}_${timestamp}.png`;

    const uploadCommand = new PutObjectCommand({
      Bucket: config.s3.bucketName,
      Key: filename,
      Body: buffer,
      ContentType: "image/png",
      ACL: "public-read",
      Metadata: {
        "upload-id": uniqueId,
        "created-at": new Date().toISOString(),
      },
    });

    await s3Client.send(uploadCommand);

    const s3Url = `${config.s3.publicDomain}/${filename}`;

    return sendSuccess(req, res, {
      url: s3Url,
      uploadId: uniqueId,
      bucket: config.s3.bucketName,
      key: filename,
    });
  } catch (error) {
    return sendError(
      req,
      res,
      "Failed to upload QR code to S3",
      ERROR_CODES.UPLOAD_ERROR,
      500,
    );
  }
});

export { router as uploadRoutes };
