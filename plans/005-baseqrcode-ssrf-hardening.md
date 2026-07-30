# Plan 005: Harden `baseQrCode` fetching against SSRF and resource exhaustion

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 803136b..HEAD -- packages/validation-schemas/src/qr-generation.ts apps/controlnet/app/services/inference.py apps/controlnet/requirements.txt`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-verification-baseline.md (for the TS schema test only)
- **Category**: security
- **Planned at**: commit `803136b`, 2026-07-03

## Why this matters

`baseQrCode` is a list of URLs supplied by the client. The API validates them only as
`z.string().url()` (any scheme, any host) and forwards them verbatim to the inference
container, which **fetches them server-side** with `requests.get` from inside the SageMaker
VPC. There is no host/scheme allowlist, no block on link-local/private ranges (e.g. the
`169.254.169.254` instance-metadata endpoint), no response-size cap, no `Content-Type` check,
and no Pillow decompression-bomb guard. That is a classic SSRF sink plus a memory-exhaustion
sink (a huge or decompression-bomb image is fully buffered and decoded on the GPU instance).

Legitimately, `baseQrCode` values are always URLs the app itself just produced via
`/api/upload-qr`, i.e. under the S3 public domain (`config.s3.publicDomain`). So both tiers can
constrain the input tightly with little risk to real traffic:
- **API tier** (defense at the boundary): restrict the Zod schema to `https` and, where the
  public domain is known, to that host.
- **Container tier** (defense at the sink): re-validate scheme, resolve the host and refuse
  private/link-local IPs, cap the streamed byte count, and set `Image.MAX_IMAGE_PIXELS`.

Both are needed: the API can be bypassed by anyone with direct (AWS-authenticated) access to
the SageMaker endpoint, so the container must not trust its input.

## Current state

- `packages/validation-schemas/src/qr-generation.ts:26-32` — the only URL constraint today:
  ```ts
  baseQrCode: z
    .array(z.string().url(VALIDATION_MESSAGES.INVALID_URL))
    .min(1, VALIDATION_MESSAGES.QR_CODE_REQUIRED)
    .max(IMAGE_CONSTRAINTS.MAX_QR_CODES, VALIDATION_MESSAGES.QR_CODE_MAX_EXCEEDED),
  ```
- `apps/api/src/services/ControlNetService.ts:513` — forwards it unchanged:
  ```ts
  base_qr_code: request.baseQrCode,
  ```
- `apps/controlnet/app/services/inference.py:286-314` — the fetch sink:
  ```python
  def load_qr_code_from_url(self, url):
      if url.startswith('data:image'):
          _, encoded = url.split(",", 1)
          data = base64.b64decode(encoded)
          image = Image.open(BytesIO(data)).convert("RGB")
          return image
      parsed_url = urlparse(url)
      if not parsed_url.scheme or not parsed_url.netloc:
          raise ValueError(f"Invalid URL: {url}")
      response = requests.get(url, stream=True, timeout=10)   # <-- no host/IP/size guard
      response.raise_for_status()
      image = Image.open(BytesIO(response.content)).convert("RGB")   # <-- no pixel cap
      return image
  ```
  It is reached from `generate()` → planning → per-image load. `base64`, `BytesIO`, `Image`
  (Pillow), `requests`, and `urlparse` are already imported in this module.
- `apps/controlnet/requirements.txt:7` — `Pillow==10.2.0` (predates the 10.3.0 fix for
  CVE-2024-28219; bump as part of this plan since this is the module that decodes untrusted
  images).
- The public-domain anchor: `apps/api/src/utils/environment.ts:180` exposes
  `config.s3.publicDomain` (from `S3_PUBLIC_DOMAIN`); legitimate `baseQrCode` URLs are
  `${publicDomain}/...` (see `apps/api/src/routes/qrUpload.ts:57`).

**Convention to follow**: the container validates request fields with marshmallow
(`app/schemas/generate.py`) and raises `ValidationError`/`ValueError` with plain messages;
keep the fetch guard raising a clear `ValueError`/`Exception` that the existing
`try/except` around generation will surface. Do not introduce new heavyweight deps — `requests`
and the stdlib `ipaddress`/`socket` modules are sufficient.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install (JS) | `pnpm install` | exit 0 |
| Typecheck (schemas) | `cd packages/validation-schemas && npx tsc --noEmit -p tsconfig.json` | exit 0 |
| Tests (api, incl. schema) | `cd apps/api && pnpm test` | all pass |
| Python syntax gate | `cd apps/controlnet && python -m py_compile app/services/inference.py` | exit 0 |
| Python unit (optional) | `cd apps/controlnet && python -m pytest tests/ -q` | pass (only if you add pytest) |

Note: the Python container's full behavior can only be exercised with the model/GPU
(`make dev-controlnet`, needs NVIDIA GPU). Do NOT attempt a full inference run; use
`py_compile` plus a pure-function unit test for the new guard (see Step 3).

## Scope

**In scope**:
- `packages/validation-schemas/src/qr-generation.ts` (tighten `baseQrCode`)
- `apps/controlnet/app/services/inference.py` (guard the fetch)
- `apps/controlnet/requirements.txt` (bump Pillow)
- `apps/api/src/services/JobManager.test.ts` or the schema test from plan 001 (add TS cases)
- `apps/controlnet/tests/test_url_guard.py` (create, optional but recommended)

**Out of scope** (do NOT touch):
- `ControlNetService.ts` forwarding logic — it stays a pass-through; the guard is at the two
  ends (schema + sink).
- The `data:image` base64 branch's behavior beyond adding the pixel cap (keep accepting data
  URLs; they don't make a network request).
- The broader torch/diffusers/transformers version bump (that's finding DEPS-04's larger
  half; only Pillow is in scope here because this module decodes untrusted input).

## Git workflow

- Branch: `advisor/005-baseqrcode-ssrf-hardening`
- Commits: one for the schema, one for the container guard + Pillow bump.
- Message style: `security: constrain baseQrCode to https/own-domain and block SSRF + image bombs at the fetch sink`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Tighten the API schema

In `packages/validation-schemas/src/qr-generation.ts`, replace the plain `.url()` element
validator with an `https`-only refinement. Keep it host-agnostic in the shared package (the
package doesn't know the runtime `S3_PUBLIC_DOMAIN`), but reject non-https and obvious
internal targets:
```ts
const qrUrl = z
  .string()
  .url(VALIDATION_MESSAGES.INVALID_URL)
  .refine((u) => {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "https:") return false;
      const host = parsed.hostname.toLowerCase();
      // reject localhost / obvious internal hosts at the boundary
      if (host === "localhost" || host.endsWith(".localhost")) return false;
      if (host === "169.254.169.254") return false; // cloud metadata
      return true;
    } catch { return false; }
  }, "QR code URL must be a public https URL");

