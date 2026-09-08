import json
import os
import sys
import time
import unittest
from urllib.request import urlopen

import boto3
from botocore.exceptions import ClientError


ENDPOINT = os.environ.get("AWS_ENDPOINT_URL", "http://127.0.0.1:4566")
TABLE_NAME = "reno-localstack-test"
BUCKET_NAME = "reno-localstack-assets"

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("TABLE_NAME", TABLE_NAME)
os.environ.setdefault("ASSET_BUCKET", BUCKET_NAME)
# CIでも同じ秘密鍵でトークンを検証できるよう、テストでは固定値を使う。
os.environ["TOKEN_SECRET"] = "localstack-test-secret-0123456789abcdef"
os.environ.setdefault("AWS_ENDPOINT_URL", ENDPOINT)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


class LocalStackHandlerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        deadline = time.time() + 180
        while time.time() < deadline:
            try:
                with urlopen(ENDPOINT + "/_localstack/health", timeout=2) as response:
                    if response.status == 200:
                        break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError("LocalStack did not become ready")

        cls.dynamodb = boto3.resource("dynamodb", endpoint_url=ENDPOINT, region_name="ap-northeast-1")
        cls.s3 = boto3.client("s3", endpoint_url=ENDPOINT, region_name="ap-northeast-1")
        if TABLE_NAME not in cls.dynamodb.meta.client.list_tables().get("TableNames", []):
            cls.dynamodb.create_table(
                TableName=TABLE_NAME,
                KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
                AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
                BillingMode="PAY_PER_REQUEST",
            )
        cls.dynamodb.Table(TABLE_NAME).wait_until_exists()
        try:
            cls.s3.head_bucket(Bucket=BUCKET_NAME)
        except ClientError:
            cls.s3.create_bucket(Bucket=BUCKET_NAME, CreateBucketConfiguration={"LocationConstraint": "ap-northeast-1"})

        import handler

        cls.handler = handler

    def setUp(self):
        # テスト順に依存しないよう、handlerのプロセス内状態を毎回初期化する。
        os.environ["TOKEN_SECRET"] = "localstack-test-secret-0123456789abcdef"
        self.handler.UNLIMITED_MODE = False

    def test_verify_pin_and_authenticated_usage(self):
        self.handler.save({
            "pk": "PIN#1234",
            "sk": "PIN",
            "label": "LocalStack test",
            "uses": 0,
            "max_uses": 1,
            "expires_at": int(time.time()) + 300,
        })
        verify_event = {"body": json.dumps({"type": "verify_pin", "pin": "1234"})}
        verified = self.handler.lambda_handler(verify_event, None)
        self.assertEqual(verified["statusCode"], 200)
        token = json.loads(verified["body"])["token"]

        usage_event = {"body": json.dumps({"type": "get_usage", "token": token})}
        usage = self.handler.lambda_handler(usage_event, None)
        self.assertEqual(usage["statusCode"], 200)
        self.assertEqual(json.loads(usage["body"])["limit"], 10)

    def test_unlimited_mode_reports_unlimited_and_ignores_limit(self):
        previous = self.handler.UNLIMITED_MODE
        try:
            self.handler.UNLIMITED_MODE = True
            token = self.handler.token_for("unlimited-test")
            usage = self.handler.lambda_handler({"body": json.dumps({"type": "get_usage", "token": token})}, None)
            payload = json.loads(usage["body"])
            self.assertEqual(usage["statusCode"], 200)
            self.assertEqual(payload["plan"], "unlimited")
            self.assertTrue(payload["unlimited"])
            self.assertIsNone(payload["remaining"])
        finally:
            self.handler.UNLIMITED_MODE = previous

    def test_chat_with_whitespace_openai_key_uses_local_fallback(self):
        previous_key = os.environ.get("OPENAI_API_KEY")
        try:
            os.environ["OPENAI_API_KEY"] = "   "
            token = self.handler.token_for("whitespace-key-test")
            result = self.handler.lambda_handler({"body": json.dumps({
                "type": "chat",
                "token": token,
                "messages": [{"role": "user", "content": "テスト"}],
            })}, None)
            self.assertEqual(result["statusCode"], 200)
            payload = json.loads(result["body"])
            self.assertIn("content", payload)
            self.assertEqual(payload["usage"]["count"], 1)
        finally:
            if previous_key is None:
                os.environ.pop("OPENAI_API_KEY", None)
            else:
                os.environ["OPENAI_API_KEY"] = previous_key

    def test_session_can_be_created_listed_reopened_and_extended(self):
        previous_key = os.environ.get("OPENAI_API_KEY")
        try:
            os.environ["OPENAI_API_KEY"] = "   "
            token = self.handler.token_for("session-history-test")
            create = self.handler.lambda_handler({"body": json.dumps({
                "type": "create_session",
                "token": token,
            })}, None)
            self.assertEqual(create["statusCode"], 201)
            session = json.loads(create["body"])["session"]
            self.assertEqual(session["status"], "active")
            session_id = session["sessionId"]

            chat = self.handler.lambda_handler({"body": json.dumps({
                "type": "chat",
                "token": token,
                "sessionId": session_id,
                "messages": [{"role": "user", "content": "浴室を相談したい"}],
            }, ensure_ascii=False)}, None)
            self.assertEqual(chat["statusCode"], 200)
            self.assertEqual(json.loads(chat["body"])["sessionId"], session_id)

            listed = self.handler.lambda_handler({"body": json.dumps({
                "type": "get_sessions",
                "token": token,
            })}, None)
            self.assertEqual(listed["statusCode"], 200)
            self.assertTrue(any(item["sessionId"] == session_id for item in json.loads(listed["body"])["sessions"]))

            reopened = self.handler.lambda_handler({"body": json.dumps({
                "type": "get_session",
                "token": token,
                "sessionId": session_id,
            })}, None)
            self.assertEqual(reopened["statusCode"], 200)
            messages = json.loads(reopened["body"])["session"]["messages"]
            self.assertEqual([message["role"] for message in messages], ["user", "assistant"])
            self.assertEqual(messages[0]["content"], "浴室を相談したい")
        finally:
            if previous_key is None:
                os.environ.pop("OPENAI_API_KEY", None)
            else:
                os.environ["OPENAI_API_KEY"] = previous_key

    def test_estimate_returns_server_side_cost_and_duration(self):
        previous_key = os.environ.get("OPENAI_API_KEY")
        try:
            os.environ["OPENAI_API_KEY"] = "   "
            token = self.handler.token_for("estimate-test")
            result = self.handler.lambda_handler({"body": json.dumps({
                "type": "estimate",
                "token": token,
                "size": "8",
                "items": ["floor", "wall"],
                "grade": "std",
            })}, None)
            self.assertEqual(result["statusCode"], 200)
            payload = json.loads(result["body"])
            self.assertEqual(payload["estimate"], {"low": 1170000, "high": 2280000})
            self.assertEqual(payload["duration"], {"low": 1, "high": 2})
            self.assertEqual(payload["subsidies"], [])
            self.assertEqual(payload["source"], "fallback")
            self.assertTrue(payload["warning"])
        finally:
            if previous_key is None:
                os.environ.pop("OPENAI_API_KEY", None)
            else:
                os.environ["OPENAI_API_KEY"] = previous_key

    def test_material_recommendation_exposes_fallback_state(self):
        previous_key = os.environ.get("OPENAI_API_KEY")
        try:
            os.environ["OPENAI_API_KEY"] = "   "
            token = self.handler.token_for("material-recommendation-test")
            result = self.handler.lambda_handler({"body": json.dumps({
                "type": "material_recommendation",
                "token": token,
                "selected_key": "composite",
                "catalog": [{"key": "composite", "name": "複合フローリング", "pros": [], "cons": []}],
                "context": [],
            }, ensure_ascii=False)}, None)
            self.assertEqual(result["statusCode"], 200)
            payload = json.loads(result["body"])
            self.assertEqual(payload["source"], "fallback")
            self.assertTrue(payload["warning"])
            self.assertEqual(payload["recommendations"][0]["key"], "composite")
        finally:
            if previous_key is None:
                os.environ.pop("OPENAI_API_KEY", None)
            else:
                os.environ["OPENAI_API_KEY"] = previous_key

    def test_generated_tokens_are_stable(self):
        for index in range(100):
            token = self.handler.token_for(f"token-roundtrip-{index}")
            subject = self.handler.subject_from_token(token)
            self.assertIsNotNone(subject)
            self.assertEqual(subject["sub"], f"token-roundtrip-{index}")


if __name__ == "__main__":
    unittest.main()
