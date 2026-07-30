#!/usr/bin/env python3
"""plan-008 QR quality eval harness (Phase 6) — the operator's tuning tool.

Runs the fixed prompt matrix (``eval/prompts.txt``: prompts x presets x 3
seeds x {v1, v2}) against a generation target, re-verifies every returned
image with the CPU scan verifier, and writes:

- ``eval/results.json`` — SSR per (pipeline x preset) cell, mean scan_score,
  p50/p95 latency, the v2 repair-rung histogram, and the promotion-gate
  evaluation;
- ``eval/report.html`` — a fully self-contained report (base64-inlined
  thumbnails, pass/fail badges, gate thresholds stated up front).

Targets:

- ``--target local`` — the docker-compose ControlNet container's HTTP
  endpoint (``make dev-controlnet``; default http://localhost:8080),
  POSTing snake_case bodies straight to ``/invocations``.
- ``--target staging`` — the deployed async job API: POST camelCase bodies
  to ``{--api-url}/api/qr-generation`` and poll ``.../{jobId}/status``
  (presenting the job's access token as ``X-Job-Token``). The URL is
  configurable via ``--api-url`` or the ``EVAL_API_URL`` env var.

This script must NOT import torch (it talks HTTP and uses the CPU
verifier); it imports ``app.utils.scan_verifier`` through a package stub so
the Flask/torch application package never loads. Scan verification uses the
WeChat models when ``WECHAT_MODEL_DIR`` points at them (falls back to the
test cache next to this file, then degrades to zxing-only).

Never runs in CI — a full matrix is GPU time and money. The acceptance gate
(operator-driven tuning round, plan 008 Phase 6.2) is:
SSR >= 95% at standard strictness, mean scan_score >= 0.6, p95 <= 150 s/image.

Usage:
    python3 apps/controlnet/eval/run_eval.py --target local
    python3 apps/controlnet/eval/run_eval.py --target local --limit 2 --seeds 1001
    python3 apps/controlnet/eval/run_eval.py --target staging --api-url https://...
    make eval-qr   # wraps the local run
"""

import argparse
import base64
import json
import math
import os
import sys
import time
import types
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image

EVAL_DIR = Path(__file__).resolve().parent
CONTROLNET_DIR = EVAL_DIR.parent
APP_DIR = CONTROLNET_DIR / "app"


def _import_scan_verifier():
    """Import ``app.utils.scan_verifier`` WITHOUT executing app/__init__.py
    (which pulls Flask + torch). Same package-stub trick as the test suite."""
    if "app" not in sys.modules:
        app_pkg = types.ModuleType("app")
        app_pkg.__path__ = [str(APP_DIR)]
        sys.modules["app"] = app_pkg
    if "app.utils" not in sys.modules:
        utils_pkg = types.ModuleType("app.utils")
        utils_pkg.__path__ = [str(APP_DIR / "utils")]
        sys.modules["app.utils"] = utils_pkg
    import importlib

    return importlib.import_module("app.utils.scan_verifier")


def _default_wechat_model_dir():
    """Point the verifier at the test cache when nothing else is configured."""
    if os.environ.get("WECHAT_MODEL_DIR"):
        return
    default_dir = Path("/opt/program/wechat_models")
    cache = CONTROLNET_DIR / "tests" / ".cache" / "wechat_models"
    if not default_dir.is_dir() and cache.is_dir():
        os.environ["WECHAT_MODEL_DIR"] = str(cache)


_default_wechat_model_dir()
scan_verifier = _import_scan_verifier()

# ---------------------------------------------------------------------------
# Promotion gate (plan 008 Phase 6.2) — the report states these so the
# operator sees pass/fail at a glance. Do not lower unilaterally (STOP
# condition); the actual tuning round is GPU/operator work.
# ---------------------------------------------------------------------------
GATES = {
    "v2_ssr_min": 0.95,             # SSR >= 95% at standard strictness
    "v2_mean_scan_score_min": 0.6,  # mean scan_score >= 0.6
    "p95_latency_max_s": 150.0,     # p95 <= 150 s/image
    "v2_ssr_above_v1": True,        # v2 SSR > v1 SSR on the same prompt set
}

