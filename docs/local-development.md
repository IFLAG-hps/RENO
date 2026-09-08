# ローカル確認手順

## 前提

- Docker Desktopが起動していること
- Node.js / npmが利用できること

Pythonをホストへインストールしなくても、バックエンドはPythonコンテナ内で起動できます。

## 起動

PowerShellを2つ開き、リポジトリ直下で次を実行します。

```powershell
.\scripts\start-local-backend.ps1
```

別のPowerShellでフロントエンドを起動します。

```powershell
npm run build:react
npm run serve:react
```

ブラウザで `http://127.0.0.1:4173/` を開き、PIN `5678` でログインします。

## 確認できる内容

- チャット（OpenAI APIキー未設定時は固定フォールバック）
- 見積りAPIと工期算出
- 同じ条件へ戻った場合のブラウザキャッシュ
- 補助金候補データの読み込み
- DynamoDB / S3をLocalStackで利用するセッション保存・事例保存

OpenAI連携も確認する場合は、API起動前に環境変数を設定します。APIキーはログやリポジトリへ記録しないでください。

```powershell
$env:OPENAI_API_KEY = 'ローカル検証用キー'
$env:OPENAI_MODEL = 'gpt-5-mini'
.\scripts\start-local-backend.ps1
```

## 停止

```powershell
docker stop reno-api reno-localstack
```

次回は同じコマンドで再起動できます。データを初期化する場合は、LocalStackコンテナを削除してから再作成してください。
