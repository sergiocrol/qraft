import express, { Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import {
  JWT_ISSUER,
  JWT_EXPIRES_IN,
  JWT_EXPIRES_IN_SECONDS,
  CHALLENGE_TTL_MS,
  CHALLENGE_CLEANUP_INTERVAL_MS,
  RATE_LIMIT_AUTH_WINDOW_MS,
  RATE_LIMIT_AUTH_MAX,
} from "../constants";
import { sendSuccess, sendError, ERROR_CODES } from "../utils/response";

const router: express.Router = express.Router();

/**
 * Throttle the admin challenge/verify pair. The verify step is a single HMAC
 * comparison against ADMIN_SECRET, so without a limit the secret is subject to
 * unlimited online guessing. Keep this strict.
 */
const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_AUTH_WINDOW_MS,
  max: RATE_LIMIT_AUTH_MAX,
  message: "Too many authentication attempts, please try again later.",
});

const challengeStore = new Map<
  string,
  { challenge: string; timestamp: number }
>();

setInterval(() => {
  const now = Date.now();
  for (const [id, data] of challengeStore) {
    if (now - data.timestamp > CHALLENGE_TTL_MS) {
      challengeStore.delete(id);
    }
  }
}, CHALLENGE_CLEANUP_INTERVAL_MS);

/**
 * @route   POST /api/auth/challenge
 * @desc    Generate a challenge for admin authentication
 * @access  Public
 * @returns {Object} Challenge ID and challenge string for HMAC signing
 */
router.post("/challenge", authLimiter, (req: Request, res: Response) => {
  const challengeId = crypto.randomUUID();
  const challenge = crypto.randomBytes(32).toString("hex");

  challengeStore.set(challengeId, {
    challenge,
    timestamp: Date.now(),
  });

  return sendSuccess(req, res, {
    challengeId,
    challenge,
  });
});

/**
 * @route   POST /api/auth/verify
 * @desc    Verify admin credentials and return JWT token
 * @access  Public
 * @body    {string} challengeId - The challenge identifier
 * @body    {string} signature - HMAC signature of the challenge
 * @returns {Object} JWT token and expiration time
 */
router.post("/verify", authLimiter, async (req: Request, res: Response) => {
  try {
    const { challengeId, signature } = req.body;

    if (!challengeId || !signature) {
      return sendError(
        req,
        res,
        "Missing challenge ID or signature",
        ERROR_CODES.AUTH_MISSING_CREDENTIALS,
        400,
      );
    }

    const challengeData = challengeStore.get(challengeId);

    if (!challengeData) {
      return sendError(
        req,
        res,
        "Invalid or expired challenge",
        ERROR_CODES.AUTH_INVALID_CHALLENGE,
        401,
      );
    }

    challengeStore.delete(challengeId);

    const adminSecret = process.env.ADMIN_SECRET;

    if (!adminSecret) {
      return sendError(
        req,
        res,
        "Invalid credentials",
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        401,
      );
    }

    const expectedSignature = crypto
      .createHmac("sha256", adminSecret)
      .update(challengeData.challenge)
      .digest("hex");

    const signatureMatch =
      signature.length === expectedSignature.length &&
      crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature),
      );

    if (!signatureMatch) {
      return sendError(
        req,
        res,
        "Invalid credentials",
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        401,
      );
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      return sendError(
        req,
        res,
        "Invalid credentials",
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        401,
      );
    }

    const token = jwt.sign(
      {
        role: "admin",
      },
      jwtSecret,
      {
        expiresIn: JWT_EXPIRES_IN,
        issuer: JWT_ISSUER,
      },
    );

    return sendSuccess(req, res, {
      token,
      expiresIn: JWT_EXPIRES_IN_SECONDS,
    });
  } catch (error: any) {
    return sendError(
      req,
      res,
      "Authentication failed",
      ERROR_CODES.AUTH_FAILED,
      500,
    );
  }
});

export { router as authRoutes };
