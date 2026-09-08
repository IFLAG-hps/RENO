# AWS MVP実装（SQS除外）

アーキテクチャ図のMVPからSQSを除いた実装を `backend/` に追加した。SAMでデプロイできる最小構成で、API GatewayからLambdaを呼び出し、DynamoDB・S3・OpenAI API・SESへ接続する。

## 実装済みの範囲

| 機能 | 実装 |
| --- | --- |
| チャット | `chat`。LambdaからOpenAI Responses APIをAPIキーで呼び出し、未設定時は安全なフォールバック応答 |
| 画像 | `create_upload_url` / `create_download_url`。S3の署名付きURL |
| セッション | DynamoDBへ保存する `save_session` |
| 相談受付 | DynamoDB保存。SESの送信元・宛先を設定した場合はメール送信 |
| 利用状況 | `get_usage` のMVP応答（利用回数の調整は後続対応） |
| ゲストアクセス | 認証なしの利用開始方式を前提とする |
| 認証基盤 | Cognito User PoolをSAMで作成。アプリ固有の短期トークンはLambdaで署名 |
| 監視 | LambdaのCloudWatch Logs |

## SQS非同期処理の採用

画像生成はSQS経由の非同期処理とする。API Lambdaはジョブ登録と状態取得を担当し、画像生成Worker LambdaがOpenAI呼び出しとS3保存を担当する。再試行回数を超えたジョブはDLQへ移動し、フロントエンドはDynamoDBのジョブ状態をポーリングする。PDF生成は引き続きブラウザ側で行う。

## フロントエンド切替

`assets/reno-config.js` の `apiUrl` にSAM出力の `ApiUrl` を設定し、`mockChat` を `false` にするとチャットの接続先を切り替えられる。未設定時は現在のSupabase接続とローカルモックを維持する。
