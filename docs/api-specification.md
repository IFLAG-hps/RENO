# RENO API仕様書（現行実装版）

## 1. この仕様書について

本書は、2026-09-07時点の `backend/src/handler.py` の実装を正として整理した仕様書です。
将来の理想仕様ではなく、現在のLambdaが受け付けるリクエスト、返却するレスポンス、保存形式を記載します。

実装とフロントエンドの接続が未完了のAPIも含みます。その場合は「現状の実装」として記載し、注記を付けています。

## 2. 共通仕様

### エンドポイント

- HTTPメソッド: `POST`
- 本番想定URL: `https://{api-id}.execute-api.{region}.amazonaws.com/v1/agent`
- ローカル開発URL: `http://127.0.0.1:3000/agent`
- API形式: すべて同一エンドポイントへJSONをPOSTし、`type`で処理を分岐
- 例外: `generateWithFiles`の現行フロント実装はMultipartを送信するが、LambdaはJSONとして解析する実装である

### 共通リクエスト

認証方式はベーシック認証とします。認証が必要なAPIでは、HTTPリクエストヘッダーに以下を付与します。

```text
Authorization: Basic base64(username:password)
```

認証処理はAPI本体から分離し、認証アダプターを差し替えられる構造にします。将来、Cognito、JWT、APIキーなどへ変更する場合も、API各処理の変更を最小限にします。

認証に成功したユーザー情報は、内部的には`userId`と`role`として扱います。APIの業務処理は認証方式そのものに依存しないものとします。

現行実装では、ベーシック認証の代わりにJSONの`token`をHMAC検証しています。ベーシック認証への変更は別途実装が必要です。

### 現行実装互換の認証情報

現行Lambdaを動作させる場合は、引き続きリクエストJSONに以下を含めます。

```json
{
  "token": "string",
  "type": "string"
}
```

### 共通レスポンスヘッダー

```text
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type,Authorization,apikey
Access-Control-Allow-Methods: POST,OPTIONS
```

### 共通エラー

```json
{
  "error": "エラー内容"
}
```

HTTPステータスはAPIごとに異なります。エラーコードやエラーオブジェクトはまだ統一されておらず、現状は文字列を返します。

### OPTIONS

`OPTIONS`リクエストには、HTTP 204と空オブジェクトを返します。

## 3. API一覧

| type | 用途 | 認証 | 成功ステータス |
|---|---|---:|---:|
| `demo_login` | デモセッション開始 | 不要 | 200 |
| `verify_pin` | ゲストPIN認証 | 不要 | 200 |
| `cognito_login` | 管理者Cognito認証 | 不要 | 200 |
| `create_session` | 相談セッション作成 | 必要 | 201 |
| `chat` | AIチャット | 必要 | 200 |
| `save_chat_turn` | チャットターン保存 | 必要 | 200 |
| `estimate` | 概算費用・工期算出 | 必要 | 200 |
| `material_recommendation` | 素材候補のAI推薦 | 必要 | 200 |
| `get_usage` | 利用状況取得 | 必要 | 200 |
| `get_sessions` | セッション一覧取得 | 必要 | 200 |
| `get_session` | セッション詳細取得 | 必要 | 200 |
| `archive_session` | セッションアーカイブ | 必要 | 200 |
| `save_session` | 旧形式のセッション保存 | 必要 | 200 |
| `create_upload_url` | S3署名付きPUT URL発行 | 必要 | 200 |
| `save_photo` | アップロード済み写真保存・紐付け | 必要 | 201 |
| `analyze_photo` | S3上の写真をAI分析 | 必要 | 200 |
| `diagnosis_chat` | 同じ写真についてAIへ追加質問 | 必要 | 200 |
| `create_download_url` | S3署名付きGET URL発行 | 必要 | 200 |
| `generate_image` | 現在の写真をもとに生成画像を作成 | 必要 | 200 |
| `handoff` | 担当者相談受付 | 必要 | 200 |
| `create_guest_pin` | ゲストPIN発行 | 管理者のみ | 200 |
| `get_guest_pins` | ゲストPIN一覧取得 | 管理者のみ | 200 |
| `delete_guest_pin` | ゲストPIN削除 | 管理者のみ | 200 |
| `save_case` | 施工事例保存 | 必要 | 200 |
| `get_cases` | 施工事例一覧取得 | 必要 | 200 |
| `delete_case` | 施工事例削除 | 必要 | 200 |

## 4. 認証API

### 認証方式の決定事項

