import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { galleryRoutes } from "./gallery";
import {
  GalleryService,
  type S3ClientLike,
} from "../services/GalleryService";
import { GALLERY_EXAMPLES_MAX_COUNT } from "../constants";

// ---------------------------------------------------------------------------
// Stub S3: an inputs prefix with relay request payloads (prompt +
// base_qr_code) and an outputs prefix with SageMaker .out results
// (input_qr_urls + images). UUIDs deliberately do NOT match between the two —
// the join must happen on the base QR URL.
// ---------------------------------------------------------------------------

const BASE_QR_A = "https://bucket.s3/user-qr-codes/generated/qr_aaa_1.png";
const BASE_QR_B = "https://bucket.s3/user-qr-codes/generated/qr_bbb_2.png";
const BASE_QR_ORPHAN =
  "https://bucket.s3/user-qr-codes/generated/qr_orphan_3.png";

const IMAGE_A1 = "https://bucket.s3/output/qr_generated_a_1.png";
const IMAGE_A2 = "https://bucket.s3/output/qr_generated_a_2.png";
const IMAGE_B1 = "https://bucket.s3/output/qr_generated_b_1.png";

function makeStubS3(): { client: S3ClientLike; sendCount: () => number } {
  const inputObjects: Record<string, unknown> = {
    "controlnet-qr-inputs/input-a.json": {
      prompt: "A castle at night",
      base_qr_code: [BASE_QR_A],
    },
    "controlnet-qr-inputs/input-b.json": {
      prompt: "A cyberpunk city",
      base_qr_code: BASE_QR_B, // plain string form
    },
    // Legacy rescue payload: no prompt — must be skipped.
    "controlnet-qr-inputs/input-rescue.json": {
      action: "rescue",
      image: "…",
      qr_code: "…",
    },
  };

  const outputObjects: Record<string, unknown> = {
    // Joins with input-a; image 2 is scan-verified with the higher score.
    "controlnet-qr-outputs/out-1.out": {
      images: [IMAGE_A1, IMAGE_A2],
      input_qr_urls: [BASE_QR_A],
      images_metadata: [
        { index: 1, scan_verified: true, scan_score: 0.08 },
        { index: 2, scan_verified: true, scan_score: 0.25 },
      ],
    },
    // Joins with input-b; old format without metadata → first image wins.
    "controlnet-qr-outputs/out-2.out": {
      images: [IMAGE_B1],
      input_qr_urls: [BASE_QR_B],
    },
    // Failed generation — must be skipped.
    "controlnet-qr-outputs/out-failed.out": {
      error: "CUDA out of memory",
      input_qr_urls: [BASE_QR_A],
    },
    // Result whose request payload is gone — no prompt, must be skipped.
    "controlnet-qr-outputs/out-orphan.out": {
      images: ["https://bucket.s3/output/qr_generated_orphan_1.png"],
      input_qr_urls: [BASE_QR_ORPHAN],
    },
    // Never-polled result still holding base64 images — must be skipped.
    "controlnet-qr-outputs/out-base64.out": {
      images: ["iVBORw0KGgoAAAANSUhEUg…"],
      input_qr_urls: [BASE_QR_B],
    },
  };

  let sendCount = 0;

  const client: S3ClientLike = {
    async send(command: any) {
      sendCount += 1;
      const name = command.constructor.name;

      if (name === "ListObjectsV2Command") {
        const prefix: string = command.input.Prefix;
        const objects = prefix.startsWith("controlnet-qr-inputs")
          ? inputObjects
          : outputObjects;
        return {
          Contents: Object.keys(objects).map((Key) => ({ Key, Size: 1024 })),
          IsTruncated: false,
        };
      }

      if (name === "GetObjectCommand") {
        const key: string = command.input.Key;
        const object = inputObjects[key] ?? outputObjects[key];
        if (!object) throw new Error(`NoSuchKey: ${key}`);
        return {
          Body: {
            transformToString: async () => JSON.stringify(object),
          },
        };
      }

      throw new Error(`Unexpected command: ${name}`);
    },
  };

  return { client, sendCount: () => sendCount };
}

describe("GalleryService", () => {
  it("joins prompts to images via the base QR URL and filters unusable records", async () => {
    const { client } = makeStubS3();
    const service = new GalleryService(client);

    const examples = await service.getRandomExamples(10);

    expect(examples).toHaveLength(2);
    const byPrompt = new Map(examples.map((e) => [e.prompt, e.imageUrl]));
    // Scan-verified image with the highest score is chosen for job A.
    expect(byPrompt.get("A castle at night")).toBe(IMAGE_A2);
    expect(byPrompt.get("A cyberpunk city")).toBe(IMAGE_B1);
  });

  it("respects the requested count", async () => {
    const { client } = makeStubS3();
    const service = new GalleryService(client);

    const examples = await service.getRandomExamples(1);

    expect(examples).toHaveLength(1);
  });

  it("serves subsequent requests from the cached pool without re-reading S3", async () => {
    const { client, sendCount } = makeStubS3();
    const service = new GalleryService(client);

    await service.getRandomExamples(2);
    const sendsAfterFirst = sendCount();
    await service.getRandomExamples(2);

    expect(sendCount()).toBe(sendsAfterFirst);
  });
});

describe("GET /api/gallery/examples", () => {
  let server: Server;
  let baseUrl: string;
  const getRandomExamples = vi.fn();

  beforeAll(async () => {
    const app = express();
    app.locals.galleryService = { getRandomExamples };
    app.use("/api/gallery", galleryRoutes);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns examples with the default count when none is given", async () => {
    const examples = [
      { imageUrl: "https://bucket.s3/output/x.png", prompt: "A fox" },
    ];
    getRandomExamples.mockResolvedValueOnce(examples);

    const res = await fetch(`${baseUrl}/api/gallery/examples`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.examples).toEqual(examples);
    expect(body.data.count).toBe(1);
    expect(getRandomExamples).toHaveBeenCalledWith(6);
  });

  it("clamps the requested count to the allowed maximum", async () => {
    getRandomExamples.mockResolvedValueOnce([]);

    const res = await fetch(`${baseUrl}/api/gallery/examples?count=999`);

    expect(res.status).toBe(200);
    expect(getRandomExamples).toHaveBeenCalledWith(
      GALLERY_EXAMPLES_MAX_COUNT,
    );
  });

  it("reports a gallery error when S3 is unreachable", async () => {
    getRandomExamples.mockRejectedValueOnce(new Error("S3 unavailable"));

    const res = await fetch(`${baseUrl}/api/gallery/examples`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("GALLERY_ERROR");
  });
});
