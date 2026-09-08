# RENO ドキュメント案内

文書を用途別に整理しています。迷った場合は、まずプロダクト資料とAI機能資料を確認してください。

## フォルダ構成

| フォルダ | 内容 |
|---|---|
| [product](./product/) | 商品方針、MVP、ロードマップ、バックログ、修正メモ |
| [ai](./ai/) | API仕様、写真診断、完成予想図、AI利用方針 |
| [architecture](./architecture/) | AWS構成、権限、認証、実装方式 |
| [operations](./operations/) | 開発、デプロイ、運用、費用試算 |
| [testing](./testing/) | E2Eテスト方針 |
| [deployment](./deployment/) | 環境別のデプロイ構成 |
| [workflows](./workflows/) | ブランチ、環境、作業フロー |
| [templates](./templates/) | 文書テンプレート |
| [archive](./archive/) | 廃止・過去検討資料 |

## まず読む資料

- [商品方針](./product/product-direction.md)
- [MVP提案](./product/mvp-proposal.md)
- [API仕様](./ai/api-specification.md)
- [写真診断フロー](./ai/image-diagnosis-workflow.md)
- [完成予想図メモ](./ai/image-generation-memo.md)
- [運用費用・損益分岐点](./operations/operating-cost-and-break-even-memo.md)
- [全体ワークフロー](./workflows/overall-workflow.md)

## 更新ルール

- 新しい仕様は用途別フォルダに配置する。
- 一時的なメモは、正式文書へ反映後に削除または `archive` へ移動する。
- ファイル名は既存リンクを考慮し、変更が必要な場合は同時に参照先を更新する。