baseQrCode: z.array(qrUrl).min(1, VALIDATION_MESSAGES.QR_CODE_REQUIRED)
  .max(IMAGE_CONSTRAINTS.MAX_QR_CODES, VALIDATION_MESSAGES.QR_CODE_MAX_EXCEEDED),
```
(Full IP-range blocking belongs at the container sink where DNS resolution happens — Step 2.
The schema is the coarse boundary.) Add `VALIDATION_MESSAGES` entry if you prefer a named
message; reuse `INVALID_URL` otherwise.

**Verify**: `cd packages/validation-schemas && npx tsc --noEmit -p tsconfig.json` → 0.

### Step 2: Guard the fetch sink in the container

Rewrite `load_qr_code_from_url` (inference.py:286-314) to resolve the host, refuse
private/link-local/loopback IPs, enforce `https`, cap the streamed bytes, and set a Pillow
pixel limit. Target shape (keep the `data:image` branch, add a pixel guard to it too):
```python
import ipaddress
import socket
# module-level, once:
Image.MAX_IMAGE_PIXELS = 1024 * 1024 * 4  # ~4 MP cap; QR inputs are <= 1024x1024

_MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024  # 8 MB hard cap on a fetched QR image

def _assert_public_host(hostname):
    infos = socket.getaddrinfo(hostname, None)
    for family, _, _, _, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ValueError(f"Refusing to fetch QR from non-public address: {hostname}")

def load_qr_code_from_url(self, url):
    if url.startswith('data:image'):
        _, encoded = url.split(",", 1)
        data = base64.b64decode(encoded)
        if len(data) > _MAX_DOWNLOAD_BYTES:
            raise ValueError("QR data URL too large")
        return Image.open(BytesIO(data)).convert("RGB")

    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError(f"Invalid or non-https URL: {url}")
    _assert_public_host(parsed.hostname)

    response = requests.get(url, stream=True, timeout=10)
    response.raise_for_status()
    ctype = response.headers.get("Content-Type", "")
    if ctype and not ctype.lower().startswith("image/"):
        raise ValueError(f"Unexpected content type for QR image: {ctype}")

    chunks, total = [], 0
    for chunk in response.iter_content(8192):
        total += len(chunk)
        if total > _MAX_DOWNLOAD_BYTES:
            raise ValueError("QR image exceeds maximum allowed size")
        chunks.append(chunk)
    return Image.open(BytesIO(b"".join(chunks))).convert("RGB")
