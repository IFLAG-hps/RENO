"""RENO MVP APIのエントリーポイント。"""
import base64, hashlib, hmac, json, os, posixpath, time, uuid
from collections import OrderedDict
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import boto3
from boto3.dynamodb.conditions import Attr, Key

AWS_ENDPOINT_URL = os.environ.get("AWS_ENDPOINT_URL")
TABLE = boto3.resource("dynamodb", endpoint_url=AWS_ENDPOINT_URL).Table(os.environ["TABLE_NAME"])
S3 = boto3.client("s3", endpoint_url=AWS_ENDPOINT_URL)
SQS = boto3.client("sqs", endpoint_url=AWS_ENDPOINT_URL)
SES = boto3.client("ses", endpoint_url=AWS_ENDPOINT_URL)
COGNITO = boto3.client("cognito-idp", endpoint_url=AWS_ENDPOINT_URL)
USAGE_LIMIT = 10
UNLIMITED_MODE = os.environ.get("UNLIMITED_MODE", "false").strip().lower() == "true"
MAX_INPUT_MESSAGES = 20
MAX_MESSAGE_CHARS = 4000
MAX_SYSTEM_CHARS = 8000
MAX_OUTPUT_TOKENS = 500

ESTIMATE_SIZES = {"6": 10, "8": 13, "10": 16, "12": 20}
ESTIMATE_ITEMS = {
    "floor": {"base": (8, 15), "unit": "m2", "weeks": (1, 2)},
    "wall": {"base": (1, 2.5), "unit": "m2", "weeks": (1, 2)},
    "kitchen": {"base": (60, 180), "unit": "flat", "weeks": (2, 3)},
    "bath": {"base": (60, 150), "unit": "flat", "weeks": (2, 3)},
    "toilet": {"base": (15, 50), "unit": "flat", "weeks": (1, 2)},
    "wash": {"base": (15, 50), "unit": "flat", "weeks": (1, 2)},
    "light": {"base": (8, 30), "unit": "flat", "weeks": (1, 1)},
    "storage": {"base": (15, 60), "unit": "flat", "weeks": (1, 2)},
}
ESTIMATE_GRADES = {"eco": 0.75, "std": 1.0, "pre": 1.5}
with open(os.path.join(os.path.dirname(__file__), "data", "subsidies.json"), encoding="utf-8") as subsidy_file:
    SUBSIDY_PROGRAMS = json.load(subsidy_file)
ESTIMATE_CACHE_TTL_SECONDS = 1800
ESTIMATE_CACHE_MAX_ENTRIES = 256
_ESTIMATE_CACHE = OrderedDict()


def response(status, body):
    return {"statusCode": status, "headers": {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
    }, "body": json.dumps(body, ensure_ascii=False, default=str)}


def token_for(subject, role="guest"):
    payload = json.dumps({"sub": subject, "role": role, "exp": int(time.time()) + 7 * 86400}, separators=(",", ":")).encode()
    sig = hmac.new(os.environ["TOKEN_SECRET"].encode(), payload, hashlib.sha256).digest()
    # payloadと署名を分離してエンコードし、署名中の`.`を区切り文字と誤認しない。
    encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip("=")
    return encode(payload) + "." + encode(sig)


