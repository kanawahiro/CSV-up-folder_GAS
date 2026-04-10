# GAS実装パターン: 手動テストからDriveトリガーへの移行

## 概要

新しいCSV取込GASを作成する際の標準的な実装フロー。
スプレッドシートのメニューで手動テストし、動作確認後にGoogleドライブトリガーへ移行する。

---

## フェーズ構成

```
フェーズ1: 手動テスト
  └── スプレッドシートのカスタムメニュー → CSV手動取込 → 動作確認

フェーズ2: 自動トリガー移行
  └── Driveフォルダ監視トリガー → CSVをフォルダに置くだけで自動実行
```

---

## フェーズ1: 手動テスト実装

### 目的

- CSV取込ロジックが正しく動くかを、スプレッドシートのメニューから確認する
- Driveフォルダ連携の前に取込仕様を完成させる

### 実装すべき関数

```javascript
// ① スプレッドシートを開いたときにメニューを追加
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('メニュー名')
    .addItem('CSVを選択して取り込む', 'showUploadDialog')
    .addToUi();
}

// ② ダイアログを表示する（upload.htmlと組み合わせて使う）
function showUploadDialog() {
  const html = HtmlService.createHtmlOutputFromFile('upload')
    .setWidth(420)
    .setHeight(260);
  SpreadsheetApp.getUi().showModalDialog(html, 'CSV取込');
}

// ③ ブラウザからアップロードされたCSVを受け取る入口
function importFromUpload(base64Data, fileName) {
  const blob = Utilities.newBlob(
    Utilities.base64Decode(base64Data), 'text/csv', fileName
  );
  const csvText = readCsvText_(blob);
  return importCsv(csvText, { fileName });
}

// ④ 将来の親GAS連携用入口（フェーズ2でも共通利用）
function importFromFileId(fileId) {
  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob();
  const csvText = readCsvText_(blob);
  return importCsv(csvText, { fileName: file.getName() });
}

// ⑤ 取込ロジック本体（①②どちらの経路でも同じ関数を使う）
function importCsv(csvText, sourceMeta) {
  // CSV解析 → 検証 → 重複チェック → シート書込 → 結果返却
}
```

### 関数の役割分担

| 関数 | 用途 | フェーズ |
|------|------|--------|
| `onOpen` | メニュー追加 | 1のみ |
| `showUploadDialog` | ダイアログ表示 | 1のみ |
| `importFromUpload` | ブラウザ経由の取込入口 | 1のみ |
| `importFromFileId` | fileId経由の取込入口 | **1・2共通** |
| `importCsv` | 取込ロジック本体 | **1・2共通** |

### 確認すべきテスト項目

1. CSVから対象期間・ヘッダーを正しく取得できること
2. データが正しい列に書き込まれること
3. 重複データが存在するときにエラーを返すこと
4. 正常時に `status: 'success'` と件数が返ること
5. `importFromFileId` でも同じ結果になること

---

## フェーズ2: Driveトリガーへの移行

### 目的

- フォルダにCSVを置くだけで自動取込が実行される仕組みに切り替える
- フェーズ1で完成した取込ロジックはそのまま使う

---

### 仕組みの説明

GASには「ファイルが追加されたら即時実行する」ネイティブトリガーは存在しない。
代わりに **時間主導型トリガー（ポーリング）** を使い、一定間隔で `input` フォルダを確認する方式をとる。

```
[定期実行トリガー（例: 5分毎）]
  ↓
processInputFolder() が起動
  ↓
input フォルダを確認
  ├── CSVあり → importFromFileId() で取込 → processed or error へ移動
  └── CSVなし → 何もせず終了
```

---

### フォルダ構成

```
Google Drive
└── CSV取込フォルダ/
    ├── input/       ← ここにCSVを置くと次回のポーリングで処理される
    ├── processed/   ← 処理成功したCSVを移動
    └── error/       ← 処理失敗したCSVを移動
```

#### フォルダIDの確認方法

Google DriveでフォルダをブラウザのURLバーで開くと、以下の形式でIDを確認できる。

```
https://drive.google.com/drive/folders/【ここがフォルダID】
```

---

### 追加する関数

