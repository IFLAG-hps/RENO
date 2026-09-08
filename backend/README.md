# RENO MVP backend (SQS なし)

`template.yaml` を AWS SAM でデプロイするためのバックエンドです。SQS は使用せず、MVPでは画像診断・画像生成・PDF生成を API Gateway から同期的に Lambda へ渡します。

## 構成

- API Gateway → `app` Lambda
- S3: 画像、生成画像、PDF
- DynamoDB: セッション、相談履歴、施工事例、画像診断結果
- Cognito User Pool: 管理者ログイン
- OpenAI Responses API: チャット（`OPENAI_API_KEY` と `OPENAI_MODEL` を設定した場合）
- SES: 担当者への相談受付メール（`SES_FROM_EMAIL` と `SES_TO_EMAIL` を設定した場合）
- CloudWatch Logs: Lambda の標準ログ

SQS の代わりに同期処理を採用しているため、画像生成などの長時間処理は API Gateway のタイムアウトに収まる軽量な MVP 用です。負荷が増えた段階で `jobType` を別の非同期基盤へ切り出します。

## デプロイ

```bash
sam build --template-file backend/template.yaml
sam deploy --guided --template-file .aws-sam/build/template.yaml
```

`UnlimitedMode` は利用回数を調整するための設定です。利用回数の具体的な調整は後続対応とし、現時点では検証用設定として扱います。

最低限、`OpenAIApiKey`、`OpenAIModel`、`SesFromEmail`、`SesToEmail` を環境に合わせて入力してください。APIキーはブラウザへ配置せず、Lambdaの環境変数としてのみ使用します。デプロイ後に出力された `ApiUrl` を `assets/reno-config.js` の `apiUrl` に設定します。