def subject_from_token(token):
    try:
        if not isinstance(token, str): return None
        if "." in token:
            payload_token, signature_token = token.split(".", 1)
            payload = base64.urlsafe_b64decode(payload_token + "=" * (-len(payload_token) % 4))
            signature = base64.urlsafe_b64decode(signature_token + "=" * (-len(signature_token) % 4))
        else:
            # 旧形式（payload + b"." + signatureをまとめてBase64化）も許容する。
            raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
            payload, signature = raw.rsplit(b".", 1)
        expected = hmac.new(os.environ["TOKEN_SECRET"].encode(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected): return None
        data = json.loads(payload)
        return data if data.get("exp", 0) > time.time() and data.get("sub") else None
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def save(item):
    TABLE.put_item(Item=item)
    return item


def query_user(user, prefix):
    result = TABLE.query(KeyConditionExpression=Key("pk").eq("USER#" + user["sub"]) & Key("sk").begins_with(prefix), ScanIndexForward=False)
    return result.get("Items", [])


def session_key(session_id):
    return "SESSION#" + str(session_id)


def message_prefix(session_id):
    return "SESSION#" + str(session_id) + "#MESSAGE#"


def session_item(user, session_id):
    return TABLE.get_item(Key={"pk": "USER#" + user["sub"], "sk": session_key(session_id)}).get("Item")


def public_session(item):
    return {
        "sessionId": item.get("session_id"),
        "status": item.get("status", "active"),
        "title": item.get("title", "新しいチャット"),
        "createdAt": item.get("created_at"),
        "updatedAt": item.get("updated_at"),
        "lastMessageAt": item.get("last_message_at"),
        "messageCount": item.get("message_count", 0),
        "handoffStatus": item.get("handoff_status", "not_requested"),
        "schemaVersion": item.get("schema_version", 1),
    }


def create_session(user):
    now = int(time.time())
    session_id = str(uuid.uuid4())
    item = {
        "pk": "USER#" + user["sub"],
        "sk": session_key(session_id),
        "session_id": session_id,
        "status": "active",
        "message_count": 0,
        "handoff_status": "not_requested",
        "created_at": now,
        "updated_at": now,
        "schema_version": 1,
    }
    save(item)
    return public_session(item)


def list_sessions(user):
    sessions = [item for item in query_user(user, "SESSION#") if item.get("session_id") and "#MESSAGE#" not in item.get("sk", "")]
    sessions.sort(key=lambda item: item.get("updated_at", item.get("created_at", 0)), reverse=True)
    return [public_session(item) for item in sessions]


def get_session_detail(user, session_id):
    item = session_item(user, session_id)
    if not item:
        return None
    result = TABLE.query(
        KeyConditionExpression=Key("pk").eq("USER#" + user["sub"]) & Key("sk").begins_with(message_prefix(session_id)),
        ScanIndexForward=True,
    )
    messages = [{"role": message.get("role"), "content": message.get("content", "")} for message in result.get("Items", [])]
    photos = [photo for photo in query_user(user, "PHOTO#") if photo.get("session_id") == session_id]
    for photo in photos:
        photo["download_url"] = signed_download_url(photo["s3_key"])
    return {**public_session(item), "messages": messages, "photos": photos}


def save_chat_turn(user, session_id, user_message, assistant_message):
    now = int(time.time())
    item = {
        "pk": "USER#" + user["sub"],
        "sk": message_prefix(session_id) + str(time.time_ns()),
        "session_id": session_id,
        "role": "user",
        "content": user_message,
        "created_at": now,
        "schema_version": 1,
    }
    save(item)
    assistant_item = {
        "pk": item["pk"],
        "sk": message_prefix(session_id) + str(time.time_ns()),
        "session_id": session_id,
        "role": "assistant",
        "content": assistant_message,
        "created_at": now,
        "schema_version": 1,
    }
    save(assistant_item)
    title = user_message[:80] or "新しいチャット"
    TABLE.update_item(
        Key={"pk": item["pk"], "sk": session_key(session_id)},
        UpdateExpression="SET updated_at = :now, last_message_at = :now, message_count = if_not_exists(message_count, :zero) + :two, title = if_not_exists(title, :title)",
        ExpressionAttributeValues={":now": now, ":zero": 0, ":two": 2, ":title": title},
    )


def is_unlimited_user(user):
    """Unlimited mode is available only to an authenticated admin account."""
    return UNLIMITED_MODE and isinstance(user, dict) and user.get("role") == "admin"


def usage(user):
    count = len(query_user(user, "CHAT#"))
    unlimited = is_unlimited_user(user)
    return {"plan": "unlimited" if unlimited else "standard", "count": count, "limit": USAGE_LIMIT, "remaining": None if unlimited else max(0, USAGE_LIMIT - count), "unlimited": unlimited}


def safe_filename(name):
    name = posixpath.basename(str(name or "image.jpg")).replace("\\", "_")
    return "".join(c for c in name if c.isalnum() or c in "._-")[:120] or "image.jpg"


ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_ROOM_TYPES = {"リビング", "キッチン", "浴室・洗面所", "寝室", "玄関"}


def owned_upload_key(user, key):
    return isinstance(key, str) and key.startswith(f"uploads/{user['sub']}/")


def owned_proposal_key(user, key):
    return isinstance(key, str) and key.startswith(f"proposals/{user['sub']}/")


def signed_download_url(key):
    return S3.generate_presigned_url("get_object", Params={"Bucket": os.environ["ASSET_BUCKET"], "Key": key}, ExpiresIn=900)


def image_data_url(key):
    obj = S3.get_object(Bucket=os.environ["ASSET_BUCKET"], Key=key)
    content_type = obj.get("ContentType", "image/jpeg")
    image_bytes = obj["Body"].read()
    return f"data:{content_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"


def _multipart_field(boundary, name, value):
    return (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").encode()


def _multipart_file(boundary, name, filename, content_type, value):
    header = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n").encode()
    return header + value + b"\r\n"


def process_image_generation(body, user, job_id=None):
    session_id = str(body.get("sessionId", "")).strip()
    source_key = str(body.get("sourceImageKey", "")).strip()
    prompt = str(body.get("prompt", "")).strip()[:5000]
    context = body.get("context", [])
    if not session_id or not session_item(user, session_id): return {"error": "session not found"}
    if not source_key or not owned_upload_key(user, source_key): return {"error": "forbidden photo key"}
    try:
        source = S3.get_object(Bucket=os.environ["ASSET_BUCKET"], Key=source_key)
        source_bytes = source["Body"].read()
        source_type = source.get("ContentType", "image/jpeg")
    except Exception as exc:
        print(json.dumps({"s3_generation_error": str(exc)}, ensure_ascii=False))
        return {"error": "uploaded object not found"}
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key: return {"error": "AI service is not configured"}
    context_text = json.dumps(context[-20:] if isinstance(context, list) else [], ensure_ascii=False)[:16000]
    instruction = (
        "Create a low-quality but clearly understandable renovation-after image based on the input room photo. "
        "Preserve the existing floor plan, windows, doors, camera viewpoint, room proportions and visible structure. "
        "Change only flooring, wallpaper, fixtures, colors, materials, or style explicitly requested by the user. "
        "Do not invent details that are not visible in the source photo. This is a conceptual finished-image preview, not a construction drawing.\n"
        f"Requested changes: {prompt or 'Use the confirmed renovation preferences from the conversation.'}\n"
        f"Conversation and flow context: {context_text}"
    )
    boundary = "----reno-image-" + uuid.uuid4().hex
    payload = b"".join([
        _multipart_field(boundary, "model", os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-1")),
        _multipart_field(boundary, "prompt", instruction),
        _multipart_field(boundary, "size", "1024x1024"),
        _multipart_field(boundary, "quality", "low"),
        _multipart_file(boundary, "image", "source.jpg", source_type, source_bytes),
        f"--{boundary}--\r\n".encode(),
    ])
    request = Request("https://api.openai.com/v1/images/edits", data=payload,
                      headers={"Authorization": f"Bearer {api_key}", "Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    try:
        with urlopen(request, timeout=120) as result: result_payload = json.loads(result.read())
        generated = (result_payload.get("data") or [{}])[0]
        encoded = generated.get("b64_json")
        if not encoded:
            print(json.dumps({"image_generation_validation_failed": True, "response_keys": sorted(result_payload.keys())}, ensure_ascii=False))
            return {"error": "AI image generation returned no image"}
        image_bytes = base64.b64decode(encoded)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        print(json.dumps({"openai_image_generation_error": f"HTTP {exc.code}", "detail": detail}, ensure_ascii=False))
        return {"error": "AI image service is temporarily unavailable"}
    except (URLError, TimeoutError, ValueError, json.JSONDecodeError, base64.binascii.Error) as exc:
        print(json.dumps({"openai_image_generation_error": str(exc)}, ensure_ascii=False))
        return {"error": "AI image service is temporarily unavailable"}
    image_id = str(uuid.uuid4())
    generated_key = f"generated/{user['sub']}/{session_id}/{image_id}.png"
    S3.put_object(Bucket=os.environ["ASSET_BUCKET"], Key=generated_key, Body=image_bytes, ContentType="image/png")
    now = int(time.time())
    save({"pk": "USER#" + user["sub"], "sk": "GENERATED#" + image_id, "id": image_id, "session_id": session_id,
          "s3_key": generated_key, "content_type": "image/png", "source_image_key": source_key,
          "prompt": prompt, "created_at": now, "schema_version": 1})
    print(json.dumps({"image_generation_completed": True, "image_id": image_id, "session_id": session_id}, ensure_ascii=False))
    return {"sessionId": session_id, "image": {"id": image_id, "key": generated_key, "downloadUrl": signed_download_url(generated_key), "contentType": "image/png", "createdAt": now}, "usage": usage(user)}


def generate_image(body, user):
    """生成をキューへ登録し、API Gatewayの同期待ち時間を短くする。"""
    session_id = str(body.get("sessionId", "")).strip()
    source_key = str(body.get("sourceImageKey", "")).strip()
    if not session_id or not session_item(user, session_id): return {"error": "session not found"}
    if not source_key or not owned_upload_key(user, source_key): return {"error": "forbidden photo key"}
    if not os.environ.get("OPENAI_API_KEY", "").strip(): return {"error": "AI service is not configured"}
    queue_url = os.environ.get("IMAGE_GENERATION_QUEUE_URL", "").strip()
    if not queue_url: return {"error": "AI image queue is not configured"}
    job_id = str(uuid.uuid4())
    now = int(time.time())
    item = {"pk": "USER#" + user["sub"], "sk": "IMAGE_JOB#" + job_id, "job_id": job_id,
            "session_id": session_id, "status": "queued", "created_at": now, "updated_at": now,
            "schema_version": 1}
    save(item)
    message = {"jobId": job_id, "userSub": user["sub"], "sessionId": session_id,
               "sourceImageKey": source_key, "prompt": str(body.get("prompt", "")).strip()[:5000],
               "context": body.get("context", [])}
    try:
        SQS.send_message(QueueUrl=queue_url, MessageBody=json.dumps(message, ensure_ascii=False))
    except Exception as exc:
        TABLE.update_item(Key={"pk": item["pk"], "sk": item["sk"]},
                          UpdateExpression="SET #status = :status, error = :error, updated_at = :now",
                          ExpressionAttributeNames={"#status": "status"},
                          ExpressionAttributeValues={":status": "failed", ":error": "queue unavailable", ":now": int(time.time())})
        print(json.dumps({"image_generation_queue_error": str(exc)}, ensure_ascii=False))
        return {"error": "AI image queue is temporarily unavailable"}
    print(json.dumps({"image_generation_queued": True, "job_id": job_id, "session_id": session_id}, ensure_ascii=False))
    return {"jobId": job_id, "status": "queued", "sessionId": session_id}


def image_generation_status(body, user):
    job_id = str(body.get("jobId", "")).strip()
    if not job_id: return {"error": "jobId is required"}
    item = TABLE.get_item(Key={"pk": "USER#" + user["sub"], "sk": "IMAGE_JOB#" + job_id}).get("Item")
    if not item: return {"error": "image generation job not found"}
    result = {"jobId": job_id, "status": item.get("status", "queued"), "sessionId": item.get("session_id")}
    if item.get("status") == "completed": result["image"] = item.get("image")
    if item.get("status") == "failed": result["error"] = item.get("error", "AI image generation failed")
    return result


def image_generation_worker(event):
    for record in event.get("Records", []):
        message = json.loads(record.get("body", "{}"))
        job_id = str(message.get("jobId", "")).strip()
        user = {"sub": str(message.get("userSub", "")).strip()}
        if not job_id or not user["sub"]: continue
        key = {"pk": "USER#" + user["sub"], "sk": "IMAGE_JOB#" + job_id}
        TABLE.update_item(Key=key, UpdateExpression="SET #status = :status, updated_at = :now",
                          ExpressionAttributeNames={"#status": "status"}, ExpressionAttributeValues={":status": "processing", ":now": int(time.time())})
        try:
            result = process_image_generation(message, user, job_id)
            if "error" in result: raise RuntimeError(result["error"])
            TABLE.update_item(Key=key, UpdateExpression="SET #status = :status, image = :image, updated_at = :now",
                              ExpressionAttributeNames={"#status": "status"}, ExpressionAttributeValues={":status": "completed", ":image": result["image"], ":now": int(time.time())})
        except Exception as exc:
            TABLE.update_item(Key=key, UpdateExpression="SET #status = :status, error = :error, updated_at = :now",
                              ExpressionAttributeNames={"#status": "status"}, ExpressionAttributeValues={":status": "failed", ":error": str(exc)[:500], ":now": int(time.time())})
            print(json.dumps({"image_generation_worker_error": str(exc), "job_id": job_id}, ensure_ascii=False))
            raise
    return {"ok": True}


def attach_photo(user, session_id, key, filename, content_type, room_type=""):
    if not session_id or not session_item(user, session_id): return None, "session not found"
    if not owned_upload_key(user, key): return None, "forbidden"
    content_type = str(content_type or "").lower()
    if content_type not in ALLOWED_IMAGE_TYPES: return None, "unsupported content type"
    try:
        metadata = S3.head_object(Bucket=os.environ["ASSET_BUCKET"], Key=key)
    except Exception:
        return None, "uploaded object not found"
    now, photo_id = int(time.time()), str(uuid.uuid4())
    room_type = str(room_type or "").strip()
    if room_type not in ALLOWED_ROOM_TYPES: room_type = ""
    item = {"pk": "USER#" + user["sub"], "sk": "PHOTO#" + photo_id, "id": photo_id, "session_id": session_id,
            "s3_key": key, "filename": safe_filename(filename), "content_type": content_type,
            "size": int(metadata.get("ContentLength", 0)), "created_at": now, "schema_version": 1}
    if room_type: item["room_type"] = room_type
    save(item)
    if room_type:
        TABLE.update_item(Key={"pk": item["pk"], "sk": session_key(session_id)}, UpdateExpression="SET room_type = :room_type, updated_at = :now", ExpressionAttributeValues={":room_type": room_type, ":now": now})
    TABLE.update_item(Key={"pk": item["pk"], "sk": session_key(session_id)},
                      UpdateExpression="SET photo_ids = list_append(if_not_exists(photo_ids, :empty), :photo), updated_at = :now",
                      ExpressionAttributeValues={":empty": [], ":photo": [photo_id], ":now": now})
    return {"id": photo_id, "sessionId": session_id, "key": key, "downloadUrl": signed_download_url(key)}, None


def analyze_photo(body, user):
    """S3上の写真をOpenAIへ渡し、リフォーム向けの状態診断を返す。"""
    key = str(body.get("key", "")).strip()
    session_id = str(body.get("sessionId", "")).strip()
    photo_id = str(body.get("photoId", "")).strip()
    focus = str(body.get("focus", "")).strip()[:1000]
    if not key or not owned_upload_key(user, key):
        return {"error": "forbidden photo key"}
    if session_id and not session_item(user, session_id):
        return {"error": "session not found"}
    try:
        S3.head_object(Bucket=os.environ["ASSET_BUCKET"], Key=key)
    except Exception:
        return {"error": "uploaded object not found"}

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return {"error": "AI service is not configured"}

    try:
        image_url = image_data_url(key)
    except Exception as exc:
        print(json.dumps({"s3_analysis_error": str(exc)}, ensure_ascii=False))
        return {"error": "uploaded object could not be read"}
    prompt = (
        "あなたはリフォーム相談の画像確認アシスタントです。添付画像を目視し、劣化していそうな箇所を大まかに推定してください。"
        "これは正式な建物診断ではありません。画像から確認できる範囲だけを扱い、原因・経過年数・安全性を断定しないでください。"
        "ユーザーの確認希望がある場合は、その意図を優先し、画像に写っていない対象は無理に判定しないでください。"
        f"ユーザーの確認希望: {focus or '特になし。画像全体を確認してください。'}"
        "次のJSONだけを返してください。"
        '{"items":[{"name":"component","finding":"visible condition","degraded":true}],'
        '"summary":"気になる箇所の短いまとめ"}'
        "itemsには画像から気になる部材を最大5件含めてください。degradedは、画像からおおむね劣化していると判断できる場合だけtrue、明らかな劣化が見られない場合はfalseにしてください。"
    )
    request = Request("https://api.openai.com/v1/responses", data=json.dumps({
        "model": os.environ.get("OPENAI_MODEL", "gpt-5-mini"),
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": prompt},
            {"type": "input_image", "image_url": image_url, "detail": "high"},
        ]}],
        "max_output_tokens": 2000,
        "reasoning": {"effort": "low"},
        "store": False,
    }).encode(), headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=30) as result:
            payload = json.loads(result.read())
        output = payload.get("output", [])
        output_summary = []
        if isinstance(output, list):
            for entry in output[:10]:
                if isinstance(entry, dict):
                    content = entry.get("content", [])
                    output_summary.append({
                        "type": entry.get("type"),
                        "content_types": [part.get("type") for part in content[:10] if isinstance(part, dict)] if isinstance(content, list) else [],
                        "has_text": any(isinstance(part, dict) and isinstance(part.get("text"), str) for part in content) if isinstance(content, list) else False,
                    })
        print(json.dumps({
            "openai_analysis_response": {
                "payload_keys": sorted(payload.keys()),
                "status": payload.get("status"),
                "incomplete_reason": (payload.get("incomplete_details") or {}).get("reason") if isinstance(payload.get("incomplete_details"), dict) else None,
                "output_summary": output_summary,
                "has_output_text": isinstance(payload.get("output_text"), str) and bool(payload.get("output_text")),
            }
        }, ensure_ascii=False))
        raw = payload.get("output_text", "") or ""
        if not isinstance(raw, str):
            raw = ""
        if not raw:
            text_parts = []

            def collect_text(value):
                if isinstance(value, dict):
                    if isinstance(value.get("text"), str):
                        text_parts.append(value["text"])
                    for key in ("output", "content", "message"):
                        collect_text(value.get(key))
                elif isinstance(value, list):
                    for entry in value:
                        collect_text(entry)

            collect_text(output)
            raw = "".join(text_parts)
        match = raw[raw.find("{"):raw.rfind("}") + 1]
        result_data = json.loads(match) if match else {}
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        print(json.dumps({"openai_analysis_error": f"HTTP {exc.code}", "detail": detail}, ensure_ascii=False))
        return {"error": "AI service is temporarily unavailable"}
    except (URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"openai_analysis_error": str(exc)}, ensure_ascii=False))
        return {"error": "AI service is temporarily unavailable"}

    source_items = result_data.get("items")
    if not isinstance(source_items, list):
        source_items = result_data.get("areas", [])
    items = []
    for item in source_items if isinstance(source_items, list) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()[:80]
        finding = str(item.get("finding", "")).strip()[:300]
        severity_value = str(item.get("severity", "")).strip().lower()
        severity = {
            "low": "軽度", "medium": "中度", "high": "重度",
            "軽度": "軽度", "中度": "中度", "重度": "重度",
            "霆ｽ蠎ｦ": "軽度", "荳ｭ蠎ｦ": "中度", "驥榊ｺｦ": "重度",
        }.get(severity_value, "")
        if "degraded" in item:
            degraded = item.get("degraded")
            if isinstance(degraded, bool):
                severity = "劣化あり" if degraded else "劣化なし"
        if name and finding and severity:
            items.append({"name": name, "finding": finding, "severity": severity})
    if not items:
        print(json.dumps({
            "analysis_validation_failed": True,
            "response_keys": sorted(result_data.keys()) if isinstance(result_data, dict) else [],
            "source_item_count": len(source_items) if isinstance(source_items, list) else 0,
            "source_item_keys": [sorted(item.keys()) for item in source_items[:5] if isinstance(item, dict)] if isinstance(source_items, list) else [],
            "raw_response_length": len(raw),
        }, ensure_ascii=False))
        return {"error": "AI analysis returned no valid result"}
    analysis = {"items": items[:5], "summary": str(result_data.get("summary", "")).strip()[:400], "focus": focus, "source": "ai"}

    if photo_id and session_id:
        TABLE.update_item(
            Key={"pk": "USER#" + user["sub"], "sk": "PHOTO#" + photo_id},
            UpdateExpression="SET analysis = :analysis, analyzed_at = :now",
            ExpressionAttributeValues={":analysis": analysis, ":now": int(time.time())},
        )
    return {"sessionId": session_id, "photoId": photo_id, "analysis": analysis}