DEFAULT_SEEDS = [1001, 2002, 3003]
DEFAULT_QR_CONTENT = "https://qraft.ai/e2e"
DEFAULT_PIPELINES = ["v1", "v2"]
THUMBNAIL_PX = 192
REPAIR_RUNGS = ["none", "module_blend", "latent_srpg", "reroll"]


# ---------------------------------------------------------------------------
# Prompt matrix
# ---------------------------------------------------------------------------

def parse_prompts(path):
    """Parse ``eval/prompts.txt``.

    Returns ``(cases, qr_content, seeds)`` where cases is a list of
    ``(style_preset, prompt)``. ``# QR_CONTENT:`` / ``# SEEDS:`` header
    comments override the defaults so the prompt file stays the single
    source of truth for the matrix.
    """
    cases = []
    qr_content = DEFAULT_QR_CONTENT
    seeds = list(DEFAULT_SEEDS)
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            body = line.lstrip("#").strip()
            if body.upper().startswith("QR_CONTENT:"):
                qr_content = body.split(":", 1)[1].strip()
            elif body.upper().startswith("SEEDS:"):
                seeds = [int(s) for s in body.split(":", 1)[1].split(",")]
            continue
        if "|" not in line:
            raise ValueError(f"Bad prompt line (want 'preset|prompt'): {line!r}")
        preset, prompt = line.split("|", 1)
        cases.append((preset.strip(), prompt.strip()))
    if not cases:
        raise ValueError(f"No prompts found in {path}")
    return cases, qr_content, seeds


def _qr_data_url(content):
    """Render *content* as a plain QR data URL — the v1 lane's input raster."""
    import qrcode

    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=16, border=4
    )
    qr.add_data(content)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def build_request_body(pipeline, preset, prompt, seed, qr_content, camel=False,
                       prompt_enhancement=False):
    """Generation request for one matrix run (1 image per request).

    ``camel=False`` -> container snake_case (/invocations);
    ``camel=True``  -> public API camelCase (staging job API).
    ``prompt_enhancement`` (plan 009) is sent only when True, so default runs
    keep baseline bodies byte-identical (and old containers never see the
    field).
    """
    if camel:
        body = {
            "prompt": prompt,
            "baseQrCode": [_qr_data_url(qr_content)],
            "numImagesPerPrompt": 1,
            "seed": seed,
        }
        if prompt_enhancement:
            body["promptEnhancement"] = True
        if pipeline == "v2":
            body.update({
                "pipeline": "v2",
                "qrContent": qr_content,
                "stylePreset": preset,
                "scanStrictness": "standard",
                "environment": "staging",
            })
        return body

    body = {
        "prompt": prompt,
        "base_qr_code": [_qr_data_url(qr_content)],
        "num_images_per_prompt": 1,
        "seed": seed,
    }
    if prompt_enhancement:
        body["prompt_enhancement"] = True
    if pipeline == "v2":
        body.update({
            "pipeline": "v2",
            "qr_content": qr_content,
            "style_preset": preset,
            "scan_strictness": "standard",
        })
    return body


# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------

def _load_output_image(ref, timeout=60):
    """PIL image from a container output ref (data URL or https URL)."""
    if ref.startswith("data:"):
        payload = ref.split(",", 1)[1]
        return Image.open(BytesIO(base64.b64decode(payload))).convert("RGB")
    response = requests.get(ref, timeout=timeout)
    response.raise_for_status()
    return Image.open(BytesIO(response.content)).convert("RGB")


