import { Router } from "express";
import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";

import { GalleryService } from "../services/GalleryService";
import {
  RATE_LIMIT_GALLERY_WINDOW_MS,
  RATE_LIMIT_GALLERY_MAX,
  GALLERY_EXAMPLES_DEFAULT_COUNT,
  GALLERY_EXAMPLES_MAX_COUNT,
} from "../constants";
import { sendSuccess, sendError, ERROR_CODES } from "../utils/response";

const router: Router = Router();

const galleryLimiter = rateLimit({
  windowMs: RATE_LIMIT_GALLERY_WINDOW_MS,
  max: RATE_LIMIT_GALLERY_MAX,
  message: "Too many gallery requests",
});

/**
 * @route   GET /api/gallery/examples
 * @desc    Random past generations (image + the prompt that produced it),
 *          recovered by joining the async request/result records in S3 —
 *          shown in the client's "while you wait" section.
 * @access  Public (rate limited)
 * @query   {number} count - How many examples to return (1-12, default 6)
 */
router.get(
  "/examples",
  galleryLimiter,
  async (req: Request, res: Response) => {
    try {
      const galleryService = req.app.locals.galleryService as GalleryService;

      const requested = Number.parseInt(String(req.query.count), 10);
      const count = Number.isNaN(requested)
        ? GALLERY_EXAMPLES_DEFAULT_COUNT
        : Math.min(Math.max(requested, 1), GALLERY_EXAMPLES_MAX_COUNT);

      const examples = await galleryService.getRandomExamples(count);

      return sendSuccess(req, res, { examples, count: examples.length });
    } catch (error) {
      return sendError(
        req,
        res,
        error instanceof Error ? error.message : "Failed to load gallery",
        ERROR_CODES.GALLERY_ERROR,
        500,
      );
    }
  },
);

export { router as galleryRoutes };
