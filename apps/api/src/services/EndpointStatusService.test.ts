import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { endpointStatusService } from "./EndpointStatusService";

// Unit tests for scaleEndpoint's Updating guard, with getEndpointStatus
// spied out and the private AWS clients stubbed — no AWS access. Regression
// for the 2026-07-06 incident: UpdateEndpointWeightsAndCapacities throws
// ValidationException while the endpoint is mid-update, so scaling calls
// during the 4–10 min scale-out surfaced as opaque 500s.

const baseStatus = {
  endpointName: "controlnet-qr-endpoint",
  status: "InService",
  currentInstanceCount: 0,
  desiredInstanceCount: 0,
  isScaling: false,
  isAvailable: false,
  lastUpdated: new Date().toISOString(),
  healthCheck: "unhealthy",
};

function mockStatus(overrides: Partial<typeof baseStatus>) {
  return vi
    .spyOn(endpointStatusService, "getEndpointStatus")
    .mockResolvedValue({ ...baseStatus, ...overrides } as any);
}

describe("scaleEndpoint (guarded while the endpoint is Updating)", () => {
  const svc = endpointStatusService as any;
  let originalAutoScaling: unknown;
  let originalSagemaker: unknown;
  let registerSpy: ReturnType<typeof vi.fn>;
  let updateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalAutoScaling = svc.autoScaling;
    originalSagemaker = svc.sagemaker;
    registerSpy = vi.fn(() => ({ promise: () => Promise.resolve({}) }));
    updateSpy = vi.fn(() => ({ promise: () => Promise.resolve({}) }));
    svc.autoScaling = { registerScalableTarget: registerSpy };
    svc.sagemaker = { updateEndpointWeightsAndCapacities: updateSpy };
  });

  afterEach(() => {
    svc.autoScaling = originalAutoScaling;
    svc.sagemaker = originalSagemaker;
    vi.restoreAllMocks();
  });

  it("returns in-progress without touching AWS while the endpoint is Updating", async () => {
    mockStatus({ status: "Updating", desiredInstanceCount: 1, isScaling: true });

    const result = await endpointStatusService.scaleEndpoint(1);

    expect(result.message).toContain("already in progress");
    expect(result.targetInstanceCount).toBe(1);
    expect(registerSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("guards scale-down during an update too — SageMaker rejects both directions", async () => {
    mockStatus({ status: "Updating", desiredInstanceCount: 1, isScaling: true });

    const result = await endpointStatusService.scaleEndpoint(0);

    expect(result.message).toContain("already in progress");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("suspends scale-in and pins the desired count when scaling up from InService", async () => {
    mockStatus({ status: "InService" });

    const result = await endpointStatusService.scaleEndpoint(1, "production");

    expect(result.message).toBe("Endpoint scaling to 1 instance(s)");
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy.mock.calls[0][0].SuspendedState.DynamicScalingInSuspended).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0].DesiredWeightsAndCapacities).toEqual([
      { VariantName: "AllTraffic", DesiredInstanceCount: 1 },
    ]);
  });

  it("re-enables scale-in when scaling down to 0", async () => {
    mockStatus({ status: "InService", currentInstanceCount: 1, isAvailable: true });

    await endpointStatusService.scaleEndpoint(0, "production");

    expect(registerSpy.mock.calls[0][0].SuspendedState.DynamicScalingInSuspended).toBe(false);
    expect(updateSpy.mock.calls[0][0].DesiredWeightsAndCapacities).toEqual([
      { VariantName: "AllTraffic", DesiredInstanceCount: 0 },
    ]);
  });
});
