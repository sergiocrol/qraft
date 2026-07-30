import { describe, it, expect, vi } from "vitest";
import type { QRGenerationRequest } from "@repo/shared-types";
import { JobManager } from "./JobManager";
import type { AsyncQRJob } from "./DynamoJobStore";

// The pure transforms exercised below are private; access them via a
// minimal cast. A stub ControlNetService is enough because none of these
// methods touch controlNetService or DynamoDB.
const jm = new JobManager({} as any) as any;

describe("JobManager pure transforms (characterization)", () => {
  describe("safeScales", () => {
    it("defaults to [1.0, 0.1] when given undefined", () => {
      expect(jm.safeScales(undefined)).toEqual([1.0, 0.1]);
    });

    it("takes the first two elements when given a longer array", () => {
      expect(jm.safeScales([2, 3, 9])).toEqual([2, 3]);
    });
  });

  describe("safeNumber", () => {
    it("parses a numeric string", () => {
      expect(jm.safeNumber("5")).toBe(5);
    });

    it("falls back to the provided default on a non-numeric string", () => {
      expect(jm.safeNumber("x", 7)).toBe(7);
    });
  });

  describe("transformGenerationPlan", () => {
    it("returns undefined for undefined input", () => {
      expect(jm.transformGenerationPlan(undefined)).toBeUndefined();
    });

    it("maps snake_case keys to camelCase", () => {
      const result = jm.transformGenerationPlan({ total_generations: 3 });
      expect(result).toEqual({
        totalGenerations: 3,
        uniqueUrls: 0,
        userScaleCount: 0,
        alternativeScaleCount: 0,
        details: [],
      });
    });
  });

  describe("estimateProgress", () => {
    it("returns 30 when the job has no startedAt", () => {
      expect(jm.estimateProgress({} as AsyncQRJob)).toBe(30);
    });

    it("stays within [30, 95] once the job has started", () => {
      const job = {
        startedAt: new Date(Date.now() - 10_000).toISOString(),
      } as AsyncQRJob;
      const progress = jm.estimateProgress(job);
      expect(progress).toBeGreaterThanOrEqual(30);
      expect(progress).toBeLessThanOrEqual(95);
    });
  });
});

// createJob must complete the SageMaker submission in-band, before it
// resolves: in Lambda, work deferred past the HTTP response is frozen and
// may never run. These tests inject a Map-backed job store and a stub
// ControlNetService so no AWS access is needed.
describe("JobManager.createJob (in-band submission)", () => {
  const validRequest: QRGenerationRequest = {
    prompt: "a castle on a hill",
    baseQrCode: ["data:image/png;base64,iVBORw0KGgo="],
  };

  function makeJobManager(controlNetStub: {
    submitQRGeneration: ReturnType<typeof vi.fn>;
  }) {
    const jobManager = new JobManager(controlNetStub as any);
    const store = new Map<string, AsyncQRJob>();
    (jobManager as any).jobStore = {
      putJob: async (job: AsyncQRJob) => {
        store.set(job.id, job);
      },
      getJob: async (id: string) => store.get(id),
    };
    return { jobManager, store };
  }

  it("awaits the submission, so the job is already processing when createJob resolves", async () => {
    const submitQRGeneration = vi.fn().mockResolvedValue({
      requestId: "req-1",
      statusCheckUrl: "/generate/status/req-1",
      resultUrl: "/generate/result/req-1",
      outputLocation: "s3://out/req-1",
    });
    const { jobManager, store } = makeJobManager({ submitQRGeneration });

    const job = await jobManager.createJob(validRequest);

    // Submission happened before createJob returned — not as deferred work.
    expect(submitQRGeneration).toHaveBeenCalledTimes(1);
    expect(submitQRGeneration).toHaveBeenCalledWith(validRequest);

    // The route's 202 branch keys off the tmp_ prefix; it must be preserved.
    expect(job.id.startsWith("tmp_")).toBe(true);

    const stored = store.get(job.id);
    expect(stored?.status).toBe("processing");
    expect(stored?.apiGatewayRequestId).toBe("req-1");
    expect(stored?.outputLocation).toBe("s3://out/req-1");

    // createJob returns the reloaded job, reflecting the submitted state.
    expect(job.status).toBe("processing");
    expect(job.apiGatewayRequestId).toBe("req-1");
    expect(job.outputLocation).toBe("s3://out/req-1");
  });

  it("mints a per-job accessToken, persisted and round-tripped to the caller", async () => {
    const submitQRGeneration = vi.fn().mockResolvedValue({
      requestId: "req-1",
      statusCheckUrl: "/generate/status/req-1",
      resultUrl: "/generate/result/req-1",
      outputLocation: "s3://out/req-1",
    });
    const { jobManager, store } = makeJobManager({ submitQRGeneration });

    const job = await jobManager.createJob(validRequest);

    // Persisted on the job (UUID-shaped) and survives the status updates
    // that processJobAsync applies before createJob reloads and returns it.
    const stored = store.get(job.id);
    expect(stored?.accessToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(job.accessToken).toBe(stored?.accessToken);

    // Each job gets its own token.
    const second = await jobManager.createJob(validRequest);
    expect(second.accessToken).toBeDefined();
    expect(second.accessToken).not.toBe(job.accessToken);

    // The create response is the only surface that may carry the token.
    expect(jobManager.createJobResponse(job).accessToken).toBe(
      job.accessToken,
    );
  });

  it("resolves (does not throw) on a rejected submission and persists the job as failed", async () => {
    const submitQRGeneration = vi
      .fn()
      .mockRejectedValue(new Error("SageMaker unreachable"));
    const { jobManager, store } = makeJobManager({ submitQRGeneration });

    // Must not reject: the client discovers failure via status polling.
    const job = await jobManager.createJob(validRequest);

    const stored = store.get(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toEqual({
      message: "SageMaker unreachable",
      code: "PROCESSING_ERROR",
    });

    // The returned job reflects the persisted failure.
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("PROCESSING_ERROR");
  });
});

// The accessToken — not the weakly random, enumerable job id — is the
// ownership boundary for the public status/cancel endpoints.
describe("JobManager.verifyJobToken", () => {
  const token = "11111111-2222-4333-8444-555555555555";
  const job = { accessToken: token } as AsyncQRJob;

  it("accepts the exact persisted token", () => {
    expect(jm.verifyJobToken(job, token)).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    expect(
      jm.verifyJobToken(job, "11111111-2222-4333-8444-555555555556"),
    ).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    expect(jm.verifyJobToken(job, "short")).toBe(false);
  });

  it("rejects a missing or empty token", () => {
    expect(jm.verifyJobToken(job, undefined)).toBe(false);
    expect(jm.verifyJobToken(job, "")).toBe(false);
  });

  it("never grants access to legacy jobs that have no persisted token", () => {
    expect(jm.verifyJobToken({} as AsyncQRJob, "anything")).toBe(false);
    expect(jm.verifyJobToken({} as AsyncQRJob, undefined)).toBe(false);
    expect(jm.verifyJobToken({} as AsyncQRJob, "")).toBe(false);
  });
});
