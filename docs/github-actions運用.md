# GitHub Actions運用

## 現在の公開構成

フロントエンドはAmplify HostingのGitHubリポジトリ連携で公開します。`main` ブランチへのpushを契機にAmplifyがビルド・デプロイします。GitHub ActionsからGitHub PagesやS3へ直接配信するフローは使用しません。

```text
GitHub main push
      ↓
Amplify Hosting（amplify.ymlでReact/Viteをビルド）
      ↓
Amplify管理の配信基盤
      ↓
API Gateway → Lambda → OpenAI API / DynamoDB / S3
```

## フロントエンドのビルド

リポジトリ直下の `amplify.yml` を使用します。

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

`RENO_API_URL`、`RENO_MOCK_CHAT`、`COGNITO_CLIENT_ID` などの公開可能な設定値はAmplifyの環境変数で管理します。OpenAI APIキーやトークン秘密鍵はフロントエンドへ渡さず、バックエンドのSecretsとして管理します。

## Actionsの使い分け

### `main-deploy.yml`

LocalStack、SAM、React、PlaywrightのCIを実行します。AWSへの実デプロイは、手動実行で入力を明示的に有効化した場合だけ行います。

`main-deploy.yml` は、CIに加えて、手動入力で本番デプロイを実行できます。デプロイ後は、CloudFormationの出力URLを使ったAPIスモークテストと、実APIを使うフロントエンドE2Eを実行します。

### `sync-fork.yml`

`main-deploy.yml`のテストが成功した後に自動実行し、テスト済みの`main`を`DaisukeShirai/RENO/main`へ反映します。Amplifyはfork側の`main`を参照するため、この反映を起点にAmplifyがビルド・公開します。

実行には、上流リポジトリのActions Secret `FORK_REPO_TOKEN` が必要です。トークンにはforkリポジトリの`main`へのcontents書き込み権限を付与します。

## 操作手順

## 標準の作業フロー

今後の変更は、次の順序で進めます。

1. 作業ブランチを作成し、作業ブランチ上で編集する。
2. 変更内容を確認し、プロジェクトの`main`ブランチへマージする。
3. `main`の状態でローカルテストを実行する。
4. テスト成功後、`DaisukeShirai/RENO`の`main`へマージまたはpushする。
5. Amplify Hostingのビルド結果と公開URLを確認する。

Amplifyは`DaisukeShirai/RENO`の`main`を参照するため、fork側の`main`への反映が公開トリガーになります。GitHub Pages用のworkflowは使用しません。

ローカルテストでは、少なくとも次を実行します。

```text
npm run test:workflows
npm run test:e2e
```

### 画面を公開・更新する場合

1. `main` へpushする。
2. Amplify Hostingのビルド結果を確認する。
3. Amplifyの公開URLで画面、チャット、画像処理を確認する。

### バックエンドを更新する場合

1. `CI: Test and optionally deploy backend` を `deploy_aws=true` で手動実行する。
2. `reno-mvp` の更新成功とデプロイ後の実API検証を確認する。
3. API URLやCognitoクライアントIDが変わった場合はAmplifyの環境変数を更新し、再デプロイする。

GitHub Pages用の `deploy-pages.yml` は `.github/workflows/` から移動し、[アーカイブ](archive/workflows/deploy-pages.yml) として保存しています。Actions画面には表示されません。