def diagnosis_chat(body, user):
    """同じ写真を見ながら、ユーザーの追加質問に回答する。"""
    key = str(body.get("key", "")).strip()
    question = str(body.get("question", "")).strip()[:1000]
    messages = body.get("messages", [])
    if not key or not owned_upload_key(user, key): return {"error": "forbidden photo key"}
    if not question: return {"error": "question is required"}
    try:
        S3.head_object(Bucket=os.environ["ASSET_BUCKET"], Key=key)
    except Exception:
        return {"error": "uploaded object not found"}
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key: return {"error": "AI service is not configured"}
    history_messages = []
    if isinstance(messages, list):
        history_messages = [{"role": m.get("role"), "content": str(m.get("content", ""))[:2000]} for m in messages[-8:] if isinstance(m, dict) and m.get("role") in {"user", "assistant"}]
    prompt = "同じ写真についての追加質問に答えてください。画像から確認できる範囲に限定し、原因・経過年数・安全性を断定せず、必要なら現地確認を案内してください。"
    input_content = [{"type": "input_text", "text": prompt}]
    try:
        input_content.append({"type": "input_image", "image_url": image_data_url(key), "detail": "auto"})
    except Exception as exc:
        print(json.dumps({"s3_diagnosis_chat_error": str(exc)}, ensure_ascii=False))
        return {"error": "uploaded object could not be read"}
    input_messages = history_messages + [{"role": "user", "content": question}]
    request = Request("https://api.openai.com/v1/responses", data=json.dumps({
        "model": os.environ.get("OPENAI_MODEL", "gpt-5-mini"),
        "input": [{"role": "system", "content": prompt}, *input_messages[:-1], {"role": "user", "content": input_content}],
        "max_output_tokens": 500,
        "store": False,
    }).encode(), headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=30) as result:
            payload = json.loads(result.read())
        answer = payload.get("output_text", "") or "".join(part.get("text", "") for item in payload.get("output", []) for part in item.get("content", []) if part.get("type") == "output_text")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        print(json.dumps({"openai_diagnosis_chat_error": f"HTTP {exc.code}", "detail": detail}, ensure_ascii=False))
        return {"error": "AI service is temporarily unavailable"}
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(json.dumps({"openai_diagnosis_chat_error": str(exc)}, ensure_ascii=False))
        return {"error": "AI service is temporarily unavailable"}
    if not answer.strip(): return {"error": "AI returned an empty answer"}
    return {"answer": answer.strip(), "source": "ai"}


