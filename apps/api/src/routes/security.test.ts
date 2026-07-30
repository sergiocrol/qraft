import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { API_ENDPOINTS, JWT_ISSUER, JWT_EXPIRES_IN } from "../constants";
import { JobManager } from "../services/JobManager";
import type { AsyncQRJob } from "../services/DynamoJobStore";
import { qrGenerationRoutes } from "./qrGeneration";
import { jobRoutes } from "./jobs";
import { uploadRoutes } from "./qrUpload";

// Route-level tests over real HTTP (app.listen(0) + fetch), with a real
// JobManager backed by an in-memory Map store and a stub ControlNetService —
// no AWS access. Covers plan 003's boundaries: per-job token on status and
// cancel (404, never 403, on mismatch), admin gate on /api/jobs*, and
// upload content validation (which rejects before any S3 call).

const TEST_JWT_SECRET = "test-secret";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let server: Server;
let baseUrl: string;
let store: Map<string, AsyncQRJob>;

function seedJob(id: string, accessToken?: string): AsyncQRJob {
  const now = new Date().toISOString();
  // status "pending" with no outputLocation, so getJob takes no
  // status-refresh side path.
  const job: AsyncQRJob = {
    id,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    requestData: {
      prompt: "a castle on a hill",
      baseQrCode: ["https://example.com/a.png"],
    },
    ...(accessToken ? { accessToken } : {}),
  };
  store.set(id, job);
  return job;
}

