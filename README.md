# CSV-up-folder_GAS

このリポジトリは、Google Apps Script で Google Drive 上の入力フォルダを定期監視し、置かれたファイルをファイル名ルールに応じて処理する仕組みです。

## 先に結論

このリポジトリのローカルフォルダにファイルを入れても、自動処理は走りません。  
実際に監視されるのは `src/コード.js` の `DRIVE_FOLDERS.input` と `DRIVE_FOLDERS.input_delayed` に設定された Google Drive フォルダです。

- **`input/`（第1バッチ）** にファイルを置くと、1 分ごとのトリガーで即時処理されます。
- **`input_delayed/`（第2バッチ）** にファイルを置くと、`input/` が空になってから 2 分後に処理されます。

## 全体フロー

1. `input/` 内の全ファイルを順番に確認・処理
   - `clickpostReport` 対象か判定
   - `RPP運用CSV` の対象か判定
   - それ以外は通常の子 GAS 振り分け処理
   - 最後に `RPP運用CSV` をペア単位でまとめて処理
2. `input/` が空かどうかを確認し、Script Properties にタイムスタンプを記録
3. 空になってから 2 分以上経過していれば `input_delayed/` を同じ手順で処理

## 処理一覧

| 条件 | 対象ファイル名 | 実行される処理 | 成功時 | 失敗時 | 保留 |
| --- | --- | --- | --- | --- | --- |
| `clickpostReport` を含む | 例: `会津clickpostReport.csv` | CSV を加工して重複対策版を別フォルダへ出力 | 元ファイルを `processed` へ移動 | 元ファイルを `error` へ移動 | なし |
| RPP運用 CPC | `rpp_item_keyword_limelimedou_YYYYMMDD*.csv` | 同日の rank ファイルとペア待ち | ペア処理成功時に `processed` | ペア処理失敗時に `error` | rank が揃うまで入力フォルダに残る |
| RPP運用 rank | `rpp_keyword_ranking_limelimedou_YYYYMMDDHHMMSS(_n).csv` | 同日の CPC ファイルとペア待ち | ペア処理成功時に `processed` | ペア処理失敗時に `error` | CPC が揃うまで入力フォルダに残る |
| 楽天サーチ取込 | `act_` で始まる CSV/ZIP | 子 GAS へ `fileId` を POST | `processed` へ移動 | `error` へ移動 | なし |
| 会津在庫減算取込 | ファイル名に `ピッキング` を含む `.csv` | 子 GAS へ `fileId` を POST | `processed` へ移動 | `error` へ移動 | なし |
| RPPパフォーマンス取込 | `rpp_` で始まる CSV/ZIP、または `YYYYMMDD_item_list.csv` | 子 GAS へ `fileId` を POST | `processed` へ移動 | `error` へ移動 | なし |
| 未対応形式 | CSV/ZIP 以外 | エラー扱い | なし | `error` へ移動 | なし |
| 振り分けルールなし | CSV/ZIP だが上記に一致しない | エラー扱い | なし | `error` へ移動 | なし |

## 1. clickpostReport 系の処理

ファイル名に `clickpostReport` を含むファイルは、通常の子 GAS 振り分けではなく専用処理になります。

### 対象条件

- ファイル名に `clickpostReport` を含む
- かつ CSV であること

### 実施内容

- Shift_JIS として CSV を読み込む
- 1 行目をヘッダーとして保持する
- 2 行目以降は空行を除外する
- データ行数が偶数であることをチェックする
- データを 2 行 1 組とみなし、各組の先頭行だけを残す
- 加工後 CSV を別フォルダへ新規作成する

### 出力先

- `DRIVE_FOLDERS.output` が設定されていればそのフォルダ
- 未設定なら、入力フォルダと同階層の `04output`
- `04output` がなければ自動作成

### 出力ファイル名

元ファイル名の拡張子を除いたうえで、以下の形式になります。

```text
元ファイル名_deduped_YYYYMMDD_HHMMSS.csv
```

### 成否判定

- 成功: 元ファイルを `processed` フォルダへ移動
- 失敗: 元ファイルを `error` フォルダへ移動

### 失敗条件

- CSV ではない
- CSV の読み込み結果が空
- 空行除外後のデータ行数が奇数
- 出力先フォルダを取得できない

## 2. RPP運用CSV のペア処理

以下 2 種類は単独では即処理されず、同じ日付キーの 2 ファイルが揃ったときだけ処理されます。

### 対象ファイル

- CPC: `rpp_item_keyword_limelimedou_YYYYMMDD*.csv`
- rank: `rpp_keyword_ranking_limelimedou_YYYYMMDDHHMMSS.csv`
- rank は末尾に `_1` などの連番付きでも対象

### ペアキー

- どちらもファイル名から `YYYYMMDD` を取り出し、同じ日付なら 1 ペアとして扱う

### 揃っていない場合

- CPC のみ、または rank のみでは処理しない
- ファイルは入力フォルダに残る
- ログシートへの記録も行われない

### 重複がある場合

