# Plan 007: Self-service endpoint wake (design spike + implementation)

> **Executor instructions**: This is a **spike + implementation** plan. Do the
> investigation in Step 1 and record the answers in your report BEFORE writing
> code. Then follow the implementation steps, running every verification
> command. If anything in "STOP conditions" occurs — especially anything about
> cost exposure — stop and report. When done, update `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 803136b..HEAD -- apps/api/src/routes/endpoint.ts apps/api/src/services/EndpointStatusService.ts apps/api/src/services/EmailService.ts apps/client/src/components/wake/WakeEndpointForm.tsx apps/client/src/components/generation/GenerationPage.tsx`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (changes cloud-cost behavior — a user action can now start a GPU instance)
- **Depends on**: none (but coordinate with plan 004 if both touch `endpoint.ts`)
- **Category**: direction
- **Planned at**: commit `803136b`, 2026-07-03

## Why this matters

The README sells a "scale-to-zero with a friendly wake screen" experience, and the machinery
to wake the endpoint **already exists and is wired**: `EndpointStatusService.wakeEndpoint()`
scales the SageMaker endpoint 0→1 (suspending scale-in, with a scheduled cron re-enabling it
after 60 min), and the Lambda already holds the required IAM permissions
(`application-autoscaling:*` + `sagemaker:UpdateEndpointWeightsAndCapacities` in
`serverless.yml`). The admin `POST /api/endpoint/scale` route uses it.

But the **public** `POST /api/endpoint/wake` route does none of that — it just emails the admin
asking them to open the admin panel and click "Scale to 1" manually. So the advertised
self-service wake requires a human in the loop and a 1–2 hour wait. This plan closes that gap:
the wake button actually wakes the endpoint.

The reason it's a spike, not a one-liner: making wake self-service means **any visitor can
start a paid GPU instance**. That needs a deliberate abuse/cost guardrail, and the existing
rate limiter is per-Lambda-container (in-memory) so it does not hold across concurrent
containers. The decision on the guardrail is the spike's real content.

## Current state

- `apps/api/src/routes/endpoint.ts:77-113` — `POST /wake` today:
  ```ts
  router.post("/wake", wakeLimiter, async (req, res) => {
    const { userEmail, reason } = req.body;
    if (!userEmail || !userEmail.includes("@")) return sendError(... "Valid email address is required" ...);
    await emailService.sendActivationRequest({ userEmail, reason: reason || "...", requestedAt: new Date().toISOString(), ipAddress: req.ip! });
    return sendSuccess(req, res, { message: "Activation request sent to administrator", userEmail, estimatedResponseTime: "1-2 hours during business hours" });
  });
  ```
  `wakeLimiter` = `express-rate-limit` 5 per 15 min (`endpoint.ts:22-26`, constants
  `RATE_LIMIT_WAKE_*`).
- `apps/api/src/services/EndpointStatusService.ts:194-228` — `wakeEndpoint(environment)`
  already does exactly what's needed:
  ```ts
  const status = await this.getEndpointStatus(environment);
  if (status.currentInstanceCount > 0) return { message: "Endpoint is already active", ... };
  await this.scaleEndpoint(1, environment);   // suspends scale-in; sets desired=1
  return { message: "Endpoint wake-up initiated", estimatedTime: "7-10 minutes", statusUrl: ENDPOINT_STATUS_PATH };
  ```
  `scaleEndpoint` (301-350) suspends `DynamicScalingInSuspended`, then
  `updateEndpointWeightsAndCapacities` desired=1. The `scheduledScaler` cron
  (`apps/api/src/cron.ts`, `serverless.yml` `schedule: rate(10 minutes)`) re-enables scale-in
  after 60 min via `checkAndReleaseSuspension`.
- `apps/api/src/services/EmailService.ts:23-181` — `sendActivationRequest`; interpolates
  `userEmail`/`reason` into HTML (see finding F7 — that HTML-injection/relay issue is separate;
  if you keep email here, prefer sending only to the admin and escaping fields).
