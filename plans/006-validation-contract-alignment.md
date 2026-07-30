# Plan 006: Align the QR-generation validation contract across tiers and fix client slider bounds

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 803136b..HEAD -- packages/validation-schemas/src/qr-generation.ts packages/qr-constants/src/index.tsx apps/controlnet/app/schemas/generate.py apps/client/src/components/generation/GenerationForm.tsx`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-verification-baseline.md
- **Category**: tech-debt
- **Planned at**: commit `803136b`, 2026-07-03

## Why this matters

The same QR-generation request contract is implemented three times and the copies have
already drifted:

- **Public API (Zod)** bounds `numInferenceSteps` to 1–100, `height`/`width` to 512–1024
  (÷8), and `controlGuidanceStart`/`End` tuples to 0–1.
- **Container, live `/invocations` schema (`InvocationRequestSchema`, marshmallow)** leaves
  `num_inference_steps` **unbounded** and enforces only `≤1024` / ÷8 on height/width (**no 512
  floor**). Its sibling `SageMakerRequestSchema` *does* bound steps 1–100 — but that schema
  isn't the one bound to `/invocations`.
- **Client form** lets the four Control Guidance sliders range **0–2**, while the Zod schema
  caps them at **1** — and the default is already `[1, 1]` (the max), so nudging any guidance
  slider to the right submits an out-of-contract value that the API rejects with a 400 the
  user can't diagnose. The prompt textarea also has no `maxLength` (schema max 1000) and the
  seed input accepts negatives (schema min 0).

Two concrete harms: (1) the container accepts unbounded `num_inference_steps` on its live
endpoint — a GPU cost/DoS lever (also covered defensively by the API cap, but the container
must not depend on that); (2) the client emits values guaranteed to 400. This plan makes the
numeric bounds consistent and fixes the client controls. The camelCase↔snake_case boundary is
intentional and stays.

## Current state

- `packages/qr-constants/src/index.tsx` — the shared numeric source of truth:
  ```ts
  // IMAGE_CONSTRAINTS (77-85)
  MIN_DIMENSION: 512, MAX_DIMENSION: 1024, DIMENSION_MULTIPLE: 8, MAX_PROMPT_LENGTH: 1000, ...
  // INFERENCE_CONSTRAINTS (95-101)
  MIN_STEPS: 1, MAX_STEPS: 100, ...
  // SEED_CONSTRAINTS (104-107)
  MIN_SEED: 0, MAX_SEED: 4294967295,
  ```
- `packages/validation-schemas/src/qr-generation.ts` — the authoritative Zod schema:
  - `numInferenceSteps` min `MIN_STEPS`(1) / max `MAX_STEPS`(100) (47-52)
  - `controlGuidanceStart`/`End`: `z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])` (58-64)
  - `height`/`width`: min 512, max 1024, ÷8 (67-87)
- `apps/controlnet/app/schemas/generate.py`:
  - `InvocationRequestSchema.num_inference_steps = fields.Integer(missing=DEFAULT_NUM_INFERENCE_STEPS)` — **no `validate=Range`** (line 129). This is the schema bound to `/invocations` (`app/__init__.py:75`).
  - `_CommonValidators.validate_height`/`validate_width` (45-57) — only `÷8` and `≤1024`, **no minimum**.
  - `SageMakerRequestSchema.num_inference_steps = fields.Integer(validate=validate.Range(min=1, max=100))` (168) — the correct bound, on the wrong schema. `height`/`width` there use `validate.OneOf([512, 768, 1024])` (172-173).
- `apps/client/src/components/generation/GenerationForm.tsx`:
  - Guidance sliders `min={0} max={2}` at lines 397-439 (Guidance Start 1/2, Guidance End 1/2).
  - Conditioning-scale sliders `min={0} max={2}` (367-387) — these MATCH the schema (0–2), leave them.
  - Prompt `<textarea>` (200-210) — no `maxLength`.
  - Seed `<Input type="number">` (292-302) — no min/clamp.
- `packages/qr-constants/src/index.tsx` has no `MIN`/`MAX` for guidance tuples; the bound
  (0–1) lives only in the Zod schema. Consider adding a `GUIDANCE_RANGE = { MIN: 0, MAX: 1 }`
  constant so the client and schema share it (optional but prevents re-drift).

**Convention to follow**: numeric bounds live in `@repo/qr-constants` and are consumed by the
Zod schema and the client. The container mirrors the *numbers* (not the code) in marshmallow.
Keep field names snake_case in the container, camelCase in TS.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install (JS) | `pnpm install` | exit 0 |
| Build packages | `pnpm -r --filter '@repo/*' run build` | exit 0 |
| Tests (api, schema) | `cd apps/api && pnpm test` | all pass |
| Typecheck (client) | `cd apps/client && npx astro check` | no new errors in touched files |
| Python syntax gate | `cd apps/controlnet && python -m py_compile app/schemas/generate.py` | exit 0 |

## Scope

**In scope**:
- `apps/controlnet/app/schemas/generate.py` (bound `InvocationRequestSchema` to match)
- `apps/client/src/components/generation/GenerationForm.tsx` (slider max, textarea maxLength, seed clamp)
- `packages/qr-constants/src/index.tsx` (optional: add a shared guidance range constant)
- `apps/api/src/services/JobManager.test.ts` or the schema test (assert the bounds — likely already added in plan 001)
- `apps/controlnet/tests/test_invocation_schema.py` (create, optional)

**Out of scope** (do NOT touch):
- The camelCase↔snake_case naming boundary (intentional).
- `ControlNetService.ts` transform (it's a straight field rename, correct as-is).
- The conditioning-scale sliders (0–2) — they already match the schema.
- Any change to the *default* parameter values (the tuned defaults in the README stay).

## Git workflow

- Branch: `advisor/006-validation-contract-alignment`
- Commits: one for the container schema, one for the client form.
- Message style: `fix: align validation bounds (container num_inference_steps, client guidance sliders) with the shared contract`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Bound the container's live invocation schema

In `generate.py`, make `InvocationRequestSchema` match the public contract:
- `num_inference_steps`: add `validate=validate.Range(min=1, max=100)` (mirror line 168).
- Add height/width minimum: extend `_CommonValidators.validate_height`/`validate_width`
  (45-57) to also reject `value < 512` (the Zod floor), OR switch `InvocationRequestSchema`'s
  `height`/`width` to `validate=validate.OneOf([512, 768, 1024])` like `SageMakerRequestSchema`.
  Prefer adding the `< 512` check in `_CommonValidators` so both schemas benefit — but confirm
  that doesn't over-restrict any intended small size (the Zod floor is 512, so 512 is the min).

Keep `missing=DEFAULT_NUM_INFERENCE_STEPS` etc. (defaults unchanged).

**Verify**: `cd apps/controlnet && python -m py_compile app/schemas/generate.py` → exit 0.

### Step 2 (optional, prevents re-drift): share the guidance range

In `packages/qr-constants/src/index.tsx`, add:
```ts
export const GUIDANCE_RANGE = { MIN: 0, MAX: 1 } as const;
```
and have the Zod tuples reference `.min(GUIDANCE_RANGE.MIN).max(GUIDANCE_RANGE.MAX)` and the
client sliders reference `GUIDANCE_RANGE.MAX`. If you do this, rebuild packages so the client
picks up the new export.

**Verify**: `pnpm -r --filter '@repo/*' run build` → exit 0.

### Step 3: Fix the client controls

In `GenerationForm.tsx`:
- Change the four Control Guidance sliders (lines 397-439) from `max={2}` to `max={1}` (or
  `GUIDANCE_RANGE.MAX`). Leave `min={0}` and `step`.
- Add `maxLength={IMAGE_CONSTRAINTS.MAX_PROMPT_LENGTH}` to the prompt `<textarea>` (line 200)
  — import `IMAGE_CONSTRAINTS` from `@repo/qr-constants` (already imported for other constants
  in this file? check the import block at the top; add it if missing).
- Clamp the seed input: in the `onChange` (295-298), clamp parsed values to
  `[SEED_CONSTRAINTS.MIN_SEED, SEED_CONSTRAINTS.MAX_SEED]` and prevent negatives (add
  `min={0}` to the `<Input>` and guard in the handler).

**Verify**: `cd apps/client && npx astro check` → no new errors in touched files;
`grep -n 'max={2}' apps/client/src/components/generation/GenerationForm.tsx` returns only the
two conditioning-scale sliders (368-386), not the guidance sliders.

### Step 4: Tests

- TS (schema test from plan 001): assert `controlGuidanceEnd: [2, 2]` fails and `[1, 1]`
  passes; `numInferenceSteps: 101` fails, `100` passes; `height: 500` fails, `512` passes.
- Python (optional): a small pytest that `InvocationRequestSchema().load({...})` raises for
  `num_inference_steps=999` and for `height=8`, and accepts `num_inference_steps=40`,
  `height=1024`. If no pytest harness, rely on `py_compile` + a manual `python -c` load and
  note the follow-up.

**Verify**: `cd apps/api && pnpm test` → all pass.

## Test plan

- TS schema: guidance tuple max (1), steps max (100), height min (512) — pass/fail pairs.
- Python (if harness available): `InvocationRequestSchema` rejects unbounded steps and
  sub-512 height.
- Verification: `cd apps/api && pnpm test` + `python -m py_compile app/schemas/generate.py`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "Range(min=1, max=100)" apps/controlnet/app/schemas/generate.py` returns matches for BOTH schemas (or an equivalent bound applied to `InvocationRequestSchema.num_inference_steps`)
- [ ] `grep -c 'max={2}' apps/client/src/components/generation/GenerationForm.tsx` returns `2` (only the conditioning-scale sliders remain at 2)
- [ ] `grep -n "maxLength=" apps/client/src/components/generation/GenerationForm.tsx` shows the prompt textarea cap
- [ ] `cd apps/controlnet && python -m py_compile app/schemas/generate.py` exits 0
- [ ] `cd apps/api && pnpm test` exits 0 with the bound assertions
- [ ] `cd apps/client && npx astro check` reports no new errors in touched files
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift).
- Adding a `< 512` height/width floor to `_CommonValidators` breaks an intended small-size
  path elsewhere (grep for other schema users) — if so, apply the floor only to
  `InvocationRequestSchema`.
- Bounding `num_inference_steps` on `/invocations` would reject payloads the deployed client
  actually sends today (it shouldn't — the client slider max is 40) — report if you find a
  caller exceeding 100.

## Maintenance notes

- Ideal end-state (future plan): generate the marshmallow bounds and client slider ranges from
  the same `@repo/qr-constants` numbers (e.g. emit a JSON contract at build time) so the three
  copies can't drift again. This plan aligns the numbers by hand; it does not unify the source.
- Reviewer focus: confirm the container's **live** `/invocations` schema (not just the unused
  `SageMakerRequestSchema`) is the one that got the bounds, and that guidance sliders can no
  longer emit `> 1`.
- Related: plan 005 also touches this schema file's sibling (`baseQrCode`); if both land,
  reconcile the diffs.
