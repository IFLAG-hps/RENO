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


def usage(user):
    count = len(query_user(user, "CHAT#"))
    return {"plan": "unlimited" if UNLIMITED_MODE else "standard", "count": count, "limit": USAGE_LIMIT, "remaining": None if UNLIMITED_MODE else max(0, USAGE_LIMIT - count), "unlimited": UNLIMITED_MODE}


def safe_filename(name):
    name = posixpath.basename(str(name or "image.jpg")).replace("\\", "_")
    return "".join(c for c in name if c.isalnum() or c in "._-")[:120] or "image.jpg"


ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}


def owned_upload_key(user, key):
    return isinstance(key, str) and key.startswith(f"uploads/{user['sub']}/")


def signed_download_url(key):
    return S3.generate_presigned_url("get_object", Params={"Bucket": os.environ["ASSET_BUCKET"], "Key": key}, ExpiresIn=900)


def attach_photo(user, session_id, key, filename, content_type):
    if not session_id or not session_item(user, session_id): return None, "session not found"
    if not owned_upload_key(user, key): return None, "forbidden"
    content_type = str(content_type or "").lower()
    if content_type not in ALLOWED_IMAGE_TYPES: return None, "unsupported content type"
    try:
        metadata = S3.head_object(Bucket=os.environ["ASSET_BUCKET"], Key=key)
    except Exception:
        return None, "uploaded object not found"
    now, photo_id = int(time.time()), str(uuid.uuid4())
    item = {"pk": "USER#" + user["sub"], "sk": "PHOTO#" + photo_id, "id": photo_id, "session_id": session_id,
            "s3_key": key, "filename": safe_filename(filename), "content_type": content_type,
            "size": int(metadata.get("ContentLength", 0)), "created_at": now, "schema_version": 1}
    save(item)
    TABLE.update_item(Key={"pk": item["pk"], "sk": session_key(session_id)},
                      UpdateExpression="SET photo_ids = list_append(if_not_exists(photo_ids, :empty), :photo), updated_at = :now",
                      ExpressionAttributeValues={":empty": [], ":photo": [photo_id], ":now": now})
    return {"id": photo_id, "sessionId": session_id, "key": key, "downloadUrl": signed_download_url(key)}, None


def chat(body, user, session_id):
    messages = body.get("messages", [])
    if not isinstance(messages, list) or len(messages) > 50: return {"error": "messages must be an array of at most 50 items"}
    current = usage(user)
    if not UNLIMITED_MODE and current["count"] >= current["limit"]: return {"error": "usage limit reached", "usage": current}
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
        if typ == "save_photo":
            photo, error = attach_photo(user, str(body.get("sessionId", "")).strip(), str(body.get("key", "")).strip(), body.get("filename"), body.get("content_type", "image/jpeg"))
            if error == "session not found": return response(404, {"error": error})
            if error == "forbidden": return response(403, {"error": error})
            if error: return response(400, {"error": error})
            return response(201, {"photo": photo})
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
        return response(500, {"error": "internal error"})
