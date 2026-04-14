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
  input:         '1hqQhtQ3CKsu07wsrutiTeQUkw3xFmgV5', // CSVを置くフォルダ
  input_delayed: '1cVHO3_VW2aVaSGQOMz5ISuh6VtnCPoVQ', // 第2バッチ用フォルダ（input/ が空になってから2分後に処理）
  processed:     '1i9cqp-ZxLnhTnecyru484-CiOix05hZ2', // 処理成功後の移動先
  error:         '1IRO975sSTLINYdWRfoQpvzkdyq9JguCo', // 処理失敗後の移動先
  output:        '', // clickpostReport 加工後CSVの出力先（未設定時は入力フォルダと同階層の 04output を使用）
};

// ---- 子GAS ウェブアプリURL ----
// ファイル名のプレフィックスで振り分け先を判定する
const CHILD_SCRIPTS = [
  { prefix: 'act_', webAppUrl: 'https://script.google.com/macros/s/AKfycbwj9fQ2X_A9mZRwvlHUZD8vqlkvYzb2bPCzUwhsZv_vVxLYgjDbCnoqvvdTPDe4srXSvw/exec', desc: '楽天サーチ取込 (楽天サーチ 記録用)' },
  {
    patterns: [/^\d{8}_\d{8}_日次_SKU別売上データ\.csv$/i],
    webAppUrl: 'https://script.google.com/macros/s/AKfycbxL7beih1QQh8AbzjwX3NkPAvjw2m6-094B_M3feE4AhXHzmgtcAW-_e5357FysH6Jh-w/exec',
    desc: '販売実績CSV取込・分析更新',
  },
  {
    patterns: [/.*ピッキング.*\.csv$/i],
    webAppUrl: 'https://script.google.com/macros/s/AKfycbx-g5YT4kvVG1x4rd3jiDVLrtool1X0gGbaZejJ-VxMXuiTLCjL2_AsK066bzEKQaLK/exec',
    desc: '会津在庫減算取込 (ピッキングCSV)',
  },
  {
    prefix: 'rpp_',
    patterns: [/^\d{8}_item_list\.csv$/i],
    webAppUrl: 'https://script.google.com/macros/s/AKfycbwUuMWwtkPsGDfE6gEHCu3Eno7ynoV0IQCZdUK1baEdo50RoL9-STegoBj6hqDMIuLP/exec',
    desc: 'RPPパフォーマンス取込 (RPP-Track)',
  },
];

const RPP_UNYOU_CHILD = {
  webAppUrl: 'https://script.google.com/macros/s/AKfycbyyXLyOFWkfuCJYfFWXlBTBvdYNGh-18ftYR_70TkX5qnWWMpTiAJggBzD2dugo3tPH/exec',
  desc: 'RPP運用CSV取込 (RPP-unyou)',
};

const RPP_UNYOU_FILE_PATTERNS = {
  cpc: /^rpp_item_keyword_limelimedou_(\d{8})\d+\.csv$/i,
  rank: /^rpp_keyword_ranking_limelimedou_(\d{8})\d{6}(?:_\d+)?\.csv$/i,
};

const INPUT_NOW_EMPTY_SINCE_KEY = 'INPUT_NOW_EMPTY_SINCE';
const DELAYED_WAIT_MS = 2 * 60 * 1000; // 2分

const RPP_UNYOU_PAIR_PROPERTY_PREFIX = 'RPP_UNYOU_PAIR_';
const FILE_PROCESS_PROPERTY_PREFIX = 'FILE_PROCESS_';
const FILE_PROCESSING_STATUS = 'processing';
const FILE_DONE_STATUS = 'done';
const FILE_PROCESSING_TTL_MS = 60 * 60 * 1000;
const FILE_DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESS_INPUT_LOCK_WAIT_MS = 5000;


// ============================================================
// メイン処理（タイマートリガーで定期実行）
// ============================================================

