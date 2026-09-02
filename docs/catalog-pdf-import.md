# PDFカタログのOCR登録

管理者がPDFカタログから商品を取り込むためのAPIです。OCR結果は自動公開せず、利用者が内容を確認・編集してから保存します。

## 呼び出し順

1. `create_catalog_upload_url` に `filename`（`.pdf`）を渡します。
2. 返却された `upload_url` に、`Content-Type: application/pdf` を指定してPDFをPUTします。
3. `extract_catalog_from_pdf` に返却された `key` を `source_key` として渡します。
4. 返却された `items` を確認・修正します。
5. 修正後の `items` と同じ `source_key` を `save_catalog_items` に渡します。

PDFは15 MB以下、1回の保存は100商品までです。登録値には `source_key` と `source_pages` が残るため、後で原典を確認できます。

## APIの入力例

```json
{"type":"extract_catalog_from_pdf","token":"<admin-token>","source_key":"catalog-sources/<id>-catalog.pdf"}
```

OCRはOpenAI Responses APIへPDFファイルとして渡します。テキストPDFと、画像化された文字を含むスキャンPDFの両方を対象にし、モデルには推測値を登録しないよう指示しています。
