# Plan 004: Fix the never-expiring admin JWT and the Lambda CORS wildcard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 803136b..HEAD -- apps/api/src/routes/auth.ts apps/api/src/lambda.ts apps/api/src/app.ts apps/client/src/services/AuthService.ts`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: plans/001-verification-baseline.md
- **Category**: security
- **Planned at**: commit `803136b`, 2026-07-03

## Why this matters

Two small, independent, high-leverage security bugs:

1. **Admin JWTs effectively never expire.** `auth.ts` signs the token with
   `iat: Date.now()` — milliseconds — while also passing `expiresIn: "24h"`. The
   `jsonwebtoken` library computes `exp = iat + expiresInSeconds` treating `iat` as **seconds**,
   so with `iat ≈ 1.75e12` the `exp` lands roughly 55,000 years in the future. `jwt.verify`
   never sees the token as expired. The `expiresIn: 86400` returned to the client is therefore
   false, and a leaked admin token grants indefinite access with no revocation path. The
   client even carries a workaround for this exact bug (`AuthService.validateToken` special-cases
   `iat > 1e12`), confirming it's real.

2. **The Lambda forces `Access-Control-Allow-Origin: *` on every response**, overwriting the
   Express `cors({ origin: allowedOrigins, credentials: true })` allowlist. So the allowlist is
   dead code in production and any website can call the API and read responses.

Both are quick to fix and both are pure security hardening.

## Current state

- `apps/api/src/routes/auth.ts` — token signing (lines 132-147):
  ```ts
  const token = jwt.sign(
    { role: "admin", iat: Date.now() },   // <-- iat in MILLISECONDS; also redundant with expiresIn
    jwtSecret,
    { expiresIn: JWT_EXPIRES_IN, issuer: JWT_ISSUER },
  );
  return sendSuccess(req, res, { token, expiresIn: JWT_EXPIRES_IN_SECONDS });
  ```
  `JWT_EXPIRES_IN = "24h"`, `JWT_EXPIRES_IN_SECONDS = 86400` (`apps/api/src/constants.ts:16-17`).
- `apps/api/src/middlewares/adminAuth.ts:44-47` — verification:
  ```ts
  const decoded = jwt.verify(token, jwtSecret, { issuer: JWT_ISSUER }) as { role: string; iat: number };
  ```
  It does not pass `maxAge`, so it relies entirely on `exp` — which is broken today.
- `apps/api/src/lambda.ts` — the CORS override:
  ```ts
  // lines 9-14
  const LAMBDA_CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Request-ID",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
  // response modifier (lines 78-88) spreads it over EVERY response:
  response: (response, event, context) => ({ ...response, headers: { ...response.headers, ...LAMBDA_CORS_HEADERS } }),
  // OPTIONS preflight (lines 108-114) returns LAMBDA_CORS_HEADERS directly.
  ```
- `apps/api/src/app.ts:39-46` — the intended allowlist (currently overridden in Lambda):
  ```ts
  app.use(cors({ origin: config.allowedOrigins, credentials: true, methods: [...], allowedHeaders: ["Content-Type","Authorization","X-Request-ID"] }));
  ```
  `config.allowedOrigins` = `process.env.ALLOWED_ORIGINS?.split(",")` (environment.ts:131-133).
  `serverless.yml:19` defaults `ALLOWED_ORIGINS` to `'*'`.
- `apps/client/src/services/AuthService.ts:103-108` — the client-side workaround to simplify
  once the backend is fixed:
  ```ts
  if (payload.iat) {
    const iatInSeconds = payload.iat > 1000000000000 ? payload.iat / 1000 : payload.iat;
    const now = Date.now() / 1000;
    return iatInSeconds + 86400 > now;
  }
  ```

**Convention to follow**: `jsonwebtoken` sets `iat` automatically (in seconds) when you omit
it. Errors use `sendError(..., ERROR_CODES.*, 401)`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck (api) | `cd apps/api && pnpm check-types` | exit 0 |
| Typecheck (client) | `cd apps/client && npx astro check` | no new errors in touched files |
| Tests (api) | `cd apps/api && pnpm test` | all pass |