function processInputFolder() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PROCESS_INPUT_LOCK_WAIT_MS)) {
    Logger.log('processInputFolder スキップ: 他の実行が処理中です');
    return;
  }

  try {
    cleanupOldFileProcessMarks_();

    const inputFolder = DriveApp.getFolderById(DRIVE_FOLDERS.input);
    const rppUnyouFiles = [];
    const files = inputFolder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();

      if (isClickpostReportFile_(fileName)) {
        processFileWithGuard_(file, function() {
          try {
            return processClickpostReportFile_(file);
          } catch (e) {
            return { status: 'error', message: e.message, rowsImported: 0 };
          }
        });
        continue;
      }

      if (isRppUnyouManagedFile_(file.getName())) {
        rppUnyouFiles.push(file);
        continue;
      }

      processFileWithGuard_(file, function() {
        try {
          return dispatchToChild_(file);
        } catch (e) {
          return { status: 'error', message: e.message, rowsImported: 0 };
        }
      });
    }

    processRppUnyouFilePairs_(rppUnyouFiles);

    // input の空状態を記録し、条件を満たせば input_delayed を処理
    const nowEmpty = !DriveApp.getFolderById(DRIVE_FOLDERS.input).getFiles().hasNext();
    updateInputNowEmptyTimestamp_(nowEmpty);
    if (shouldProcessDelayed_()) {
      processDelayedInputFolder_();
    }
  } finally {
    lock.releaseLock();
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

  return postToChildWebApp_(
    child.webAppUrl,
    { fileId: file.getId() },
    child.desc,
    `fileName=${fileName} fileId=${file.getId()}`
  );
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

function isRppUnyouManagedFile_(fileName) {
  return Boolean(parseRppUnyouFileMeta_(fileName));
}

function parseRppUnyouFileMeta_(fileName) {
  const normalizedFileName = String(fileName || '');
  const cpcMatch = normalizedFileName.match(RPP_UNYOU_FILE_PATTERNS.cpc);
  if (cpcMatch) {
    return { type: 'cpc', pairKey: cpcMatch[1] };
  }

  const rankMatch = normalizedFileName.match(RPP_UNYOU_FILE_PATTERNS.rank);
  if (rankMatch) {
    return { type: 'rank', pairKey: rankMatch[1] };
  }

  return null;
}

function processRppUnyouFilePairs_(files) {
  if (!files || files.length === 0) {
    return;
  }

  const pairMap = new Map();

  files.forEach(file => {
    const meta = parseRppUnyouFileMeta_(file.getName());
    if (!meta) {
      return;
    }

    const pair = pairMap.get(meta.pairKey) || {
      pairKey: meta.pairKey,
      cpcFiles: [],
      rankFiles: [],
    };

    if (meta.type === 'cpc') {
      pair.cpcFiles.push(file);
    } else {
      pair.rankFiles.push(file);
    }

    pairMap.set(meta.pairKey, pair);
  });

  pairMap.forEach(pair => processRppUnyouPair_(pair));
}

function processRppUnyouPair_(pair) {
  if (pair.cpcFiles.length === 0 || pair.rankFiles.length === 0) {
    Logger.log(`RPP運用CSV待機中 pair=${pair.pairKey}`);
    return;
  }

  if (pair.cpcFiles.length > 1 || pair.rankFiles.length > 1) {
    const filesToMove = pair.cpcFiles.concat(pair.rankFiles);
    const result = {
      status: 'error',
      message: `RPP運用CSVが重複しています pair=${pair.pairKey}`,
      rowsImported: 0,
    };

    if (!startFilesProcessing_(filesToMove)) {
      Logger.log(`RPP運用CSV重複処理スキップ pair=${pair.pairKey}`);
      return;
    }

    let completed = false;
    try {
      filesToMove.forEach(file => {
        moveFile_(file, DRIVE_FOLDERS.error);
        markFileDone_(file.getId(), file.getName(), result.status);
        logResult_(file.getName(), result);
      });
      completed = true;
    } finally {
      if (!completed) {
        clearFilesProcessing_(filesToMove);
      }
    }
    return;
  }

  const propertyKey = `${RPP_UNYOU_PAIR_PROPERTY_PREFIX}${pair.pairKey}`;
  if (!startRppUnyouPairProcessing_(propertyKey)) {
    Logger.log(`RPP運用CSV処理スキップ pair=${pair.pairKey}`);
    return;
  }

  const cpcFile = pair.cpcFiles[0];
  const rankFile = pair.rankFiles[0];
  const pairFiles = [cpcFile, rankFile];

  if (!startFilesProcessing_(pairFiles)) {
    finishRppUnyouPairProcessing_(propertyKey);
    Logger.log(`RPP運用CSV処理スキップ fileId処理中 pair=${pair.pairKey}`);
    return;
  }

  if (!pairFiles.every(isFileInInputFolder_)) {
    clearFilesProcessing_(pairFiles);
    finishRppUnyouPairProcessing_(propertyKey);
    Logger.log(`RPP運用CSV処理スキップ input外移動済み pair=${pair.pairKey}`);
    return;
  }

  let result;
  let completed = false;

  try {
    result = dispatchRppUnyouPairToChild_(pair.pairKey, cpcFile, rankFile);
  } catch (error) {
    result = { status: 'error', message: error.message, rowsImported: 0, csvImportStatus: 'error' };
  }

  const destinationFolderId = isRppUnyouCsvImportSuccessful_(result)
    ? DRIVE_FOLDERS.processed
    : DRIVE_FOLDERS.error;

  try {
    moveFile_(cpcFile, destinationFolderId);
    moveFile_(rankFile, destinationFolderId);
    markFileDone_(cpcFile.getId(), cpcFile.getName(), result.status);
    markFileDone_(rankFile.getId(), rankFile.getName(), result.status);
    completed = true;
  } finally {
    if (!completed) {
      clearFilesProcessing_(pairFiles);
    }
    finishRppUnyouPairProcessing_(propertyKey);
  }

  logResult_(cpcFile.getName(), result);
  logResult_(rankFile.getName(), result);
}

function dispatchRppUnyouPairToChild_(pairKey, cpcFile, rankFile) {
  if (!RPP_UNYOU_CHILD.webAppUrl) {
    return {
      status: 'error',
      message: `ウェブアプリURLが未設定: pair=${pairKey}`,
      rowsImported: 0,
    };
  }

  const result = postToChildWebApp_(
    RPP_UNYOU_CHILD.webAppUrl,
    {
      cpcFileId: cpcFile.getId(),
      rankFileId: rankFile.getId(),
    },
    RPP_UNYOU_CHILD.desc,
    `pair=${pairKey} cpcFile=${cpcFile.getName()} rankFile=${rankFile.getName()}`
  );

  if (result.csvImportStatus === 'success' && result.rppTrackStatus === 'error') {
    result.message =
      `CSV取込み成功 / RPPトラックデータ読込み失敗: ${result.rppTrackMessage || result.message}`;
  }

  return result;
}

function isRppUnyouCsvImportSuccessful_(result) {
  return result && result.csvImportStatus === 'success';
}

function startRppUnyouPairProcessing_(propertyKey) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(propertyKey)) {
    return false;
  }

  properties.setProperty(propertyKey, String(new Date().getTime()));
  return true;
}

