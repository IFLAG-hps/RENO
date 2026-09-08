# AIモデル自動検証ひな形

## 実行

リポジトリルートから次を実行します。

```powershell
python -m unittest backend.tests.test_ai_model_evaluation -v
```

または、テストディレクトリから実行します。

```powershell
python backend/tests/test_ai_model_evaluation.py
```

初期状態では外部AI APIを呼ばないモックテストです。結果は `test-results/ai-model-evaluation.json` に出力されます（`test-results/` はGit管理対象外）。

## 実APIへ接続するとき

`MockModelClient` と同じ `run(model, case) -> ModelResponse` インターフェースを持つ実APIクライアントへ置換します。APIキーはコードへ直書きせず環境変数から読み込み、実行前に以下を設定してください。

```powershell
$env:AI_EVAL_MAX_COST_JPY = "30000"
$env:AI_EVAL_REPORT = "test-results/ai-model-evaluation-live.json"
```

実APIテストでは、費用上限、レート制限、画像利用許諾、個人情報の匿名化を確認してから実行します。
