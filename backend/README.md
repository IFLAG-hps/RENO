# RENO MVP backend

`template.yaml` を AWS SAM でデプロイするためのバックエンドです。画像生成はSQS経由の非同期処理とし、API Gatewayのタイムアウトに影響されない構成にしています。

## 構成

- API Gateway → API Lambda
- SQS → 画像生成Worker Lambda（失敗時はDLQ）
- S3: 画像、生成画像、PDF
- DynamoDB: セッション、相談履歴、施工事例、画像診断結果
- Cognito User Pool: 管理者ログイン
- OpenAI Responses API: チャット（`OPENAI_API_KEY` と `OPENAI_MODEL` を設定した場合）
- SES: 担当者への相談受付メール（`SES_FROM_EMAIL` と `SES_TO_EMAIL` を設定した場合）
- CloudWatch Logs: Lambda の標準ログ

画像生成開始APIはジョブIDを返し、フロントエンドはステータスAPIをポーリングします。Workerは最大900秒実行でき、SQSのVisibility Timeoutは5400秒です。

## デプロイ

```bash
sam build --template-file backend/template.yaml
sam deploy --guided --template-file .aws-sam/build/template.yaml
```

`UnlimitedMode` は利用回数を調整するための設定です。利用回数の具体的な調整は後続対応とし、現時点では検証用設定として扱います。

最低限、`OpenAIApiKey`、`OpenAIModel`、`SesFromEmail`、`SesToEmail` を環境に合わせて入力してください。APIキーはブラウザへ配置せず、Lambdaの環境変数としてのみ使用します。デプロイ後に出力された `ApiUrl` を `assets/reno-config.js` の `apiUrl` に設定します。
