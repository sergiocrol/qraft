# Plan 003: Lock down the unauthenticated job and upload surfaces

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in the "STOP conditions" section occurs, stop and report — do not
> improvise. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 803136b..HEAD -- apps/api/src/routes/jobs.ts apps/api/src/routes/qrGeneration.ts apps/api/src/routes/qrUpload.ts apps/api/src/services/JobManager.ts apps/api/src/services/DynamoJobStore.ts apps/client/src/services/GenerationService.ts`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-verification-baseline.md
- **Category**: security
- **Planned at**: commit `803136b`, 2026-07-03

## Why this matters

Every job endpoint is public with no ownership check:
- `GET /api/jobs` returns a paginated list of **all** jobs including each one's prompt,
  QR-source URL count, model, and result summary.
- `GET /api/jobs/:jobId` returns the **full** job: `requestData` (the user's `baseQrCode`
  source URLs) and `result` (generated image URLs).
- `GET /api/jobs/stats` returns aggregate counts.
- `GET /api/qr-generation/:jobId/status` and `DELETE /api/qr-generation/:jobId` (cancel) are
  public too.

Job ids are weakly random (`tmp_${Date.now()}_${Math.random().toString(36).substr(2,9)}`) and
never change, but an attacker doesn't even need to guess them — `GET /api/jobs` enumerates
everything. Net effect: any unauthenticated caller can read every user's prompts and result
images and cancel anyone's job.

This plan applies two boundaries: (1) the **admin/listing** surface (`/api/jobs*`) goes behind
the existing `adminAuth` middleware; (2) the **end-user** per-job surface (status + cancel)
requires an **unguessable per-job access token** minted at creation and returned to that
client. The `/api/upload-qr` endpoint is hardened in the same pass (auth-adjacent rate limit +
content validation), since it is the other fully-open write surface.

## Current state

- `apps/api/src/routes/jobs.ts` — no auth middleware anywhere in the file. `GET /` (line 18),
  `GET /stats` (83), `GET /:jobId` (117, returns `{ job: { ...job, requestData, result } }`).
- `apps/api/src/routes/qrGeneration.ts`:
  - `GET /:jobId/status` (lines 84-129) — `statusCheckLimiter` + `requireJobId`, no ownership.
  - `DELETE /:jobId` (136-167) — `requireJobId` only.
- `apps/api/src/middlewares/adminAuth.ts` — a working JWT bearer guard (`adminAuth`) already
  used by `POST /api/endpoint/scale`. Reuse it verbatim for `/api/jobs*`.
- `apps/api/src/services/JobManager.ts`:
  - `createJob` (44-76) builds the job and returns it; **add token minting here**.
  - `createJobResponse` (285-295) and the route's inline `202` body (qrGeneration.ts:45-58)
    build the create response; **add the token to what the client receives**.
  - `cancelJob` (114-125) and `getJob` (78-92) take only `jobId` today.
- `apps/api/src/services/DynamoJobStore.ts` — `AsyncQRJob` (lines 12-18) is the persisted
  shape; add an `accessToken?: string` field. `putJob` (50-64) / `getJob` (69-78) are the
  read/write path. `removeUndefinedValues: true` (39-43) is already set, so an absent token
  won't break marshalling.
- Client side (must keep working):
  - `apps/client/src/services/GenerationService.ts` — `generateQR` (23-45) reads
    `response.data.data.jobId`; `getJobStatus` (47-76) GETs `qrGenerationStatusUrl(jobId)`;
    `cancelJob` (78-85) DELETEs `qrGenerationCancelUrl(jobId)`.
  - `apps/client/src/lib/constants.ts` — `qrGenerationStatusUrl` / `qrGenerationCancelUrl`
    (lines 26-33) build the paths; `ADMIN_TOKEN_STORAGE_KEY` (51) shows the localStorage
    convention.
  - `apps/client/src/lib/utils/jobStore.ts` — helpers around the job id in the URL; a natural
    home for a `jobToken` persistence helper.
  - `apps/client/src/components/generation/JobPage.tsx` — reads the job id from the URL path
    (`getJobIdFromPath`, line 67) and calls `generationService.getJobStatus(id)` (77) and
    `cancelJob` (147). This is the flow that must keep working after tokens are required.

**Convention to follow**: responses go through `sendSuccess`/`sendError`
(`apps/api/src/utils/response.ts`) with `ERROR_CODES`. Auth failures use
`sendError(..., ERROR_CODES.AUTH_UNAUTHORIZED, 401)` (see `adminAuth.ts`). Use
`crypto.randomUUID()` (Node's `crypto`, already used in `auth.ts:36`) for the token.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck (api) | `cd apps/api && pnpm check-types` | exit 0 |
| Typecheck (client) | `cd apps/client && npx astro check` | no new errors in touched files |
| Lint (api) | `cd apps/api && pnpm lint` | exit 0 |
| Tests (api) | `cd apps/api && pnpm test` | all pass |

## Scope

**In scope**:
- `apps/api/src/routes/jobs.ts` (add `adminAuth`)
- `apps/api/src/routes/qrGeneration.ts` (require job token on status + cancel)
- `apps/api/src/routes/qrUpload.ts` (rate limit + content validation)
- `apps/api/src/services/JobManager.ts` (mint token; verify token on status/cancel)
- `apps/api/src/services/DynamoJobStore.ts` (add `accessToken` field)
- `apps/api/src/services/JobManager.test.ts` (tests)
- `apps/client/src/services/GenerationService.ts` (send/store token)
- `apps/client/src/lib/utils/jobStore.ts` (token persistence helper)
- `apps/client/src/components/generation/JobPage.tsx` (read token when polling/cancelling)

**Out of scope** (do NOT touch):
- The admin login/JWT mechanism itself (plan 004 covers the JWT expiry bug).
- Public read-only *sharing* of results across devices — deliberately NOT enabled here (a
  fresh device has no token and will get 401/404 on someone else's job). That is direction
  finding D2; note it, don't build it.
- `apps/client/src/components/admin/AdminPanel.tsx` — it calls the (now admin-gated) jobs
  endpoints already carrying the admin bearer via `apiClient`; confirm it still works but do
  not redesign it.

## Git workflow

- Branch: `advisor/003-lock-down-unauth-surfaces`
- Commits per logical unit (server token, admin gate, upload hardening, client wiring).
- Message style: `security(api): require per-job token for status/cancel; admin-gate /api/jobs`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Persist a per-job access token

In `DynamoJobStore.ts`, add to the `AsyncQRJob` interface (after line 17):
```ts
  accessToken?: string;
