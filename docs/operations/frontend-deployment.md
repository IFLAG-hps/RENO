# フロントエンドのデプロイ

## 正式公開：Amplify Hosting + Lambda

フロントエンドはAmplify HostingへGitHubリポジトリを接続して公開します。対象ブランチへのpushでAmplifyが自動ビルド・デプロイします。GitHub Pages、S3、CloudFrontへGitHub Actionsから直接配信するWorkflowは使用しません。

リポジトリ直下の `amplify.yml` がビルド設定です。

```yaml
version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - node scripts/generate-config.mjs
        - npm run build:react
  artifacts:
    baseDirectory: dist
    files:
      - '**/*'
```

Amplifyの環境変数には次を設定します。

- `RENO_API_URL`：API Gatewayの `/v1/agent` エンドポイント
- `RENO_MOCK_CHAT`：`false`
- `COGNITO_CLIENT_ID`：Cognito User Pool Client ID

OpenAI APIキーやトークン秘密鍵はフロントエンド環境変数へ設定せず、バックエンドのSecretsへ設定します。

## デプロイ手順

1. Amplify HostingでGitHubリポジトリの `main` ブランチを接続する。
2. 上記の環境変数をAmplifyへ設定する。
3. `main` へpushし、Amplifyのビルドと公開結果を確認する。
4. Amplifyの公開URLでチャット、画像アップロード、画像診断、相談受付を確認する。

バックエンドを先に更新する場合は、GitHub Actionsの `CI: Test and optionally deploy backend` を `deploy_aws=true` で実行します。デプロイ後に実API検証が行われます。API URLまたはCognitoクライアントIDが変わった場合は、Amplifyの環境変数を更新して再デプロイします。

## 本番デプロイのブランチ制限

バックエンドの本番デプロイジョブは `main` ブランチからの実行に限定しています。featureブランチから手動実行した場合は、LocalStackなどのテストだけを実行し、本番デプロイはスキップします。

## バックエンドだけを更新する場合

`CI: Test and optionally deploy backend` を手動実行すると、テスト成功後にLambda、API Gateway、DynamoDB、S3、Cognitoを更新し、デプロイ済みAPIとフロントエンドの接続を検証します。フロントエンドはAmplifyのリポジトリ連携で管理されるため、バックエンド更新時にAWSへ同期する必要はありません。