> **Amendment (2026-07-04, post-001):** `pnpm lint` fails in every workspace — ESLint 9 with
> no `eslint.config.*`/`.eslintrc*` anywhere in the repo (pre-existing, see
> `plans/README.md`). Lint is NOT a gate for this plan. Do not create an ESLint config to
> satisfy it — that's out of scope.
> Also: in a fresh worktree run `pnpm -r --filter '@repo/*' run build` after `pnpm install`
> before `pnpm test` — the API tests import `@repo/validation-schemas` from its built `dist/`.

## Scope

**In scope**:
- `apps/api/src/routes/auth.ts` (remove the bogus `iat`)
- `apps/api/src/middlewares/adminAuth.ts` (optional defense-in-depth `maxAge`)
- `apps/api/src/lambda.ts` (echo allowlisted origin instead of static `*`)
- `apps/client/src/services/AuthService.ts` (simplify the now-unneeded ms workaround)
- `apps/api/src/routes/auth.test.ts` (create — token expiry test)

**Out of scope** (do NOT touch):
- The challenge/response mechanism and the in-memory challenge store (that's finding F12 —
  challenge store under Lambda — a separate plan).
- Rotating `JWT_SECRET`/`ADMIN_SECRET` — that's an ops action; note it in your report but the
  values live in SSM (`serverless.yml:41-42`), not in the repo.
- `ALLOWED_ORIGINS` production value — setting the real origin is an ops/config task; this
  plan makes the code honor whatever allowlist is configured.

## Git workflow

- Branch: `advisor/004-jwt-expiry-and-cors`
- Commit style: `security(api): fix admin JWT expiry (iat in seconds) and honor CORS allowlist in Lambda`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Remove the millisecond `iat`

In `auth.ts` (lines 132-142), drop the manual `iat` so `jsonwebtoken` sets it correctly (in
seconds), and keep `expiresIn`:
```ts
const token = jwt.sign(
  { role: "admin" },
  jwtSecret,
  { expiresIn: JWT_EXPIRES_IN, issuer: JWT_ISSUER },
);
```
Do not otherwise change the payload or the `{ token, expiresIn: JWT_EXPIRES_IN_SECONDS }`
response — after this fix `exp` will genuinely be `iat + 86400` seconds, matching the
advertised `expiresIn`.

**Verify**: `grep -n "iat: Date.now()" apps/api/src/routes/auth.ts` → no match.

### Step 2 (defense-in-depth): enforce max token age on verify

In `adminAuth.ts`, add `maxAge` to the verify options so even a malformed future-`exp` token
is bounded:
```ts
const decoded = jwt.verify(token, jwtSecret, { issuer: JWT_ISSUER, maxAge: JWT_EXPIRES_IN }) as { role: string; iat: number };
```
Import `JWT_EXPIRES_IN` from `../constants` (already exports it). `maxAge` makes verification
reject tokens whose `iat` is older than 24h regardless of `exp`.

**Verify**: `cd apps/api && pnpm check-types` → 0.

### Step 3: Echo the allowlisted origin in the Lambda instead of `*`

In `lambda.ts`, stop hard-coding `Access-Control-Allow-Origin: "*"`. Compute the allowed
origin per-request from `ALLOWED_ORIGINS` and echo the request's `Origin` only when it is in
the list. Target shape:
```ts
function corsHeadersFor(event: APIGatewayProxyEvent): Record<string, string> {
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const reqOrigin = event.headers?.origin || event.headers?.Origin || "";
  const allowAll = allowed.includes("*");
  const originHeader = allowAll ? "*" : (allowed.includes(reqOrigin) ? reqOrigin : (allowed[0] || ""));
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Request-ID",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
  if (originHeader) headers["Access-Control-Allow-Origin"] = originHeader;
  // Only advertise credentials support when echoing a specific origin (not with "*").
  if (originHeader !== "*") headers["Access-Control-Allow-Credentials"] = "true";
  if (originHeader !== "*") headers["Vary"] = "Origin";
  return headers;
}
```
Use `corsHeadersFor(event)` in both the OPTIONS branch (lines 108-114) and the serverless-http
`response` modifier (78-88) — pass the `event` through (the modifier already receives `event`).
Remove the static `LAMBDA_CORS_HEADERS` (or keep only the non-origin headers if it simplifies
the error responses at lines 122-136 and 160-174 — those can call `corsHeadersFor(event)` too).

