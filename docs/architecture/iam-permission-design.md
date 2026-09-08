# RENO IAM権限設計

## 1. 方針

RENOのAWSリソースは、`dev`、`staging`、`production`の環境単位で分離する。
Lambdaの実行ロールには、実行する環境のリソースだけを許可する。

開発者がCLIから3環境を確認・操作するためのユーザーには、3環境分のポリシーをアタッチする。ただし、このユーザーは本番リソースも操作可能になるため、MFAを必須とし、本番削除権限は付与しない。

## 2. 権限の構成

```text
RENODevAccessPolicy
  └ devのDynamoDB・S3・Cognito権限

RENOStagingAccessPolicy
  └ stagingのDynamoDB・S3・Cognito権限

RENOProductionAccessPolicy
  └ productionのDynamoDB・S3・Cognito権限
```

### Lambda実行ロール

| 環境 | ロール | アタッチするポリシー |
|---|---|---|
| dev | `RENODevLambdaExecutionRole` | `RENODevAccessPolicy`、`AWSLambdaBasicExecutionRole` |
| staging | `RENOStagingLambdaExecutionRole` | `RENOStagingAccessPolicy`、`AWSLambdaBasicExecutionRole` |
| production | `RENOProductionLambdaExecutionRole` | `RENOProductionAccessPolicy`、`AWSLambdaBasicExecutionRole` |

Lambdaロールには、自環境以外のDynamoDB・S3・Cognitoを許可しない。

### 開発用コマンド実行ユーザー

| ユーザー | アタッチするポリシー |
|---|---|
| `RENODeveloper` | `RENODevAccessPolicy`、`RENOStagingAccessPolicy`、`RENOProductionAccessPolicy` |

このユーザーは3環境のリソース確認・アプリケーション動作確認に使用する。CloudFormationスタックの削除権限は付与しない。将来的にはIAMユーザーではなくIAM Identity CenterのPermission Setへ移行する。

## 3. 環境別アクセスポリシー

### RENODevAccessPolicy

対象リソースはdev環境のARNだけとする。

```text
arn:aws:dynamodb:ap-northeast-1:{account-id}:table/reno-mvp-dev-*
arn:aws:s3:::reno-mvp-dev-*
arn:aws:s3:::reno-mvp-dev-*/*
arn:aws:cognito-idp:ap-northeast-1:{account-id}:userpool/*（devのUser Poolに限定）
```

### RENOStagingAccessPolicy

```text
arn:aws:dynamodb:ap-northeast-1:{account-id}:table/reno-mvp-staging-*
arn:aws:s3:::reno-mvp-staging-*
arn:aws:s3:::reno-mvp-staging-*/*
arn:aws:cognito-idp:ap-northeast-1:{account-id}:userpool/*（stagingのUser Poolに限定）
```

### RENOProductionAccessPolicy

```text
arn:aws:dynamodb:ap-northeast-1:{account-id}:table/reno-mvp-prod-*
arn:aws:s3:::reno-mvp-prod-*
arn:aws:s3:::reno-mvp-prod-*/*
arn:aws:cognito-idp:ap-northeast-1:{account-id}:userpool/*（productionのUser Poolに限定）
```

## 4. 許可する操作

### DynamoDB

```text
dynamodb:GetItem
dynamodb:PutItem
dynamodb:UpdateItem
dynamodb:DeleteItem
dynamodb:Query
dynamodb:Scan
dynamodb:BatchGetItem
dynamodb:BatchWriteItem
dynamodb:DescribeTable
dynamodb:ConditionCheckItem
```

対象は各環境のテーブル本体と、そのインデックスだけとする。

### S3

```text
s3:GetObject
s3:PutObject
s3:DeleteObject
s3:ListBucket
```

`head_object`はS3のオブジェクトメタデータ取得APIであり、IAM上は`s3:GetObject`で許可する。`ListBucket`はバケットARN、その他のオブジェクト操作は`バケットARN/*`を対象にする。必要に応じて、さらに以下のPrefixへ限定する。

```text
uploads/{userId}/*
generated/{userId}/*
proposals/{userId}/*
```

### Cognito

```text
cognito-idp:GetUser
```

管理者ログインでCognitoを使用する場合だけ付与する。`GetUser`はIAM上リソースARNを限定できないため、対象アクションを`GetUser`だけに限定する。ベーシック認証へ完全移行し、Cognitoを使用しない場合は削除する。

### SES

SESは後続対応とする。相談受付メールを有効にする段階で、以下をproductionポリシーへ追加する。

```text
ses:SendEmail
```

送信先・送信元は環境変数で管理し、dev・stagingから本番宛先へ送信しない。

## 5. ロールの信頼ポリシー

