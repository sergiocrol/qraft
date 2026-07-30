# Plan 002: Submit generation jobs before responding, so Lambda doesn't drop them

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 803136b..HEAD -- apps/api/src/services/JobManager.ts apps/api/src/routes/qrGeneration.ts apps/api/src/lambda.ts`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-verification-baseline.md
- **Category**: bug
- **Planned at**: commit `803136b`, 2026-07-03

## Why this matters

This is the core product flow, and it is unreliable in production. `JobManager.createJob`
stores the job as `pending`, then kicks off `processJobAsync(tempId)` as an **un-awaited
floating promise** and immediately returns; the route then sends the `202` response. The
actual submission to SageMaker (`controlNetService.submitQRGeneration`) happens *inside*
`processJobAsync`, i.e. **after** the HTTP response is already on its way.

The API is deployed as an AWS Lambda (`serverless.yml`, `make deploy-api`). Lambda **freezes
the execution environment as soon as the response is returned** and only thaws it if/when a
later invocation reuses that container — with no guarantee and no defined timing. So the
`processJobAsync` continuation (which does the SageMaker call and the `pending → processing`
DynamoDB writes) may never run, or run minutes later against an unrelated request's lifetime.
Symptom: jobs stuck at `pending` forever, generation silently never submitted.

The fix: **do the submission as part of the request the client is awaiting**, before we
return `202`. The client already expects a short wait and then polls status, so moving the
(fast, async-endpoint) SageMaker *submit* call in-band does not change the UX — it just makes
it actually happen.

## Current state

- `apps/api/src/services/JobManager.ts` — `createJob` (lines 44-76):
  ```ts
  async createJob(request: QRGenerationRequest): Promise<AsyncQRJob> {
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();
    const job: AsyncQRJob = { id: tempId, createdAt: now, updatedAt: now, status: "pending", requestData: request };
    await this.jobStore.putJob(job);
    this.processJobAsync(tempId).catch(async (error) => {   // <-- FLOATING PROMISE, not awaited
      console.error(`Error processing job ${tempId}:`, error);
      try { await this.updateJobStatus(tempId, "failed", { error: { message: error.message || "Processing failed", code: "PROCESSING_ERROR" } }); }
      catch (updateError) { console.error(`Failed to update job ${tempId} status to failed:`, updateError); }
    });
    return job;
  }
  ```
- `JobManager.ts` — `processJobAsync` (lines 248-283) is where the real work is:
  ```ts
  private async processJobAsync(jobId: string): Promise<void> {
    const job = await this.jobStore.getJob(jobId);
    if (!job) return;
    try {
      await this.updateJobStatus(jobId, "processing", { startedAt: new Date().toISOString(), progress: 10, message: "Submitting your request..." });
      const submissionResult = await this.controlNetService.submitQRGeneration(job.requestData);
      const realJobId = submissionResult.requestId;
      await this.updateJobStatus(jobId, "processing", { progress: 30, message: "Submitted to generation service, processing...", apiGatewayRequestId: realJobId, outputLocation: submissionResult.outputLocation });
    } catch (error) {
      console.error(`Async job ${jobId} submission failed:`, error);
      await this.updateJobStatus(jobId, "failed", { failedAt: new Date().toISOString(), progress: 0, error: { message: error instanceof Error ? error.message : "Processing failed", code: "PROCESSING_ERROR" } });
    }
  }
  ```
  Note: `submitQRGeneration` calls the SageMaker **async** endpoint (`InvokeEndpointAsync`),
  which returns quickly with a request id + `outputLocation`; the long GPU work happens
  out-of-band and is polled later via `getJob` → `updateJobStatusFromApiGateway`. So awaiting
  the *submit* does not make the request wait for image generation.
- `apps/api/src/routes/qrGeneration.ts` — the route (lines 34-71) that responds `202`:
  ```ts
  const job = await jobManager.createJob(validatedData);
  if (job.id.startsWith("tmp_")) {
    return sendSuccess(req, res, { jobId: job.id, status: job.status, message: "QR generation job created successfully", estimatedTime: "2-5 minutes", statusUrl: jobStatusPath(job.id), temporary: true }, 202);
  }
  ```
- `apps/api/src/lambda.ts` — confirms serverless-http; there is **no** post-response hook or
  provisioned mechanism that would run background work. The handler returns the Express
  response and the container freezes.

**Convention to follow**: status transitions go exclusively through `updateJobStatus(jobId,
status, updates)` (JobManager.ts:393-409). Preserve that. Error shape is `{ message, code }`
with codes from `apps/api/src/utils/response.ts`'s `ERROR_CODES` / the inline `"PROCESSING_ERROR"`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck (api) | `cd apps/api && pnpm check-types` | exit 0 |
| Lint (api) | `cd apps/api && pnpm lint` | exit 0 |
| Tests (api) | `cd apps/api && pnpm test` | all pass |

## Scope

**In scope**:
- `apps/api/src/services/JobManager.ts` (change `createJob` to await submission)
- `apps/api/src/services/JobManager.test.ts` (add tests — created in plan 001)

**Out of scope** (do NOT touch):
- `apps/api/src/services/ControlNetService.ts` — `submitQRGeneration` already returns
  `{ requestId, outputLocation }`; don't change its contract.
- The status-polling path (`getJob`, `updateJobStatusFromApiGateway`) — plan 011-candidate
  (DynamoDB races) covers that; leave it here.
- `apps/api/src/lambda.ts` — do not attempt to add background-processing hacks
  (`context.callbackWaitsForEmptyEventLoop`, etc.); the fix is to not defer the work at all.
- Introducing SQS/Step Functions. That is a valid larger design (note it in your report) but
  is out of scope for this plan, which is the minimal correctness fix.

## Git workflow

- Branch: `advisor/002-lambda-job-submission`
- Commit message style (terse, matches repo): `fix(api): submit SageMaker job in-band so Lambda does not drop it`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make `createJob` await the submission

Rewrite `createJob` (JobManager.ts:44-76) so the SageMaker submission is awaited as part of
the request, instead of fired-and-forgotten. Target shape:

```ts
async createJob(request: QRGenerationRequest): Promise<AsyncQRJob> {
  const tempId = `tmp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  const job: AsyncQRJob = {
    id: tempId, createdAt: now, updatedAt: now, status: "pending", requestData: request,
  };

  await this.jobStore.putJob(job);

  // Submit to the generation service in-band. In Lambda, any work deferred past the
  // HTTP response is frozen and may never run, so the submission must complete here.
  await this.processJobAsync(tempId);

  // Return the freshest persisted job so the response reflects the submitted state.
  return (await this.jobStore.getJob(tempId)) ?? job;
}
```

Key points:
- `processJobAsync` already catches its own submission errors and marks the job `failed`
  (JobManager.ts:271-282), so awaiting it will not throw for a SageMaker failure — the job is
  persisted as `failed` and the route still returns `202` with a job id the client can poll.
  Preserve that behavior (do not wrap in a way that turns a failed submission into a 500 —
  the client's polling flow expects to discover failure via status).
- Because you now return the reloaded job, its `status` will be `processing` (or `failed`),
  not `pending`. The route branches on `job.id.startsWith("tmp_")` (still true) — so the
  `202` response shape is unchanged. Confirm this in Step 3.

### Step 2: Remove the now-dead floating-promise error handler

The `.catch(...)` block attached to the floating promise (old JobManager.ts:58-73) is
removed as part of Step 1's rewrite. Ensure no other caller relies on `createJob` returning
before submission completes.

**Verify**: `grep -rn "processJobAsync" apps/api/src` → only the definition and the new
awaited call in `createJob` remain (no other callers).

### Step 3: Add tests

In `apps/api/src/services/JobManager.test.ts` add tests using a stub `ControlNetService`:
- **Happy path**: stub `submitQRGeneration` to resolve `{ requestId: "req-1", outputLocation: "s3://out/req-1" }` and stub the job store (an in-memory Map) so `putJob`/`getJob` work. Assert that after `await createJob(validRequest)`, the stored job has `status === "processing"`, `apiGatewayRequestId === "req-1"`, and `outputLocation` set — i.e. submission happened before `createJob` returned.
- **Failure path**: stub `submitQRGeneration` to reject; assert `createJob` still resolves (does not throw) and the stored job has `status === "failed"` with `error.code === "PROCESSING_ERROR"`.

Model the stub/in-memory-store pattern on the characterization tests from plan 001. If the
real `DynamoJobStore` is hard to substitute, inject a fake via the constructor or override
`(jm as any).jobStore` with a minimal `{ putJob, getJob }` Map-backed object in the test.

**Verify**: `cd apps/api && pnpm test` → new tests pass; the failure-path test proves a
rejected submission yields a persisted `failed` job rather than an unhandled rejection.

### Step 4: Full gate

**Verify**: `pnpm install` → 0; `cd apps/api && pnpm check-types` → 0; `pnpm lint` → 0;
`pnpm test` → all pass.

## Test plan

- New tests in `apps/api/src/services/JobManager.test.ts`: happy-path (submission completes
  before return; job is `processing`) and failure-path (rejected submit → persisted `failed`,
  no throw).
- Model after the plan-001 characterization tests (same stubbing style).
- Verification: `cd apps/api && pnpm test` → all pass including the 2 new cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "processJobAsync(tempId).catch" apps/api/src/services/JobManager.ts` returns no match (floating promise gone)
- [ ] `grep -n "await this.processJobAsync" apps/api/src/services/JobManager.ts` returns exactly one match (inside `createJob`)
- [ ] `cd apps/api && pnpm test` exits 0 with the 2 new JobManager tests passing
- [ ] `cd apps/api && pnpm check-types` exits 0 and `pnpm lint` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift).
- `submitQRGeneration` turns out to block on actual image generation (i.e. it is NOT the fast
  async-endpoint submit described here) such that awaiting it would make the request hang for
  minutes — if so, the correct fix is a queue (SQS), which is out of scope; report this.
- Awaiting `processJobAsync` causes the request to exceed the Lambda timeout
  (`serverless.yml` `timeout: 30`) in a realistic case — report with evidence; the queue
  design becomes necessary.
- Any change appears to require editing `ControlNetService.ts` or `lambda.ts`.

## Maintenance notes

- If throughput ever grows, revisit moving submission to SQS/Step Functions with a dedicated
  consumer — that decouples submit latency from the HTTP request entirely. This plan is the
  minimal in-band fix; it assumes the SageMaker *async* submit stays fast.
- The same "work after response is frozen" hazard affects the admin challenge store
  (`auth.ts` in-memory `Map` + `setInterval`) and the in-memory rate limiters — those are
  separate findings (F12 / F8-rate-limit) not fixed here. A reviewer should not assume this
  plan addresses them.
- Reviewer focus: confirm the failure path still surfaces to the client via status polling
  (job persisted `failed`), and that the `202` response shape is byte-for-byte unchanged.