- 採用方式: ベーシック認証
- 目的: MVP利用者が簡単に利用できること
- 変更容易性: 認証処理を共通ミドルウェアまたは認証アダプターへ分離する
- 業務APIが参照する情報: `userId`、`role`
- パスワード保存: 平文保存しない。ハッシュ化または外部認証基盤で管理する
- 通信: HTTPS必須。HTTPでベーシック認証情報を送信しない
- 将来の変更候補: Cognito、JWT、APIキー

### demo_login

リクエスト:

```json
{
  "type": "demo_login",
  "demo_id": "browser-identifier"
}
```

`demo_id`は最大120文字。省略時は`browser`です。

レスポンス:

```json
{
  "token": "{payload}.{signature}",
  "role": "guest",
  "label": "デモ"
}
```

### verify_pin

リクエスト:

```json
{
  "type": "verify_pin",
  "pin": "1234"
}
```

レスポンス:

```json
{
  "token": "string",
  "role": "guest",
  "label": "string"
}
```

失敗時は`401 {"error":"invalid pin"}`です。

### cognito_login

リクエスト:

```json
{
  "type": "cognito_login",
  "access_token": "Cognito access token"
}
```

レスポンス:

```json
{
  "token": "string",
  "role": "admin",
  "email": "admin@example.com"
}
```

環境変数`ADMIN_EMAIL`と一致するCognitoユーザーだけが管理者として認証されます。

## 5. セッション・チャットAPI

### create_session

リクエスト:

```json
{
  "type": "create_session",
  "token": "string"
}
```

レスポンス:

```json
{
  "session": {
    "sessionId": "uuid",
    "status": "active",
    "title": "新しいチャット",
    "createdAt": 1710000000,
    "updatedAt": 1710000000,
    "lastMessageAt": null,
    "messageCount": 0,
    "handoffStatus": "not_requested",
    "schemaVersion": 1
  }
}
```

### chat

リクエスト:

```json
{
  "type": "chat",
  "token": "string",
  "sessionId": "uuid",
  "system": "system prompt",
  "messages": [
    {"role": "user", "content": "浴室をリフォームしたい"},
    {"role": "assistant", "content": "ご希望を教えてください"}
  ]
}
```

- `sessionId`省略時は新規セッションを作成
- `messages`は配列、最大50件
- AIに渡すのは末尾20件まで
- 1メッセージ最大4000文字
- `system`最大8000文字
- `role`は`user`または`assistant`のみAI入力対象

レスポンス:

```json
{
  "sessionId": "uuid",
  "content": [
    {"type": "text", "text": "AIの回答"}
  ],
  "usage": {
    "plan": "unlimited",
    "count": 1,
    "limit": 10,
    "remaining": null,
    "unlimited": true
  }
}
```

OpenAIキー未設定時は固定フォールバック文を返します。OpenAI呼び出し失敗時は503です。

### save_chat_turn

リクエスト:

```json
{
  "type": "save_chat_turn",
  "token": "string",
  "sessionId": "uuid",
  "userMessage": "ユーザー発言",
  "assistantMessage": "アシスタント発言"
}
```

レスポンス:

```json
{"ok": true, "sessionId": "uuid"}
```

### get_usage

レスポンス:

```json
{
  "plan": "standard",
  "count": 0,
  "limit": 10,
  "remaining": 10,
  "unlimited": false
}
```

### get_sessions

リクエスト:

```json
{"type":"get_sessions","token":"string"}
```

レスポンス:

```json
{"sessions":[{"sessionId":"uuid","status":"active","title":"タイトル","createdAt":1710000000,"updatedAt":1710000000,"lastMessageAt":1710000000,"messageCount":2,"handoffStatus":"not_requested","schemaVersion":1}]}
```

### get_session

リクエスト:

```json
{"type":"get_session","token":"string","sessionId":"uuid"}
```

レスポンス:

```json
{
  "session": {
    "sessionId": "uuid",
    "status": "active",
    "title": "タイトル",
    "createdAt": 1710000000,
    "updatedAt": 1710000000,
    "lastMessageAt": 1710000000,
    "messageCount": 2,
    "handoffStatus": "not_requested",
    "schemaVersion": 1,
    "messages": [
      {"role":"user","content":"相談内容"},
      {"role":"assistant","content":"回答"}
    ],
    "photos": []
  }
}
```

写真がある場合、`photos`の各要素に`download_url`が付与されます。

### archive_session

リクエスト:

```json
{"type":"archive_session","token":"string","sessionId":"uuid"}
```

レスポンス:

```json
{"sessionId":"uuid","status":"archived"}
```

### save_session（旧形式）

リクエスト:

```json
{"type":"save_session","token":"string","data":{}}
```