class LocalTarget:
    """POSTs straight to the ControlNet container's /invocations endpoint."""

    name = "local"

    def __init__(self, base_url, timeout_s, prompt_enhancement=False):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.prompt_enhancement = prompt_enhancement

    def run(self, pipeline, preset, prompt, seed, qr_content):
        """Returns ``(pil_image, container_image_metadata, latency_s)``."""
        body = build_request_body(
            pipeline, preset, prompt, seed, qr_content,
            prompt_enhancement=self.prompt_enhancement,
        )
        start = time.monotonic()
        response = requests.post(
            f"{self.base_url}/invocations", json=body, timeout=self.timeout_s
        )
        latency = time.monotonic() - start
        response.raise_for_status()
        data = response.json()
        if "error" in data:
            raise RuntimeError(f"container error: {data['error']}")
        images = data.get("images") or []
        if not images:
            raise RuntimeError("container returned no images")
        metadata = (data.get("images_metadata") or [{}])[0]
        return _load_output_image(images[0]), metadata, latency


class StagingTarget:
    """Submits async jobs to the deployed API and polls for the result."""

    name = "staging"

    def __init__(self, api_url, timeout_s, poll_interval_s=10,
                 prompt_enhancement=False):
        self.api_url = api_url.rstrip("/")
        self.timeout_s = timeout_s
        self.poll_interval_s = poll_interval_s
        self.prompt_enhancement = prompt_enhancement

    def run(self, pipeline, preset, prompt, seed, qr_content):
        body = build_request_body(
            pipeline, preset, prompt, seed, qr_content, camel=True,
            prompt_enhancement=self.prompt_enhancement,
        )
        start = time.monotonic()
        response = requests.post(
            f"{self.api_url}/api/qr-generation", json=body, timeout=60
        )
        response.raise_for_status()
        created = response.json().get("data") or response.json()
        job_id = created.get("jobId")
        if not job_id:
            raise RuntimeError(f"no jobId in response: {created}")
        headers = {}
        if created.get("accessToken"):
            headers["X-Job-Token"] = created["accessToken"]

        deadline = start + self.timeout_s
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError(f"job {job_id} did not finish in {self.timeout_s}s")
            time.sleep(self.poll_interval_s)
            status_resp = requests.get(
                f"{self.api_url}/api/qr-generation/{job_id}/status",
                headers=headers, timeout=60,
            )
            status_resp.raise_for_status()
            payload = status_resp.json().get("data") or status_resp.json()
            status = payload.get("status")
            if status == "completed":
                latency = time.monotonic() - start
                result = payload.get("result") or {}
                images = result.get("images") or []
                if not images:
                    raise RuntimeError(f"job {job_id} completed without images")
                metadata = (result.get("images_metadata") or [{}])[0]
                return _load_output_image(images[0]), metadata, latency
            if status in ("failed", "cancelled"):
                raise RuntimeError(f"job {job_id} {status}: {payload.get('error')}")


# ---------------------------------------------------------------------------
# Records + aggregation (pure functions — unit-tested with fake data)
# ---------------------------------------------------------------------------

def make_thumbnail_b64(image, size=THUMBNAIL_PX):
    """Small JPEG thumbnail as a bare base64 string (None-safe)."""
    if image is None:
        return None
    thumb = image.copy()
    thumb.thumbnail((size, size), Image.LANCZOS)
    buffer = BytesIO()
    thumb.convert("RGB").save(buffer, format="JPEG", quality=70)
    return base64.b64encode(buffer.getvalue()).decode()


def build_record(pipeline, preset, prompt, seed, image=None,
                 container_metadata=None, latency_s=None, error=None,
                 qr_content=DEFAULT_QR_CONTENT):
    """One matrix-run record: harness-side verification + container metadata."""
    record = {
        "pipeline": pipeline,
        "preset": preset,
        "prompt": prompt,
        "seed": seed,
        "latency_s": None if latency_s is None else round(latency_s, 2),
        "error": error,
        "scan_verified": None,
        "scan_score": None,
        "decoders_passed": [],
        "container_scan_verified": None,
        "repair_stage_used": None,
        "hires_dropped": None,
        "thumbnail_b64": make_thumbnail_b64(image),
    }
    if image is not None and not error:
        report = scan_verifier.verify(image, qr_content, "standard")
        record["scan_verified"] = report.scan_verified
        record["scan_score"] = report.scan_score
        record["decoders_passed"] = list(report.decoders_passed)
    if container_metadata:
        record["container_scan_verified"] = container_metadata.get("scan_verified")
        record["repair_stage_used"] = container_metadata.get("repair_stage_used")
        record["hires_dropped"] = container_metadata.get("hires_dropped")
    return record


