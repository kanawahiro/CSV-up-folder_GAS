// ============================================================
// GAS名: アップ用親フォルダGAS
// GAS URL: https://script.google.com/u/0/home/projects/1pObElCJbDz9GIUZZmZjTZhEPa2DLqai9nstUcNONY47i5624CQ16xOow/edit
// 役割: Driveフォルダを監視し、CSVをファイル名プレフィックスで子GASへ振り分けて取り込む
// ============================================================

// ---- スプレッドシート ----
const LOG_SPREADSHEET_ID = '1aYDQl95GRViM1OJOV-5e2NlB-H_6jseXTAHL2PYoAHk'; // ログ管理スプレッドシートのID
const LOG_SHEET_NAME = 'log';
const PARENT_LOG_SIGNATURE = 'PARENT_20260410_V1';

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
  {
    prefix: 'rpp_',
    patterns: [/^\d{8}_item_list\.csv$/i],
    webAppUrl: 'https://script.google.com/macros/s/AKfycbzCU1tvrd3vn-7NRY_b_RwBiWzecRVA0f3TAHwT3MA4hCbE03w9abDa-lqW4HIw3AiC/exec',
    desc: 'RPPパフォーマンス取込 (RPP-Track bridge)',
  },
];


// ============================================================
// メイン処理（タイマートリガーで定期実行）
// ============================================================

function processInputFolder() {
  const inputFolder = DriveApp.getFolderById(DRIVE_FOLDERS.input);

  const files = inputFolder.getFiles();
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
  const fileMimeType = file.getMimeType();

  if (!isSupportedInputFile_(fileName, fileMimeType)) {
    return {
      status: 'error',
      message: `未対応のファイル形式です: ${fileName} / ${fileMimeType}`,
      rowsImported: 0,
    };
  }

  const child = CHILD_SCRIPTS.find(c => matchChildScript_(c, fileName));

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

  let response;
  try {
    response = UrlFetchApp.fetch(
      child.webAppUrl,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ fileId: file.getId() }),
        muteHttpExceptions: true,
      }
    );
  } catch (error) {
    return {
      status: 'error',
      message:
        `子GAS呼び出し例外 child=${child.desc} url=${child.webAppUrl} ` +
        `fileName=${fileName} fileId=${file.getId()} error=${error.message}`,
      rowsImported: 0,
    };
  }

  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();
  let json;

  try {
    json = JSON.parse(responseText);
  } catch (e) {
    const preview = responseText.slice(0, 300);
    Logger.log(`子GASレスポンス内容: ${preview}`);
    return {
      status: 'error',
      message:
        `子GASレスポンス解析失敗 child=${child.desc} url=${child.webAppUrl} ` +
        `HTTP ${statusCode} / ${preview}`,
      rowsImported: 0,
    };
  }

  if (statusCode >= 400) {
    return {
      status: 'error',
      message:
        `子GASHTTPエラー child=${child.desc} url=${child.webAppUrl} ` +
        `HTTP ${statusCode} / ${json.message || responseText}`,
      rowsImported: json.rowsImported ?? 0,
    };
  }

  if (json && json.status === 'error') {
    return {
      status: 'error',
      message:
        `子GASエラー child=${child.desc} url=${child.webAppUrl} ` +
        `HTTP ${statusCode} / ${json.message || responseText}`,
      rowsImported: json.rowsImported ?? 0,
    };
  }

  return json;
}

function matchChildScript_(child, fileName) {
  if (child.prefix && fileName.startsWith(child.prefix)) {
    return true;
  }

  if (child.patterns) {
    return child.patterns.some(pattern => pattern.test(fileName));
  }

  return false;
}

function isSupportedInputFile_(fileName, mimeType) {
  return isCsvFile_(fileName, mimeType) || isZipFile_(fileName, mimeType);
}

function isCsvFile_(fileName, mimeType) {
  const normalizedFileName = String(fileName || '').toLowerCase();
  return normalizedFileName.endsWith('.csv') || mimeType === MimeType.CSV;
}

function isZipFile_(fileName, mimeType) {
  const normalizedFileName = String(fileName || '').toLowerCase();
  return normalizedFileName.endsWith('.zip') || mimeType === 'application/zip';
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
    formatParentLogMessage_(result.message),
  ]);
}

function formatParentLogMessage_(message) {
  const normalizedMessage = message == null ? '' : String(message);
  return `${PARENT_LOG_SIGNATURE} ${normalizedMessage}`.trim();
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