**Verify**: `grep -n '"Access-Control-Allow-Origin": "\*"' apps/api/src/lambda.ts` → no match;
`cd apps/api && pnpm check-types` → 0.

### Step 4: Simplify the client workaround

Now that the backend emits a correct `exp` (seconds) and `iat` (seconds),
`AuthService.validateToken` can rely on `exp` and the ms special-case is dead. In
`AuthService.ts` (lines 90-114), keep the `exp` branch (98-102) and remove the ms-detection in
the `iat` branch (103-108) — simplify to treat `iat` as seconds (or drop the `iat` fallback
entirely since fixed tokens always carry `exp`). Do not change the method signature or callers.

**Verify**: `grep -n "1000000000000" apps/client/src/services/AuthService.ts` → no match;
`cd apps/client && npx astro check` → no new errors in touched files.

### Step 5: Test the expiry

Create `apps/api/src/routes/auth.test.ts`. Since signing lives in the route, the cleanest unit
test signs the same way and asserts the decoded claims:
```ts
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { JWT_ISSUER, JWT_EXPIRES_IN } from "../constants";

it("issues a token that expires in ~24h (iat/exp in seconds)", () => {
  const token = jwt.sign({ role: "admin" }, "test-secret", { expiresIn: JWT_EXPIRES_IN, issuer: JWT_ISSUER });
  const decoded = jwt.decode(token) as { iat: number; exp: number };
  const nowSec = Math.floor(Date.now() / 1000);
  expect(decoded.iat).toBeLessThanOrEqual(nowSec + 2);
  expect(decoded.exp - decoded.iat).toBe(86400); // exactly 24h, not 55,000 years
});
```
This locks in the fix (the old code would have produced `exp - iat === 86400` too, but with
`iat` in the trillions — so also assert `decoded.iat` is a seconds-scale value `< 1e12`).

**Verify**: `cd apps/api && pnpm test` → passes.

## Test plan

- `apps/api/src/routes/auth.test.ts`: `iat` is seconds-scale (`< 1e12`), `exp - iat === 86400`.
- Optionally a verify test: a token signed with `iat` 25h ago is rejected when `maxAge` is set.
- Verification: `cd apps/api && pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "iat: Date.now()" apps/api/src/routes/auth.ts` → no match
- [ ] `grep -n '"Access-Control-Allow-Origin": "\*"' apps/api/src/lambda.ts` → no match
- [ ] `grep -n "1000000000000" apps/client/src/services/AuthService.ts` → no match
- [ ] `cd apps/api && pnpm test` exits 0 with the new auth test passing
- [ ] `cd apps/api && pnpm check-types` exits 0 (lint is known-broken repo-wide — not a gate; see amendment above)
- [ ] `cd apps/client && npx astro check` reports no new errors in touched files
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift).
- Echoing the allowlisted origin breaks the real client because `ALLOWED_ORIGINS` in the
  deployed environment doesn't contain the CloudFront origin — this is a config gap; report it
  (the code is correct; the env value must be set), do not revert to `*`.
- Removing the client ms-workaround would break admin login against **old** tokens still in
  someone's `localStorage` — acceptable (they can re-login), but note it so it's expected.

## Maintenance notes

- After this lands, existing issued tokens (with the ms `iat`) will still verify until the
  server restarts issuing — but any *new* token is correct. If immediate invalidation of old
  tokens is desired, rotate `JWT_SECRET` in SSM (ops action, out of scope here).
- Reviewer focus: confirm `Access-Control-Allow-Origin: *` is never combined with
  `Access-Control-Allow-Credentials: true` (browsers reject that pairing) — the Step 3 code
  only sets credentials when echoing a specific origin.
- Related but separate: the in-memory challenge store (F12) still makes admin login flaky
  under Lambda; this plan does not address it.