def percentile(values, q):
    """Nearest-rank percentile (q in [0, 100]); None for empty input."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(q / 100.0 * len(ordered)))
    return ordered[rank - 1]


def _summarize(records):
    """SSR / mean score / latency percentiles over *records*."""
    ok = [r for r in records if not r["error"]]
    verified = [r for r in ok if r["scan_verified"]]
    scores = [r["scan_score"] for r in ok if r["scan_score"] is not None]
    latencies = [r["latency_s"] for r in ok if r["latency_s"] is not None]
    return {
        "runs": len(records),
        "errors": len(records) - len(ok),
        "ssr": round(len(verified) / len(ok), 4) if ok else None,
        "mean_scan_score": round(sum(scores) / len(scores), 4) if scores else None,
        "p50_latency_s": percentile(latencies, 50),
        "p95_latency_s": percentile(latencies, 95),
    }


def aggregate(records, target="unknown", qr_content=DEFAULT_QR_CONTENT,
              seeds=DEFAULT_SEEDS, prompt_enhancement=False):
    """The results.json payload: per-cell + per-pipeline stats + gates."""
    pipelines = sorted({r["pipeline"] for r in records})
    presets = sorted({r["preset"] for r in records})

    cells = {}
    for pipeline in pipelines:
        for preset in presets:
            subset = [
                r for r in records
                if r["pipeline"] == pipeline and r["preset"] == preset
            ]
            if subset:
                cells[f"{pipeline}|{preset}"] = _summarize(subset)

    per_pipeline = {}
    for pipeline in pipelines:
        subset = [r for r in records if r["pipeline"] == pipeline]
        summary = _summarize(subset)
        if pipeline == "v2":
            histogram = {rung: 0 for rung in REPAIR_RUNGS}
            hires_dropped = 0
            for r in subset:
                if r["error"]:
                    continue
                rung = r["repair_stage_used"] or "none"
                histogram[rung] = histogram.get(rung, 0) + 1
                if r["hires_dropped"]:
                    hires_dropped += 1
            summary["repair_histogram"] = histogram
            summary["hires_dropped_count"] = hires_dropped
        per_pipeline[pipeline] = summary

    v1 = per_pipeline.get("v1", {})
    v2 = per_pipeline.get("v2", {})
    checks = {
        "v2_ssr_min": (
            v2.get("ssr") is not None and v2["ssr"] >= GATES["v2_ssr_min"]
        ),
        "v2_mean_scan_score_min": (
            v2.get("mean_scan_score") is not None
            and v2["mean_scan_score"] >= GATES["v2_mean_scan_score_min"]
        ),
        "p95_latency_max_s": (
            v2.get("p95_latency_s") is not None
            and v2["p95_latency_s"] <= GATES["p95_latency_max_s"]
        ),
        "v2_ssr_above_v1": (
            v2.get("ssr") is not None
            and (v1.get("ssr") is None or v2["ssr"] > v1["ssr"])
        ),
    }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "target": target,
        "qr_content": qr_content,
        "seeds": list(seeds),
        "strictness": "standard",
        "prompt_enhancement": prompt_enhancement,
        "gates": GATES,
        "cells": cells,
        "pipelines": per_pipeline,
        "gate_evaluation": {"checks": checks, "all_passed": all(checks.values())},
    }


# ---------------------------------------------------------------------------
# Report rendering (self-contained HTML)
# ---------------------------------------------------------------------------

def _badge(ok, label_ok="PASS", label_fail="FAIL"):
    if ok is None:
        return '<span class="badge na">n/a</span>'
    cls, label = ("pass", label_ok) if ok else ("fail", label_fail)
    return f'<span class="badge {cls}">{label}</span>'


def _fmt(value, suffix=""):
    if value is None:
        return "–"
    return f"{value}{suffix}"


def render_report(results, records):
    """Self-contained HTML: gate banner, cell table, thumbnail grid."""
    gates = results["gates"]
    checks = results["gate_evaluation"]["checks"]
    v1 = results["pipelines"].get("v1", {})
    v2 = results["pipelines"].get("v2", {})

    gate_rows = f"""
      <tr><td>v2 SSR &ge; {gates['v2_ssr_min']:.0%} (standard strictness)</td>
          <td>{_fmt(v2.get('ssr'))}</td><td>{_badge(checks.get('v2_ssr_min'))}</td></tr>
      <tr><td>v2 mean scan_score &ge; {gates['v2_mean_scan_score_min']}</td>
          <td>{_fmt(v2.get('mean_scan_score'))}</td><td>{_badge(checks.get('v2_mean_scan_score_min'))}</td></tr>
      <tr><td>v2 p95 latency &le; {gates['p95_latency_max_s']:.0f} s/image</td>
          <td>{_fmt(v2.get('p95_latency_s'), ' s')}</td><td>{_badge(checks.get('p95_latency_max_s'))}</td></tr>
      <tr><td>v2 SSR &gt; v1 SSR (same prompt set)</td>
          <td>v2 {_fmt(v2.get('ssr'))} vs v1 {_fmt(v1.get('ssr'))}</td>
          <td>{_badge(checks.get('v2_ssr_above_v1'))}</td></tr>
    """

    cell_rows = []
    for key in sorted(results["cells"]):
        cell = results["cells"][key]
        pipeline, preset = key.split("|", 1)
        cell_rows.append(
            f"<tr><td>{pipeline}</td><td>{preset}</td>"
            f"<td>{cell['runs']}</td><td>{_fmt(cell['ssr'])}</td>"
            f"<td>{_fmt(cell['mean_scan_score'])}</td>"
            f"<td>{_fmt(cell['p50_latency_s'], ' s')}</td>"
            f"<td>{_fmt(cell['p95_latency_s'], ' s')}</td>"
            f"<td>{cell['errors']}</td></tr>"
        )

    histogram = v2.get("repair_histogram") or {}
    histogram_row = " · ".join(
        f"{rung}: {histogram.get(rung, 0)}" for rung in REPAIR_RUNGS
    ) or "–"

    tiles = []
    for r in records:
        if r["error"]:
            body = f'<div class="thumb err">ERROR</div>'
            verdict = f'<span class="badge fail">error</span>'
        else:
            src = (
                f'data:image/jpeg;base64,{r["thumbnail_b64"]}'
                if r["thumbnail_b64"] else ""
            )
            body = (
                f'<img class="thumb" src="{src}" alt="output"/>'
                if src else '<div class="thumb err">no image</div>'
            )
            verdict = _badge(r["scan_verified"], "scans", "no scan")
        rung = r["repair_stage_used"]
        rung_tag = f'<span class="tag">{rung}</span>' if rung else ""
        hires_tag = (
            '<span class="tag warn">hires dropped</span>' if r["hires_dropped"] else ""
        )
        tiles.append(f"""
        <div class="tile">
          {body}
          <div class="meta">
            <div>{verdict} {rung_tag} {hires_tag}</div>
            <div class="dim">{r['pipeline']} · {r['preset']} · seed {r['seed']}</div>
            <div class="dim">score {_fmt(r['scan_score'])} · {_fmt(r['latency_s'], ' s')}</div>
            <div class="prompt" title="{r['prompt']}">{r['prompt'][:80]}</div>
          </div>
        </div>""")

    all_passed = results["gate_evaluation"]["all_passed"]
    banner_cls = "pass" if all_passed else "fail"
    banner_text = (
        "ALL PROMOTION GATES PASSED" if all_passed else "PROMOTION GATES NOT MET"
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>QR quality eval — plan 008</title>
<style>
  body {{ font: 14px/1.45 -apple-system, "Segoe UI", sans-serif; margin: 24px;
         color: #1a1a1a; background: #fafafa; }}
  h1 {{ font-size: 20px; }} h2 {{ font-size: 16px; margin-top: 28px; }}
  .banner {{ padding: 10px 14px; border-radius: 6px; font-weight: 700;
             display: inline-block; }}
  .banner.pass {{ background: #e2f6e5; color: #14652a; }}
  .banner.fail {{ background: #fde3e3; color: #8f1d1d; }}
  table {{ border-collapse: collapse; margin-top: 8px; }}
  th, td {{ border: 1px solid #ddd; padding: 5px 10px; text-align: left; }}
  th {{ background: #f0f0f0; }}
  .badge {{ padding: 1px 8px; border-radius: 10px; font-size: 12px;
            font-weight: 700; }}
  .badge.pass {{ background: #e2f6e5; color: #14652a; }}
  .badge.fail {{ background: #fde3e3; color: #8f1d1d; }}
  .badge.na {{ background: #eee; color: #666; }}
  .tag {{ background: #e8ecfd; color: #29418f; border-radius: 10px;
          padding: 1px 8px; font-size: 12px; }}
  .tag.warn {{ background: #fdf3dc; color: #7a5a12; }}
  .grid {{ display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; }}
  .tile {{ width: {THUMBNAIL_PX}px; background: #fff; border: 1px solid #ddd;
           border-radius: 6px; padding: 6px; }}
  .thumb {{ width: 100%; aspect-ratio: 1; object-fit: contain;
            background: #eee; display: block; }}
  .thumb.err {{ display: flex; align-items: center; justify-content: center;
                color: #8f1d1d; font-weight: 700; }}
  .meta {{ margin-top: 6px; }} .dim {{ color: #666; font-size: 12px; }}
  .prompt {{ font-size: 12px; overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; }}
</style>
</head>
<body>
<h1>QR quality eval — plan 008 (v2 pipeline)</h1>
<p class="dim">target: {results['target']} · generated {results['generated_at']} ·
qr_content: {results['qr_content']} · seeds: {results['seeds']} ·
strictness: {results['strictness']} ·
prompt_enhancement: {results.get('prompt_enhancement', False)}</p>
<p><span class="banner {banner_cls}">{banner_text}</span></p>

<h2>Promotion gate (plan 008 Phase 6)</h2>
<table>
  <tr><th>Gate</th><th>Measured</th><th>Verdict</th></tr>
  {gate_rows}
</table>

<h2>Cells (pipeline × preset)</h2>
<table>
  <tr><th>pipeline</th><th>preset</th><th>runs</th><th>SSR</th>
      <th>mean score</th><th>p50</th><th>p95</th><th>errors</th></tr>
  {''.join(cell_rows)}
</table>

<h2>v2 repair-rung histogram</h2>
<p>{histogram_row} · hires dropped: {v2.get('hires_dropped_count', 0)}</p>

<h2>Runs ({len(records)})</h2>
<div class="grid">
{''.join(tiles)}
</div>
</body>
</html>
"""


