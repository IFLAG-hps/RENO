# Amplify一時アクセス制限（廃止）

現在はCognito管理者ログインを使用するため、この設定は無効化する。

過去の一時運用では、Amplify HostingのAccess controlでサイト全体を保護していた。
アプリケーションへBasic認証を実装せず、Amplifyのホスティング層で認証する。

## 現在の設定

Amplifyコンソールで`main`ブランチのAccess controlを`No restriction`にする。
サイト入口は公開し、RENO内で以下を制御する。

- 一般利用者：PINなしで利用開始
- 管理者：Cognitoログイン
- 管理者機能：Cognitoで許可された管理者のみ

## 過去の設定方法

1. AWSコンソールでAmplifyを開く。
2. 対象アプリを開き、`Hosting` → `Access control`を選択する。
3. `Manage access`を選択する。
4. `main`ブランチを`Restricted - password required`にする。
5. 一時利用者用のユーザー名と強固なパスワードを設定する。
6. 保存する。

接続済みブランチ全体を保護する場合は、`Manage access for all branches`を有効にする。
通常は本番候補の`main`だけを保護する。

## ログイン方法

Amplifyの公開URLを開くと、ブラウザに認証ダイアログが表示される。
設定したユーザー名とパスワードを入力するとサイトを閲覧できる。

これはサイト閲覧用の一時認証であり、RENOアプリ内の管理者権限やAWS管理者権限ではない。

## 撤去時

正式公開時に、同じ画面で`Access control`を無効化する。
その後、必要に応じてCognitoによる管理者ログインを導入する。

## 注意

- 認証情報を`.env`、ソースコード、GitHub Actionsのログへ記載しない。
- Basic認証のパスワードは正式公開用の管理者パスワードと別にする。
- AmplifyのAccess controlはAmplifyの公開ページを保護する。API GatewayのURLを直接呼び出すアクセス制御とは別である。
