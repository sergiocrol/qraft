import { describe, it, expect } from "vitest";
import { QRGenerationRequestSchema } from "@repo/validation-schemas";
import type { QRGenerationRequest } from "@repo/shared-types";
import { ControlNetService } from "./services/ControlNetService";

// Mirrors the payload used by `make test-api-server` (Makefile), with the
// $(MODEL_S3_BUCKET)/$(AWS_REGION) Make variables filled in with stand-in
// values -- the schema only cares that these are well-formed URLs.
const validRequest = {
  prompt:
    "A japanese small village full of cherry blosom trees and snowy landscape",
  baseQrCode: [
    "https://test-bucket.s3.eu-west-1.amazonaws.com/user-qr-codes/test/qr3.png",
    "https://test-bucket.s3.eu-west-1.amazonaws.com/user-qr-codes/test/qr2.png",
  ],
  numImagesPerPrompt: 3,
  negativePrompt: "ugly, disfigured, low quality, blurry, nsfw",
  sampler: "dpm++_2m_karras",
  model: "dreamshaper",
  controlnetConditioningScale: [1.4, 0.1],
  controlGuidanceStart: [0, 0.1],
  controlGuidanceEnd: [1, 1],
  guidanceScale: 7,
  numInferenceSteps: 40,
  height: 1024,
  width: 1024,
};

describe("QRGenerationRequestSchema (characterization)", () => {
  it("accepts a fully-specified valid request", () => {
    expect(() => QRGenerationRequestSchema.parse(validRequest)).not.toThrow();
  });

  it("rejects numInferenceSteps above the max (100)", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({
        prompt: "test",
        baseQrCode: ["https://example.com/a.png"],
        numInferenceSteps: 999,
      }),
    ).toThrow();
  });

  it("rejects controlGuidanceEnd values above the max (1)", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({
        prompt: "test",
        baseQrCode: ["https://example.com/a.png"],
        controlGuidanceEnd: [2, 2],
      }),
    ).toThrow();
  });

  // Boundary pairs for the bounds shared across the three contract copies
  // (Zod schema, container marshmallow schemas, client form) — plan 006.
  it("accepts numInferenceSteps at the max (100) but rejects 101", () => {
    const base = {
      prompt: "test",
      baseQrCode: ["https://example.com/a.png"],
    };
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, numInferenceSteps: 100 }),
    ).not.toThrow();
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, numInferenceSteps: 101 }),
    ).toThrow();
  });

  it("accepts controlGuidanceEnd at the max ([1, 1])", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({
        prompt: "test",
        baseQrCode: ["https://example.com/a.png"],
        controlGuidanceEnd: [1, 1],
      }),
    ).not.toThrow();
  });

  it("accepts height at the floor (512) but rejects 500", () => {
    const base = {
      prompt: "test",
      baseQrCode: ["https://example.com/a.png"],
    };
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, height: 512 }),
    ).not.toThrow();
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, height: 500 }),
    ).toThrow();
  });

  it("rejects a non-URL baseQrCode entry", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({
        prompt: "test",
        baseQrCode: ["not-a-url"],
      }),
    ).toThrow();
  });

  // SSRF hardening (plan 005): baseQrCode entries must be public https URLs.
  // Legitimate values are always S3 public-domain URLs minted by /api/upload-qr.
  it("rejects an http:// baseQrCode entry", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({
        prompt: "test",
        baseQrCode: ["http://x/y.png"],
      }),
    ).toThrow();
  });

  it("rejects localhost and cloud-metadata baseQrCode hosts", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({
        prompt: "test",
        baseQrCode: ["https://localhost/qr.png"],
      }),
    ).toThrow();
    expect(() =>
      QRGenerationRequestSchema.parse({
        prompt: "test",
        baseQrCode: ["https://169.254.169.254/latest/meta-data"],
      }),
    ).toThrow();
  });

  it("accepts a normal https S3 public-domain baseQrCode URL", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({
        prompt: "test",
        baseQrCode: [
          "https://test-bucket.s3.eu-west-1.amazonaws.com/user-qr-codes/qr_abc123_1719999999999.png",
        ],
      }),
    ).not.toThrow();
  });
});

