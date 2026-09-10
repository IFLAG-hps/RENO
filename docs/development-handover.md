# RENO 開発引き継ぎ書

最終更新: 2026-09-10

## 1. システム概要

フロントエンドは React 19 + Vite で構成し、`react/src/` をビルドして `dist/` に出力します。画面の主な実装は `react/src/migrated/` にあり、メイン画面のイベント・API連携は `main-runtime.js` に集約されています。

バックエンドは Python 3.12 の AWS Lambda です。SAMテンプレート（`backend/template.yaml`）から API Gateway、Lambda、DynamoDB、S3、Cognito、SQS/DLQ を構成します。OpenAI Responses APIは会話・画像診断・画像生成に利用し、SESは担当者への相談通知に利用します。

## 2. 重要ファイル

| 目的 | ファイル |
| --- | --- |
| React入口・パス分岐 | `react/src/App.jsx` |
| メイン画面とクライアント動作 | `react/src/migrated/main.jsx`, `react/src/migrated/main-runtime.js` |
| AI/API処理 | `backend/src/handler.py` |
| ローカルAPI | `backend/local_server.py` |
| AWS構成 | `backend/template.yaml`, `infra/` |
| 設定生成 | `scripts/generate-config.mjs` |
| ビルド | `scripts/build-react.mjs` |
| 単体・E2Eテスト | `test/`, `backend/tests/`, `e2e/` |
| CI/CD | `.github/workflows/` |

## 3. ローカル開発

前提は Node.js/npm、Python、Docker Desktopです。依存関係をインストールした後、`.env.example`を`.env`へコピーしてローカル値を設定します。`.env`はコミットしません。

```powershell
npm install
npm run build:config
.\scripts\start-local-backend.ps1
```

別のPowerShellでフロントエンドを起動します。

```powershell
npm run build:react
npm run serve:react
```

通常は `http://127.0.0.1:4173/`、ローカルPINは `5678` です。チャットの画面確認は `RENO_MOCK_CHAT=true`、実API確認は `false` とし、実API確認時だけ`OPENAI_API_KEY`を環境変数へ設定します。

停止:

```powershell
docker stop reno-api reno-localstack
```

## 4. 検証コマンド

```powershell
npm run test:unit
npm run test:e2e:local
npm run test:workflows
```

`test:e2e` はライブサイト用ケースを含みます。変更内容に応じて、React、バックエンド、LocalStack、E2Eを確認してください。

## 5. ブランチ・デプロイ運用

作業ブランチは `[Issue番号]-<概要>` 形式で作成します。`origin`（現在は `IFLAG-hps/RENO`）で実装・検証し、CI成功後に `fork`（移管後は `IFG-IP/RENO`）へ同名ブランチを同期します。移管先の `dev` → `staging` → `main` はPRで昇格し、直接pushしません。

環境とAWSスタックは次の対応です。

| ブランチ | 用途 | スタック |
| --- | --- | --- |
| `dev` | 開発確認 | `reno-mvp-dev` |
| `staging` | 受入確認 | `reno-mvp-staging` |
| `main` | 公開 | `reno-mvp-prod` |

詳細は [環境昇格ワークフロー](./workflows/environment-workflow.md)、[3スタック環境設定](./deployment/three-stack-setup.md)、[GitHub Actions運用](./operations/github-actions運用.md)を参照してください。

## 6. 移管チェックリスト（DaisukeShirai → IFG-IP）

1. 移管先 `IFG-IP` に `RENO` が存在しないこと、移管権限と請求・組織ポリシーを確認する。
2. GitHubの **Settings > General > Danger Zone > Transfer ownership** から `IFG-IP` へ移管する。移管後は旧URLからのリダイレクト有無を確認する。
3. 移管先で、メンバー権限、branch protection、Rulesets、Actions、Environments、Secrets、Variablesを再確認する。
4. `IFLAG-hps/RENO` の `FORK_REPO_TOKEN` を、移管先リポジトリの必要ブランチへ書き込める最小権限で再発行・更新する。
5. Amplifyの接続リポジトリを `IFG-IP/RENO` に変更し、`dev`、`staging`、`main`の環境変数を再確認する。
6. AWS側の既存スタック、S3、DynamoDB、Cognito、SESを削除せず、各環境の出力値と接続先を確認する。
7. ローカルのremoteを更新する。

```powershell
git remote set-url fork https://github.com/IFG-IP/RENO.git
git remote -v
```

8. Actionsで同期、テスト、フロントエンド候補ビルド、バックエンドデプロイを順に実行し、各環境URLでログイン・相談・写真診断・履歴・受付を確認する。

## 7. 移管後に必ず確認する固定参照

`DaisukeShirai/RENO` を参照するworkflow、検証スクリプト、運用文書、Amplify設定が残っていないことを確認します。GitHub CLIを使う場合は、移管先への有効な認証後に `gh auth status` で確認します。秘密値はIssue、ログ、ドキュメントへ記載しません。

## 8. 障害対応の基本

- フロントだけ更新されない：Amplifyのビルドログ、対象ブランチ、`RENO_API_URL`、`COGNITO_CLIENT_ID`を確認。
- APIが失敗する：API Gateway/LambdaのCloudWatch Logs、Lambda環境変数、IAMロール、CORSを確認。
- 画像生成が終わらない：SQSの滞留数、DLQ、Worker Lambdaのログを確認。API成功は生成完了ではなくジョブ登録完了の場合があります。
- ログインできない：Cognito User Pool、Client ID、ユーザーの初回パスワード変更、時刻ずれを確認。