function adminBearer(): string {
  return jwt.sign({ role: "admin" }, TEST_JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    issuer: JWT_ISSUER,
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;

  const controlNetStub = {
    submitQRGeneration: vi.fn().mockResolvedValue({
      requestId: "req-1",
      statusCheckUrl: "/generate/status/req-1",
      resultUrl: "/generate/result/req-1",
      outputLocation: "s3://out/req-1",
    }),
    checkQRGenerationStatusByOutputLocation: vi
      .fn()
      .mockResolvedValue({ isComplete: false }),
  };

  const jobManager = new JobManager(controlNetStub as any);
  store = new Map<string, AsyncQRJob>();
  (jobManager as any).jobStore = {
    putJob: async (job: AsyncQRJob) => {
      store.set(job.id, job);
    },
    getJob: async (id: string) => store.get(id),
  };

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.locals.jobManager = jobManager;
  app.use(API_ENDPOINTS.QR_GENERATION, qrGenerationRoutes);
  app.use(API_ENDPOINTS.JOBS, jobRoutes);
  app.use(API_ENDPOINTS.UPLOAD_QR, uploadRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("GET /api/qr-generation/:jobId/status (job token required)", () => {
  it("returns the status with the correct X-Job-Token, and never echoes the token", async () => {
    const job = seedJob("tmp_status_ok", "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb");

    const res = await fetch(`${baseUrl}/api/qr-generation/${job.id}/status`, {
      headers: { "X-Job-Token": job.accessToken! },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.jobId).toBe(job.id);
    expect(body.data.status).toBe("pending");
    // The read response must not carry the secret anywhere.
    expect("accessToken" in body.data).toBe(false);
    expect(JSON.stringify(body)).not.toContain(job.accessToken!);
  });

  it("accepts the token via the ?token= query param fallback", async () => {
    const job = seedJob("tmp_status_qp", "cccccccc-1111-4222-8333-dddddddddddd");

    const res = await fetch(
      `${baseUrl}/api/qr-generation/${job.id}/status?token=${job.accessToken}`,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.jobId).toBe(job.id);
  });

  it("returns 404 (not 403) on a wrong token, indistinguishable from a missing job", async () => {
    const job = seedJob("tmp_status_wrong", "eeeeeeee-1111-4222-8333-ffffffffffff");

    const wrongToken = await fetch(
      `${baseUrl}/api/qr-generation/${job.id}/status`,
      { headers: { "X-Job-Token": "eeeeeeee-1111-4222-8333-000000000000" } },
    );
    const missingToken = await fetch(
      `${baseUrl}/api/qr-generation/${job.id}/status`,
    );
    const missingJob = await fetch(
      `${baseUrl}/api/qr-generation/tmp_does_not_exist/status`,
      { headers: { "X-Job-Token": "eeeeeeee-1111-4222-8333-ffffffffffff" } },
    );

    for (const res of [wrongToken, missingToken, missingJob]) {
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("JOB_NOT_FOUND");
      expect(body.error.message).toBe("Job not found");
    }
  });

  it("returns 404 for legacy jobs persisted without a token, whatever the caller sends", async () => {
    const job = seedJob("tmp_status_legacy");

    const res = await fetch(`${baseUrl}/api/qr-generation/${job.id}/status`, {
      headers: { "X-Job-Token": "" },
    });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/qr-generation/:jobId (job token required)", () => {
  it("rejects a cancel without the token (404) and leaves the job untouched", async () => {
    const job = seedJob("tmp_cancel_denied", "12121212-1111-4222-8333-343434343434");

    const res = await fetch(`${baseUrl}/api/qr-generation/${job.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("JOB_NOT_FOUND");
    expect(store.get(job.id)?.status).toBe("pending");
  });

  it("cancels the job with the correct token", async () => {
    const job = seedJob("tmp_cancel_ok", "56565656-1111-4222-8333-787878787878");

    const res = await fetch(`${baseUrl}/api/qr-generation/${job.id}`, {
      method: "DELETE",
      headers: { "X-Job-Token": job.accessToken! },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("cancelled");
    expect(store.get(job.id)?.status).toBe("cancelled");
  });
});

describe("POST /api/qr-generation (create hands the token to the creating client)", () => {
  it("returns 202 with the accessToken that then authorizes status polling", async () => {
    const res = await fetch(`${baseUrl}/api/qr-generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "a castle on a hill",
        baseQrCode: ["https://example.com/a.png"],
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.data.jobId).toMatch(/^tmp_/);
    expect(body.data.accessToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.data.accessToken).toBe(store.get(body.data.jobId)?.accessToken);

    // The single-browser flow: the token from create authorizes the poll.
    const statusRes = await fetch(
      `${baseUrl}/api/qr-generation/${body.data.jobId}/status`,
      { headers: { "X-Job-Token": body.data.accessToken } },
    );
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.data.jobId).toBe(body.data.jobId);
    expect(JSON.stringify(statusBody)).not.toContain(body.data.accessToken);
  });
});

describe("/api/jobs* (admin gate)", () => {
  it("returns 401 without a bearer on list, stats and detail", async () => {
    for (const path of [
      "/api/jobs",
      "/api/jobs/stats",
      "/api/jobs/tmp_status_ok",
    ]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("AUTH_UNAUTHORIZED");
    }
  });

  it("returns 401 for a non-admin/garbage bearer", async () => {
    const res = await fetch(`${baseUrl}/api/jobs`, {
      headers: { Authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("serves the job detail to an admin bearer, without the accessToken", async () => {
    const token = "9a9a9a9a-1111-4222-8333-b0b0b0b0b0b0";
    const job = seedJob("tmp_admin_detail", token);

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}`, {
      headers: { Authorization: `Bearer ${adminBearer()}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.job.id).toBe(job.id);
    expect(body.data.job.requestData).toBeDefined();
    // Even the admin surface must not echo the per-job secret.
    expect("accessToken" in body.data.job).toBe(false);
    expect(JSON.stringify(body)).not.toContain(token);
  });
});

describe("POST /api/upload-qr (content validation)", () => {
  it("rejects a missing/non-string payload", async () => {
    const res = await fetch(`${baseUrl}/api/upload-qr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qrDataUrl: 42 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
  });

  it("rejects data that is not a PNG (magic-byte check)", async () => {
    const notPng = Buffer.from("hello, definitely not a png").toString("base64");
    const res = await fetch(`${baseUrl}/api/upload-qr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qrDataUrl: `data:image/png;base64,${notPng}` }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("Invalid or oversized image");
  });

  it("rejects a PNG-magic payload over 2 MB", async () => {
    const oversized = Buffer.concat([
      PNG_MAGIC,
      Buffer.alloc(2 * 1024 * 1024),
    ]).toString("base64");
    const res = await fetch(`${baseUrl}/api/upload-qr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qrDataUrl: `data:image/png;base64,${oversized}` }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("Invalid or oversized image");
  });
});
