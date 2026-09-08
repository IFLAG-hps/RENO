# GitHub Actions一覧

フロントエンドはGitHub Actionsから直接公開せず、Amplify Hostingのリポジトリ連携で公開します。リポジトリ直下の `amplify.yml` にビルド設定があります。

| 表示名 | ファイル | いつ使うか | 実行内容 |
|---|---|---|---|
| `CI: Test and optionally deploy backend` | `main-deploy.yml` | 通常のpush・Pull Request | LocalStack、SAM、React、Playwrightのテスト。AWSデプロイは手動入力時のみ |
| `PROD: Deploy backend to AWS (SAM)` | `deploy-backend.yml` | AWSバックエンドを更新するとき | `reno-mvp` のLambda、API Gateway、DynamoDB、S3、Cognitoをデプロイ |
| `REUSABLE: LocalStack smoke tests` | `localstack-test.yml` | 単独では使わない | 他のWorkflowから呼び出す共通テスト |
| `SYNC: Merge tested main to fork` | `sync-fork.yml` | CI成功後に自動実行 | テスト済みの`main`を`DaisukeShirai/RENO/main`へ反映 |

## 使い分け

- 画面を公開・更新する：Amplify Hostingの対象ブランチへpushする
- バックエンドを変更する：`PROD: Deploy backend to AWS (SAM)` を手動実行する
- テストを確認する：`CI: Test and optionally deploy backend` の結果を確認する
- `REUSABLE: LocalStack smoke tests` は直接実行しない

## 標準の作業フロー

1. 作業ブランチで編集する。
2. プロジェクトの`main`へマージする。
3. `main`の状態でローカルテストを実行する。
4. テスト成功後、`DaisukeShirai/RENO`の`main`へマージまたはpushする。
5. Amplify Hostingのビルドと公開URLを確認する。

Amplifyはfork側の`RENO/main`を参照します。画面の公開・更新は、fork側`main`への反映を起点にAmplifyが自動実行します。

## fork同期用Secret

`sync-fork.yml`を有効にするには、上流リポジトリ（`IFLAG-hps/RENO`）のActions Secretに`FORK_REPO_TOKEN`を登録します。トークンには`DaisukeShirai/RENO`のIssueブランチへcontentsを書き込む権限が必要です。

同期が成功すると、origin側の`promote-tested-issue-branch.yml`が同期済みのIssueブランチを検証します。検証に成功した場合だけ、Workflowの`GITHUB_TOKEN`で同ブランチを`origin/main`へマージします。fork側のSecretは不要です。

## Amplify Hostingの設定

1. Amplify HostingでこのGitHubリポジトリの `main` ブランチを接続する。
2. アプリの環境変数に `RENO_API_URL`、`RENO_MOCK_CHAT=false`、必要に応じて `COGNITO_CLIENT_ID` を設定する。
3. 保存後、Amplifyの自動ビルド・公開を実行する。

`amplify.yml` は `npm ci` と `npm run build:react` を実行し、生成された `dist` を公開します。OpenAI APIキーなどの秘密値はフロントエンド環境変数へ設定しません。

バックエンドのAPI URLやCognitoクライアントIDが変わった場合は、Amplifyの環境変数を更新して再デプロイします。