レスポンス:

```json
{"ok":true}
```

現状は新しいセッションIDとの明示的な紐付けを行わず、`SESSION#{時刻}`として保存します。

## 6. 概算・素材API

### estimate

リクエスト:

```json
{
  "type":"estimate",
  "token":"string",
  "size":"8",
  "items":["floor","wall"],
  "grade":"std",
  "context":[]
}
```

使用可能な値:

- `size`: `6`, `8`, `10`, `12`
- `items`: `floor`, `wall`, `kitchen`, `bath`, `toilet`, `wash`, `light`, `storage`
- `grade`: `eco`, `std`, `pre`

レスポンス:

```json
{
  "estimate":{"low":1170000,"high":2280000},
  "duration":{"low":1,"high":2},
  "conditions":{"size":"8","items":["floor","wall"],"grade":"std"},
  "subsidies":[],
  "explanation":"説明",
  "source":"fallback",
  "warning":"AI未使用時の注意"
}
```

`source`は`ai`または`fallback`です。AIキーがない場合、またはAI結果を採用できない場合は`fallback`になります。

### material_recommendation

リクエスト:

```json
{
  "type":"material_recommendation",
  "token":"string",
  "selected_key":"oak",
  "catalog":[{"key":"oak","name":"オーク","category":"床材","pros":[],"cons":[]}],
  "context":[]
}
```

レスポンス:

```json
{
  "source":"fallback",
  "warning":"説明",
  "recommendations":[{"key":"oak","reason":"選択理由"}]
}
```

## 7. 写真・ファイルAPI

### create_upload_url

リクエスト:

```json
{
  "type":"create_upload_url",
  "token":"string",
  "sessionId":"uuid",
  "filename":"bathroom.jpg",
  "content_type":"image/jpeg"
}
```

許可される`content_type`は、`image/jpeg`、`image/png`、`image/webp`、`application/pdf`です。

レスポンス:

```json
{
  "key":"uploads/{userId}/{sessionId}/{uuid}-bathroom.jpg",
  "upload_url":"https://s3...",
  "content_type":"image/jpeg",
  "expires_in":900
}
```

発行されたURLへ、返却された`Content-Type`を付けてHTTP PUTします。

### analyze_photo

保存済みの現状写真をLambdaからOpenAIへ渡し、リフォーム向けの状態診断を取得します。

リクエスト:

```json
{
  "type":"analyze_photo",
  "token":"string",
  "sessionId":"uuid",
  "photoId":"uuid",
  "key":"uploads/{userId}/{sessionId}/{uuid}-bathroom.jpg",
  "focus":"浴室の壁と床を中心に見てほしい"
}
```

レスポンス:

```json
{
  "sessionId":"uuid",
  "photoId":"uuid",
  "analysis":{
    "items":[
      {"name":"壁紙（クロス）","finding":"継ぎ目の浮き・黄ばみが見られます","severity":"中度"}
    ],
    "summary":"優先すべき対応の説明",
    "source":"ai"
  }
}
```

`key`は認証ユーザーが所有する`uploads/{userId}/`配下に限ります。`focus`は任意の自然言語で、ユーザーが特に確認してほしい箇所を指定します。分析結果は対象写真レコードの`analysis`属性と`analyzed_at`属性にも保存します。

### diagnosis_chat

初回分析後も、同じS3画像を参照しながらユーザーが自然言語で追加質問できます。

```json
{
  "type":"diagnosis_chat",
  "token":"string",
  "key":"uploads/{userId}/{sessionId}/{uuid}-bathroom.jpg",
  "question":"浴室の壁紙は張り替えたほうがいい？",
  "messages":[]
}
```

`messages`には直前までの診断に関する会話を最大8件送ります。回答も画像から確認できる範囲の参考情報とし、原因や安全性は断定しません。

### save_photo

リクエスト:

```json
{
  "type":"save_photo",
  "token":"string",
  "sessionId":"uuid",
  "key":"uploads/{userId}/{sessionId}/{uuid}-bathroom.jpg",
  "filename":"bathroom.jpg",
  "content_type":"image/jpeg"
}
```

LambdaがS3の`head_object`でアップロード済みオブジェクトを確認し、DynamoDBへ写真メタデータを保存します。

レスポンス:

```json
{
  "photo": {
    "id":"uuid",
    "sessionId":"uuid",
    "key":"uploads/{userId}/{sessionId}/{uuid}-bathroom.jpg",
    "downloadUrl":"https://s3..."
  }
}
```

### create_download_url

リクエスト:

