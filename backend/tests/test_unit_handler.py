"""Unit tests for handler logic without AWS or OpenAI network access."""

import importlib
import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch


os.environ.setdefault("TABLE_NAME", "unit-test-table")
os.environ.setdefault("ASSET_BUCKET", "unit-test-bucket")
os.environ.setdefault("TOKEN_SECRET", "unit-test-secret-0123456789abcdef")
os.environ.setdefault("OPENAI_API_KEY", "")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


class HandlerUnitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.table = MagicMock()
        resource = MagicMock()
        resource.Table.return_value = cls.table
        with patch("boto3.resource", return_value=resource), patch("boto3.client", return_value=MagicMock()):
            sys.modules.pop("handler", None)
            cls.handler = importlib.import_module("handler")

    def setUp(self):
        self.handler._ESTIMATE_CACHE.clear()
        self.handler.UNLIMITED_MODE = False
        self.handler.TABLE.reset_mock()
        os.environ["OPENAI_API_KEY"] = ""

    def test_response_serializes_json_and_exposes_cors_headers(self):
        result = self.handler.response(201, {"ok": True})

        self.assertEqual(result["statusCode"], 201)
        self.assertEqual(json.loads(result["body"]), {"ok": True})
        self.assertEqual(result["headers"]["Access-Control-Allow-Origin"], "*")

    def test_signed_token_round_trip_and_tamper_rejection(self):
        token = self.handler.token_for("user-123", "admin")

        self.assertEqual(self.handler.subject_from_token(token)["sub"], "user-123")
        self.assertEqual(self.handler.subject_from_token(token)["role"], "admin")
        payload, signature = token.split(".")
        tampered = payload + "." + ("A" if signature[0] != "A" else "B") + signature[1:]
        self.assertIsNone(self.handler.subject_from_token(tampered))

    def test_safe_filename_removes_paths_and_unsafe_characters(self):
        self.assertEqual(self.handler.safe_filename("../../room photo?.png"), "roomphoto.png")
        self.assertEqual(self.handler.safe_filename(""), "image.jpg")

    def test_estimate_rejects_invalid_conditions_and_deduplicates_items(self):
        user = {"sub": "unit-user", "role": "guest"}

        self.assertEqual(self.handler.estimate({"size": "99", "items": ["floor"]}, user)["error"], "invalid estimate condition")
        self.assertEqual(self.handler.estimate({"size": "8", "items": []}, user)["error"], "at least one valid estimate item is required")
        result = self.handler.estimate({"size": "8", "items": ["floor", "floor"], "grade": "eco"}, user)

        self.assertEqual(result["conditions"], {"size": "8", "items": ["floor"], "grade": "eco"})
        self.assertEqual(result["source"], "fallback")
        self.assertIn("warning", result)

    def test_material_recommendation_requires_selected_catalog_item(self):
        user = {"sub": "unit-user", "role": "guest"}

        self.assertEqual(self.handler.material_recommendation({}, user)["error"], "material catalog is required")
        result = self.handler.material_recommendation({"selected_key": "floor", "catalog": [{"key": "wall"}]}, user)
        self.assertEqual(result["error"], "invalid material key")

        result = self.handler.material_recommendation({"selected_key": "floor", "catalog": [{"key": "floor"}]}, user)
        self.assertEqual(result["source"], "fallback")
        self.assertEqual(result["recommendations"][0]["key"], "floor")

    def test_chat_stops_at_usage_limit_before_saving(self):
        user = {"sub": "unit-user", "role": "guest"}
        with patch.object(self.handler, "query_user", return_value=[{}] * self.handler.USAGE_LIMIT), patch.object(self.handler, "save_chat_turn") as save_turn:
            result = self.handler.chat({"messages": [{"role": "user", "content": "hello"}]}, user, "session-1")

        self.assertEqual(result["error"], "usage limit reached")
        save_turn.assert_not_called()

    def test_lambda_handler_handles_options_and_unauthorized_requests(self):
        options = self.handler.lambda_handler({"httpMethod": "OPTIONS"}, None)
        unauthorized = self.handler.lambda_handler({"body": json.dumps({"type": "get_usage"})}, None)

        self.assertEqual(options["statusCode"], 204)
        self.assertEqual(unauthorized["statusCode"], 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
