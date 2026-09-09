# Basic認証の廃止

アプリ内のCognitoログインへ移行したため、Amplify HostingのBasic認証は有効化しない。

Amplify Hostingの各ブランチで、Access controlを次の設定にする。

- `dev`: `Restricted - password required`
- `staging`: `Restricted - password required`
- `main`: `Restricted - password required`

ユーザー認証はCognito User Poolで行い、CognitoのアクセストークンをAPI側で検証する。

Basic認証の設定は不要であり、アプリ内ログインに成功した場合だけAPI側でアプリトークンを発行する。