```
Keep the existing `except` handlers (Timeout / RequestException / generic) that wrap and
re-raise with context (inference.py:309-314).

Note the TOCTOU caveat: `_assert_public_host` resolves DNS, then `requests.get` resolves
again. For this project's threat model (blocking the obvious IMDS/private-range SSRF and image
bombs) this is acceptable; a fully airtight fix would pin the resolved IP into the connection.
Record that as a known limitation in your report — do NOT expand scope to a custom transport
adapter here.

**Verify**: `cd apps/controlnet && python -m py_compile app/services/inference.py` → exit 0.

### Step 3: Add a Python unit test for the guard (recommended)

Create `apps/controlnet/tests/test_url_guard.py` testing the pure parts without network:
- `_assert_public_host` raises for a hostname resolving to `127.0.0.1` / a private IP (monkeypatch `socket.getaddrinfo`).
- a `http://` or `file://` URL raises `ValueError` before any request.
- a `data:image/...;base64,...` under the size cap returns an image.
Use `pytest` + `monkeypatch`; if pytest isn't set up in the container, keep the test minimal
and note that the container test harness is a follow-up (do not block on it — the `py_compile`
gate plus the TS test in Step 4 are the required gates).

**Verify**: `cd apps/controlnet && python -m pytest tests/test_url_guard.py -q` → pass (if
pytest available); otherwise skip and note it.

### Step 4: Bump Pillow and add the TS schema test

- In `requirements.txt`, change `Pillow==10.2.0` to a patched line, e.g. `Pillow==10.4.0`
  (or the latest 10.x). Do not jump major versions in this plan.
- Add TS cases to the plan-001 schema test: `baseQrCode: ["http://x/y.png"]` fails;
  `["https://evil/../"]`... keep it simple — assert `http` fails and a normal
  `https://<public-domain>/qr.png` passes.

**Verify**: `cd apps/api && pnpm test` → the schema cases pass;
`grep -n "Pillow==10.2.0" apps/controlnet/requirements.txt` → no match.

## Test plan

- TS: `http`/non-https `baseQrCode` rejected; a normal `https` URL accepted (in the plan-001
  schema test).
- Python (if harness available): private-IP host rejected; non-https rejected; oversized data
  URL rejected.
- Verification: `cd apps/api && pnpm test` (TS) + `python -m py_compile app/services/inference.py`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "protocol !== \"https:\"\|https:" packages/validation-schemas/src/qr-generation.ts` shows the https refinement present
- [ ] `grep -n "_assert_public_host\|MAX_IMAGE_PIXELS\|_MAX_DOWNLOAD_BYTES" apps/controlnet/app/services/inference.py` returns matches
- [ ] `cd apps/controlnet && python -m py_compile app/services/inference.py` exits 0
- [ ] `grep -n "Pillow==10.2.0" apps/controlnet/requirements.txt` → no match
- [ ] `cd apps/api && pnpm test` exits 0 with the new schema cases
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift).
- Legitimate `baseQrCode` URLs are NOT under `https` / a public domain (e.g. the app is
  designed to accept arbitrary user image URLs) — then the `https`-only + public-IP rule would
  break real traffic; report before tightening.
- `socket.getaddrinfo`-based blocking would break a legitimate internal-but-intended fetch
  (unlikely here) — report.
- Bumping Pillow to 10.4.x conflicts with the pinned `torch`/`diffusers` versions at install
  time — report the conflict; do not start a broader dependency migration.

## Maintenance notes

- The TOCTOU gap (resolve-then-connect) is a known, accepted limitation for this threat model.
  If the endpoint ever becomes broadly network-reachable, revisit pinning the resolved IP into
  the connection (custom `requests` adapter) or using an egress allowlist/proxy.
- The larger torch/diffusers/transformers currency bump (DEPS-04) is deliberately deferred;
  this plan only moves Pillow because it decodes untrusted input.
- Reviewer focus: confirm the container guard rejects `http`, `file:`, `169.254.169.254`, and
  private-range hosts, and that the byte cap streams (does not buffer the whole body before
  checking size).
