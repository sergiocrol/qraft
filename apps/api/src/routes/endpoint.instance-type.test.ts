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
import jwt from "jsonwebtoken";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { endpointRoutes } from "./endpoint";
import { endpointStatusService } from "../services/EndpointStatusService";
import { JWT_ISSUER } from "../constants";

const TEST_JWT_SECRET = "test-jwt-secret";

let server: Server;
let baseUrl: string;

function adminToken(role = "admin"): string {
  return jwt.sign({ role }, TEST_JWT_SECRET, { issuer: JWT_ISSUER });
}

function postInstanceType(
  body: unknown,
  token?: string,
): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/api/endpoint/instance-type`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
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

describe("POST /api/endpoint/instance-type", () => {
  let changeSpy: ReturnType<
    typeof vi.spyOn<typeof endpointStatusService, "changeInstanceType">
  >;

  beforeEach(() => {
    changeSpy = vi
      .spyOn(endpointStatusService, "changeInstanceType")
      .mockResolvedValue({
        message: "Switching to ml.g5.xlarge",
        endpointName: "controlnet-qr-endpoint",
        instanceType: "ml.g5.xlarge",
        previousInstanceType: "ml.g4dn.xlarge",
        changed: true,
        estimatedTime: "5-15 minutes",
      });
  });

  afterEach(() => {
    changeSpy.mockRestore();
  });

  it("rejects requests without a token", async () => {
    const res = await postInstanceType({ instanceType: "ml.g5.xlarge" });
    expect(res.status).toBe(401);
    expect(changeSpy).not.toHaveBeenCalled();
  });

  it("rejects tokens without the admin role", async () => {
    const res = await postInstanceType(
      { instanceType: "ml.g5.xlarge" },
      adminToken("viewer"),
    );
    expect(res.status).toBe(403);
    expect(changeSpy).not.toHaveBeenCalled();
  });

  it("rejects instance types outside the allowlist", async () => {
    const res = await postInstanceType(
      { instanceType: "ml.p4d.24xlarge" },
      adminToken(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("ml.g5.xlarge");
    expect(changeSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing instance type", async () => {
    const res = await postInstanceType({}, adminToken());
    expect(res.status).toBe(400);
    expect(changeSpy).not.toHaveBeenCalled();
  });

  it("switches the production endpoint by default", async () => {
    const res = await postInstanceType(
      { instanceType: "ml.g5.xlarge" },
      adminToken(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.changed).toBe(true);
    expect(body.data.instanceType).toBe("ml.g5.xlarge");
    expect(changeSpy).toHaveBeenCalledWith("ml.g5.xlarge", "production");
  });

  it("passes the staging environment through", async () => {
    const res = await postInstanceType(
      { instanceType: "ml.g4dn.xlarge", environment: "staging" },
      adminToken(),
    );
    expect(res.status).toBe(200);
    expect(changeSpy).toHaveBeenCalledWith("ml.g4dn.xlarge", "staging");
  });

  it("returns 500 with ENDPOINT_INSTANCE_TYPE_ERROR when the switch fails", async () => {
    changeSpy.mockRejectedValueOnce(new Error("capacity unavailable"));
    const res = await postInstanceType(
      { instanceType: "ml.g5.xlarge" },
      adminToken(),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("ENDPOINT_INSTANCE_TYPE_ERROR");
  });
});