// v2 pipeline fields (plan 008): all four are optional and must have NO
// defaults — an absent field stays absent so the container's own default
// ("v1") rules.
describe("QRGenerationRequestSchema v2 pipeline fields", () => {
  const base = {
    prompt: "test",
    baseQrCode: ["https://example.com/a.png"],
  };

  it("accepts the four fields with valid values", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({
        ...base,
        pipeline: "v2",
        qrContent: "https://example.com/a",
        stylePreset: "cyberpunk",
        scanStrictness: "strict",
      }),
    ).not.toThrow();
  });

  it("leaves absent fields absent (no injected defaults)", () => {
    const parsed = QRGenerationRequestSchema.parse(base);
    expect(parsed).not.toHaveProperty("pipeline");
    expect(parsed).not.toHaveProperty("qrContent");
    expect(parsed).not.toHaveProperty("stylePreset");
    expect(parsed).not.toHaveProperty("scanStrictness");
  });

  it("rejects values outside the enums", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, pipeline: "v3" }),
    ).toThrow();
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, stylePreset: "vaporwave" }),
    ).toThrow();
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, scanStrictness: "loose" }),
    ).toThrow();
  });

  it("bounds qrContent to 1..90 chars", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, qrContent: "" }),
    ).toThrow();
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, qrContent: "a".repeat(91) }),
    ).toThrow();
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, qrContent: "a".repeat(90) }),
    ).not.toThrow();
  });
});

// Prompt enhancement (plan 009): defaults ON, explicit false preserved,
// non-boolean rejected.
describe("QRGenerationRequestSchema promptEnhancement", () => {
  const base = {
    prompt: "test",
    baseQrCode: ["https://example.com/a.png"],
  };

  it("defaults to true when absent", () => {
    const parsed = QRGenerationRequestSchema.parse(base);
    expect(parsed.promptEnhancement).toBe(true);
  });

  it("preserves an explicit false", () => {
    const parsed = QRGenerationRequestSchema.parse({
      ...base,
      promptEnhancement: false,
    });
    expect(parsed.promptEnhancement).toBe(false);
  });

  it("rejects non-boolean values", () => {
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, promptEnhancement: "yes" }),
    ).toThrow();
    expect(() =>
      QRGenerationRequestSchema.parse({ ...base, promptEnhancement: 1 }),
    ).toThrow();
  });
});

// transformRequest is private; accessed via a cast, same convention as the
// JobManager private-transform tests. Constructing the service needs no AWS
// access: getConfig() falls back to the localhost endpoint.
describe("ControlNetService.transformRequest v2 field mapping", () => {
  const service = new ControlNetService() as any;

  const baseRequest: QRGenerationRequest = {
    prompt: "a castle on a hill",
    baseQrCode: ["https://example.com/a.png"],
  };

  it("maps present v2 fields to snake_case", () => {
    const transformed = service.transformRequest({
      ...baseRequest,
      environment: "staging",
      pipeline: "v2",
      qrContent: "https://example.com/a",
      stylePreset: "watercolor",
      scanStrictness: "relaxed",
    });

    expect(transformed.pipeline).toBe("v2");
    expect(transformed.qr_content).toBe("https://example.com/a");
    expect(transformed.style_preset).toBe("watercolor");
    expect(transformed.scan_strictness).toBe("relaxed");

    // camelCase spellings must not leak into the container payload
    expect(transformed).not.toHaveProperty("qrContent");
    expect(transformed).not.toHaveProperty("stylePreset");
    expect(transformed).not.toHaveProperty("scanStrictness");

    // the existing environment routing is untouched
    expect(transformed.environment).toBe("staging");
  });

  it("omits the v2 keys entirely when the fields are absent", () => {
    const transformed = service.transformRequest(baseRequest);

    expect(transformed).not.toHaveProperty("pipeline");
    expect(transformed).not.toHaveProperty("qr_content");
    expect(transformed).not.toHaveProperty("style_preset");
    expect(transformed).not.toHaveProperty("scan_strictness");

    // untouched baseline mapping still present
    expect(transformed.prompt).toBe(baseRequest.prompt);
    expect(transformed.base_qr_code).toEqual(baseRequest.baseQrCode);
  });

  // Plan 009: both true AND false must map (anti-truthy regression) — the
  // container's schema default is False, so a dropped false would still be
  // correct today, but an explicit mapping keeps the contract unambiguous.
  it("maps promptEnhancement true and false to prompt_enhancement", () => {
    expect(
      service.transformRequest({ ...baseRequest, promptEnhancement: true })
        .prompt_enhancement,
    ).toBe(true);
    expect(
      service.transformRequest({ ...baseRequest, promptEnhancement: false })
        .prompt_enhancement,
    ).toBe(false);
  });

  it("leaves prompt_enhancement undefined when the field is absent", () => {
    const transformed = service.transformRequest(baseRequest);
    expect(transformed.prompt_enhancement).toBeUndefined();
  });
});
