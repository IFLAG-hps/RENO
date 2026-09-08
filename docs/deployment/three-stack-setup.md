# 3スタック環境の設定手順

## 構成

| Fork先Gitブランチ | Amplify環境 | CloudFormationスタック | 用途 |
| --- | --- | --- | --- |
| `dev` | 開発用プレビュー | `reno-mvp-dev` | 日常開発と結合確認 |
| `staging` | レビュー用プレビュー | `reno-mvp-staging` | 上長の受入確認 |
| `main` | 動作デモ・公開URL | `reno-mvp-prod` | 承認済みの公開版 |

各CloudFormationスタックは、独立したDynamoDBテーブル、S3バケット、Cognito User Pool、API Gateway、Lambdaを作成する。環境間で相談データやアップロード画像を共有しない。

この3環境は機能フェーズを分けるものではない。同一コミットを`dev`で開発確認、`staging`で受入確認、`main`で公開するための昇格先である。Phase 2・Phase 3の機能も、同じ順序で全環境へ進める。

## GitHub Environments

Fork先リポジトリ（`DaisukeShirai/RENO`）の **Settings > Environments** で、次の3環境を作成する。

| Environment | デプロイ元ブランチ | 承認設定 |
| --- | --- | --- |
| `dev` | `dev` | 不要 |
| `staging` | `staging` | 上長レビューを推奨 |
| `production` | `main` | 上長レビューを必須 |

各Environmentに同名の値を設定する。秘密値はSecrets、公開してよい設定はVariablesに登録する。

### Secrets

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `OPENAI_API_KEY`
- `TOKEN_SECRET`

### Variables

- `ADMIN_EMAIL`
- `DEMO_PIN`
- `UNLIMITED_MODE`
- `OPENAI_MODEL`
- `SES_FROM_EMAIL`
- `SES_TO_EMAIL`

`dev`と`staging`のSESは、検証用アドレスまたは空値にする。本番の宛先・送信元は`production`だけに設定する。

`main`へのPR承認だけで本番を自動デプロイする場合は、`production` Environmentに追加の必須レビューを設定しない。PR承認とデプロイ承認を分けたい場合だけ、`production` Environmentの必須レビューを有効にする。

## リポジトリ間同期用のSecret

| 設定先 | Secret | 用途 |
| --- | --- | --- |
| Fork元（`IFLAG-hps/RENO`） | `FORK_REPO_TOKEN` | CI成功した`feature/*`をFork先へ同期 |

トークンは、Fork先リポジトリの`feature/*`へContents書き込みできる最小権限に限定する。

## ブランチ保護

Fork先リポジトリの **Settings > Branches** で、`main`、`staging`、`dev` に次のルールを設定する。

- Pull Requestを必須化する
- `CI: Validate application` の成功を必須化する
- `main` と `staging` は承認レビューを必須化する
- force pushとブランチ削除を禁止する

## Amplifyの設定

1. AmplifyでFork先リポジトリに`dev`、`staging`、`main`を接続する。
2. 各ブランチの環境変数に、それぞれのスタック出力値を設定する。

| Amplifyブランチ | `RENO_API_URL` | `COGNITO_CLIENT_ID` | `RENO_MOCK_CHAT` |
| --- | --- | --- | --- |
| `dev` | `reno-mvp-dev` の `ApiUrl` | devの `UserPoolClientId` | `false` |
| `staging` | `reno-mvp-staging` の `ApiUrl` | stagingの `UserPoolClientId` | `false` |
| `main` | `reno-mvp-prod` の `ApiUrl`、またはデモ中は未設定 | productionの `UserPoolClientId`、または未設定 | デモ中は `true` |

3. デプロイ後に各URLで、ブラウザコンソールに環境間違いのAPI URLが出ていないことを確認する。

## 初回デプロイ

1. Fork元の`main`へ、このワークフロー設定を一度だけpushする。その後はFork元`main`をアーカイブとして保護する。
2. Fork先の`main`へ同じ設定を一度だけ反映する。以後の公開版はFork先だけで管理する。
3. Fork先リポジトリで`dev`と`staging`をFork先`main`から作成する。
4. Fork先の各EnvironmentへSecrets・Variablesを設定する。
5. Fork先の`dev`、`staging`、`main`をAmplifyへ接続する。
6. Fork先の`dev`、`staging`、`main`へPRをマージすると、対象スタックが自動作成・更新される。
7. Actionsの出力から各環境の`ApiUrl`と`UserPoolClientId`を取得し、対応するAmplify環境変数へ設定する。
8. Fork元のFeatureがCI成功後にFork先の同名Featureへ同期されることを確認する。

## 運用上の注意

- `dev`への自動デプロイには、破壊的なスキーマ変更を含めない。変更前にバックアップ・移行手順を準備する。
- `staging`と`production`は、GitHub Environmentの承認を通してから更新する。
- CloudFormationスタックを削除する前に、S3の保存データとDynamoDBの保持方針を確認する。
- 本番のOpenAI・SES設定値は、`dev`や`staging`と共有しない。
- PR本文には対象環境のプレビューURL、確認項目、ロールバック方法を記載する。
