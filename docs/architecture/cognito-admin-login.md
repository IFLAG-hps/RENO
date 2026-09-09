# Cognitoログイン

Amplify HostingのBasic認証を使わず、RENOの画面内でCognitoログインを行う。PIN認証およびPIN管理機能は廃止し、今後も実装しない。
認証基盤は既存のAmazon Cognito User Poolを利用し、Supabaseは使用しない。一般ユーザーは通常ログイン、管理者は「管理者はこちら」から管理者ログインへ切り替える。

## デプロイ前の設定

GitHubの`production`環境に以下を設定する。

Secrets:

- `OPENAI_API_KEY`
- `TOKEN_SECRET`

Variables:

- `ADMIN_EMAIL`：管理者として許可するCognitoユーザーのメールアドレス
- `OPENAI_MODEL`：任意

`ADMIN_EMAIL`は大文字・小文字を区別せず照合し、一致したユーザーだけに管理者権限を付与する。一致しないCognitoユーザーは一般ユーザーとしてログインできる。

## デプロイ後の管理者作成

1. Cognito User Pool `reno-mvp-users`を開く。
2. ユーザーを管理者作成する。
3. メールアドレスを`ADMIN_EMAIL`と同じ値にする。
4. 初回パスワードを設定し、必要に応じてSoftware token MFAを登録する。
5. `admin`グループへ追加する。
6. Actionsのログに出力された`UserPoolClientId`を`COGNITO_CLIENT_ID`としてAmplify環境変数へ設定する。

## ログイン方法

1. RENO画面の一般ログイン欄に、Cognitoユーザーのメールアドレスとパスワードを入力する。
2. MFAを有効にしている場合は、認証アプリの6桁コードを入力する。
3. 管理者の場合は「管理者はこちら」から管理者ログインへ切り替える。
4. 認証成功後、権限に応じた機能が表示される。

API側でもCognitoアクセストークンを検証し、`ADMIN_EMAIL`と一致するユーザーだけに管理者用のアプリトークンを発行する。
サイトにアクセスしただけでは管理者権限は付与されず、Cognito認証に成功した場合だけアプリトークンが発行される。
