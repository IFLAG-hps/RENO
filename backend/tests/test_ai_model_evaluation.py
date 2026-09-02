"""画像診断AIモデル比較テストのひな形。

初期状態は外部APIを呼ばないモック実行です。実APIへ接続する場合は、
同じインターフェースのクライアントを差し替え、費用上限を設定してください。
"""

import json
import math
import os
import statistics
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MODELS = {
    "luna": {"model_id": "gpt-5.6-luna", "input_usd_per_million": 0.20, "output_usd_per_million": 1.20},
    "sol": {"model_id": "gpt-5.6-sol", "input_usd_per_million": 4.00, "output_usd_per_million": 20.00},
    "nano": {"model_id": "gpt-5.4-nano", "input_usd_per_million": 0.20, "output_usd_per_million": 1.25},
}

USD_JPY = 150
REQUIRED_FIELDS = {"room", "areas"}
# TODO: 本番検証では、material-catalog-db.mdで定義した検索API／DBから取得する。
CATALOG_KEYS = {"floor-001", "wall-001", "window-001"}


@dataclass
class ModelResponse:
    model: str
    output: dict[str, Any]
    input_tokens: int
    output_tokens: int
    latency_ms: float
    error: str | None = None

    @property
    def estimated_cost_jpy(self) -> float:
        price = MODELS[self.model]
        usd = (self.input_tokens * price["input_usd_per_million"] + self.output_tokens * price["output_usd_per_million"]) / 1_000_000
        return usd * USD_JPY


class MockModelClient:
    """実APIクライアントと置換可能な決定的モック。"""

    def run(self, model: str, case: dict[str, Any]) -> ModelResponse:
        started = time.perf_counter()
        output = {
            "room": case["expected_room"],
            "areas": [{
                "name": case["area"],
                "issue": case["expected_issue"],
                "severity": case["expected_severity"],
                "recommendation": "登録済み素材を確認",
                "material_key": case["expected_material_key"],
            }],
        }
        # モックでもモデルごとの相対速度を測定結果として再現する。
        time.sleep({"luna": 0.001, "sol": 0.003, "nano": 0.0005}[model])
        return ModelResponse(model, output, case["input_tokens"], case["output_tokens"], (time.perf_counter() - started) * 1000)


def load_cases() -> list[dict[str, Any]]:
    fixture = Path(__file__).parent / "fixtures" / "ai_model_cases.json"
    with fixture.open(encoding="utf-8") as stream:
        return json.load(stream)


def validate_output(output: dict[str, Any]) -> list[str]:
    errors = []
    errors.extend(f"missing:{field}" for field in REQUIRED_FIELDS if field not in output)
    for area in output.get("areas", []):
        if area.get("material_key") not in CATALOG_KEYS:
            errors.append("material_key_not_registered")
    return errors


class AIModelEvaluationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = MockModelClient()
        cls.cases = load_cases()
        cls.results: list[ModelResponse] = []

    def test_all_models_return_schema_valid_registered_material(self):
        for model in MODELS:
            for case in self.cases:
                response = self.client.run(model, case)
                self.__class__.results.append(response)
                self.assertEqual(validate_output(response.output), [], f"{model}/{case['id']}")

    def test_unknown_material_is_rejected(self):
        output = {"room": "living", "areas": [{"material_key": "hallucinated-material"}]}
        self.assertIn("material_key_not_registered", validate_output(output))

    def test_report_contains_cost_and_latency_metrics(self):
        results = [self.client.run(model, case) for model in MODELS for case in self.cases]
        report = {}
        for model in MODELS:
            rows = [item for item in results if item.model == model]
            report[model] = {
                "model_id": MODELS[model]["model_id"],
                "cases": len(rows),
                "estimated_cost_jpy": round(sum(item.estimated_cost_jpy for item in rows), 2),
                "average_latency_ms": round(statistics.mean(item.latency_ms for item in rows), 2),
                "p95_latency_ms": round(sorted(item.latency_ms for item in rows)[max(0, math.ceil(len(rows) * 0.95) - 1)], 2),
            }
        self.assertEqual(set(report), set(MODELS))
        self.assertTrue(all(row["estimated_cost_jpy"] >= 0 for row in report.values()))

        output_path = Path(os.environ.get("AI_EVAL_REPORT", Path(__file__).parents[2] / "test-results" / "ai-model-evaluation.json"))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps({"mode": "mock", "models": report}, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    unittest.main(verbosity=2)