def write_outputs(results, records, out_dir):
    """Write results.json + report.html; returns their paths."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "results.json"
    report_path = out_dir / "report.html"
    payload = dict(results)
    payload["records"] = [
        {k: v for k, v in r.items() if k != "thumbnail_b64"} for r in records
    ]
    results_path.write_text(json.dumps(payload, indent=2))
    report_path.write_text(render_report(results, records))
    return results_path, report_path


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_matrix(target, cases, seeds, pipelines, qr_content):
    """Execute the full matrix, returning the record list."""
    records = []
    total = len(cases) * len(seeds) * len(pipelines)
    n = 0
    for preset, prompt in cases:
        for seed in seeds:
            for pipeline in pipelines:
                n += 1
                label = f"[{n}/{total}] {pipeline} · {preset} · seed {seed}"
                try:
                    image, metadata, latency = target.run(
                        pipeline, preset, prompt, seed, qr_content
                    )
                    record = build_record(
                        pipeline, preset, prompt, seed, image=image,
                        container_metadata=metadata, latency_s=latency,
                        qr_content=qr_content,
                    )
                    print(
                        f"{label}: verified={record['scan_verified']} "
                        f"score={record['scan_score']} "
                        f"rung={record['repair_stage_used']} {latency:.1f}s"
                    )
                except Exception as e:
                    record = build_record(
                        pipeline, preset, prompt, seed, error=str(e),
                        qr_content=qr_content,
                    )
                    print(f"{label}: ERROR {e}")
                records.append(record)
    return records


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", choices=["local", "staging"], required=True)
    parser.add_argument(
        "--url", default="http://localhost:8080",
        help="local ControlNet base URL (default: %(default)s)",
    )
    parser.add_argument(
        "--api-url", default=os.environ.get("EVAL_API_URL"),
        help="staging API base URL (or env EVAL_API_URL)",
    )
    parser.add_argument(
        "--prompts", default=str(EVAL_DIR / "prompts.txt"),
        help="prompt matrix file (default: %(default)s)",
    )
    parser.add_argument(
        "--out-dir", default=str(EVAL_DIR),
        help="where results.json/report.html go (default: %(default)s)",
    )
    parser.add_argument(
        "--pipelines", default=",".join(DEFAULT_PIPELINES),
        help="comma list of pipelines to run (default: %(default)s)",
    )
    parser.add_argument("--presets", default=None,
                        help="optional comma list filter of presets")
    parser.add_argument("--seeds", default=None,
                        help="optional comma list of seeds (overrides the file)")
    parser.add_argument("--limit", type=int, default=None,
                        help="only the first N prompts (smoke runs)")
    parser.add_argument("--timeout", type=float, default=600.0,
                        help="per-request timeout, seconds (staging: per-job)")
    parser.add_argument("--prompt-enhancement", action="store_true",
                        help="send prompt_enhancement:true on every request "
                             "(plan 009 A/B; default off keeps baselines intact)")
    args = parser.parse_args(argv)

    cases, qr_content, seeds = parse_prompts(args.prompts)
    if args.presets:
        wanted = {p.strip() for p in args.presets.split(",")}
        cases = [c for c in cases if c[0] in wanted]
    if args.limit:
        cases = cases[: args.limit]
    if args.seeds:
        seeds = [int(s) for s in args.seeds.split(",")]
    pipelines = [p.strip() for p in args.pipelines.split(",") if p.strip()]

    if args.target == "local":
        target = LocalTarget(args.url, timeout_s=args.timeout,
                             prompt_enhancement=args.prompt_enhancement)
    else:
        if not args.api_url:
            parser.error("--target staging needs --api-url (or env EVAL_API_URL)")
        target = StagingTarget(args.api_url, timeout_s=args.timeout,
                               prompt_enhancement=args.prompt_enhancement)

    if not scan_verifier.wechat_available():
        print(
            "WARNING: WeChat decoder unavailable (set WECHAT_MODEL_DIR); "
            "harness verification degrades to zxing-only"
        )

    print(
        f"Eval matrix: {len(cases)} prompts x {len(seeds)} seeds x "
        f"{pipelines} against {target.name} — {len(cases) * len(seeds) * len(pipelines)} runs"
    )
    records = run_matrix(target, cases, seeds, pipelines, qr_content)
    results = aggregate(records, target=target.name,
                        qr_content=qr_content, seeds=seeds,
                        prompt_enhancement=args.prompt_enhancement)
    results_path, report_path = write_outputs(results, records, args.out_dir)

    verdict = results["gate_evaluation"]
    print(f"\nresults: {results_path}\nreport:  {report_path}")
    print("gates:  ", json.dumps(verdict["checks"]))
    print("ALL GATES PASSED" if verdict["all_passed"] else "GATES NOT MET (see report)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