function finishRppUnyouPairProcessing_(propertyKey) {
  PropertiesService.getScriptProperties().deleteProperty(propertyKey);
}

function postToChildWebApp_(webAppUrl, payload, childDesc, contextLabel) {
  let response;
  try {
    response = UrlFetchApp.fetch(
      webAppUrl,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      }
    );
  } catch (error) {
    return {
      status: 'error',
      message:
        `子GAS呼び出し例外 child=${childDesc} url=${webAppUrl} ` +
        `${contextLabel} error=${error.message}`,
      rowsImported: 0,
    };
  }

  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();
  let json;

  try {
    json = JSON.parse(responseText);
  } catch (error) {
    const preview = responseText.slice(0, 300);
    Logger.log(`子GASレスポンス内容: ${preview}`);
    return {
      status: 'error',
      message:
        `子GASレスポンス解析失敗 child=${childDesc} url=${webAppUrl} ` +
        `HTTP ${statusCode} / ${preview}`,
      rowsImported: 0,
    };
  }

  if (statusCode >= 400) {
    return {
      status: 'error',
      message:
        `子GASHTTPエラー child=${childDesc} url=${webAppUrl} ` +
        `HTTP ${statusCode} / ${json.message || responseText}`,
      rowsImported: json.rowsImported ?? 0,
    };
  }

  if (json && json.status === 'error') {
    return {
      status: 'error',
      message:
        `子GASエラー child=${childDesc} url=${webAppUrl} ` +
        `HTTP ${statusCode} / ${json.message || responseText}`,
      rowsImported: json.rowsImported ?? 0,
    };
  }

  return json;
}

function processFileWithGuard_(file, processor, srcFolderId) {
  const fileName = file.getName();
  const fileId = file.getId();

  if (!startFileProcessing_(fileId, fileName)) {
    Logger.log(`ファイル処理スキップ fileName=${fileName} fileId=${fileId}`);
    return null;
  }

  let completed = false;
  try {
    if (!isFileInInputFolder_(file)) {
      Logger.log(`ファイル処理スキップ input外 fileName=${fileName} fileId=${fileId}`);
      return null;
    }

    const result = processor();
    const destinationFolderId = result.status === 'success'
      ? DRIVE_FOLDERS.processed
      : DRIVE_FOLDERS.error;

    moveFile_(file, destinationFolderId, srcFolderId);
    markFileDone_(fileId, fileName, result.status);
    completed = true;
    logResult_(fileName, result);
    return result;
  } finally {
    if (!completed) {
      clearFileProcessing_(fileId);
    }
  }
}

function startFilesProcessing_(files) {
  const startedFiles = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!startFileProcessing_(file.getId(), file.getName())) {
      clearFilesProcessing_(startedFiles);
      return false;
    }
    startedFiles.push(file);
  }

  return true;
}

