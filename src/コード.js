// ============================================================
// CSV-up-folder 親GAS
// Driveフォルダを監視し、CSVを子GASへ振り分けて取り込む
// ============================================================

// ---- スプレッドシート ----
const LOG_SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID'; // ログ管理スプレッドシートのID
const LOG_SHEET_NAME = 'log';

// ---- Driveフォルダ ----
const DRIVE_FOLDERS = {
  input:     'YOUR_INPUT_FOLDER_ID',     // CSVを置くフォルダ
  processed: 'YOUR_PROCESSED_FOLDER_ID', // 処理成功後の移動先
  error:     'YOUR_ERROR_FOLDER_ID',     // 処理失敗後の移動先
};

// ---- 子GAS スクリプトID ----
// ファイル名のプレフィックスで振り分け先を判定する
const CHILD_SCRIPTS = [
  // { prefix: 'act_', scriptId: '子GASのスクリプトID', funcName: 'importFromFileId' },
];


// ============================================================
// メイン処理（タイマートリガーで定期実行）
// ============================================================

function processInputFolder() {
  const inputFolder = DriveApp.getFolderById(DRIVE_FOLDERS.input);
  const files = inputFolder.getFilesByType(MimeType.CSV);

  while (files.hasNext()) {
    const file = files.next();
    const fileName = file.getName();
    let result;

    try {
      result = dispatchToChild_(file);
    } catch (e) {
      result = { status: 'error', message: e.message, rowsImported: 0 };
    }

    if (result.status === 'success') {
      moveFile_(file, DRIVE_FOLDERS.processed);
    } else {
      moveFile_(file, DRIVE_FOLDERS.error);
    }

    logResult_(fileName, result);
  }
}


// ============================================================
// 子GASへの振り分け
// ============================================================

function dispatchToChild_(file) {
  const fileName = file.getName();
  const child = CHILD_SCRIPTS.find(c => fileName.startsWith(c.prefix));

  if (!child) {
    return { status: 'error', message: '対応する子GASが見つかりません: ' + fileName, rowsImported: 0 };
  }

  const response = UrlFetchApp.fetch(
    `https://script.google.com/macros/s/${child.scriptId}/exec`,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ fileId: file.getId() }),
      muteHttpExceptions: true,
    }
  );

  const json = JSON.parse(response.getContentText());
  return json;
}


// ============================================================
// ユーティリティ
// ============================================================

function moveFile_(file, destFolderId) {
  const dest = DriveApp.getFolderById(destFolderId);
  const src  = DriveApp.getFolderById(DRIVE_FOLDERS.input);
  dest.addFile(file);
  src.removeFile(file);
}

function logResult_(fileName, result) {
  const sheet = SpreadsheetApp.openById(LOG_SPREADSHEET_ID).getSheetByName(LOG_SHEET_NAME);
  sheet.appendRow([
    new Date(),
    fileName,
    result.status,
    result.rowsImported ?? 0,
    result.message ?? '',
  ]);
}


// ============================================================
// セットアップ（一度だけ手動実行）
// ============================================================

function setupTrigger() {
  // 既存トリガーを全削除（重複防止）
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 5分毎のポーリングトリガーを登録
  ScriptApp.newTrigger('processInputFolder')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('トリガーを設定しました（5分毎）');
}
