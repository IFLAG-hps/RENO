"""LocalStack上でLambdaハンドラをHTTP APIとして起動する開発用サーバー。"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

import boto3

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("TABLE_NAME", "reno-localstack-test")
os.environ.setdefault("ASSET_BUCKET", "reno-localstack-assets")
os.environ.setdefault("TOKEN_SECRET", "localstack-test-secret-0123456789abcdef")
os.environ.setdefault("UNLIMITED_MODE", "false")
os.environ.setdefault("AWS_ENDPOINT_URL", "http://host.docker.internal:4566")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
import handler  # noqa: E402

ENDPOINT = os.environ["AWS_ENDPOINT_URL"]
REGION = os.environ["AWS_DEFAULT_REGION"]


def ensure_resources():
    dynamodb = boto3.resource("dynamodb", endpoint_url=ENDPOINT, region_name=REGION)
    client = dynamodb.meta.client
    if os.environ["TABLE_NAME"] not in client.list_tables().get("TableNames", []):
        client.create_table(
            TableName=os.environ["TABLE_NAME"],
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        dynamodb.Table(os.environ["TABLE_NAME"]).wait_until_exists()
    s3 = boto3.client("s3", endpoint_url=ENDPOINT, region_name=REGION)
    try:
        s3.head_bucket(Bucket=os.environ["ASSET_BUCKET"])
    except Exception:
        s3.create_bucket(Bucket=os.environ["ASSET_BUCKET"], CreateBucketConfiguration={"LocationConstraint": REGION})
    pin = os.environ.get("LOCAL_PIN", "1234")
    table = dynamodb.Table(os.environ["TABLE_NAME"])
    if not table.get_item(Key={"pk": "PIN#" + pin, "sk": "PIN"}).get("Item"):
        table.put_item(Item={"pk": "PIN#" + pin, "sk": "PIN", "label": "ローカル確認用", "uses": 0, "max_uses": 99, "expires_at": 4102444800})


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._write(handler.response(200, {"ok": True}))
        else:
            self._write(handler.response(404, {"error": "not found"}))

    def do_OPTIONS(self):
        self._write(handler.response(204, {}))

    def do_POST(self):
        if self.path != "/agent":
            self._write(handler.response(404, {"error": "not found"}))
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)
        try:
            body = raw_body.decode("utf-8")
        except UnicodeDecodeError:
            self._write(handler.response(400, {"error": "request must be UTF-8 JSON"}))
            return
        result = handler.lambda_handler({"body": body, "httpMethod": "POST"}, None)
        self._write(result)

    def _write(self, result):
        payload = result.get("body", json.dumps({"error": "empty response"})).encode("utf-8")
        self.send_response(result.get("statusCode", 500))
        for key, value in result.get("headers", {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        print("[local-api] " + format % args)


ensure_resources()
port = int(os.environ.get("PORT", "3000"))
print(f"RENO local API: http://0.0.0.0:{port}/agent", flush=True)
HTTPServer(("0.0.0.0", port), Handler).serve_forever()
