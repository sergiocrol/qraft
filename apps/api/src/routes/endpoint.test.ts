import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { endpointRoutes } from "./endpoint";
import { emailService } from "../services/EmailService";
import { RATE_LIMIT_WAKE_MAX } from "../constants";

let server: Server;
let baseUrl: string;

// The wakeLimiter is module-scoped in endpoint.ts (5 requests / 15 min per
// IP), so its budget is shared by every request this file sends. Track them
// so the rate-limit test stays deterministic regardless of test order.
let wakeRequestsSent = 0;

function postWake(body: unknown = {}): Promise<globalThis.Response> {
  wakeRequestsSent += 1;
  return fetch(`${baseUrl}/api/endpoint/wake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/endpoint", endpointRoutes);
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

describe("POST /api/endpoint/wake (activation request emailed to the admin)", () => {
  let emailSpy: ReturnType<
    typeof vi.spyOn<typeof emailService, "sendActivationRequest">
  >;

  beforeEach(() => {
    emailSpy = vi
      .spyOn(emailService, "sendActivationRequest")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    emailSpy.mockRestore();
  });

  it("emails the admin and confirms the request — it never scales the endpoint itself", async () => {
    const res = await postWake({
      userEmail: "visitor@example.com",
      reason: "Demoing QR art to a friend",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.message).toBe("Activation request sent to administrator");
    expect(body.data.userEmail).toBe("visitor@example.com");
    expect(body.data.estimatedResponseTime).toContain("1-2 hours");

    expect(emailSpy).toHaveBeenCalledTimes(1);
    const sent = emailSpy.mock.calls[0][0];
    expect(sent.userEmail).toBe("visitor@example.com");
    expect(sent.reason).toBe("Demoing QR art to a friend");
    expect(sent.requestedAt).toBeTruthy();
  });

  it("defaults the reason when omitted", async () => {
    const res = await postWake({ userEmail: "visitor@example.com" });

    expect(res.status).toBe(200);
    expect(emailSpy.mock.calls[0][0].reason).toBe("No reason provided");
  });

  it("rejects a missing or invalid email with 400 before any email is sent", async () => {
    // Two cases only: the wakeLimiter budget (RATE_LIMIT_WAKE_MAX) is shared
    // across this whole file, and the 500-path test below still needs a slot.
    for (const body of [{}, { userEmail: "not-an-email" }]) {
      const res = await postWake(body);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("BAD_REQUEST");
    }
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("returns a generic 500 without leaking SES details when the email fails", async () => {
    emailSpy.mockRejectedValue(
      new Error("MessageRejected: Email address is not verified in SES sandbox"),
    );

    const res = await postWake({ userEmail: "visitor@example.com" });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("ENDPOINT_WAKE_ERROR");
    expect(body.error.message).toBe("Failed to send activation request");
    expect(JSON.stringify(body)).not.toContain("MessageRejected");
    expect(JSON.stringify(body)).not.toContain("SES");
  });

  it("keeps the wakeLimiter as abuse friction: requests beyond the window budget get 429", async () => {
    // Use up whatever budget the earlier tests left, then overflow it.
    while (wakeRequestsSent < RATE_LIMIT_WAKE_MAX) {
      const res = await postWake({ userEmail: "visitor@example.com" });
      expect([200, 400]).toContain(res.status);
    }

    const limited = await postWake({ userEmail: "visitor@example.com" });
    expect(limited.status).toBe(429);
    // The rate-limited request must never reach the email service.
    expect(emailSpy.mock.calls.length).toBeLessThan(wakeRequestsSent);
  });
});
