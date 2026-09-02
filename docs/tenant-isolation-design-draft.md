# RENO テナント分離設計書（原案）

- 文書状態: 原案
- 作成日: 2026-09-02
- 対象: カタログ、PDF/OCR、会話、施工事例、見積、提案書
- 方針: DynamoDB相当のコストを維持し、誤設定時も他テナントへ公開しない

## 1. 採用方針

初期実装では、DynamoDBオンデマンド＋テナント別物理テーブル＋Tenant Data Gatewayを採用する。公開API LambdaからDynamoDB権限を外し、テナント解決とデータアクセスをGatewayへ集約する。

```text
ブラウザ → API Lambda（認証・入力検証、DynamoDB権限なし）
         → Tenant Data Gateway（JWT再検証・テナント解決）
         → reno-tenant-{internal_id} / tenants/{tenant_id}/...
```

PostgreSQL RLSは強力だが、常時稼働するDB費用が発生するため、DynamoDBと同程度のコストという条件では採用しない。DynamoDBオンデマンドはリクエスト・保存容量ベースの課金を基本とする。

## 2. テナント識別

- `tenant_id`: 外部公開用の不変UUID。JWT・監査ログで使用する。
- `internal_tenant_id`: 内部ランダムID。テーブル名に使用する。
- `user_id`: 認証基盤の不変ユーザーID。

クライアントから送信された `tenant_id`、テーブル名、S3キー、商品IDは認可情報として信用しない。Gatewayが検証済みJWTとレジストリから対象を決定する。

JWTには `sub`、`tenant_id`、`tenant_role`、`iss`、`aud`、`exp` を必須とする。`tenant_role` は `tenant_member`、`tenant_admin`、`platform_admin` に限定する。

## 3. DynamoDB

### テナントレジストリ

共有テーブル `reno-tenant-registry` を使用する。

```text
PK=TENANT#{tenant_id}
属性=internal_tenant_id, table_name, status, created_at, retention_until
```

`status` は `provisioning`、`active`、`suspended`、`deleting`、`deleted` のいずれかとする。`active` 以外はGatewayが全操作を拒否する。

### テナントデータテーブル

テーブル名は `reno-tenant-{internal_tenant_id}` とする。各テーブルはシングルテーブル設計とする。

```text
PK=CATALOG        SK=ITEM#{item_id}
PK=CATALOG        SK=IMPORT#{import_id}
PK=USER#{user_id} SK=CHAT#{timestamp}#{id}
PK=USER#{user_id} SK=CASE#{case_id}
PK=PROPOSAL       SK=PROPOSAL#{proposal_id}
PK=AUDIT          SK={timestamp}#{id}
```

全アイテムに `tenant_id` を冗長保存し、Gatewayが書き込み時に検証する。`Scan` は禁止し、`Query` / `GetItem` を使用する。

### IAM

- API Lambda: DynamoDB権限なし
- Gateway: レジストリ取得と必要最小限のテナントテーブル操作
- テーブル作成・削除・バックアップ削除: 専用Provisionerロールのみ
- 緊急アクセス: 別ロール、理由・操作者・対象テナントを監査ログへ記録

共有テーブル方式を将来検討する場合は、`dynamodb:LeadingKeys` を追加防御として利用する。ただし、初期方式の主境界は物理テーブルとGatewayとする。

## 4. S3

```text
tenants/{tenant_id}/catalog-sources/{import_id}/source.pdf
tenants/{tenant_id}/catalog-sources/{import_id}/ocr.json
tenants/{tenant_id}/generated/{generation_id}.png
tenants/{tenant_id}/proposals/{proposal_id}.pdf
```

- バケットは非公開、暗号化を有効にする。
- 署名URLはGatewayのみが発行する。
- 発行前にキーのテナントプレフィックスとJWTのテナントを照合する。
- URLの有効期限は原則15分以内とする。

## 5. PDF/OCR登録

1. `create_catalog_upload_url`（`tenant_admin`限定）でPDF用URLを発行する。
2. PDFをテナント配下のS3へアップロードする。
3. `extract_catalog_from_pdf` でOCR/AI抽出を実行する。
4. 結果は `draft` として返し、自動公開しない。
5. 管理者が確認・修正する。
6. `save_catalog_items` で確定データのみ登録する。

商品には `source_key`、`source_pages`、`import_id`、`reviewed_by`、`reviewed_at` を保存する。読み取れない値は空欄とし、推測した価格・品番・性能は登録しない。

## 5.1 入力フォーマットを自由にする仕様

利用者には拡張子やレイアウトを限定しない。ただし、品質と安全性を保証できるサポート範囲を明示し、未対応形式はエラーではなく「変換待ち/確認待ち」として扱う。

### 受け付ける形式

| 区分 | 拡張子 | 内部処理 |
|---|---|---|
| 文書 | PDF | 直接解析。テキスト層の有無を判定 |
| 画像 | JPG, PNG, TIFF, WEBP | 画像OCR。向き・解像度を補正 |
| 表計算 | XLSX, XLS, CSV | セル値・シート・表範囲を抽出 |
| 文書 | DOCX | PDFまたはページ画像へ変換して解析 |

拡張子だけで判断せず、MIMEタイプとファイルシグネチャを検査する。実行形式、暗号化ファイル、破損ファイル、パスワード付きファイル、許容サイズ超過は受け付けない。

### 取り込み段階

