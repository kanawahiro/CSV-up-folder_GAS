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
  output:    '', // clickpostReport 加工後CSVの出力先（未設定時は入力フォルダと同階層の 04output を使用）
};

// ---- 子GAS ウェブアプリURL ----
// ファイル名のプレフィックスで振り分け先を判定する
const CHILD_SCRIPTS = [
  { prefix: 'act_', webAppUrl: 'https://script.google.com/macros/s/AKfycbwj9fQ2X_A9mZRwvlHUZD8vqlkvYzb2bPCzUwhsZv_vVxLYgjDbCnoqvvdTPDe4srXSvw/exec', desc: '楽天サーチ取込 (楽天サーチ 記録用)' },
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

const RPP_UNYOU_PAIR_PROPERTY_PREFIX = 'RPP_UNYOU_PAIR_';

const RPP_TRACK_ORDERED_FILE_PATTERNS = {
  itemList: /^(\d{8})_item_list\.csv$/i,
  itemReports: /^rpp_item_reports_limelimedou_(\d{8})\d+\.csv$/i,
  keywordReports: /^rpp_keyword_reports_limelimedou_(\d{8})\d+\.csv$/i,
};

const RPP_TRACK_ORDERED_TYPE_ORDER = {
  itemList: 1,
  itemReports: 2,
  keywordReports: 3,
};

const ORDERED_UPLOAD_SKIPPED_MESSAGE = '前段エラーのため未処理でerror移動';


// ============================================================
// メイン処理（タイマートリガーで定期実行）
// ============================================================

function processInputFolder() {
  const inputFolder = DriveApp.getFolderById(DRIVE_FOLDERS.input);
  const files = collectInputFiles_(inputFolder);
  const clickpostFiles = [];
  const orderedUploadFiles = [];
  const regularFiles = [];

  files.forEach(file => {
    const fileName = file.getName();

    if (isClickpostReportFile_(fileName)) {
      clickpostFiles.push(file);
      return;
    }

    if (isOrderedUploadTargetFile_(fileName)) {
      orderedUploadFiles.push(file);
      return;
    }

    regularFiles.push(file);
  });

  clickpostFiles.forEach(file => processClickpostReportInputFile_(file));

  if (!processOrderedUploadFiles_(orderedUploadFiles)) {
    return;
  }

  regularFiles.forEach(file => processRegularInputFile_(file));
}

function collectInputFiles_(inputFolder) {
  const files = [];
  const iterator = inputFolder.getFiles();

  while (iterator.hasNext()) {
    files.push(iterator.next());
  }

  return files;
}

function processClickpostReportInputFile_(file) {
  const fileName = file.getName();
  let result;

  try {
    result = processClickpostReportFile_(file);
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

function processRegularInputFile_(file) {
  const result = dispatchInputFile_(file);
  const destinationFolderId = result.status === 'success'
    ? DRIVE_FOLDERS.processed
    : DRIVE_FOLDERS.error;

  moveFile_(file, destinationFolderId);
  logResult_(file.getName(), result);
}

function processOrderedUploadFiles_(files) {
  if (!files || files.length === 0) {
    return true;
  }

  const handledFileIds = {};
  const rppTrackFiles = files
    .filter(file => isRppTrackOrderedFile_(file.getName()))
    .sort(compareRppTrackOrderedFiles_);
  const rakutenSearchFiles = files
    .filter(file => isRakutenSearchFile_(file.getName()))
    .sort(compareFilesByName_);
  const rppUnyouFiles = files
    .filter(file => isRppUnyouManagedFile_(file.getName()))
    .sort(compareRppUnyouFiles_);

  if (!processOrderedDispatchFiles_(rppTrackFiles, files, handledFileIds)) {
    return false;
  }

  if (!processOrderedRppUnyouFiles_(rppUnyouFiles, files, handledFileIds)) {
    return false;
  }

  if (!processOrderedDispatchFiles_(rakutenSearchFiles, files, handledFileIds)) {
    return false;
  }

  return true;
}

function processOrderedDispatchFiles_(stageFiles, allOrderedFiles, handledFileIds) {
  for (let i = 0; i < stageFiles.length; i++) {
    const file = stageFiles[i];
    const result = dispatchInputFile_(file);
    const destinationFolderId = result.status === 'success'
      ? DRIVE_FOLDERS.processed
      : DRIVE_FOLDERS.error;

    moveFile_(file, destinationFolderId);
    logResult_(file.getName(), result);
    markHandledFile_(handledFileIds, file);

    if (result.status !== 'success') {
      moveRemainingOrderedFilesToError_(allOrderedFiles, handledFileIds, result.message);
      return false;
    }
  }

  return true;
}

function processOrderedRppUnyouFiles_(files, allOrderedFiles, handledFileIds) {
  if (!files || files.length === 0) {
    return true;
  }

  const pairMap = buildRppUnyouPairMap_(files);
  const pairKeys = Array.from(pairMap.keys()).sort();

  for (let i = 0; i < pairKeys.length; i++) {
    const pair = pairMap.get(pairKeys[i]);
    const pairValidationError = validateRppUnyouPair_(pair);

    if (pairValidationError) {
      const errorFiles = pair.cpcFiles.concat(pair.rankFiles);
      const result = {
        status: 'error',
        message: pairValidationError,
        rowsImported: 0,
      };

      errorFiles.forEach(file => {
        moveFile_(file, DRIVE_FOLDERS.error);
        logResult_(file.getName(), result);
        markHandledFile_(handledFileIds, file);
      });
      moveRemainingOrderedFilesToError_(allOrderedFiles, handledFileIds, result.message);
      return false;
    }

    if (!processOrderedRppUnyouPair_(pair, handledFileIds)) {
      const message = `RPP運用CSV処理失敗 pair=${pair.pairKey}`;
      moveRemainingOrderedFilesToError_(allOrderedFiles, handledFileIds, message);
      return false;
    }
  }

  return true;
}

function processOrderedRppUnyouPair_(pair, handledFileIds) {
  const propertyKey = `${RPP_UNYOU_PAIR_PROPERTY_PREFIX}${pair.pairKey}`;
  const cpcFile = pair.cpcFiles[0];
  const rankFile = pair.rankFiles[0];

  if (!startRppUnyouPairProcessing_(propertyKey)) {
    const result = {
      status: 'error',
      message: `RPP運用CSV処理スキップ pair=${pair.pairKey}`,
      rowsImported: 0,
      csvImportStatus: 'error',
    };
    [cpcFile, rankFile].forEach(file => {
      moveFile_(file, DRIVE_FOLDERS.error);
      logResult_(file.getName(), result);
      markHandledFile_(handledFileIds, file);
    });
    return false;
  }

  let result;

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
  } finally {
    finishRppUnyouPairProcessing_(propertyKey);
  }

  logResult_(cpcFile.getName(), result);
  logResult_(rankFile.getName(), result);
  markHandledFile_(handledFileIds, cpcFile);
  markHandledFile_(handledFileIds, rankFile);

  return isRppUnyouCsvImportSuccessful_(result);
}

function dispatchInputFile_(file) {
  try {
    return dispatchToChild_(file);
  } catch (e) {
    return { status: 'error', message: e.message, rowsImported: 0 };
  }
}

function moveRemainingOrderedFilesToError_(allOrderedFiles, handledFileIds, reason) {
  const result = {
    status: 'error',
    message: `${ORDERED_UPLOAD_SKIPPED_MESSAGE}: ${reason || ''}`.trim(),
    rowsImported: 0,
  };

  allOrderedFiles.forEach(file => {
    if (isHandledFile_(handledFileIds, file)) {
      return;
    }

    moveFile_(file, DRIVE_FOLDERS.error);
    logResult_(file.getName(), result);
    markHandledFile_(handledFileIds, file);
  });
}

function markHandledFile_(handledFileIds, file) {
  handledFileIds[file.getId()] = true;
}

function isHandledFile_(handledFileIds, file) {
  return handledFileIds[file.getId()] === true;
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

function isOrderedUploadTargetFile_(fileName) {
  return isRppTrackOrderedFile_(fileName)
    || isRakutenSearchFile_(fileName)
    || isRppUnyouManagedFile_(fileName);
}

function isRppTrackOrderedFile_(fileName) {
  return Boolean(parseRppTrackOrderedFileMeta_(fileName));
}

function parseRppTrackOrderedFileMeta_(fileName) {
  const normalizedFileName = String(fileName || '');
  const itemListMatch = normalizedFileName.match(RPP_TRACK_ORDERED_FILE_PATTERNS.itemList);
  if (itemListMatch) {
    return { type: 'itemList', typeOrder: RPP_TRACK_ORDERED_TYPE_ORDER.itemList, dateKey: itemListMatch[1] };
  }

  const itemReportsMatch = normalizedFileName.match(RPP_TRACK_ORDERED_FILE_PATTERNS.itemReports);
  if (itemReportsMatch) {
    return { type: 'itemReports', typeOrder: RPP_TRACK_ORDERED_TYPE_ORDER.itemReports, dateKey: itemReportsMatch[1] };
  }

  const keywordReportsMatch = normalizedFileName.match(RPP_TRACK_ORDERED_FILE_PATTERNS.keywordReports);
  if (keywordReportsMatch) {
    return { type: 'keywordReports', typeOrder: RPP_TRACK_ORDERED_TYPE_ORDER.keywordReports, dateKey: keywordReportsMatch[1] };
  }

  return null;
}

function isRakutenSearchFile_(fileName) {
  return String(fileName || '').startsWith('act_');
}

function compareRppTrackOrderedFiles_(a, b) {
  const aMeta = parseRppTrackOrderedFileMeta_(a.getName());
  const bMeta = parseRppTrackOrderedFileMeta_(b.getName());
  const typeOrderDiff = aMeta.typeOrder - bMeta.typeOrder;
  if (typeOrderDiff !== 0) {
    return typeOrderDiff;
  }

  const dateDiff = aMeta.dateKey.localeCompare(bMeta.dateKey);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  return compareFilesByName_(a, b);
}

function compareRppUnyouFiles_(a, b) {
  const aMeta = parseRppUnyouFileMeta_(a.getName());
  const bMeta = parseRppUnyouFileMeta_(b.getName());
  const pairKeyDiff = aMeta.pairKey.localeCompare(bMeta.pairKey);
  if (pairKeyDiff !== 0) {
    return pairKeyDiff;
  }

  if (aMeta.type !== bMeta.type) {
    return aMeta.type === 'cpc' ? -1 : 1;
  }

  return compareFilesByName_(a, b);
}

function compareFilesByName_(a, b) {
  return a.getName().localeCompare(b.getName());
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

  const pairMap = buildRppUnyouPairMap_(files);
  pairMap.forEach(pair => processRppUnyouPair_(pair));
}

function buildRppUnyouPairMap_(files) {
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

  return pairMap;
}

function validateRppUnyouPair_(pair) {
  if (pair.cpcFiles.length === 0 || pair.rankFiles.length === 0) {
    return `RPP運用CSVのペアが不足しています pair=${pair.pairKey}`;
  }

  if (pair.cpcFiles.length > 1 || pair.rankFiles.length > 1) {
    return `RPP運用CSVが重複しています pair=${pair.pairKey}`;
  }

  return '';
}

function processRppUnyouPair_(pair) {
  const pairValidationError = validateRppUnyouPair_(pair);
  if (pairValidationError && (pair.cpcFiles.length === 0 || pair.rankFiles.length === 0)) {
    Logger.log(`RPP運用CSV待機中 pair=${pair.pairKey}`);
    return;
  }

  if (pairValidationError) {
    const filesToMove = pair.cpcFiles.concat(pair.rankFiles);
    const result = {
      status: 'error',
      message: pairValidationError,
      rowsImported: 0,
    };

    filesToMove.forEach(file => {
      moveFile_(file, DRIVE_FOLDERS.error);
      logResult_(file.getName(), result);
    });
    return;
  }

  const propertyKey = `${RPP_UNYOU_PAIR_PROPERTY_PREFIX}${pair.pairKey}`;
  if (!startRppUnyouPairProcessing_(propertyKey)) {
    Logger.log(`RPP運用CSV処理スキップ pair=${pair.pairKey}`);
    return;
  }

  const cpcFile = pair.cpcFiles[0];
  const rankFile = pair.rankFiles[0];
  let result;

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
  } finally {
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
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return false;
  }

  try {
    const properties = PropertiesService.getScriptProperties();
    if (properties.getProperty(propertyKey)) {
      return false;
    }

    properties.setProperty(propertyKey, String(new Date().getTime()));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function finishRppUnyouPairProcessing_(propertyKey) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    PropertiesService.getScriptProperties().deleteProperty(propertyKey);
  } finally {
    lock.releaseLock();
  }
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

function moveFile_(file, destFolderId) {
  const dest = DriveApp.getFolderById(destFolderId);
  const src  = DriveApp.getFolderById(DRIVE_FOLDERS.input);
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