def chat(body, user, session_id):
    messages = body.get("messages", [])
    if not isinstance(messages, list) or len(messages) > 50: return {"error": "messages must be an array of at most 50 items"}
    current = usage(user)
    if not current["unlimited"] and current["count"] >= current["limit"]: return {"error": "usage limit reached", "usage": current}
    # CIの空値指定などで空白だけが渡っても、OpenAI API呼び出しへ進めない。
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if api_key:
        input_messages = ([{"role": "system", "content": str(body.get("system", ""))[:MAX_SYSTEM_CHARS]}] + [{"role": m.get("role", "user"), "content": str(m.get("content", ""))[:MAX_MESSAGE_CHARS]} for m in messages[-MAX_INPUT_MESSAGES:] if isinstance(m, dict) and m.get("role") in ("user", "assistant")])
        request = Request("https://api.openai.com/v1/responses", data=json.dumps({"model": os.environ.get("OPENAI_MODEL", "gpt-5-mini"), "input": input_messages, "max_output_tokens": MAX_OUTPUT_TOKENS, "store": False}).encode(), headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(request, timeout=25) as result: payload = json.loads(result.read())
        except (HTTPError, URLError, TimeoutError) as exc:
            print(json.dumps({"openai_error": str(exc)}, ensure_ascii=False))
            return {"error": "AI service is temporarily unavailable"}
        text = payload.get("output_text", "") or "".join(part.get("text", "") for item in payload.get("output", []) for part in item.get("content", []) if part.get("type") == "output_text")
    else:
        text = "ご相談内容を確認しました。現在の状態・ご希望の部屋・ご予算を教えてください。"
    user_message = next((str(message.get("content", "")) for message in reversed(messages) if isinstance(message, dict) and message.get("role") == "user"), "")
    save_chat_turn(user, session_id, user_message, text)
    # Keep the existing usage counter compatible while the session history uses message records.
    save({"pk": "USER#" + user["sub"], "sk": "CHAT#" + str(time.time_ns()), "session_id": session_id, "messages": messages[-20:], "updated_at": int(time.time())})
    return {"sessionId": session_id, "content": [{"type": "text", "text": text}], "usage": usage(user)}


def estimate(body, user):
    """AIで条件を抽出し、金額と工期はサーバーの料金マスタで検証計算する。"""
    requested_size = str(body.get("size", "8"))
    requested_items = body.get("items", [])
    requested_grade = str(body.get("grade", "std"))
    if requested_size not in ESTIMATE_SIZES or requested_grade not in ESTIMATE_GRADES:
        return {"error": "invalid estimate condition"}
    if not isinstance(requested_items, list) or not requested_items or any(key not in ESTIMATE_ITEMS for key in requested_items):
        return {"error": "at least one valid estimate item is required"}

    requested_items = list(dict.fromkeys(requested_items))
    cache_key = json.dumps({"v": 1, "size": requested_size, "items": requested_items, "grade": requested_grade}, separators=(",", ":"), sort_keys=True)
    now = time.time()
    cached = _ESTIMATE_CACHE.get(cache_key)
    if cached and cached["expires_at"] > now:
        _ESTIMATE_CACHE.move_to_end(cache_key)
        return cached["value"]
    if cached:
        _ESTIMATE_CACHE.pop(cache_key, None)

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    size_key, item_keys, grade_key = requested_size, list(dict.fromkeys(requested_items)), requested_grade
    subsidy_signals = []
    explanation = "選択した工事内容と面積をもとに、標準的な施工条件で概算しています。"
    source = "fallback"
    if api_key:
        context = body.get("context", [])
        context_text = json.dumps(context[-10:] if isinstance(context, list) else [], ensure_ascii=False)[:12000]
        prompt = (
            "リフォーム相談の会話から見積り条件を抽出してください。JSONだけを返してください。\n"
            "キーは size（6,8,10,12のいずれか）、items（floor,wall,kitchen,bath,toilet,wash,light,storageの配列）、"
            "grade（eco,std,preのいずれか）、subsidy_signals（window,insulation,water_heaterの配列）、"
            "explanation（日本語80文字以内）です。"
            "会話に明示がない条件は、画面で選択された値を維持してください。金額は計算しないでください。\n"
            f"画面選択: size={requested_size}, items={','.join(requested_items)}, grade={requested_grade}\n"
            f"会話: {context_text}"
        )
        request = Request("https://api.openai.com/v1/responses", data=json.dumps({
            "model": os.environ.get("OPENAI_MODEL", "gpt-5-mini"),
            "input": [{"role": "system", "content": "指定されたJSON形式を厳守するリフォーム見積り条件抽出器。"}, {"role": "user", "content": prompt}],
            "max_output_tokens": 240,
            "store": False,
        }).encode(), headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(request, timeout=15) as result:
                payload = json.loads(result.read())
            raw = payload.get("output_text", "")
            match = raw[raw.find("{"):raw.rfind("}") + 1]
            ai_conditions = json.loads(match) if match else {}
            candidate_size = str(ai_conditions.get("size", requested_size))
            candidate_items = ai_conditions.get("items", requested_items)
            candidate_grade = str(ai_conditions.get("grade", requested_grade))
            if candidate_size in ESTIMATE_SIZES and candidate_grade in ESTIMATE_GRADES and isinstance(candidate_items, list):
                candidate_items = list(dict.fromkeys(key for key in candidate_items if key in ESTIMATE_ITEMS))
                if candidate_items:
                    size_key, item_keys, grade_key = candidate_size, candidate_items, candidate_grade
                    subsidy_signals = list(dict.fromkeys(signal for signal in ai_conditions.get("subsidy_signals", []) if signal in {"window", "insulation", "water_heater"}))
                    explanation = str(ai_conditions.get("explanation", explanation))[:240] or explanation
                    source = "ai"
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError):
            pass

    m2 = ESTIMATE_SIZES[size_key]
    multiplier = ESTIMATE_GRADES[grade_key]
    low = high = 0
    low_weeks = high_weeks = 0
    for key in dict.fromkeys(item_keys):
        item = ESTIMATE_ITEMS[key]
        factor = m2 if item["unit"] == "m2" else 1
        low += item["base"][0] * factor * 10000
        high += item["base"][1] * factor * 10000
        low_weeks = max(low_weeks, item["weeks"][0])
        high_weeks = max(high_weeks, item["weeks"][1])
    low = round(low * multiplier / 10000) * 10000
    high = round(high * multiplier / 10000) * 10000
    duration = {"low": max(1, low_weeks), "high": max(low_weeks, high_weeks)}

    subsidies = [
        {**program, "match": "candidate", "reason": "会話内容に対象となる可能性のある工事が含まれています。"}
        for program in SUBSIDY_PROGRAMS
        if set(subsidy_signals) & set(program["eligible_signals"])
    ]
    value = {"estimate": {"low": low, "high": high}, "duration": duration, "conditions": {"size": size_key, "items": item_keys, "grade": grade_key}, "subsidies": subsidies, "explanation": explanation, "source": source}
    if source != "ai":
        value["warning"] = "AIから正しい概算条件を取得できなかったため、登録済みの計算ルールで表示しています。"
    _ESTIMATE_CACHE[cache_key] = {"expires_at": now + ESTIMATE_CACHE_TTL_SECONDS, "value": value}
    _ESTIMATE_CACHE.move_to_end(cache_key)
    while len(_ESTIMATE_CACHE) > ESTIMATE_CACHE_MAX_ENTRIES:
        _ESTIMATE_CACHE.popitem(last=False)
    return value


def material_recommendation(body, user):
    """登録済みカタログから、相談内容に合う素材候補をAIに選定させる。"""
    selected_key = str(body.get("selected_key", ""))[:80]
    catalog = body.get("catalog", [])
    if not isinstance(catalog, list) or not catalog:
        return {"error": "material catalog is required"}
    catalog = [item for item in catalog if isinstance(item, dict) and item.get("key")]
    catalog_by_key = {str(item["key"]): item for item in catalog}
    if selected_key not in catalog_by_key:
        return {"error": "invalid material key"}

    fallback = {
        "source": "fallback",
        "warning": "AIから正しい候補を取得できなかったため、登録済みの標準候補を表示しています。",
        "recommendations": [{"key": selected_key, "reason": "選択された素材の登録済み候補です。"}],
    }
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return fallback

    compact_catalog = [{
        "key": str(item["key"]),
        "name": str(item.get("name", ""))[:120],
        "category": str(item.get("category", ""))[:80],
        "pros": [str(value)[:100] for value in item.get("pros", [])[:5]] if isinstance(item.get("pros"), list) else [],
        "cons": [str(value)[:100] for value in item.get("cons", [])[:5]] if isinstance(item.get("cons"), list) else [],
    } for item in catalog]
    context = body.get("context", [])
    context_text = json.dumps(context[-10:] if isinstance(context, list) else [], ensure_ascii=False)[:12000]
    prompt = (
        "リフォーム相談から、登録済み素材カタログの候補を最大3件選んでください。JSONだけを返してください。\n"
        "形式: {\"recommendations\":[{\"key\":\"登録カタログのkey\",\"reason\":\"日本語の短い理由\"}]}\n"
        "カタログにないkey、商品名、価格、性能を作らないでください。相談内容に根拠がなければ選択素材のkeyを1件返してください。\n"
        f"選択素材: {selected_key}\n相談履歴: {context_text}\nカタログ: {json.dumps(compact_catalog, ensure_ascii=False)}"
    )
    request = Request("https://api.openai.com/v1/responses", data=json.dumps({
        "model": os.environ.get("OPENAI_MODEL", "gpt-5-mini"),
        "input": [{"role": "system", "content": "JSON形式を厳密に返す素材選定アシスタントです。"}, {"role": "user", "content": prompt}],
        "max_output_tokens": 300,
        "store": False,
    }).encode(), headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=15) as result:
            payload = json.loads(result.read())
        raw = payload.get("output_text", "")
        match = raw[raw.find("{"):raw.rfind("}") + 1]
        parsed = json.loads(match) if match else {}
        recommendations = parsed.get("recommendations")
        if not isinstance(recommendations, list):
            return fallback
        valid = []
        for recommendation in recommendations[:3]:
            if not isinstance(recommendation, dict):
                continue
            key = str(recommendation.get("key", ""))
            reason = str(recommendation.get("reason", "")).strip()[:240]
            if key in catalog_by_key and reason:
                valid.append({"key": key, "reason": reason})
        if not valid:
            return fallback
        return {"source": "ai", "recommendations": valid}
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return fallback


def lambda_handler(event, context):
    try:
        if event.get("Records"):
            return image_generation_worker(event)
        method = event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod")
        if method == "OPTIONS": return response(204, {})
        body = json.loads(event.get("body") or "{}")
        if not isinstance(body, dict): return response(400, {"error": "request body must be an object"})
        typ = body.get("type")
        if typ == "demo_login":
            # PINなしの動作デモ用。ブラウザごとに利用量を分けるため識別子をハッシュ化する。
            demo_id = str(body.get("demo_id", "browser"))[:120]
            subject = "demo:" + hashlib.sha256(demo_id.encode()).hexdigest()[:32]
            return response(200, {"token": token_for(subject), "role": "guest", "label": "動作デモ"})
        if typ == "verify_pin":
            pin = str(body.get("pin", ""))
            demo_pin = os.environ.get("DEMO_PIN", "").strip()
            if demo_pin and pin == demo_pin:
                return response(200, {"token": token_for("demo:" + pin), "role": "guest", "label": "デモ用PIN"})
            item = TABLE.get_item(Key={"pk": "PIN#" + pin, "sk": "PIN"}).get("Item")
            if not item or item.get("expires_at", 0) < int(time.time()) or item.get("uses", 0) >= item.get("max_uses", 0): return response(401, {"error": "invalid pin"})
            TABLE.update_item(Key={"pk": "PIN#" + pin, "sk": "PIN"}, UpdateExpression="SET uses = uses + :one", ExpressionAttributeValues={":one": 1})
            return response(200, {"token": token_for("guest:" + pin), "role": "guest", "label": item.get("label", "")})
        if typ == "cognito_login":
            access_token = str(body.get("access_token", ""))
            admin_email = os.environ.get("ADMIN_EMAIL", "").strip().lower()
            if not access_token or not admin_email: return response(401, {"error": "admin login is not configured"})
            try:
                cognito_user = COGNITO.get_user(AccessToken=access_token)
                attributes = {item.get("Name"): item.get("Value", "") for item in cognito_user.get("UserAttributes", [])}
                email = attributes.get("email", "").strip().lower()
                if not email or email != admin_email: return response(403, {"error": "admin access denied"})
                return response(200, {"token": token_for("admin:" + email, "admin"), "role": "admin", "email": email})
            except Exception:
                return response(401, {"error": "invalid Cognito session"})
        user = subject_from_token(body.get("token", ""))
        if not user: return response(401, {"error": "unauthorized"})
        if typ == "chat":
            session_id = str(body.get("sessionId", "")).strip()
            if session_id:
                existing = session_item(user, session_id)
                if not existing: return response(404, {"error": "session not found"})
                if existing.get("status") == "archived": return response(409, {"error": "session is archived"})
            else:
                session_id = create_session(user)["sessionId"]
            result = chat(body, user, session_id)
            status = 429 if "usage limit" in result.get("error", "") else 503 if "unavailable" in result.get("error", "") else 400 if "messages" in result.get("error", "") else 200
            return response(status, result)
        if typ == "save_chat_turn":
            session_id = str(body.get("sessionId", "")).strip()
            user_message = str(body.get("userMessage", "")).strip()
            assistant_message = str(body.get("assistantMessage", "")).strip()
            if not session_id or not user_message or not assistant_message:
                return response(400, {"error": "sessionId, userMessage and assistantMessage are required"})
            if not session_item(user, session_id):
                return response(404, {"error": "session not found"})
            save_chat_turn(user, session_id, user_message, assistant_message)
            return response(200, {"ok": True, "sessionId": session_id})
        if typ == "estimate":
            result = estimate(body, user)
            status = 400 if "error" in result else 200
            return response(status, result)
        if typ == "material_recommendation":
            result = material_recommendation(body, user)
            status = 400 if "error" in result else 200
            return response(status, result)
        if typ == "get_usage": return response(200, usage(user))
        if typ == "create_session":
            return response(201, {"session": create_session(user)})
        if typ == "get_sessions":
            return response(200, {"sessions": list_sessions(user)})
        if typ == "get_session":
            session_id = str(body.get("sessionId", "")).strip()
            if not session_id: return response(400, {"error": "sessionId is required"})
            detail = get_session_detail(user, session_id)
            if not detail: return response(404, {"error": "session not found"})
            return response(200, {"session": detail})
        if typ == "archive_session":
            session_id = str(body.get("sessionId", "")).strip()
            if not session_id: return response(400, {"error": "sessionId is required"})
            if not session_item(user, session_id): return response(404, {"error": "session not found"})
            TABLE.update_item(
                Key={"pk": "USER#" + user["sub"], "sk": session_key(session_id)},
                UpdateExpression="SET #status = :status, updated_at = :now",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":status": "archived", ":now": int(time.time())},
            )
            return response(200, {"sessionId": session_id, "status": "archived"})
        if typ == "save_session":
            save({"pk": "USER#" + user["sub"], "sk": "SESSION#" + str(time.time_ns()), "data": body.get("data", {}), "created_at": int(time.time())})
            return response(200, {"ok": True})
        if typ == "create_upload_url":
            content_type = str(body.get("content_type", "image/jpeg")).lower()
            if content_type not in ALLOWED_IMAGE_TYPES | {"application/pdf"}: return response(400, {"error": "unsupported content type"})
            session_id = str(body.get("sessionId", "")).strip()
            if session_id and not session_item(user, session_id): return response(404, {"error": "session not found"})
            key = f"uploads/{user['sub']}/{session_id or 'unattached'}/{uuid.uuid4().hex}-{safe_filename(body.get('filename'))}"
            url = S3.generate_presigned_url("put_object", Params={"Bucket": os.environ["ASSET_BUCKET"], "Key": key, "ContentType": content_type}, ExpiresIn=900)
            return response(200, {"key": key, "upload_url": url, "content_type": content_type, "expires_in": 900})
        if typ == "create_proposal_upload_url":
            content_type = str(body.get("content_type", "application/pdf")).lower()
            if content_type != "application/pdf": return response(400, {"error": "PDF content type is required"})
            session_id = str(body.get("sessionId", "")).strip()
            if session_id and not session_item(user, session_id): return response(404, {"error": "session not found"})
            proposal_id = str(uuid.uuid4())
            key = f"proposals/{user['sub']}/{session_id or 'unattached'}/{proposal_id}.pdf"
            url = S3.generate_presigned_url("put_object", Params={"Bucket": os.environ["ASSET_BUCKET"], "Key": key, "ContentType": content_type}, ExpiresIn=900)
            return response(200, {"proposal_id": proposal_id, "key": key, "upload_url": url, "content_type": content_type, "expires_in": 900})
        if typ == "save_proposal":
            key = str(body.get("key", "")).strip()
            session_id = str(body.get("sessionId", "")).strip()
            if not owned_proposal_key(user, key): return response(403, {"error": "forbidden proposal key"})
            if session_id and not session_item(user, session_id): return response(404, {"error": "session not found"})
            try:
                metadata = S3.head_object(Bucket=os.environ["ASSET_BUCKET"], Key=key)
            except Exception:
                return response(404, {"error": "proposal not found"})
            proposal_id = posixpath.splitext(posixpath.basename(key))[0]
            now = int(time.time())
            item = {"pk": "USER#" + user["sub"], "sk": "PROPOSAL#" + proposal_id, "id": proposal_id,
                    "session_id": session_id, "s3_key": key, "filename": safe_filename(body.get("filename", "RENO-proposal.pdf")),
                    "content_type": "application/pdf", "size": int(metadata.get("ContentLength", 0)),
                    "created_at": now, "schema_version": 1}
            save(item)
            return response(201, {"proposal": {"id": proposal_id, "sessionId": session_id, "key": key,
                                                 "filename": item["filename"], "size": item["size"],
                                                 "downloadUrl": signed_download_url(key), "createdAt": now}})
        if typ == "get_proposals":
            session_id = str(body.get("sessionId", "")).strip()
            proposals = [item for item in query_user(user, "PROPOSAL#") if not session_id or item.get("session_id") == session_id]
            return response(200, {"proposals": [{"id": item.get("id"), "sessionId": item.get("session_id", ""),
                                                   "filename": item.get("filename", "RENO-proposal.pdf"),
                                                   "size": int(item.get("size", 0)), "createdAt": item.get("created_at"),
                                                   "downloadUrl": signed_download_url(item["s3_key"])} for item in proposals]})
        if typ == "save_photo":
            photo, error = attach_photo(user, str(body.get("sessionId", "")).strip(), str(body.get("key", "")).strip(), body.get("filename"), body.get("content_type", "image/jpeg"), body.get("room_type", ""))
            if error == "session not found": return response(404, {"error": error})
            if error == "forbidden": return response(403, {"error": error})
            if error: return response(400, {"error": error})
            return response(201, {"photo": photo})
        if typ == "analyze_photo":
            result = analyze_photo(body, user)
            status = 200 if "error" not in result else (404 if result["error"] in {"session not found", "uploaded object not found"} else 403 if result["error"] == "forbidden photo key" else 503)
            return response(status, result)
        if typ == "diagnosis_chat":
            result = diagnosis_chat(body, user)
            status = 200 if "error" not in result else (400 if result["error"] == "question is required" else 404 if result["error"] == "uploaded object not found" else 403 if result["error"] == "forbidden photo key" else 503)
            return response(status, result)
        if typ == "generate_image":
            result = generate_image(body, user)
            status = 200 if "error" not in result else (404 if result["error"] in {"session not found", "uploaded object not found"} else 403 if result["error"] == "forbidden photo key" else 503)
            return response(status, result)
        if typ == "image_generation_status":
            result = image_generation_status(body, user)
            status = 200 if "error" not in result else 404
            return response(status, result)
        if typ == "create_download_url":
            key = str(body.get("key", "")); allowed = (f"uploads/{user['sub']}/", f"generated/{user['sub']}/", f"proposals/{user['sub']}/")
            if not key.startswith(allowed): return response(403, {"error": "forbidden"})
            url = signed_download_url(key)
            return response(200, {"download_url": url, "expires_in": 900})
        if typ == "create_guest_pin":
            if user.get("role") != "admin": return response(403, {"error": "admin only"})
            pin = f"{uuid.uuid4().int % 10000:04d}"; max_uses = min(100, max(1, int(body.get("max_uses", 30)))); expires_at = int(time.time()) + min(30, max(1, int(body.get("days", 7)))) * 86400
            save({"pk": "PIN#" + pin, "sk": "PIN", "owner_sub": user["sub"], "label": str(body.get("label", ""))[:120], "uses": 0, "max_uses": max_uses, "expires_at": expires_at})
            return response(200, {"pin": pin, "label": body.get("label", ""), "max_uses": max_uses, "expires_at": expires_at * 1000})
        if typ == "get_guest_pins":
            if user.get("role") != "admin": return response(403, {"error": "admin only"})
            items = TABLE.scan(FilterExpression=Attr("owner_sub").eq(user["sub"])).get("Items", [])
            return response(200, [{"id": i["pk"].replace("PIN#", ""), "pin": i["pk"].replace("PIN#", ""), "label": i.get("label", ""), "use_count": i.get("uses", 0), "max_uses": i.get("max_uses", 0), "expires_at": i.get("expires_at", 0) * 1000, "is_active": i.get("uses", 0) < i.get("max_uses", 0) and i.get("expires_at", 0) > int(time.time())} for i in items])
        if typ == "delete_guest_pin":
            if user.get("role") != "admin": return response(403, {"error": "admin only"})
            pin = str(body.get("id", "")); item = TABLE.get_item(Key={"pk": "PIN#" + pin, "sk": "PIN"}).get("Item")
            if not item or item.get("owner_sub") != user["sub"]: return response(404, {"error": "pin not found"})
            TABLE.delete_item(Key={"pk": "PIN#" + pin, "sk": "PIN"}); return response(200, {"ok": True})
        if typ == "save_case":
            title, room = str(body.get("title", "")).strip(), str(body.get("room", "")).strip()
            if not title or not room: return response(400, {"error": "title and room are required"})
            image_key = str(body.get("image_key", "")).strip()
            if image_key and not owned_upload_key(user, image_key): return response(403, {"error": "forbidden image key"})
            image = "" if image_key else str(body.get("image_data", ""))
            if len(image) > 700_000: return response(413, {"error": "image is too large"})
            item = {"pk": "USER#" + user["sub"], "sk": "CASE#" + str(uuid.uuid4()), "id": str(uuid.uuid4()), "title": title[:120], "room": room[:80], "style": str(body.get("style", ""))[:80], "budget_range": str(body.get("budget_range", ""))[:80], "description": str(body.get("description", ""))[:1000], "image_data": image, "image_key": image_key, "created_at": int(time.time())}
            save(item); return response(200, {"ok": True, "case": item})
        if typ == "get_cases":
            room, style = str(body.get("room", "")), str(body.get("style", "")); items = query_user(user, "CASE#")
            result = [i for i in items if (not room or i.get("room") == room) and (not style or i.get("style") == style)]
            for item in result:
                if item.get("image_key"): item["image_url"] = signed_download_url(item["image_key"])
            return response(200, result)
        if typ == "delete_case":
            items = [i for i in query_user(user, "CASE#") if i.get("id") == str(body.get("id", ""))]
            if not items: return response(404, {"error": "case not found"})
            item = items[0]
            TABLE.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
            if item.get("image_key"): S3.delete_object(Bucket=os.environ["ASSET_BUCKET"], Key=item["image_key"])
            return response(200, {"ok": True})
        if typ == "handoff":
            if os.environ.get("SES_FROM_EMAIL") and os.environ.get("SES_TO_EMAIL"):
                SES.send_email(Source=os.environ["SES_FROM_EMAIL"], Destination={"ToAddresses": [os.environ["SES_TO_EMAIL"]]}, Message={"Subject": {"Data": "RENO相談受付"}, "Body": {"Text": {"Data": json.dumps(body.get("data", {}), ensure_ascii=False)}}})
            save({"pk": "USER#" + user["sub"], "sk": "HANDOFF#" + str(time.time_ns()), "data": body.get("data", {}), "created_at": int(time.time())})
            return response(200, {"ok": True, "status": "received"})
        return response(400, {"error": "unsupported type"})
    except Exception as exc:
        print(json.dumps({"error": str(exc), "request_id": getattr(context, "aws_request_id", "")}, ensure_ascii=False))
        if event.get("Records"):
            raise
        return response(500, {"error": "internal error"})