```json
{"type":"create_download_url","token":"string","key":"uploads/{userId}/..."}
```

許可されるキーの接頭辞は、`uploads/{userId}/`、`generated/{userId}/`、`proposals/{userId}/`です。

レスポンス:

```json
{"download_url":"https://s3...","expires_in":900}
```

## 8. 画像生成API

### generate_image

「施工後イメージを生成」ボタン押下時に呼び出すAPIです。
画像生成処理はLambdaからOpenAI画像生成APIを呼び出して実行し、生成画像をS3へ保存します。

```json
{
  "type": "generate_image",
  "token": "string",
  "sessionId": "uuid",
  "prompt": "明るく開放感のある浴室にリフォーム",
  "sourceImageKey": "uploads/{userId}/{sessionId}/before.jpg",
  "referenceImageKey": "uploads/{userId}/{sessionId}/reference.jpg"
}
```

#### リクエスト項目

| 項目 | 必須 | 内容 |
|---|---:|---|
| `type` | 必須 | `generate_image`固定 |
| `token` | 必須 | 認証トークン |
| `sessionId` | 必須 | 対象相談セッションのID |
| `prompt` | 必須 | 生成するリフォーム内容・希望。Lambda側で長さを制限する |
| `sourceImageKey` | 必須 | 現状写真のS3キー。ユーザー所有キーであることを確認する |
| `referenceImageKey` | 任意 | 参考画像のS3キー。指定時はスタイル参考画像として使用する |

画像ファイル本体はAPIにMultipartで直接送らず、先に`create_upload_url`でS3へアップロードし、S3キーを渡します。

#### 処理フロー

1. フロントエンドで生成ボタンを押下
2. `generate_image`をAPI Gateway経由でLambdaへ送信
3. Lambdaが`sessionId`とS3キーの所有権を確認
4. LambdaがS3から現状写真・参考画像を取得
5. LambdaがOpenAI画像生成APIを呼び出す
6. 生成画像を`generated/{userId}/{sessionId}/{uuid}.png`へ保存
7. 生成画像のメタデータをDynamoDBへ保存
8. 生成画像の署名付きURLをレスポンスで返す

#### 成功レスポンス: 200

```json
{
  "sessionId": "uuid",
  "image": {
    "id": "uuid",
    "key": "generated/{userId}/{sessionId}/{uuid}.png",
    "downloadUrl": "https://s3...",
    "contentType": "image/png",
    "createdAt": 1710000000
  },
  "usage": {
    "count": 1,
    "limit": 10,
    "remaining": 9
  }
}
```

#### エラー

| ステータス | 内容 |
|---:|---|
| 400 | 必須項目不足、入力形式不正 |
| 401 | 認証失敗 |
| 403 | S3キーがユーザー所有でない |
| 404 | セッションまたは入力画像が存在しない |
| 429 | 画像生成回数の上限超過 |
| 502/503 | OpenAIまたは画像生成処理の一時的な失敗 |

> 注: `generate_image`は設計上確定済みですが、Lambdaの分岐処理・OpenAI呼び出し・生成画像保存は未実装です。

## 9. 担当者相談API

### handoff

リクエスト:

```json
{
  "type":"handoff",
  "token":"string",
  "data":{
    "name":"山田太郎",
    "contact":"taro@example.com",
    "sessionId":"uuid",
    "summary":"相談内容",
    "photoKeys":[],
    "estimate":{}
  }
}
```

現行実装では`data`の中身を検証せず、そのままDynamoDBの`data`属性へ保存します。送信元・送信先のSES設定がある場合だけメールを送信します。

レスポンス:

```json
{"ok":true,"status":"received"}
```

## 10. 管理者PIN API

### create_guest_pin

リクエスト:

```json
{"type":"create_guest_pin","token":"admin-token","label":"デモ用","days":7,"max_uses":30}
```

- `days`: 1〜30日に制限
- `max_uses`: 1〜100回に制限

レスポンス:

```json
{"pin":"1234","label":"デモ用","max_uses":30,"expires_at":1710000000000}
```

### get_guest_pins

レスポンスはPIN情報の配列です。

```json
[
  {"id":"1234","pin":"1234","label":"デモ用","use_count":0,"max_uses":30,"expires_at":1710000000000,"is_active":true}
]
```

### delete_guest_pin

リクエスト:

```json
{"type":"delete_guest_pin","token":"admin-token","id":"1234"}
```

レスポンス:

```json
{"ok":true}
```

## 11. 施工事例API

### save_case

リクエスト:

```json
{
  "type":"save_case",
  "token":"string",
  "title":"浴室リフォーム事例",
  "room":"bath",
  "style":"modern",
  "budget_range":"100万円〜",
  "description":"説明",
  "image_key":"uploads/{userId}/...",
  "image_data":""
}
```

`title`と`room`は必須です。`image_key`を指定した場合はユーザー所有の`uploads/{userId}/`配下である必要があります。`image_data`は700,000文字以下です。

レスポンス:

```json
{"ok":true,"case":{"pk":"USER#...","sk":"CASE#...","id":"uuid","title":"...","room":"...","style":"...","budget_range":"...","description":"...","image_data":"","image_key":"...","created_at":1710000000}}
```

### get_cases

リクエスト:

```json
{"type":"get_cases","token":"string","room":"bath","style":"modern"}
```

`room`または`style`を空にすると、その条件では絞り込みません。`image_key`がある場合はレスポンスに署名付き`image_url`が追加されます。

### delete_case

リクエスト:

```json
{"type":"delete_case","token":"string","id":"uuid"}
```

レスポンス:

```json
{"ok":true}
```

## 12. 保存データ形式

### DynamoDB共通

- テーブル名: 環境変数`TABLE_NAME`
- パーティションキー: `pk`（文字列）
- ソートキー: `sk`（文字列）
- ユーザーデータの`pk`: `USER#{tokenのsub}`

### セッション

```json
{
  "pk":"USER#{userId}",
  "sk":"SESSION#{sessionId}",
  "session_id":"uuid",
  "status":"active",
  "message_count":0,
  "handoff_status":"not_requested",
  "created_at":1710000000,
  "updated_at":1710000000,
  "schema_version":1
}
```

### チャットメッセージ

```json
{
  "pk":"USER#{userId}",
  "sk":"SESSION#{sessionId}#MESSAGE#{nanosecond}",
  "session_id":"uuid",
  "role":"user|assistant",
  "content":"本文",
  "created_at":1710000000,
  "schema_version":1
}
```

### 写真

```json
{
  "pk":"USER#{userId}",
  "sk":"PHOTO#{photoId}",
  "id":"uuid",
  "session_id":"uuid",
  "s3_key":"uploads/{userId}/{sessionId}/{uuid}-{filename}",
  "filename":"bathroom.jpg",
  "content_type":"image/jpeg",
  "size":123456,
  "created_at":1710000000,
  "schema_version":1
}
```

セッション側には`photo_ids`配列も追加されます。

### 担当者相談受付

```json
{
  "pk":"USER#{userId}",
  "sk":"HANDOFF#{nanosecond}",
  "data":{},
  "created_at":1710000000
}
```

### 施工事例

`pk=USER#{userId}`、`sk=CASE#{uuid}`で保存します。

## 13. S3キー形式

| データ | 現行キー形式 |
|---|---|
| アップロードファイル | `uploads/{userId}/{sessionIdまたはunattached}/{uuid}-{safeFilename}` |
| 生成画像 | `generated/{userId}/...`を取得APIでは許可しているが、生成・保存処理は未実装 |
| 提案PDF | `proposals/{userId}/...`を取得APIでは許可しているが、PDF保存処理は未実装 |

`safeFilename`はパス部分を除去し、英数字・`.`・`_`・`-`のみを残して最大120文字にします。

## 14. HTTPステータス一覧

| ステータス | 現行の意味 |
|---:|---|
| 200 | 正常終了 |
| 201 | セッション・写真の作成成功 |
| 204 | CORSのOPTIONS応答 |
| 400 | 入力不正、未対応`type`、必須項目不足 |
| 401 | 認証失敗、PIN不正、Cognitoセッション不正 |
| 403 | 所有権違反、管理者権限不足 |
| 404 | セッション・写真・PIN・事例が存在しない |
| 409 | アーカイブ済みセッションへの操作 |
| 413 | 施工事例画像データが大きすぎる |
| 429 | チャット利用上限超過 |
| 503 | OpenAIが一時利用不可 |
| 500 | 想定外例外 |

## 15. 現行実装で残っている注意点

1. `generate_image`の`type`は確定済みですが、生成処理と生成画像保存は未実装です。
2. PDFはブラウザで生成・ダウンロードしており、S3保存APIは未実装です。
3. フロントエンドの担当者相談フォームは、現状`handoff` APIを呼び出していません。
4. `save_session`は新しいセッション構造とは別の旧形式です。
5. `handoff.data`の正式な内部項目は未検証です。
6. エラー形式は文字列で統一されていますが、フロント側には`error.message`を想定する箇所があります。
7. ページング、冪等性キー、保存期間、削除ポリシーは未定義です。