function clearFilesProcessing_(files) {
  files.forEach(file => clearFileProcessing_(file.getId()));
}

function startFileProcessing_(fileId, fileName) {
  const properties = PropertiesService.getScriptProperties();
  const propertyKey = buildFileProcessPropertyKey_(fileId);
  const current = parseFileProcessMark_(properties.getProperty(propertyKey));
  const now = new Date().getTime();

  if (current) {
    const age = now - current.timestamp;
    if (current.status === FILE_DONE_STATUS && age < FILE_DONE_TTL_MS) {
      return false;
    }
    if (current.status === FILE_PROCESSING_STATUS && age < FILE_PROCESSING_TTL_MS) {
      return false;
    }
  }

  properties.setProperty(propertyKey, JSON.stringify({
    status: FILE_PROCESSING_STATUS,
    fileName: fileName,
    timestamp: now,
  }));
  return true;
}

function markFileDone_(fileId, fileName, resultStatus) {
  PropertiesService.getScriptProperties().setProperty(
    buildFileProcessPropertyKey_(fileId),
    JSON.stringify({
      status: FILE_DONE_STATUS,
      fileName: fileName,
      resultStatus: resultStatus,
      timestamp: new Date().getTime(),
    })
  );
}

function clearFileProcessing_(fileId) {
  const properties = PropertiesService.getScriptProperties();
  const propertyKey = buildFileProcessPropertyKey_(fileId);
  const current = parseFileProcessMark_(properties.getProperty(propertyKey));

  if (current && current.status === FILE_PROCESSING_STATUS) {
    properties.deleteProperty(propertyKey);
  }
}

function cleanupOldFileProcessMarks_() {
  const properties = PropertiesService.getScriptProperties();
  const allProperties = properties.getProperties();
  const now = new Date().getTime();

  Object.keys(allProperties).forEach(key => {
    if (key.indexOf(FILE_PROCESS_PROPERTY_PREFIX) !== 0) {
      return;
    }

    const current = parseFileProcessMark_(allProperties[key]);
    if (!current) {
      properties.deleteProperty(key);
      return;
    }

    const ttl = current.status === FILE_DONE_STATUS
      ? FILE_DONE_TTL_MS
      : FILE_PROCESSING_TTL_MS;
    if (now - current.timestamp > ttl) {
      properties.deleteProperty(key);
    }
  });
}

function parseFileProcessMark_(value) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || !parsed.status || !parsed.timestamp) {
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

function buildFileProcessPropertyKey_(fileId) {
  return `${FILE_PROCESS_PROPERTY_PREFIX}${fileId}`;
}

function isFileInInputFolder_(file) {
  const validFolders = [DRIVE_FOLDERS.input];
  if (DRIVE_FOLDERS.input_delayed) validFolders.push(DRIVE_FOLDERS.input_delayed);

  const parents = file.getParents();
  while (parents.hasNext()) {
    if (validFolders.indexOf(parents.next().getId()) !== -1) return true;
  }
  return false;
}

function moveFile_(file, destFolderId, srcFolderId) {
  const dest = DriveApp.getFolderById(destFolderId);
  const src  = DriveApp.getFolderById(srcFolderId || DRIVE_FOLDERS.input);
  dest.addFile(file);
  src.removeFile(file);
}


// ============================================================
// ユーティリティ
// ============================================================

function logResult_(fileName, result) {
  const spreadsheet = SpreadsheetApp.openById(LOG_SPREADSHEET_ID);
  let sheet = spreadsheet.getSheetByName(LOG_SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(LOG_SHEET_NAME);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 5).setValues([['timestamp', 'fileName', 'status', 'rowsImported', 'message']]);
  }

  sheet.insertRowAfter(1);
  sheet.getRange(2, 1, 1, 5).setValues([[
    new Date(),
    fileName,
    result.status,
    result.rowsImported ?? 0,
    formatParentLogMessage_(result.message),
  ]]);
}

function formatParentLogMessage_(message) {
  const normalizedMessage = message == null ? '' : String(message);
  return `${PARENT_LOG_SIGNATURE} ${normalizedMessage}`.trim();
}


// ============================================================
// input_delayed 2段階処理
// ============================================================

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

function shouldProcessDelayed_() {
  if (!DRIVE_FOLDERS.input_delayed) return false;
  const emptySince = PropertiesService.getScriptProperties().getProperty(INPUT_NOW_EMPTY_SINCE_KEY);
  if (!emptySince) return false;
  const elapsed = new Date().getTime() - Number(emptySince);
  return elapsed >= DELAYED_WAIT_MS;
}

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
