# RENO 現行AWSアーキテクチャ

現行の `backend/template.yaml` および検証環境を基準にした構成図です。

![RENO 現行AWSアーキテクチャ](./aws-current-architecture.svg)

## 現行構成

| サービス | 現在の役割 |
|---|---|
| Amplify / CloudFront | 静的フロントエンド配信 |
| API Gateway | `POST /agent` のAPI入口 |
| Lambda | API受付、チャット、画像診断、見積もり、相談受付、画像生成Worker |
| Cognito | 管理者・利用者の認証、トークン発行 |
| DynamoDB | 会話履歴、相談、見積もり、利用状態 |
| S3 | 写真、生成画像、PDFの保存 |
| SQS / DLQ | 画像生成ジョブの非同期実行、失敗ジョブの退避 |
| SES | 担当者へのメール通知（設定時） |
| 外部AI API | OpenAI Responses APIによる会話・画像診断 |

## 画像生成の非同期フロー

1. API Gateway経由のAPI Lambdaが入力画像の所有権を確認し、画像生成ジョブをDynamoDBへ保存する。
2. API LambdaがジョブをSQSへ送信し、ジョブIDをフロントエンドへ返す。
3. SQSが画像生成Worker Lambdaを起動する。WorkerはOpenAI画像生成APIを呼び出し、生成画像をS3へ保存する。
4. WorkerがDynamoDBのジョブ状態を`completed`または`failed`へ更新する。
5. フロントエンドがジョブ状態APIをポーリングし、完了時に署名付きS3 URLを表示する。

SQSのVisibility TimeoutはWorkerの最大実行時間を考慮して設定し、3回の受信失敗後はDLQへ移動する。

## 現時点で未導入のもの

- PostgreSQL／Aurora（素材カタログDBは導入予定）
- OpenSearch等の全文・ベクトル検索基盤
- EventBridgeなどの業務イベント連携

素材カタログDBを導入する場合は、まずDynamoDBまたは検証用SQLiteで開始し、要件が固まった段階でPostgreSQL等への移行を判断します。
