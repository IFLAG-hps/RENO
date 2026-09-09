# GitHub Actions一覧

フロントエンドはAmplify Hostingのリポジトリ連携で候補をビルドし、GitHub ActionsがCI成功後にblue / greenの公開先を切り替えます。リポジトリ直下の `amplify.yml` にビルド設定があります。

| 表示名 | ファイル | いつ使うか | 実行内容 |
|---|---|---|---|
| `CI: Test and optionally deploy backend` | `main-deploy.yml` | Pull Request、blue/greenリリースからの起動、または手動実行 | LocalStack、SAM、ローカルE2E。手動デプロイ時は本番APIスモークと実APIフロントE2Eも実行 |
| `DEPLOY: Blue/green frontend` | `frontend-blue-green.yml` | fork側の`dev`／`staging`／`main`へのpush、または手動実行 | Amplify候補ビルドとCIを並列実行し、成功後にカスタムドメインを切替。失敗時は現行版を維持 |
| `SYNC: Merge tested main to fork` | `sync-fork.yml` | CI成功後に自動実行 | テスト済みの`main`を`DaisukeShirai/RENO/main`へ反映 |

## 使い分け

- 画面を公開・更新する：対象環境ブランチへpushし、`DEPLOY: Blue/green frontend`の成功を確認する
- バックエンドを本番へ反映する：`CI: Test and optionally deploy backend` を `deploy_aws=true` で手動実行する
- テストを確認する：`CI: Test and optionally deploy backend` の結果を確認する

## 標準の作業フロー

1. 作業ブランチで編集する。
2. プロジェクトの`main`へマージする。
3. `main`へのpushでCIを実行する。
4. 本番反映時はActionsから同じWorkflowを`deploy_aws=true`で実行する。
5. デプロイ後のAPI検証とAmplify Hostingのビルド・公開URLを確認する。

Amplifyはfork側の環境ブランチを候補ビルドの入力にします。公開ドメインは、CIと候補デプロイの成功後だけ切り替わります。

## fork同期用Secret

`sync-fork.yml`を有効にするには、上流リポジトリ（`IFLAG-hps/RENO`）のActions Secretに`FORK_REPO_TOKEN`を登録します。トークンには`DaisukeShirai/RENO`のIssueブランチへcontentsを書き込む権限が必要です。

同期が成功すると、origin側の`promote-tested-issue-branch.yml`が同期済みのIssueブランチを検証します。検証に成功した場合だけ、Workflowの`GITHUB_TOKEN`で同ブランチを`origin/main`へマージします。fork側のSecretは不要です。

## Amplify Hostingの設定

1. Amplify Hostingで候補用の`release-blue`と`release-green`を接続し、カスタムドメインをどちらか一方へ関連付ける。
2. 各候補ブランチの環境変数に `RENO_API_URL`、`RENO_MOCK_CHAT=false`、必要に応じて `COGNITO_CLIENT_ID` を設定する。
3. 公開ブランチと候補ブランチの自動ビルドを無効にし、Environment変数・Secretを[ブルーグリーン設定](../../docs/deployment/amplify-blue-green.md)に従って登録する。

`amplify.yml` は `npm ci` と `npm run build:react` を実行し、生成された `dist` を公開します。OpenAI APIキーなどの秘密値はフロントエンド環境変数へ設定しません。

バックエンドのAPI URLやCognitoクライアントIDが変わった場合は、Amplifyの環境変数を更新して再デプロイします。