- Client:
  - `apps/client/src/components/wake/WakeEndpointForm.tsx:26-46` — collects `email` + `reason`,
    calls `endpointService.requestActivation({ userEmail, reason })`, then shows a "Request
    Sent to administrator" success screen (48-107) with copy like "Administrator receives your
    request" and "Email notification sent to you".
  - `apps/client/src/services/EndpointService.ts:39-42` — `requestActivation` → `POST /wake`.
  - `apps/client/src/components/generation/GenerationPage.tsx:93-100` — on success, starts a
    quick-poll interval (this has a cleanup bug, finding F15 — out of scope here, note it).

**Convention to follow**: keep the route's `sendSuccess`/`sendError` shape; keep the existing
`wakeLimiter`. The `WakeEndpointResponse` type already exists
(`apps/client/src/lib/api/types.ts:61-65`: `{ message, estimatedTime, statusUrl }`) — reuse it.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck (api) | `cd apps/api && pnpm check-types` | exit 0 |
| Typecheck (client) | `cd apps/client && npx astro check` | no new errors in touched files |
| Lint (api) | `cd apps/api && pnpm lint` | exit 0 |
| Tests (api) | `cd apps/api && pnpm test` | all pass |

## Step 1 — SPIKE: decide the cost guardrail (record answers before coding)

Answer these in your report; they determine the implementation:

1. **Is self-service wake acceptable at all, or must it stay admin-gated?** If the operator
   wants a human approval, STOP — this plan doesn't apply and the email flow stays. Default
   assumption for proceeding: self-service is desired (that's the point of the finding).
2. **What is the abuse ceiling?** The per-container `wakeLimiter` (5/15min) does not hold
   across Lambda containers (finding F8). Options, pick one:
   - (a) **Idempotent-by-state** (lowest risk, recommended default): `wakeEndpoint` already
     no-ops if `currentInstanceCount > 0`. Since a single instance serves everyone, repeated
     wakes while starting/running are harmless — the only cost is the one instance the product
     intends to run. Keep the per-container limiter as light abuse friction and rely on
     idempotency. **This is the recommended default** because it needs no new infra.
   - (b) **Shared throttle**: a DynamoDB-backed "last wake at" record + a minimum interval
     (e.g. one wake per 5 min globally). More robust, more code.
   - (c) **Keep a soft gate**: require the email step but *also* wake immediately (email
     becomes a notification, not an approval).
3. **Keep, repurpose, or drop the email?** Recommended: repurpose `sendActivationRequest` into
   a fire-and-forget *notification* to the admin ("a visitor woke the endpoint"), sent AFTER
   the wake, and never blocking the response. If kept, it must be awaited-safely (in Lambda,
   see plan 002's lesson — do not defer it past the response; either await it or accept it may
   not send). Simplest: drop the email from the hot path and note it.

**Default decision if the operator is unavailable**: proceed with (a) idempotent-by-state,
drop email from the request path (keep the function for admin use), keep `wakeLimiter`.

## Scope

**In scope**:
- `apps/api/src/routes/endpoint.ts` (`/wake` calls `wakeEndpoint`)
- `apps/client/src/components/wake/WakeEndpointForm.tsx` (copy + flow reflect real wake)
- `apps/api/src/routes/endpoint.test.ts` (create — wake behavior)
- (only if guardrail (b) chosen) a small shared-throttle helper — but prefer (a)

**Out of scope** (do NOT touch):
- `EndpointStatusService.wakeEndpoint`/`scaleEndpoint`/`checkAndReleaseSuspension` internals —
  reuse as-is.
- The `scheduledScaler` cron and `serverless.yml` scaling config.
- The wake-poll interval cleanup bug in `GenerationPage.tsx` (finding F15 — separate plan).
- The email HTML-injection/relay hardening (finding F7 — separate plan). If you keep email,
  don't expand into fixing F7 here; note the dependency.

## Steps (implementation — after the spike)

### Step 2: Make `/wake` actually wake the endpoint

Rewrite the `/wake` handler (endpoint.ts:77-113) to call `endpointStatusService.wakeEndpoint`.
Keep `wakeLimiter`. Accept the optional `env` the same way `/status` does
(`parseEnvironment`). `userEmail`/`reason` become optional metadata (used only for the admin
notification if you keep it). Target shape:
```ts
router.post("/wake", wakeLimiter, async (req, res) => {
  try {
    const environment = parseEnvironment(req);
    const result = await endpointStatusService.wakeEndpoint(environment);

    // Optional, non-blocking admin notification (do NOT defer past the response in Lambda):
    // if keeping email, await it or drop it — see plan 002. Simplest is to omit it here.

    return sendSuccess(req, res, result); // { message, estimatedTime, statusUrl }
  } catch (error: any) {
    console.error("Error waking endpoint:", error);
    return sendError(req, res, "Failed to wake endpoint", ERROR_CODES.ENDPOINT_WAKE_ERROR, 500);
    // NOTE: generic message in prod — do not echo error.message (see finding F13).
  }
});
```
If the operator chose to keep the email (guardrail (c) or notification), send it to the admin
only, escape the fields, and either `await` it before responding or wrap it so a failure
doesn't fail the wake.

**Verify**: `cd apps/api && pnpm check-types` → 0; `pnpm lint` → 0.

### Step 3: Update the client wake flow and copy

In `WakeEndpointForm.tsx`:
- The email field can become optional (or remain for notifications). If the guardrail no
  longer needs an email, relax the required validation (26-32) and the disabled-button guard
  (212).
- Replace the "Request Sent to administrator / Administrator receives your request / Email
  notification sent to you" copy (62-99) with wake-in-progress copy: e.g. "Waking the service
  — this takes ~7–10 minutes. This page updates automatically when it's ready." Keep the
  auto-poll behavior (the page already polls status).
- `endpointService.requestActivation` still POSTs `/wake`; the response is now
  `{ message, estimatedTime, statusUrl }` — adjust any code that read the old
  `{ message, userEmail, estimatedResponseTime }` shape.

**Verify**: `cd apps/client && npx astro check` → no new errors in touched files.

### Step 4: Tests

Create `apps/api/src/routes/endpoint.test.ts` (or a unit test of the handler logic). With
`endpointStatusService.wakeEndpoint` stubbed:
- when the endpoint is down, `/wake` calls `wakeEndpoint` and returns its
  `{ message, estimatedTime, statusUrl }`.
- when `wakeEndpoint` throws, the route returns a generic 500 (no `error.message` leak).
If route-level testing needs `supertest`, add it as an api dev dep or test the extracted
handler logic directly.

**Verify**: `cd apps/api && pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Spike answers (guardrail choice, email decision) are recorded in the executor's report
- [ ] `grep -n "wakeEndpoint" apps/api/src/routes/endpoint.ts` returns a match (the route now calls it)
- [ ] `grep -n "sent to administrator\|1-2 hours" apps/api/src/routes/endpoint.ts` → no match (old manual-email copy gone from the wake path)
- [ ] `cd apps/api && pnpm test` exits 0 with the new wake test
- [ ] `cd apps/api && pnpm check-types` and `pnpm lint` exit 0
- [ ] `cd apps/client && npx astro check` reports no new errors in touched files
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The operator's answer to Spike Q1 is "keep it admin-approved" — then don't ship self-service
  wake; report and leave the email flow.
- `wakeEndpoint`/`scaleEndpoint` do NOT actually change desired capacity in a dry run you can
  reason about (e.g. the IAM statement in `serverless.yml` doesn't cover the endpoint name) —
  report; a permissions gap must be fixed in infra first.
- You find that a single wake could start **more than one** instance, or that repeated wakes
  aren't idempotent by state (contradicting the assumption behind guardrail (a)) — cost risk;
  report before shipping.
- Removing the email would break an operational dependency (e.g. the admin relies on the email
  to know usage) — confirm before dropping it.

## Maintenance notes

- This unlocks the intended product UX and removes the 1–2h human latency. Pair it later with
  a lightweight usage signal (CloudWatch alarm or the repurposed admin notification) so the
  operator still has visibility into wakes.
- If abuse becomes real, upgrade guardrail (a)→(b) (shared DynamoDB throttle) — the per-job
  token store from plan 003 shows the DynamoDB-with-TTL pattern to reuse.
- Reviewer focus: confirm the wake response no longer promises a human ("1-2 hours"), that no
  `error.message` is leaked on failure (F13), and that any retained email send does not rely
  on post-response execution in Lambda (plan 002's lesson).
- Related deferred findings this plan deliberately does NOT fix: F7 (email HTML/relay), F15
  (wake-poll interval leak), F8 (per-container rate limit). Note them so they aren't assumed
  covered.
