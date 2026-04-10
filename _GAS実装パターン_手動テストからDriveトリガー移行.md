# GAS実装パターン: 手動テストから親子GAS構成への移行

## 概要

新しいCSV取込GASを作成する際の標準的な実装フロー。
スプレッドシートのメニューで手動テストし、動作確認後に親GAS（アップ用親フォルダGAS）から呼び出される構成へ移行する。

---

## 前提

- **アップするCSVの形式・実行するプログラムは子GASごとに異なる**
- CSVのフォーマット、ヘッダー構成、取込先スプレッドシートはすべて子GAS側で定義する
- 親GASは「どのファイルをどの子GASに渡すか」だけを管理し、取込内容には関与しない
- 新しい子GASを追加するときは、**その子GASのコードを確認してから**プレフィックスや設定を決めること

---

## 新しいCSV種別を追加するときは（クイックリファレンス）

1. **子GASに `doPost` + `importFromFileId` を実装してウェブアプリとしてデプロイ**
2. **親GAS（`CSV-up-folder_GAS/src/コード.js`）の `CHILD_SCRIPTS` に1行追加するだけ**

```javascript
const CHILD_SCRIPTS = [
  { prefix: 'act_', webAppUrl: '...', desc: '楽天サーチ取込 (楽天サーチ 記録用)' },
  { prefix: '新プレフィックス_', webAppUrl: 'デプロイURL', desc: '追加する子GASの説明' }, // ← ここに追加
];
```

詳細な手順は下記の各フェーズを参照。

---

## フェーズ構成

```
フェーズ1: 手動テスト（子GAS単体）
  └── スプレッドシートのカスタムメニュー → CSV手動取込 → 動作確認

フェーズ2: 親子GAS構成への移行
  └── 子GAS → doPost エンドポイントを追加してウェブアプリとして公開
  └── 親GAS → CHILD_SCRIPTS に1行追加して振り分けルールを登録
```

---

## フェーズ1: 手動テスト実装

### 目的

- CSV取込ロジックが正しく動くかを、スプレッドシートのメニューから確認する
- 親GAS連携の前に取込仕様を完成させる

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

// ④ 親GAS連携用入口（フェーズ2でも共通利用）
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

## フェーズ2: 親子GAS構成への移行

### 目的

- 親GAS（アップ用親フォルダGAS）からHTTPで呼び出される構成に切り替える
- フェーズ1で完成した取込ロジックはそのまま使う
- フォルダ監視・ファイル移動・ログ記録はすべて親GASが担当する

---

### 全体構成

```
[01input フォルダ]
  ↓ 1分おきにポーリング（親GAS）
[アップ用親フォルダGAS]
  ├── ファイル名プレフィックスで振り分け
  │     ├── act_ → 楽天サーチ 記録用（ウェブアプリ）へ POST
  │     └── （将来追加分） → 他の子GAS へ POST
  ├── 成功 → 02processed へ移動
  └── 失敗 → 03error へ移動・ログ記録
```

---

### 子GAS側に追加する実装

フェーズ1のコードはそのまま残し、`doPost(e)` を1つ追加するだけ。

```javascript
// 親GASからPOSTリクエストで呼ばれるエンドポイント
// リクエストボディ: { "fileId": "DriveファイルID" }
function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    const result = importFromFileId(params.fileId);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error.message,
      rowsImported: 0,
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
```

### 子GASのウェブアプリとしてのデプロイ手順

1. GASエディタ → デプロイ → 新しいデプロイ
2. 種類: **ウェブアプリ**
3. 実行者: **自分**
4. アクセス: **全員（URLを知っている人）**
5. デプロイ → URLをコピー（`https://script.google.com/macros/s/AKfycbx.../exec`）

> コードを変更した場合は「デプロイを管理」→「新しいバージョンを作成」が必要。

---

### 親GAS（アップ用親フォルダGAS）の設定

子GASを追加するときは `CHILD_SCRIPTS` に1行追加するだけ。

```javascript
// ここを見れば何がどのGASに振り分けられるかわかる
const CHILD_SCRIPTS = [
  { prefix: 'act_', webAppUrl: '子GASのデプロイURL', desc: '楽天サーチ取込 (楽天サーチ 記録用)' },
  // { prefix: '新プレフィックス_', webAppUrl: '...', desc: '説明' },  ← 追加はここに1行
];
```