```javascript
// フォルダIDは定数として管理する（URLから取得したIDを設定する）
const DRIVE_FOLDERS = {
  input:     'FOLDER_ID_INPUT',      // inputフォルダのID
  processed: 'FOLDER_ID_PROCESSED',  // processedフォルダのID
  error:     'FOLDER_ID_ERROR',      // errorフォルダのID
};

// ポーリングで定期実行されるメイン処理
// ※ この関数にトリガーを設定する
function processInputFolder() {
  const inputFolder = DriveApp.getFolderById(DRIVE_FOLDERS.input);
  const files = inputFolder.getFilesByType(MimeType.CSV);

  while (files.hasNext()) {
    const file = files.next();
    const result = importFromFileId(file.getId());  // フェーズ1と共通の入口

    if (result.status === 'success') {
      moveFile_(file, DRIVE_FOLDERS.processed);
    } else {
      moveFile_(file, DRIVE_FOLDERS.error);
    }

    logResult_(file.getName(), result);
  }
}

// ファイルをフォルダ間で移動するユーティリティ
function moveFile_(file, destFolderId) {
  const dest = DriveApp.getFolderById(destFolderId);
  const src  = DriveApp.getFolderById(DRIVE_FOLDERS.input);
  dest.addFile(file);
  src.removeFile(file);
}

// 実行ログをシートに記録する
function logResult_(fileName, result) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('log');
  sheet.appendRow([
    new Date(),
    fileName,
    result.status,
    result.rowsImported ?? 0,
    result.message,
  ]);
}
```

---

### トリガーの設定手順

**GASエディタからの手動設定手順:**

1. GASエディタ左メニューの「トリガー（時計マーク）」を開く
2. 右下の「トリガーを追加」をクリック
3. 以下の通り設定して保存する

| 設定項目 | 値 |
|--------|---|
| 実行する関数 | `processInputFolder` |
| 実行するデプロイ | Head |
| イベントのソース | 時間主導型 |
| 時間ベースのトリガーのタイプ | 分ベースのタイマー |
| 時間の間隔（分） | 5分毎（または10分毎） |

4. 初回実行時にGoogleアカウントの権限承認が求められる → 「許可」をクリック

**コードからトリガーを登録する方法（任意）:**

```javascript
// 一度だけ手動実行してトリガーを登録するセットアップ関数
function setupTrigger() {
  // 既存のトリガーを削除（重複防止）
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 5分毎のポーリングトリガーを登録
  ScriptApp.newTrigger('processInputFolder')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('トリガーを設定しました');
}
```

> `setupTrigger()` はエディタから一度だけ手動実行する。以後は自動でポーリングが動く。

---

### logシートの列構成

スプレッドシートに `log` という名前のシートを作成し、1行目にヘッダーを手動で入力する。

| 列 | 内容 | 例 |
|----|------|---|
| A | 実行日時 | 2026/04/09 10:05:00 |
| B | ファイル名 | act_20260401_427986.csv |
| C | status | success / error |
| D | 取込件数 | 10 |
| E | メッセージ | 取込完了: 10件 |

---

## 移行チェックリスト

フェーズ1の動作確認が取れたら、以下を順番に実施する。

- [ ] Google Driveに `input` / `processed` / `error` フォルダを作成する
- [ ] 各フォルダのIDをコードの `DRIVE_FOLDERS` に設定する
- [ ] スプレッドシートに `log` シートを追加し、ヘッダー行を記入する
- [ ] `processInputFolder` 関数を追加する
- [ ] `moveFile_` / `logResult_` ユーティリティを追加する
- [ ] 時間トリガーを設定する（5〜15分毎）
- [ ] `input` フォルダに実際のCSVを置いて動作確認する

---

## 戻り値の標準形

子GASの取込結果は、親GASや `logResult_` が共通で扱えるよう以下の形を守る。

```javascript
{
  status: 'success' | 'error',
  message: '取込完了: 10件 / エラー原因: ...',
  rowsImported: 10,
  duplicateCount: 0,     // 任意
  dataPeriod: '期間文字列', // 任意
  fileName: 'xxx.csv',  // 任意
}
```

最低限 `status` / `message` / `rowsImported` を必ず返すこと。

---

## ファイル構成テンプレート

```
src/
├── コード.js     ← メイン処理（取込ロジック + Driveトリガー処理）
├── upload.html  ← フェーズ1のブラウザアップロードUI
└── appsscript.json
```

---

## 横展開時の注意点

新しいCSV種別を追加するときは以下を確認する。

1. **取込ロジック本体**（`importCsv` 相当）を新たに作る
2. **`importFromFileId(fileId)` の入口** を必ず用意する（親GASとの接続仕様）
3. **ファイル名プレフィックス** を決めて親GASの判定に追加する
4. **戻り値** が標準形になっていることを確認する
5. フェーズ1でメニューテストが通ってからフェーズ2へ進む
