# RPP item_list 切り分け状況引き継ぎ

作成日: 2026-04-10

## 概要

`01input` フォルダへ `20260409_item_list.csv` を配置した際に、親GASのログシート `log` へ以下エラーが継続記録された。

`Invalid argument: ContentType. Should be of type: application/zip`

本件について、親GASと子GASのどちらが原因かを切り分けた結果、現時点では **親GASではなく子GAS側の実処理またはデプロイ整合の問題** と判断している。

---

## 分かったこと

- 親GASは `CSV-up-folder_GAS` で、Apps Script プロジェクトは `1pObElCJbDz9GIUZZmZjTZhEPa2DLqai9nstUcNONY47i5624CQ16xOow`
- 親GASのトリガーは `processInputFolder` の1件のみ
- `log` シートへ出ている `item_list.csv` の行は、この親GAS自身が書いている
  - 親GASのログメッセージ先頭へ `PARENT_20260410_V1` を付与して確認済み
- 親GASは `20260409_item_list.csv` を `RPP` 系の子GAS宛てに振り分けている
- 親GASは `item_list.csv` 向け子GAS URL を実際に呼び出している
- bridge 用の切り分け子GASを経由した結果、親GASから子GAS `/exec` までは到達している
  - `RPP-BRIDGE UI reached / fileId=...` を返すところまで確認済み
- したがって、問題は親GASのルーティングではなく、`item_list.csv` を処理する子GAS側にある

---

## やったこと

### 親GAS側

- `YYYYMMDD_item_list.csv` を `RPP` 宛てに振り分けるよう変更
- CSV/ZIP の入力形式チェックを追加
- 子GAS呼び出し時の詳細ログを追加
  - `child`
  - `url`
  - `HTTP status`
  - `response body`
- 親GAS識別子 `PARENT_20260410_V1` をログへ付与
- `clasp push` 実施済み
- Git 反映済み

### RPP-Track 側

- `item_list.csv` を CSV として扱う `doPost/importFromFileId` 系コードの存在は確認
- ただし、既存 web app デプロイとローカルコードの整合が不安定で、期待どおりの応答が返らない状態があった

### bridge 切り分け用GAS

- 切り分け専用の新規GASを作成
  - プロジェクト名: `RPP-Track 切り分け用`
  - `scriptId`: `1dVH1abxQ6VuG3Bht8x2Af2LWqu7FeiekioLFf3XwhO2CwIp6BPPq3p7i`
- 固定レスポンス `doPost` を用意
- 親GASの `RPP` 宛て URL を一時的に bridge へ差し替え
- bridge から `RPP-BRIDGE UI reached / fileId=...` が返ることを確認

---

## 現在も分かっていないこと

- 既存 `RPP-Track` 本番 web app が、なぜ `item_list.csv` で `application/zip` エラーを返しているのか
- `RPP-Track` のローカルコードと、実際の `/exec` で動いているコードがどこでずれているのか
- `RPP-Track` 既存プロジェクトで、安定して `doPost` を反映した web app をどう運用すべきか
- `RPP-Track` 本処理が依存しているスプレッドシートの結び付きが、既存プロジェクト上で正しく保たれているか

補足:

- `RPP-Track` は `SpreadsheetApp.getActiveSpreadsheet()` 前提のため、bridge に本処理を移すことはできない

---

## 現時点の結論

- 親GASは正常
- `item_list.csv` のルーティングも親GAS側では正常
- 障害箇所は子GAS側
- 具体的には、`RPP-Track` 本番 web app の実行内容またはデプロイ整合に問題がある可能性が高い

---

## 次にやるべきこと

1. `RPP-Track` プロジェクト側で、本番用 `doPost/importFromFileId` を確実に反映した新しい web app を用意する
2. その URL を親GASの `item_list.csv` / `rpp_` 宛てへ設定し直す
3. bridge 接続は切り分けが終わったら外す

---

## 参考ログ

親GASのログ出力で確認できたメッセージ:

```text
PARENT_20260410_V1 子GASエラー child=RPPパフォーマンス取込 (RPP-Track bridge) url=https://script.google.com/macros/s/AKfycbxiYBfNGtAdbTYEh05V4Z61lWq_F7k2Tqjhny3Ybsju7WHE89fyalElQ8ogx-rFKgy7/exec HTTP 200 / RPP-BRIDGE UI reached / fileId=1B4TB5ZcAUadYyc7LMnt6ZWAs1K3EOoZ9
```

このログにより、親GASから子GASへの `fileId` 受け渡し自体は成功していると判断している。