Lambda実行ロールの信頼先はLambdaサービスだけに限定する。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"Service": "lambda.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }
  ]
}
```

## 6. 開発用ユーザーの安全対策

- MFAを必須にする
- 本番リソースの削除権限を付与しない
- 長期アクセスキーをソースコードや`.env`へ保存しない
- アクセスキーを発行する場合は用途ごとに分離する
- 本番操作はCloudTrailで追跡できる状態にする
- 将来的にはIAM Identity Centerへ移行する

## 7.1 CloudFormationスタック削除の運用

CloudFormationスタックの削除は、開発用コマンド実行ユーザーでは行わない。
削除が必要な場合は、メインで使用している管理用IAMユーザーへ手動で再認証し、対象スタック名と環境を確認したうえで実行する。

削除前に、以下を確認する。

1. 対象が`dev`または`staging`であることを確認する
2. `production`の場合は、削除理由とバックアップ・保持方針を確認する
3. S3保存データとDynamoDBデータの扱いを確認する
4. CloudFormationの削除対象リソースを確認する
5. 削除操作をCloudTrailで追跡できることを確認する

管理用IAMユーザーには強い権限があるため、MFAを必須とし、日常のCLI操作には使用しない。

## 8. 環境ごとの設定項目

### AWS共通

| 項目 | 設定値 |
|---|---|
| `AWS_REGION` | `ap-northeast-1` |
| AWSアカウントID | 環境のアカウントID |
| スタック名 | `reno-mvp-dev` / `reno-mvp-staging` / `reno-mvp-prod` |

### Lambda環境変数

| 項目 | 管理方法 | 内容 |
|---|---|---|
| `TABLE_NAME` | CloudFormation | 環境別DynamoDBテーブル名 |
| `ASSET_BUCKET` | CloudFormation | 環境別S3バケット名 |
| `OPENAI_API_KEY` | GitHub SecretsまたはSecrets Manager | OpenAI APIキー |
| `OPENAI_MODEL` | GitHub Variables | 使用モデル |
| `SES_FROM_EMAIL` | GitHub Variables | SES送信元。後続対応 |
| `SES_TO_EMAIL` | GitHub Variables | SES送信先。後続対応 |
| `TOKEN_SECRET` | GitHub SecretsまたはSecrets Manager | 現行HMACトークン用秘密鍵 |
| `ADMIN_EMAIL` | GitHub Variables | Cognito管理者メール |
| `DEMO_PIN` | GitHub Variables | デモPIN |
| `UNLIMITED_MODE` | GitHub Variables | 利用上限モード |
| `DEPLOYMENT_ENVIRONMENT` | CloudFormation | `dev` / `staging` / `production` |

### フロントエンド環境変数

| 項目 | 内容 |
|---|---|
| `RENO_API_URL` | 対象環境のAPI Gateway URL |
| `RENO_MOCK_CHAT` | 通常は`false` |
| `COGNITO_CLIENT_ID` | Cognitoを利用する場合の環境別Client ID |

## 9. 現在の本番環境との差分

2026-09-07時点の`reno-mvp-prod`では、Lambda実行ロールに以下が確認されている。

- `AWSLambdaBasicExecutionRole`
- DynamoDB用インラインポリシー

不足している可能性がある権限:

- S3: `GetObject`、`PutObject`、`DeleteObject`
- Cognito: `cognito-idp:GetUser`
- SES: `ses:SendEmail`（後続対応）

まずproduction用のManaged Policyを作成し、Lambda実行ロールへアタッチする。dev・stagingを作成する際も、同じ構成を環境別ARNで適用する。

## 10. 適用順序

1. 環境別のDynamoDB、S3、Cognitoの物理リソース名を確定する
2. `RENODevAccessPolicy`、`RENOStagingAccessPolicy`、`RENOProductionAccessPolicy`を作成する
3. 各Lambda実行ロールへ対応するポリシーだけをアタッチする
4. LambdaのS3・Cognito処理を確認する
5. 開発用コマンド実行ユーザーへ3ポリシーをアタッチする
6. MFAとCloudTrailを確認する
7. SESは後続で追加する

## 11. 完了条件

- 各環境のLambdaロールが自環境のリソースだけへアクセスできる
- dev/stagingからproductionのDynamoDB・S3へアクセスできない
- 開発用コマンド実行ユーザーから3環境を確認できる
- 開発用コマンド実行ユーザーからCloudFormationスタックを削除できない
- 管理用IAMユーザーで再認証した場合だけ、手動でスタック削除できる
- S3写真アップロードが成功する
- Cognitoログインを使用する場合、`GetUser`が成功する
- SES未設定でも相談内容の保存は失敗しない
- 本番環境への削除権限を開発用ユーザーへ付与していない
