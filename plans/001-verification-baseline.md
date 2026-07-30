# Plan 001: Establish a runnable test baseline for the API package

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 803136b..HEAD -- apps/api/package.json turbo.json CLAUDE.md apps/api/src/services/JobManager.ts`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `803136b`, 2026-07-03

## Why this matters

There is **no runnable test suite anywhere in the repo** and no CI. `apps/api/package.json`
declares `"test": "jest"` but `jest` is not installed and no jest config exists, so
`pnpm test` fails with "jest: command not found". `CLAUDE.md` tells contributors (and
coding agents) that `pnpm test` works — an actively misleading instruction. Every other
plan in this set changes security- and correctness-critical code (job submission, auth,
validation) with no automated way to know it still works. This plan makes `pnpm test` in
`apps/api` real and adds a small number of **characterization tests** (tests that lock in
current behavior) around the job pipeline, so the later refactors have a safety net. It is
the prerequisite for plans 002, 003, and 006.

Scope is deliberately limited to `apps/api` (the highest-value, most testable surface — pure
TypeScript, no GPU). Client and Python container test harnesses are explicitly out of scope
here and left as follow-ups.

## Current state

- `apps/api/package.json` — API workspace manifest. Relevant lines:
  ```jsonc
  // scripts (lines 5-24)
  "test": "jest",
  "test:watch": "jest --watch",
  // devDependencies (lines 54-66) — NOTE: no jest, ts-jest, @types/jest, or vitest present
  "eslint": "^9.24.0",
  "serverless": "^4.17.1",
  "tsx": "^4.19.1",
  "typescript": "^5.8.2"
  ```
- `turbo.json:28-30` — a `test` task already exists at the turbo level:
  ```jsonc
  "test": { "cache": false },
  ```
- `CLAUDE.md:22` — documents `pnpm test` (jest), `pnpm test -- <pattern>`, `pnpm test:watch` as working commands. This claim is currently false.
- `apps/api/tsconfig.json` — the API extends `@repo/typescript-config`. The API is ESM/`tsx`-run in dev but compiled with `tsc --build`. Confirm module settings before choosing a runner (see Step 1).
- `apps/api/src/services/JobManager.ts` — the class to characterize. Pure logic worth locking in without hitting AWS:
  - `transformGenerationPlan` (lines 297-330), `transformGenerationDetails` (332-365), `safeNumber` (377-380), `safeString` (382-384), `safeScales` (386-391) — pure, dependency-free transforms. **These are the ideal first characterization targets** (no DynamoDB/SageMaker needed).
  - `estimateProgress` (234-246) — pure but uses `Date.now()` and `Math.random()`; test the bounds (returns 30 when no `startedAt`; never exceeds 95).
- `packages/validation-schemas/src/qr-generation.ts` — exported `QRGenerationRequestSchema` (Zod). A second cheap, dependency-free characterization target (valid input passes; out-of-range `numInferenceSteps` fails). This also directly supports plan 006.

**Convention to follow**: the repo uses TypeScript 5.8, pnpm workspaces, and `@repo/*`
path aliases resolved via each package's `tsconfig`. Tests must run against the TypeScript
source without a separate build step (the dev story is `tsx`). Prefer **vitest** — it needs
no `ts-jest`/babel transform wiring, runs ESM/TS out of the box, and is the lowest-friction
choice for this setup. If you have a strong reason to use jest instead, you must add
`ts-jest` and a matching config; do not leave `jest` referenced without installing it.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck (api) | `cd apps/api && pnpm check-types` | exit 0, no errors |
| Lint (api) | `cd apps/api && pnpm lint` | exit 0 |
| Tests (api) | `cd apps/api && pnpm test` | all pass (fails today) |

Dependencies are NOT installed in a fresh clone — always run `pnpm install` first.

## Scope

**In scope** (the only files you should modify or create):
- `apps/api/package.json` (add dev deps + fix scripts)
- `apps/api/vitest.config.ts` (create) — or `jest.config.js` if you deviate to jest
- `apps/api/src/services/JobManager.test.ts` (create)
- `packages/validation-schemas/src/qr-generation.test.ts` (create)
- `pnpm-lock.yaml` (will change from installing dev deps — expected)
- `CLAUDE.md` (only if Step 5 finds its test commands need correcting)

**Out of scope** (do NOT touch):
- Any `apps/api/src/**` file other than adding the two `*.test.ts` files. This plan adds
  tests only — it does NOT change production behavior. If a test reveals a bug, record it
  in your report; do not fix it here (later plans do).
- `apps/client` and `apps/controlnet` test setup — separate follow-ups.
- `turbo.json` — the `test` task already exists; leave it.

## Git workflow

- Branch: `advisor/001-verification-baseline`
- One commit is fine; message style matches the repo's terse history (e.g. `test: add vitest baseline + characterization tests for api`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the module setup, then add vitest

Read `apps/api/tsconfig.json` and the base it extends (`packages/typescript-config/*.json`)
to note `module`/`moduleResolution`. Then add vitest to `apps/api` dev deps and a config.

Add to `apps/api/package.json` `devDependencies`: `"vitest": "^2.1.0"`. Replace the two test
scripts:
```jsonc
"test": "vitest run",
"test:watch": "vitest",
```

Create `apps/api/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

**Verify**: `pnpm install` → exit 0; `cd apps/api && npx vitest --version` prints a version.

### Step 2: Characterize the pure JobManager transforms

Create `apps/api/src/services/JobManager.test.ts`. Import `JobManager` and construct it with
a stub ControlNetService (the transforms under test never call it):
```ts
import { describe, it, expect } from "vitest";
import { JobManager } from "./JobManager";

// The pure transforms are private; exercise them via a minimal cast.
// A stub is enough because these methods never touch controlNetService/DynamoDB.
const jm = new JobManager({} as any) as any;
```
Write tests that **lock in today's behavior** (do not "fix" anything):
- `safeScales(undefined)` → `[1.0, 0.1]`; `safeScales([2, 3, 9])` → `[2, 3]`.
- `safeNumber("5")` → `5`; `safeNumber("x", 7)` → `7`.
- `transformGenerationPlan(undefined)` → `undefined`; a plan with snake_case keys
  (`total_generations: 3`) maps to `{ totalGenerations: 3, ... }`.
- `estimateProgress({} as any)` → `30`; `estimateProgress({ startedAt: new Date(Date.now() - 10_000).toISOString() } as any)` returns a number `<= 95` and `>= 30`.

If constructing `JobManager` with a `{}` stub throws (its constructor calls `getConfig()` and
builds a `DynamoJobStore`), set the minimal env first in the test file:
```ts
process.env.DYNAMODB_TABLE_NAME = "test-jobs";
process.env.AWS_REGION = "eu-west-1";
```
If it still throws, that itself is a finding — see STOP conditions.

**Verify**: `cd apps/api && pnpm test` → the JobManager suite passes.

### Step 3: Characterize the shared validation schema

Create `packages/validation-schemas/src/qr-generation.test.ts` (this package is a dep of the
api; the api's vitest can import it via the `@repo/validation-schemas` alias, OR place the
test so `apps/api` picks it up — simplest is to add the test in the package and add a `test`
script there too; if the package has no test runner, keep this test inside `apps/api/src`
instead as `validation-schema.test.ts` importing from `@repo/validation-schemas`). Choose the
in-`apps/api` location if unsure — it is guaranteed to run under the vitest you just wired.

Tests:
- A fully-specified valid request (copy the body from `Makefile:132`'s `test-api-server`
  payload, converting to an object) passes `QRGenerationRequestSchema.parse`.
- `numInferenceSteps: 999` throws (schema max is 100).
- `controlGuidanceEnd: [2, 2]` throws (schema max is 1) — this pins the bound that plan 006 relies on.
- `baseQrCode: ["not-a-url"]` throws.

**Verify**: `cd apps/api && pnpm test` → both suites pass; note the total test count.

### Step 4: Make the whole thing green from the repo root

**Verify**:
- `pnpm install` → exit 0
- `cd apps/api && pnpm test` → all pass
- `cd apps/api && pnpm check-types` → exit 0 (adding tests must not break typecheck; if
  vitest globals cause type errors, add `"types": ["vitest/globals"]` is unnecessary because
  we import `{ describe, it, expect }` explicitly — keep the explicit imports).

### Step 5: Fix the CLAUDE.md claim if needed

Re-read `CLAUDE.md:22`. It should now be accurate for `apps/api` (`pnpm test` works there).
If the wording implies repo-wide tests that still don't exist (client/container), tighten it
to say tests currently cover `apps/api` only. Make the smallest edit that makes the doc true.

**Verify**: `grep -n "pnpm test" CLAUDE.md` → the surrounding text matches reality.

## Test plan

- New file `apps/api/src/services/JobManager.test.ts`: the transform + progress cases above
  (happy path + defaulting/edge cases). ~8-10 assertions.
- New validation test (in `apps/api/src` or the package): valid-request pass + three
  rejection cases including the `controlGuidanceEnd` bound.
- No existing test to model after (this is the first). Keep tests dependency-free — no
  DynamoDB, no network, no `aws-sdk` calls.
- Verification: `cd apps/api && pnpm test` → all pass; record the count in `plans/README.md`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm install` exits 0
- [ ] `cd apps/api && pnpm test` exits 0 and runs ≥ 8 tests across ≥ 2 files
- [ ] `cd apps/api && pnpm check-types` exits 0
- [ ] `grep -n "\"test\": \"jest\"" apps/api/package.json` returns no match (the dead jest reference is gone)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" excerpts doesn't match the live code (drift).
- `new JobManager({} as any)` cannot be constructed even with the env vars set, and making
  it constructable would require changing `JobManager.ts` production code — report this as a
  testability finding rather than editing the class.
- Typecheck fails only because of the test files and can't be resolved with explicit imports
  after one reasonable attempt.
- You conclude jest is genuinely required over vitest — report why instead of silently
  installing a heavier toolchain.

## Maintenance notes

- Plans 002, 003, and 006 will add behavior tests alongside these characterization tests;
  keep the vitest config's `include` glob broad (`src/**/*.test.ts`) so they're picked up.
- A reviewer should confirm the tests assert **current** behavior, not desired behavior — a
  characterization test that "fixes" a bug hides the bug from the plan meant to fix it.
- Follow-ups deferred: client (`astro check` + component tests) and Python container
  (`pytest` for the marshmallow schemas) test harnesses, plus a CI workflow to run
  `pnpm test` on push.