同じ日付キーで以下のどちらかが起きるとエラーです。

- CPC が 2 件以上
- rank が 2 件以上

この場合は、その日付キーに属する対象ファイルをすべて `error` へ移動し、ログを記録します。

### 正常ペア時の実施内容

- 子 GAS へ `cpcFileId` と `rankFileId` を POST
- 二重実行防止のため Script Properties と LockService を使用

### 成否判定の注意点

戻り値の `csvImportStatus` が `success` なら成功扱いです。
`rppTrackStatus` が `error` でも、`csvImportStatus=success` なら 2 ファイルとも `processed` に移動します。

その場合、ログメッセージは以下の趣旨に補正されます。

```text
CSV取込み成功 / RPPトラックデータ読込み失敗
```

### 実行スキップ条件

- 同じペアキーがすでに処理中
- ロック取得に失敗

この場合は処理をスキップし、ファイルは入力フォルダに残ります。

## 3. 通常の子 GAS 振り分け

`clickpostReport` でも `RPP運用CSV` でもないファイルは、子 GAS への転送対象として扱われます。

### 前提

- CSV または ZIP のみ対応
- 子 GAS には `fileId` を JSON で POST

### 振り分けルール

#### 3-1. 楽天サーチ取込

- 条件: ファイル名が `act_` で始まる
- 送信内容: `fileId`

#### 3-2. 会津在庫減算取込

- 条件: ファイル名に `ピッキング` を含み、拡張子が `.csv`
- 送信内容: `fileId`

#### 3-3. RPPパフォーマンス取込

- 条件1: ファイル名が `rpp_` で始まる
- 条件2: `YYYYMMDD_item_list.csv` に一致
- 送信内容: `fileId`

### 成否判定

- 子 GAS の HTTP ステータスが 400 以上なら失敗
- JSON 解析できないレスポンスは失敗
- JSON の `status` が `error` なら失敗
- それ以外は成功

### 処理後の移動

- 成功: `processed`
- 失敗: `error`

## 4. 未対応・ルール未設定時の挙動

### 未対応形式

CSV/ZIP 以外は処理対象外です。
`未対応のファイル形式です` として `error` に移動されます。

### 振り分けルール未設定

CSV/ZIP でも、どのルールにも一致しない場合は `振り分けルールが未設定` として `error` に移動されます。

## 5. ログ

各処理結果はログ用スプレッドシートの `log` シートに記録されます。

### 記録項目

- `timestamp`
- `fileName`
- `status`
- `rowsImported`
- `message`

### 補足

- メッセージ先頭には `PARENT_20260410_V1` が付与される
- ログシートがなければ自動作成される
- ヘッダー行がなければ自動作成される

## 6. input_delayed による2段階処理

広告系など「先に第1バッチを終わらせてから処理したいファイル」を `input_delayed/` に事前に配置しておくことで、順序を保証した2段階処理が実現できます。

### 仕組み

```
[毎分トリガー]
    ↓
input/ にファイルあり？
    Yes → 通常処理（第1バッチ）
    No  → 空になった時刻を Script Properties に記録

input/ が空になってから2分以上経過した？
    Yes → input_delayed/ を処理（第2バッチ）
    No  → スキップ
```

### フォルダの役割

| フォルダ | 役割 | 処理タイミング |
|---------|------|--------------|
| `input/` | 第1バッチ（即時処理） | 毎分チェック・即時処理 |
| `input_delayed/` | 第2バッチ（後処理） | `input/` が空になってから 2 分後 |

### 誤発火防止

- `input/` に新しいファイルが追加されたとき、「空になった時刻」のタイムスタンプをリセットする
- これにより、第1バッチの途中で誤って第2バッチが走ることを防ぐ

### input_delayed/ で対応しているファイル種別

`input/` と同じルールが適用されます。

- `clickpostReport` 系
- RPP運用CSV（CPC + rank のペア処理）
- 通常の子 GAS 振り分け（`act_`、`ピッキング`、`rpp_`、`YYYYMMDD_item_list.csv`）

## 7. トリガー

`setupTrigger()` を一度手動実行すると、`processInputFolder()` の時間主導トリガーが再作成されます。

### 動作

- 既存の同名トリガーを削除
- 1 分ごとのトリガーを新規作成

## 実際に「何が起きるか」の要約

**`input/` にファイルを置いたとき：**

- `clickpostReport` を含む CSV は、その場で加工され、加工結果 CSV が別フォルダに出力される
- `act_`、`ピッキング`、`rpp_`、`YYYYMMDD_item_list.csv` は、対応する子 GAS に転送される
- `RPP運用CSV` は 2 種類が揃うまで待機し、揃ったらペアで子 GAS に送られる
- 成功した元ファイルは `processed`、失敗した元ファイルは `error` に移動される
- どの処理もログシートに結果が残る

**`input_delayed/` にファイルを置いたとき：**

- `input/` が完全に空になるまで処理は開始されない
- `input/` が空になってから 2 分後に `input_delayed/` を処理する
- 処理内容・成否判定・ログ記録は `input/` と同じ
