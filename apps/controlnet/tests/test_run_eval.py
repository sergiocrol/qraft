"""CPU smoke tests for ``eval/run_eval.py`` (plan 008 Phase 6).

Feeds the harness FAKE in-memory records (no network, no container) and
checks the whole reporting path: record building (with the real CPU
verifier), aggregation math (SSR per cell, mean score, nearest-rank
percentiles, repair-rung histogram), the promotion-gate evaluation, and the
results.json + report.html artifacts (self-contained, gate thresholds
stated). Also pins the torch-free constraint and the request-body shapes for
both targets.

Run: cd apps/controlnet && python3 -m pytest tests/test_run_eval.py -q
"""

import importlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

CONTROLNET_DIR = Path(__file__).resolve().parent.parent
EVAL_PATH = CONTROLNET_DIR / "eval" / "run_eval.py"


def _load_run_eval():
    spec = importlib.util.spec_from_file_location("run_eval", EVAL_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # registers the app package stub itself
    return module


run_eval = _load_run_eval()
qr_canonical = importlib.import_module("app.utils.qr_canonical")

CONTENT = "https://qraft.ai/e2e"


@pytest.fixture(scope="module")
def canonical_image():
    return qr_canonical.render_canonical_qr(CONTENT).image


GRAY = Image.new("RGB", (768, 768), (128, 128, 128))


def _fake_records(canonical_image):
    """Deterministic fixture: 2 v1 runs (1 scans), 2 v2 runs (both scan,
    one repaired + hires-dropped), 1 v2 error run."""
    records = [
        run_eval.build_record(
            "v1", "none", "a fox", 1001, image=canonical_image,
            latency_s=30.0, qr_content=CONTENT,
        ),
        run_eval.build_record(
            "v1", "none", "a fox", 2002, image=GRAY,
            latency_s=50.0, qr_content=CONTENT,
        ),
        run_eval.build_record(
            "v2", "none", "a fox", 1001, image=canonical_image,
            container_metadata={
                "scan_verified": True, "repair_stage_used": None,
                "hires_dropped": False,
            },
            latency_s=60.0, qr_content=CONTENT,
        ),
        run_eval.build_record(
            "v2", "none", "a fox", 2002, image=canonical_image,
            container_metadata={
                "scan_verified": True, "repair_stage_used": "module_blend",
                "hires_dropped": True,
            },
            latency_s=100.0, qr_content=CONTENT,
        ),
        run_eval.build_record(
            "v2", "none", "a fox", 3003, error="boom", qr_content=CONTENT,
        ),
    ]
    return records


class TestHarnessBasics:
    def test_run_eval_never_imports_torch(self):
        import ast

        tree = ast.parse(EVAL_PATH.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                roots = {(node.module or "").split(".")[0]}
            else:
                continue
            assert "torch" not in roots
            assert "diffusers" not in roots

    def test_parse_prompts_reads_the_real_matrix(self):
        cases, qr_content, seeds = run_eval.parse_prompts(
            CONTROLNET_DIR / "eval" / "prompts.txt"
        )
        assert len(cases) == 20
        assert qr_content == CONTENT
        assert seeds == [1001, 2002, 3003]
        presets = {preset for preset, _ in cases}
        assert presets <= {
            "illustration", "photo", "cyberpunk", "watercolor",
            "architecture", "none",
        }

    def test_percentile_is_nearest_rank(self):
        values = list(range(1, 11))
        assert run_eval.percentile(values, 50) == 5
        assert run_eval.percentile(values, 95) == 10
        assert run_eval.percentile([], 95) is None

    def test_request_bodies_for_both_targets(self):
        v1 = run_eval.build_request_body("v1", "none", "p", 7, CONTENT)
        assert "pipeline" not in v1  # exact v1 behavior when absent
        assert v1["base_qr_code"][0].startswith("data:image/png;base64,")
        assert v1["num_images_per_prompt"] == 1 and v1["seed"] == 7

        v2 = run_eval.build_request_body("v2", "photo", "p", 7, CONTENT)
        assert v2["pipeline"] == "v2"
        assert v2["qr_content"] == CONTENT
        assert v2["style_preset"] == "photo"
        assert v2["scan_strictness"] == "standard"

        camel = run_eval.build_request_body("v2", "photo", "p", 7, CONTENT, camel=True)
        assert camel["qrContent"] == CONTENT
        assert camel["stylePreset"] == "photo"
        assert camel["baseQrCode"][0].startswith("data:image/png;base64,")
        assert camel["environment"] == "staging"

    def test_prompt_enhancement_flag_in_request_bodies(self):
        # Default off keeps baseline bodies byte-identical (plan 009).
        assert "prompt_enhancement" not in run_eval.build_request_body(
            "v1", "none", "p", 7, CONTENT)
        assert "promptEnhancement" not in run_eval.build_request_body(
            "v1", "none", "p", 7, CONTENT, camel=True)

        snake = run_eval.build_request_body(
            "v2", "photo", "p", 7, CONTENT, prompt_enhancement=True)
        assert snake["prompt_enhancement"] is True

        camel = run_eval.build_request_body(
            "v1", "none", "p", 7, CONTENT, camel=True, prompt_enhancement=True)
        assert camel["promptEnhancement"] is True
        assert "prompt_enhancement" not in camel


class TestAggregation:
    def test_records_verify_with_the_real_cpu_verifier(self, canonical_image):
        records = _fake_records(canonical_image)
        assert records[0]["scan_verified"] is True
        assert records[0]["scan_score"] > 0
        assert records[1]["scan_verified"] is False
        assert records[4]["error"] == "boom"
        assert records[4]["scan_verified"] is None
        assert records[3]["repair_stage_used"] == "module_blend"
        assert records[3]["hires_dropped"] is True
        assert records[0]["thumbnail_b64"]  # inline thumbnail present

    def test_aggregate_math_and_gates(self, canonical_image):
        results = run_eval.aggregate(
            _fake_records(canonical_image), target="fake",
            qr_content=CONTENT, seeds=[1001, 2002, 3003],
        )

        v1_cell = results["cells"]["v1|none"]
        assert v1_cell["runs"] == 2
        assert v1_cell["ssr"] == 0.5  # 1 of 2 scans
        assert v1_cell["p50_latency_s"] == 30.0
        assert v1_cell["p95_latency_s"] == 50.0

        v2 = results["pipelines"]["v2"]
        assert v2["runs"] == 3 and v2["errors"] == 1
        assert v2["ssr"] == 1.0  # errors excluded from the denominator
        assert v2["repair_histogram"] == {
            "none": 1, "module_blend": 1, "latent_srpg": 0, "reroll": 0,
        }
        assert v2["hires_dropped_count"] == 1

        checks = results["gate_evaluation"]["checks"]
        assert checks["v2_ssr_min"] is True          # 1.0 >= 0.95
        assert checks["v2_ssr_above_v1"] is True     # 1.0 > 0.5
        assert checks["p95_latency_max_s"] is True   # 100s <= 150s
        assert checks["v2_mean_scan_score_min"] is True
        assert results["gate_evaluation"]["all_passed"] is True

    def test_gates_fail_when_v2_does_not_scan(self):
        records = [
            run_eval.build_record(
                "v2", "none", "a fox", 1001, image=GRAY,
                latency_s=200.0, qr_content=CONTENT,
            ),
        ]
        results = run_eval.aggregate(records, target="fake",
                                     qr_content=CONTENT, seeds=[1001])
        checks = results["gate_evaluation"]["checks"]
        assert checks["v2_ssr_min"] is False
        assert checks["p95_latency_max_s"] is False  # 200s > 150s
        assert results["gate_evaluation"]["all_passed"] is False


class TestArtifacts:
    def test_writes_results_json_and_self_contained_report(
            self, canonical_image, tmp_path):
        records = _fake_records(canonical_image)
        results = run_eval.aggregate(records, target="fake",
                                     qr_content=CONTENT, seeds=[1001, 2002, 3003])
        results_path, report_path = run_eval.write_outputs(
            results, records, tmp_path
        )

        assert results_path.name == "results.json"
        payload = json.loads(results_path.read_text())
        assert payload["gate_evaluation"]["all_passed"] is True
        assert payload["cells"]["v2|none"]["runs"] == 3
        assert len(payload["records"]) == 5
        # Thumbnails live in the HTML, not the JSON.
        assert all("thumbnail_b64" not in r for r in payload["records"])

        html = report_path.read_text()
        # Gate thresholds stated so the operator sees pass/fail at a glance.
        assert "95%" in html
        assert "0.6" in html
        assert "150" in html
        assert "ALL PROMOTION GATES PASSED" in html
        assert "module_blend: 1" in html
        # Self-contained: inline thumbnails, no external resources.
        assert "data:image/jpeg;base64," in html
        assert 'src="http' not in html
        assert 'href="http' not in html
        assert "<script" not in html
        assert "<link" not in html

    def test_report_shows_failure_banner(self, tmp_path):
        records = [
            run_eval.build_record(
                "v2", "none", "a fox", 1001, image=GRAY,
                latency_s=10.0, qr_content=CONTENT,
            ),
            run_eval.build_record(
                "v2", "none", "a fox", 2002, error="boom", qr_content=CONTENT,
            ),
        ]
        results = run_eval.aggregate(records, target="fake",
                                     qr_content=CONTENT, seeds=[1001, 2002])
        _, report_path = run_eval.write_outputs(results, records, tmp_path)
        html = report_path.read_text()
        assert "PROMOTION GATES NOT MET" in html
        assert "ERROR" in html  # the errored run renders as an error tile