```
In `JobManager.createJob` (JobManager.ts:44-56), mint a token and store it on the job:
```ts
import crypto from "crypto"; // add at top if not present
// inside createJob, when building `job`:
const accessToken = crypto.randomUUID();
const job: AsyncQRJob = {
  id: tempId, createdAt: now, updatedAt: now, status: "pending",
  requestData: request, accessToken,
};
```
**Verify**: `cd apps/api && pnpm check-types` → 0.

### Step 2: Return the token to the creating client, but never in read responses

The create response must include the token so the client can store it. Update the `202` body
in `qrGeneration.ts` (lines 45-58) and/or `JobManager.createJobResponse` to add
`accessToken: job.accessToken`.

Crucially, the token must **not** leak from any read endpoint:
- In `jobs.ts` `GET /:jobId` (line 134-140), the response spreads `...job` — this would now
  include `accessToken`. Since `/api/jobs*` becomes admin-only (Step 4), that is acceptable,
  but still explicitly omit it: build the response without `accessToken` (destructure it out).
- In `qrGeneration.ts` `GET /:jobId/status` (105-118), the response is a hand-picked field
  list that does **not** include `accessToken` — leave it that way (do not add it).

**Verify**: `grep -n "accessToken" apps/api/src/routes/jobs.ts` shows it is destructured out,
not returned.

### Step 3: Require the token on status + cancel

Add a helper on `JobManager` and enforce it in the two routes. Accept the token from the
`X-Job-Token` header **or** a `token` query param (the client will send the header; the query
param keeps status URLs usable if needed).

In `qrGeneration.ts` `GET /:jobId/status` and `DELETE /:jobId`, after `requireJobId`:
```ts
const job = await jobManager.getJob(jobId);
if (!job) return sendError(req, res, "Job not found", ERROR_CODES.JOB_NOT_FOUND, 404);
const provided = (req.header("X-Job-Token") || (req.query.token as string) || "");
if (!job.accessToken || provided !== job.accessToken) {
  // Return 404 (not 403) so job existence isn't confirmed to non-owners.
  return sendError(req, res, "Job not found", ERROR_CODES.JOB_NOT_FOUND, 404);
}
```
Apply the same guard before `cancelJob`. Keep the existing rate limiters and `requireJobId`.

**Verify**: `cd apps/api && pnpm check-types` → 0.

### Step 4: Admin-gate the listing/detail endpoints

In `jobs.ts`, import `adminAuth` from `../middlewares/adminAuth` and apply it to the router:
```ts
import { adminAuth } from "../middlewares/adminAuth";
router.use(adminAuth); // gate all /api/jobs* routes
```
(Or add `adminAuth` to each route — router-level is simpler and covers `/`, `/stats`, `/:jobId`.)

**Verify**: `grep -n "adminAuth" apps/api/src/routes/jobs.ts` → present; an unauthenticated
`GET /api/jobs` would now hit `adminAuth` and 401.

### Step 5: Harden `/api/upload-qr`

In `qrUpload.ts`:
- Add an `express-rate-limit` limiter (mirror the one in `qrGeneration.ts:21-25`; pick a
  sane window/max, e.g. reuse `RATE_LIMIT_GENERATION_*` or add `RATE_LIMIT_UPLOAD_*` to
  `apps/api/src/constants.ts`).
- After decoding the base64 buffer (line 37), validate it is actually a PNG before uploading:
  check the 8-byte PNG magic `89 50 4E 47 0D 0A 1A 0A`, and enforce a tighter max size than
  the global 10 MB (e.g. 2 MB) — reject with `sendError(..., ERROR_CODES.BAD_REQUEST, 400)`.
```ts
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (buffer.length > 2 * 1024 * 1024 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
  return sendError(req, res, "Invalid or oversized image", ERROR_CODES.BAD_REQUEST, 400);
}
```
Leave `ACL: "public-read"` as-is for now (the generated result images are meant to be
publicly viewable); note in your report that presigned reads are a possible follow-up.

**Verify**: `cd apps/api && pnpm check-types` → 0; `pnpm lint` → 0.

### Step 6: Wire the client to store and send the token

- In `GenerationService.generateQR` (client), read `jobData.accessToken` from the create
  response and persist it keyed by job id. Add a helper to `apps/client/src/lib/utils/jobStore.ts`,
  e.g. `saveJobToken(jobId, token)` / `getJobToken(jobId)` backed by `localStorage`
  (follow the `ADMIN_TOKEN_STORAGE_KEY` pattern; namespace keys like `jobToken:{jobId}`).
- In `getJobStatus(jobId)` and `cancelJob(jobId)`, look up the token via `getJobToken(jobId)`
  and send it as the `X-Job-Token` header on the request.
- `JobPage.tsx` reads the job id from the URL and calls `getJobStatus`/`cancelJob` — no change
  needed there **if** the token lookup lives inside `GenerationService`. Confirm the flow:
  create → redirect to `/j/{id}` (same browser, token in localStorage) → poll works.

**Verify**: `cd apps/client && npx astro check` → no new type errors in the touched files.
Manually trace: after `generateQR`, `localStorage` holds `jobToken:{id}`, and `getJobStatus`
attaches `X-Job-Token`.

### Step 7: Tests + full gate

Add API tests (`JobManager.test.ts` / a small route-level test if you have supertest — if not,
unit-test the token check logic by extracting it into a small pure helper and testing that):
- status/cancel with the correct token → allowed; with wrong/missing token → 404.
- `createJob` stores an `accessToken` and it is present on the persisted job but not on the
  status response field list.

**Verify**: `pnpm install` → 0; `cd apps/api && pnpm test` → all pass; `pnpm check-types` → 0;
`pnpm lint` → 0.

## Test plan

- API: token-required behavior (correct token passes; wrong/missing → 404), admin gate on
  `/api/jobs` (no bearer → 401), upload rejects non-PNG / oversized buffers.
- Model after the plan-001/002 tests. If route-level testing needs `supertest`, add it as a
  dev dep in `apps/api` and note it; otherwise test the extracted token-check helper directly.
- Verification: `cd apps/api && pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "adminAuth" apps/api/src/routes/jobs.ts` returns a match
- [ ] `grep -n "X-Job-Token" apps/api/src/routes/qrGeneration.ts` returns matches on both status and cancel
- [ ] `grep -n "accessToken" apps/api/src/services/DynamoJobStore.ts` shows the field added
- [ ] `grep -n "PNG_MAGIC\|subarray(0, 8)" apps/api/src/routes/qrUpload.ts` returns a match
- [ ] `cd apps/api && pnpm test` exits 0 with new tests; `pnpm check-types` and `pnpm lint` exit 0
- [ ] `cd apps/client && npx astro check` reports no new errors in touched files
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift).
- `AdminPanel.tsx` turns out to fetch `/api/jobs*` **without** an admin bearer (so Step 4
  would break the admin UI) — report it; the panel must send the bearer (it has the token via
  `authService`) before this can land.
- Requiring a token breaks the existing single-browser create→view flow in a way that can't
  be fixed inside `GenerationService`/`jobStore` (e.g. results are viewed from a link opened
  in a different browser as a designed feature) — that's D2 territory; report before forcing it.
- Adding `supertest` or route testing balloons scope; fall back to testing an extracted
  helper and note the gap.

## Maintenance notes

- The per-job token is the foundation for direction finding **D2** (shareable/ownable result
  links): a future plan can add an opt-in public read mode that mints a separate share token.
- When plan 004 fixes the admin JWT expiry, the admin gate added here automatically benefits.
- Reviewer focus: verify no read endpoint (status, or any non-admin route) ever echoes
  `accessToken`, and that the 404-not-403 choice is preserved so job existence isn't leaked.
- Because job ids remain weakly random, do NOT rely on id secrecy anywhere — the token is the
  security boundary now.
