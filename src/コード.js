// ============================================================
// GAS名: アップ用親フォルダGAS
// GAS URL: https://script.google.com/u/0/home/projects/1pObElCJbDz9GIUZZmZjTZhEPa2DLqai9nstUcNONY47i5624CQ16xOow/edit
// 役割: Driveフォルダを監視し、CSVをファイル名プレフィックスで子GASへ振り分けて取り込む
// ============================================================

// ---- スプレッドシート ----
const LOG_SPREADSHEET_ID = '1aYDQl95GRViM1OJOV-5e2NlB-H_6jseXTAHL2PYoAHk'; // ログ管理スプレッドシートのID
const LOG_SHEET_NAME = 'log';

// ---- Driveフォルダ ----
const DRIVE_FOLDERS = {
  input:     '1hqQhtQ3CKsu07wsrutiTeQUkw3xFmgV5', // CSVを置くフォルダ
  processed: '1i9cqp-ZxLnhTnecyru484-CiOix05hZ2', // 処理成功後の移動先
  error:     '1IRO975sSTLINYdWRfoQpvzkdyq9JguCo', // 処理失敗後の移動先
};

// ---- 子GAS ウェブアプリURL ----
// ファイル名のプレフィックスで振り分け先を判定する
const CHILD_SCRIPTS = [
  { prefix: 'act_', webAppUrl: 'https://script.google.com/macros/s/AKfycbwj9fQ2X_A9mZRwvlHUZD8vqlkvYzb2bPCzUwhsZv_vVxLYgjDbCnoqvvdTPDe4srXSvw/exec', desc: '楽天サーチ取込 (楽天サーチ 記録用)' },
  { prefix: 'rpp_', webAppUrl: 'https://script.google.com/macros/s/AKfycbzZvxl5m7gTacon_dtM-c1VqktP6URaGqdmzYiEVsy7UvdUaEFi9uNY63_hqV3chv1Q/exec', desc: 'RPPパフォーマンス取込 (RPP-Track)' },
];


// ============================================================
// メイン処理（タイマートリガーで定期実行）
// ============================================================

function processInputFolder() {
  const inputFolder = DriveApp.getFolderById(DRIVE_FOLDERS.input);

  for (const mimeType of [MimeType.CSV, MimeType.ZIP]) {
    const files = inputFolder.getFilesByType(mimeType);
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
}


// ============================================================
// 子GASへの振り分け
// ============================================================

function dispatchToChild_(file) {
  const fileName = file.getName();
  const child = CHILD_SCRIPTS.find(c => fileName.startsWith(c.prefix));

  if (!child) {
    return { status: 'error', message: '振り分けルールが未設定: ' + fileName, rowsImported: 0 };
  }

  if (!child.webAppUrl) {
    return {
      status: 'error',
      message: `ウェブアプリURLが未設定: ${child.prefix}`,
      rowsImported: 0,
    };
  }

  const response = UrlFetchApp.fetch(
    child.webAppUrl,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ fileId: file.getId() }),
      muteHttpExceptions: true,
    }
  );

  const statusCode = response.getResponseCode();
  let json;

  try {
    json = JSON.parse(response.getContentText());
  } catch (e) {
    return {
      status: 'error',
      message: `子GASレスポンスの解析に失敗: HTTP ${statusCode}`,
      rowsImported: 0,
    };
  }

  if (statusCode >= 400) {
    return {
      status: 'error',
      message: json.message || `子GAS呼び出し失敗: HTTP ${statusCode}`,
      rowsImported: json.rowsImported ?? 0,
    };
  }

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
  const spreadsheet = SpreadsheetApp.openById(LOG_SPREADSHEET_ID);
  let sheet = spreadsheet.getSheetByName(LOG_SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['timestamp', 'fileName', 'status', 'rowsImported', 'message']);
  }

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
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processInputFolder')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // 1分毎のポーリングトリガーを登録
  ScriptApp.newTrigger('processInputFolder')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('トリガーを設定しました（1分毎）');
}
