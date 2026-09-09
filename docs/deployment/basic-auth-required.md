# Basic認証の必須設定

無制限モードを利用する場合、対象環境のサイト公開前にAmplify HostingのBasic認証を必ず有効にする。

Amplify Hostingの各ブランチで、Access controlを次の設定にする。

- `dev`: `Restricted - password required`
- `staging`: `Restricted - password required`
- `main`: `Restricted - password required`

Basic認証のユーザー名・パスワードはGitHub、ソースコード、`.env`へ保存せず、AmplifyのAccess control設定で管理する。

Basic認証はサイトの入口を保護する認証であり、アプリ内の管理者権限とは別である。無制限モードは、Basic認証に加えてRENO内の管理者アカウント（Cognito認証）が成立した場合だけ、API側で有効になる。
