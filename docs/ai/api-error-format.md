# RENO API 共通エラー形式

## 1. 目的

RENOの全APIでエラー形式を統一し、フロントエンドがエラーコード、再試行可否、入力エラーを機械的に判定できるようにする。

## 2. 標準形式

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "認証に失敗しました",
    "retryable": false,
    "requestId": "request-id"
  }
}
```

### 必須項目

| 項目 | 型 | 内容 |
|---|---|---|
| `error` | object | エラー情報の親オブジェクト |
| `error.code` | string | プログラムが判定する固定コード |
| `error.message` | string | ユーザーへ表示可能なメッセージ |

### 推奨項目

| 項目 | 型 | 内容 |
|---|---|---|
| `error.retryable` | boolean | 同じリクエストを再試行できるか |
| `error.requestId` | string | CloudWatchログ照合用の識別子 |

### 条件付き項目

| 項目 | 用途 |
|---|---|
| `error.details` | 入力エラーのフィールド名・理由 |
| `error.retryAfter` | 429などで再試行まで待つ秒数 |

## 3. 再試行ルール

### `retryable: false`

- 入力値不正
- 必須項目不足
- 認証失敗
- 権限不足
- 対象リソース不存在
- S3キー不正・所有権違反
- ファイルサイズ・形式超過
- AWSの権限設定ミス
- APIキー未設定などの設定不備

### `retryable: true`

- Lambda、S3、DynamoDBなどの一時的なAWS障害
- OpenAIなど外部AIサービスの一時障害
- ネットワークエラー、タイムアウト
- 利用制限超過（429）

同じ処理を複数回実行すると重複する可能性があるAPI（画像生成、PDF保存、相談受付）は、実装時に`idempotencyKey`またはリクエストIDによる重複防止を検討する。

## 4. エラーコード

| code | HTTP | retryable | 用途 |
|---|---:|---:|---|
| `INVALID_REQUEST` | 400 | false | 必須項目不足、入力形式不正 |
| `UNAUTHORIZED` | 401 | false | 認証失敗 |
| `FORBIDDEN` | 403 | false | 権限不足、所有権違反 |
| `NOT_FOUND` | 404 | false | セッション、画像、事例などが存在しない |
| `CONFLICT` | 409 | false | 状態上の競合 |
| `RATE_LIMITED` | 429 | true | 利用制限超過。必要に応じて`retryAfter`を返す |
| `AI_SERVICE_ERROR` | 502 | true | AIサービスの一時的な失敗 |
| `SERVICE_UNAVAILABLE` | 503 | true | AWS、ネットワークなどの一時的な障害 |
| `INTERNAL_ERROR` | 500 | false | 想定外例外、設定不備 |

## 5. セキュリティ方針

- AWS SDKの例外内容、APIキー、認証情報、内部パスはレスポンスに含めない。
- `message`はユーザー表示用とし、詳細な原因はCloudWatchログへ記録する。
- `requestId`をログとレスポンスで共通化する。

## 6. 移行方針

現行Lambdaは`{"error":"..."}`形式を返しているため、実装時に本形式へ移行する。移行後はフロントエンドも`error.code`、`error.message`、`error.retryable`を参照する。