---

### ログシートの列構成

親GASのログシート（`log`）に以下の形式で記録される。

| 列 | 内容 | 例 |
|----|------|---|
| A | 実行日時 | 2026/04/09 10:05:00 |
| B | ファイル名 | act_20260401_427986.csv |
| C | status | success / error |
| D | 取込件数 | 10 |
| E | メッセージ | 10件登録しました。 |

> `log` シートは初回実行時に自動作成される。手動での事前作成は不要。

---

## 戻り値の標準形

子GASの取込結果は、親GASが共通で扱えるよう以下の形を守る。

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

## 移行チェックリスト

フェーズ1の動作確認が取れたら、以下を順番に実施する。

- [ ] 子GASに `doPost(e)` を追加する
- [ ] 子GASをウェブアプリとしてデプロイしてURLを取得する
- [ ] 親GASの `CHILD_SCRIPTS` にプレフィックスとURLを登録する
- [ ] 親GASをclasp pushして反映する
- [ ] 親GASエディタで `setupTrigger()` を手動実行する（1分ごとのトリガーが登録される）
- [ ] 子GASに旧トリガーが残っていれば削除する
- [ ] `01input` に実際のCSVを置いて動作確認する

---

## ファイル構成テンプレート

```
子GAS/
├── src/
│   ├── コード.js     ← 取込ロジック + doPost エンドポイント
│   ├── upload.html  ← フェーズ1のブラウザアップロードUI
│   └── appsscript.json

親GAS（CSV-up-folder_GAS）/
├── src/
│   ├── コード.js     ← フォルダ監視・振り分け・ログ（CHILD_SCRIPTSを更新するだけ）
│   └── appsscript.json
```

---

## 横展開時の注意点

新しいCSV種別を追加するときは以下を確認する。

1. **取込ロジック本体**（`importCsv` 相当）を新たに作る
2. **`importFromFileId(fileId)` の入口** を必ず用意する（親GASとの接続仕様）
3. **`doPost(e)` を追加**してウェブアプリとしてデプロイする
4. **ファイル名プレフィックス** を決めて親GASの `CHILD_SCRIPTS` に1行追加する
5. **戻り値** が標準形になっていることを確認する
6. フェーズ1でメニューテストが通ってからフェーズ2へ進む

---

## 実案件設定例: 楽天サーチGAS

### GAS情報

| GAS名 | 役割 | ローカルリポジトリ | GAS URL |
|---|---|---|---|
| アップ用親フォルダGAS | フォルダ監視・振り分け | `CSV-up-folder_GAS` | https://script.google.com/u/0/home/projects/1pObElCJbDz9GIUZZmZjTZhEPa2DLqai9nstUcNONY47i5624CQ16xOow/edit |
| 楽天サーチ 記録用 | 楽天サーチCSV取込 | `利益・広告/raku_sa-chi_GAS` | https://script.google.com/home/projects/1beZAm8T7sp5LVwlQhGA4p9lLtdq3uZErKW6AHgW45Os3gCULEEnBOsKr/edit |

### Driveフォルダ情報

| 用途 | フォルダID |
|------|------------|
| input (01input) | `1hqQhtQ3CKsu07wsrutiTeQUkw3xFmgV5` |
| processed (02processed) | `1i9cqp-ZxLnhTnecyru484-CiOix05hZ2` |
| error (03error) | `1IRO975sSTLINYdWRfoQpvzkdyq9JguCo` |

### ログシート情報

| 種類 | スプレッドシートID | シート名 |
|---|---|---|
| 親GASルーティングログ | `1aYDQl95GRViM1OJOV-5e2NlB-H_6jseXTAHL2PYoAHk` | `log` |
| 子GAS取込ログ | `1aYDQl95GRViM1OJOV-5e2NlB-H_6jseXTAHL2PYoAHk` | `取込ログ` |

### 振り分けルール

```javascript
const CHILD_SCRIPTS = [
  { prefix: 'act_', webAppUrl: '（デプロイ後に設定）', desc: '楽天サーチ取込 (楽天サーチ 記録用)' },
];
```
