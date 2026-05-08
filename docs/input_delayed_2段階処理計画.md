# input_delayed フォルダによる2段階処理計画

## 背景・目的

広告系ファイルを処理する際、5ファイルをすべて同時に処理するとシステム依存の問題が発生する。
最初の3ファイル（第1バッチ）を処理し終えてから少し余裕を持って残り2ファイル（第2バッチ）を処理したい。
時間指定だと「まだ処理が終わっていない」リスクがあるため、「input フォルダが空になってから2分後」という確実な条件で第2バッチを処理する。

## 処理の流れ

```
[毎分トリガー]
    ↓
input/ にファイルあり？
    ↓ Yes → 通常通り処理（第1バッチ）
    ↓ No  → 空になった時刻をScript Propertiesに記録

空になってから2分以上経過している？
    ↓ Yes → input_delayed/ のファイルを処理（第2バッチ）
    ↓ No  → スキップ
```

## 方針

| フォルダ | 役割 | タイミング |
|---------|------|----------|
| `input/`（既存） | 第1バッチ（即時処理したいファイル） | 毎分チェック・即時処理 |
| `input_delayed/`（新規） | 第2バッチ（後で処理したいファイル） | input/ が空になってから2分後 |

- Script Properties にタイムスタンプを保存して「空になった時刻」を管理する
- `input/` にファイルが追加されたらタイムスタンプをリセット（誤発火防止）

## Drive側の準備（ユーザー作業）

1. Google Drive で `input` フォルダと同じ階層に `input_delayed` フォルダを新規作成
2. そのフォルダIDを `src/コード.js` の `DRIVE_FOLDERS.input_delayed` に設定する

## コード変更（`src/コード.js`）

### 1. `DRIVE_FOLDERS` に `input_delayed` を追加

```js
const DRIVE_FOLDERS = {
  input:         '1hqQhtQ3CKsu07wsrutiTeQUkw3xFmgV5',
  input_delayed: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', // ← 新しいフォルダIDを設定
  processed:     '1i9cqp-ZxLnhTnecyru484-CiOix05hZ2',
  error:         '1IRO975sSTLINYdWRfoQpvzkdyq9JguCo',
  output:        '',
};
```

### 2. 定数を追加（既存定数の近くに）

```js
const INPUT_NOW_EMPTY_SINCE_KEY = 'INPUT_NOW_EMPTY_SINCE';
const DELAYED_WAIT_MS = 2 * 60 * 1000; // 2分
```

### 3. `processInputFolder()` の末尾に遅延処理を追加

`processRppUnyouFilePairs_(rppUnyouFiles);` の直後に追記：

```js
// input の空状態を記録し、条件を満たせば input_delayed を処理
const nowEmpty = !DriveApp.getFolderById(DRIVE_FOLDERS.input).getFiles().hasNext();
updateInputNowEmptyTimestamp_(nowEmpty);
if (shouldProcessDelayed_()) {
  processDelayedInputFolder_();
}
```

### 4. ヘルパー関数を追加（ファイル末尾）

#### `updateInputNowEmptyTimestamp_(isEmpty)`
```js
function updateInputNowEmptyTimestamp_(isEmpty) {
  const props = PropertiesService.getScriptProperties();
  if (isEmpty) {
    if (!props.getProperty(INPUT_NOW_EMPTY_SINCE_KEY)) {
      props.setProperty(INPUT_NOW_EMPTY_SINCE_KEY, String(new Date().getTime()));
      Logger.log('input が空になりました。タイムスタンプを記録します。');
    }
  } else {
    // ファイルが追加されたらタイムスタンプをリセット
    if (props.getProperty(INPUT_NOW_EMPTY_SINCE_KEY)) {
      props.deleteProperty(INPUT_NOW_EMPTY_SINCE_KEY);
      Logger.log('input にファイルが戻ったため、タイムスタンプをリセットしました。');
    }
  }
}
```

#### `shouldProcessDelayed_()`
```js
function shouldProcessDelayed_() {
  if (!DRIVE_FOLDERS.input_delayed) return false;
  const emptySince = PropertiesService.getScriptProperties().getProperty(INPUT_NOW_EMPTY_SINCE_KEY);
  if (!emptySince) return false;
  const elapsed = new Date().getTime() - Number(emptySince);
  return elapsed >= DELAYED_WAIT_MS;
}
```

#### `processDelayedInputFolder_()`
```js
function processDelayedInputFolder_() {
  const delayedFolder = DriveApp.getFolderById(DRIVE_FOLDERS.input_delayed);
  const rppUnyouFiles = [];
  const files = delayedFolder.getFiles();

  while (files.hasNext()) {
    const file = files.next();
    const fileName = file.getName();

    if (isClickpostReportFile_(fileName)) {
      processFileWithGuard_(file, function() {
        try { return processClickpostReportFile_(file); }
        catch (e) { return { status: 'error', message: e.message, rowsImported: 0 }; }
      }, DRIVE_FOLDERS.input_delayed);
      continue;
    }

    if (isRppUnyouManagedFile_(fileName)) {
      rppUnyouFiles.push(file);
      continue;
    }

    processFileWithGuard_(file, function() {
      try { return dispatchToChild_(file); }
      catch (e) { return { status: 'error', message: e.message, rowsImported: 0 }; }
    }, DRIVE_FOLDERS.input_delayed);
  }

  processRppUnyouFilePairs_(rppUnyouFiles);
}
```

### 5. `moveFile_` に `srcFolderId` 引数を追加

```js
function moveFile_(file, destFolderId, srcFolderId) {
  const dest = DriveApp.getFolderById(destFolderId);
  const src  = DriveApp.getFolderById(srcFolderId || DRIVE_FOLDERS.input);
  dest.addFile(file);
  src.removeFile(file);
}
```

### 6. `isFileInInputFolder_` を両フォルダ対応に変更

```js
function isFileInInputFolder_(file) {
  const validFolders = [DRIVE_FOLDERS.input];
  if (DRIVE_FOLDERS.input_delayed) validFolders.push(DRIVE_FOLDERS.input_delayed);

  const parents = file.getParents();
  while (parents.hasNext()) {
    if (validFolders.indexOf(parents.next().getId()) !== -1) return true;
  }
  return false;
}
```

### 7. `processFileWithGuard_` に `srcFolderId` 引数を追加

```js
function processFileWithGuard_(file, processor, srcFolderId) {
  // ... 既存の処理 ...
  moveFile_(file, destinationFolderId, srcFolderId);  // ← srcFolderId を渡す
  // ...
}
```

## 変更ファイル

- `src/コード.js` のみ

## 動作確認手順

1. Google Drive で `input_delayed` フォルダを作成しIDを取得
2. `DRIVE_FOLDERS.input_delayed` にIDを設定して `clasp push`
3. 第2バッチ用の2ファイルを `input_delayed/` に事前に配置
4. 第1バッチ3ファイルを `input/` に投入 → 1分以内に処理されることを確認
5. `input/` が空になってから2分後に `input_delayed/` の処理が走ることを確認
6. ログスプレッドシートで両バッチの処理ログが記録されているか確認