```text
アップロード
  → ウイルス/ファイルシグネチャ検査
  → 形式・ページ数・サイズ判定
  → 必要ならPDF/画像へ正規化
  → ページ/シート単位の抽出
  → 商品候補への統合
  → 信頼度と根拠を付与
  → 管理者確認
```

入力形式は `source_format`、変換結果は `normalized_format` として取込履歴に保存する。元ファイルは必ず保持し、変換後ファイルと対応付ける。

### 文字・表・画像の抽出優先順位

1. 文字PDFはテキスト層を先に抽出し、文字欠落ページだけOCRする。
2. スキャンPDFと画像はTextractの文字抽出を使用する。
3. 行列が検出できるページはTables解析を追加する。
4. 商品写真内の品番や価格は画像解析を補助的に使用する。
5. 抽出方式が異なる結果をページ番号・座標・シート名で統合し、重複商品をまとめる。

### 正規化と欠損の扱い

- 商品名、メーカー、品番、価格、単位、カテゴリを共通項目にする。
- メーカー固有の仕様は `specifications` に保持する。
- 税込/税別、価格帯、単価、ケース単位などの原表記を保持し、勝手に換算しない。
- OCRで読み取れない値は空欄にし、AIによる推測値を登録しない。
- 商品候補には項目別 `confidence` と `evidence`（ページ、座標、元テキスト）を付ける。

### 価格の扱い

カタログ価格は公式販売価格との一致を保証する値ではなく、テナントが登録した資料に基づく参考価格として扱う。公式サイトや市場価格との照合を、登録可否の条件や自動修正の根拠にしない。

価格には次の属性を持たせる。

```json
{
  "price_display": "5,000円〜/㎡（税別）",
  "price_min": 5000,
  "price_max": null,
  "currency": "JPY",
  "unit": "㎡",
  "tax_status": "excluded",
  "price_type": "reference",
  "effective_date": "2026-04-01",
  "region": "関東",
  "conditions": "材料費のみ・施工費別",
  "price_source": "tenant_catalog",
  "price_note": "現地条件・時期により変動"
}
```

読み取り時に行うチェックは、同一PDF内の重複・表記ゆれ・税込/税別・単位の矛盾の検出に限定する。矛盾がある場合は候補を要確認にし、公式価格で上書きしない。

将来的に公式サイト等を参照する場合も、別の任意情報 `external_price_observation` として保存し、出典URL・取得日時・地域・条件を併記する。テナント価格を置き換えず、警告表示の補助情報に限定する。

### 品質ゲート

次のいずれかに該当する商品は自動公開しない。

- 商品名がない
- 品番または価格が読み取れず、カタログ上必須と判定された
- 重要項目の信頼度が設定値未満
- 同一品番に複数の価格があり、単位や価格条件を確定できない
- OCR結果と表抽出結果が矛盾する

管理者確認画面では、候補値と元ページの該当箇所を並べて表示し、項目単位で修正・承認できるようにする。承認前の候補はAI回答の検索対象にしない。

### 非同期処理と再処理

多ページPDF、複数シート、変換が必要なファイルは非同期ジョブにする。`import_id` 単位でページ/シートごとの状態を持ち、失敗した単位だけ再処理できるようにする。抽出モデルやルールを更新した場合も、元ファイルから同じテナント内で再処理できるようにする。

## 6. AI回答

AIへ渡すカタログは、JWTから確定したテナントのテーブルだけから取得する。クライアント提供のカタログ配列は正規データとして扱わない。AI出力の商品IDは、同一テナントから取得した許可リストと照合し、範囲外の候補は破棄する。

```text
JWT検証 → status=active確認 → 対象テーブルQuery
  → tenant_id再検証 → AI入力 → 出力IDを許可リスト照合
```

## 7. フェイルクローズ

- JWT不正、tenant_id未設定、レジストリ不整合は拒否する。
- テナント停止中は読み取りも書き込みも拒否する。
- レジストリ障害時は書き込みを継続しない。
- AI/OCR障害時は別テナントのフォールバックデータを使わない。
- S3所有関係を確認できない場合は署名URLを発行しない。
- テナント横断検索APIは作らない。

## 8. 監査・削除

ログイン、権限変更、PDFアップロード、OCR、カタログ登録・削除、署名URL発行、緊急アクセス、テナント停止・削除を監査記録する。記録項目は `tenant_id`、`user_id`、操作、対象ID、結果、request_id、時刻とし、PDF本文や機密情報は記録しない。

削除は `suspended` → 保持期間 → `deleting` の順に進め、DynamoDB、S3、バックアップを冪等ジョブで削除する。完了検証後に `deleted` へ遷移する。

## 9. コスト

DynamoDBはオンデマンドを基本とし、テーブルごとの読書き・保存容量・バックアップ・KMS・S3・Lambda・監視費用を管理する。テナント数が増えた場合は、物理テーブルの作成・監視・削除運用コストを四半期ごとに再評価する。

## 10. 必須テストと未決事項

必須テストは、AのJWTでBのテーブル・S3キー・商品IDを指定しても取得・更新・削除できないこと、停止テナント・改ざんJWT・レジストリ障害で拒否されること、AI出力の越境IDが破棄されることとする。

未決事項は、最大テナント数、PDF保持期間、KMSの共有/テナント別、`platform_admin` の緊急閲覧可否、Gatewayの実装形態である。
