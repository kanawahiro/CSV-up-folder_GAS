# CSV-up-folder_GAS

Google Apps Script で Google Drive の入力フォルダを定期監視し、置かれたファイルをファイル名ルールに応じて子GASへ振り分ける親GASです。

## 先に結論

このリポジトリのローカルフォルダにファイルを入れても、自動処理は走りません。  
実際に監視されるのは `src/コード.js` の `DRIVE_FOLDERS.input` に設定された Google Drive フォルダです。

入力フォルダにファイルを置くと、1分ごとのトリガーで `processInputFolder()` が実行されます。

## 全体フロー

1. 入力フォルダ内のファイルを最初に全件収集する
2. `clickpostReport` 対象は現行どおり専用処理する
3. 順番制御対象を分類する
4. 順番制御対象を固定順で処理する
5. 順番制御対象ではないファイルを既存ルールで処理する

## 順番制御対象の固定順

複数ファイルが同時に入力フォルダへ入っていても、Drive の列挙順には依存せず、以下の順で処理します。

| 順番 | 処理 | 対象ファイル名 | 送信先 |
| --- | --- | --- | --- |
| 1 | RPPトラック | `YYYYMMDD_item_list.csv` | RPP-Track |
| 1 | RPPトラック | `rpp_item_reports_limelimedou_YYYYMMDD*.csv` | RPP-Track |
| 1 | RPPトラック | `rpp_keyword_reports_limelimedou_YYYYMMDD*.csv` | RPP-Track |
| 2 | 楽天サーチ | `act_*.csv` / `act_*.zip` | 楽天サーチ 記録用 |
| 3 | 広告表示 | `rpp_item_keyword_limelimedou_YYYYMMDD*.csv` と `rpp_keyword_ranking_limelimedou_YYYYMMDDHHMMSS(_n).csv` のペア | RPP-unyou |

RPPトラック内では、必ず以下の順に処理します。

1. `YYYYMMDD_item_list.csv`
2. `rpp_item_reports_limelimedou_YYYYMMDD*.csv`
3. `rpp_keyword_reports_limelimedou_YYYYMMDD*.csv`

前の処理が成功した場合だけ次へ進みます。

## エラー時の動き

順番制御対象の処理中にエラーが出た場合は、そこで停止します。

- 失敗したファイルは `error` フォルダへ移動する
- まだ処理していない順番制御対象ファイルも `error` フォルダへ移動する
- 順番制御対象ファイルは `input` に残さない
- 未処理で `error` へ移動したファイルには `前段エラーのため未処理でerror移動` のログを残す
- 順番制御対象ではないファイルは、この一括 `error` 移動の対象外

## 処理一覧

| 条件 | 対象ファイル名 | 実行される処理 | 成功時 | 失敗時 |
| --- | --- | --- | --- | --- |
| `clickpostReport` を含む | 例: `会津clickpostReport.csv` | CSV を加工して重複対策版を別フォルダへ出力 | 元ファイルを `processed` へ移動 | 元ファイルを `error` へ移動 |
| RPPトラック | `YYYYMMDD_item_list.csv` | 子GASへ `fileId` をPOST | `processed` へ移動 | `error` へ移動し後続停止 |
| RPPトラック | `rpp_item_reports_limelimedou_YYYYMMDD*.csv` | 子GASへ `fileId` をPOST | `processed` へ移動 | `error` へ移動し後続停止 |
| RPPトラック | `rpp_keyword_reports_limelimedou_YYYYMMDD*.csv` | 子GASへ `fileId` をPOST | `processed` へ移動 | `error` へ移動し後続停止 |
| 楽天サーチ | `act_` で始まるCSV/ZIP | 子GASへ `fileId` をPOST | `processed` へ移動 | `error` へ移動し後続停止 |
| 広告表示 CPC | `rpp_item_keyword_limelimedou_YYYYMMDD*.csv` | rankファイルとペアで子GASへPOST | ペア処理成功時に `processed` | ペア処理失敗時に `error` |
| 広告表示 rank | `rpp_keyword_ranking_limelimedou_YYYYMMDDHHMMSS(_n).csv` | CPCファイルとペアで子GASへPOST | ペア処理成功時に `processed` | ペア処理失敗時に `error` |
| 会津在庫減算取込 | ファイル名に `ピッキング` を含む `.csv` | 子GASへ `fileId` をPOST | `processed` へ移動 | `error` へ移動 |
| その他RPP | `rpp_` で始まるCSV/ZIP | 子GASへ `fileId` をPOST | `processed` へ移動 | `error` へ移動 |
| 未対応形式 | CSV/ZIP以外 | エラー扱い | なし | `error` へ移動 |
| 振り分けルールなし | CSV/ZIPだが上記に一致しない | エラー扱い | なし | `error` へ移動 |

## clickpostReport 系の処理

ファイル名に `clickpostReport` を含むCSVは、通常の子GAS振り分けではなく専用処理になります。

- Shift_JIS としてCSVを読み込む
- 1行目をヘッダーとして保持する
- 2行目以降は空行を除外する
- データ行を2行1組とみなし、各組の先頭行だけを残す
- 加工後CSVを別フォルダへ出力する

出力先は `DRIVE_FOLDERS.output` が設定されていればそのフォルダです。未設定なら、入力フォルダと同階層の `04output` を使い、存在しなければ自動作成します。

出力ファイル名は以下の形式です。

```text
元ファイル名_deduped_YYYYMMDD_HHMMSS.csv
```

## 広告表示ペア処理

広告表示は、同じ日付キーのCPCファイルとrankファイルが1件ずつ揃った場合だけ処理します。

- CPC: `rpp_item_keyword_limelimedou_YYYYMMDD*.csv`
- rank: `rpp_keyword_ranking_limelimedou_YYYYMMDDHHMMSS(_n).csv`

ペア不足または同種ファイルの重複がある場合はエラー扱いです。対象ファイルを `error` へ移動し、順番制御対象の後続処理は止めます。

戻り値の `csvImportStatus` が `success` なら成功扱いです。`rppTrackStatus` が `error` でも、CSV取込みが成功していれば2ファイルとも `processed` に移動します。

## 通常の子GAS振り分け

順番制御対象でも `clickpostReport` でもないファイルは、既存の `CHILD_SCRIPTS` ルールで処理します。

- `ピッキング` を含む `.csv` は会津在庫減算取込へ送る
- その他の `rpp_` で始まるCSV/ZIPはRPP-Trackへ送る
- CSV/ZIP以外は未対応形式として `error` へ移動する
- CSV/ZIPでもルール未一致なら `error` へ移動する

## ログ

各処理結果はログ用スプレッドシートの `log` シートに記録されます。

記録項目:

- `timestamp`
- `fileName`
- `status`
- `rowsImported`
- `message`

ログメッセージ先頭には `PARENT_20260410_V1` が付与されます。

## トリガー

`setupTrigger()` を一度手動実行すると、`processInputFolder()` の時間主導トリガーが再作成されます。

- 既存の同名トリガーを削除
- 1分ごとのトリガーを新規作成
