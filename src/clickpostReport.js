const CLICKPOST_REPORT_FILE_TOKEN = 'clickpostReport';
const CLICKPOST_REPORT_INPUT_CHARSET = 'Shift_JIS';
const CLICKPOST_REPORT_OUTPUT_FOLDER_NAME = '04output';

function isClickpostReportFile_(fileName) {
  return String(fileName || '').indexOf(CLICKPOST_REPORT_FILE_TOKEN) !== -1;
}

function processClickpostReportFile_(file) {
  const fileName = file.getName();
  const mimeType = file.getMimeType();

  if (!isCsvFile_(fileName, mimeType)) {
    return {
      status: 'error',
      message: `clickpostReport はCSVのみ対応です: ${fileName} / ${mimeType}`,
      rowsImported: 0,
    };
  }

  const csvText = file.getBlob().getDataAsString(CLICKPOST_REPORT_INPUT_CHARSET);
  const rows = Utilities.parseCsv(csvText);
  if (!rows || rows.length === 0) {
    return {
      status: 'error',
      message: `clickpostReport のCSV読込結果が空です: ${fileName}`,
      rowsImported: 0,
    };
  }

  const headerRow = rows[0];
  const dataRows = rows.slice(1).filter(row => !isEmptyCsvRow_(row));
  if (dataRows.length % 2 !== 0) {
    return {
      status: 'error',
      message: `clickpostReport のデータ行数が奇数です inputRows=${dataRows.length} file=${fileName}`,
      rowsImported: 0,
    };
  }

  const outputRows = [headerRow];
  for (let i = 0; i < dataRows.length; i += 2) {
    outputRows.push(dataRows[i]);
  }

  const outputText = buildCsvText_(outputRows);
  const outputFileName = buildClickpostReportOutputFileName_(fileName);
  const outputFolder = getClickpostReportOutputFolder_();
  const outputBlob = Utilities.newBlob(`\uFEFF${outputText}`, 'text/csv', outputFileName);
  outputFolder.createFile(outputBlob);

  return {
    status: 'success',
    message:
      `clickpostReport加工完了 inputRows=${dataRows.length} outputRows=${outputRows.length - 1} ` +
      `outputFile=${outputFileName}`,
    rowsImported: outputRows.length - 1,
  };
}

function isEmptyCsvRow_(row) {
  return !row || row.every(cell => String(cell || '').trim() === '');
}

function buildCsvText_(rows) {
  return rows
    .map(row => row.map(escapeCsvCell_).join(','))
    .join('\r\n');
}

function escapeCsvCell_(value) {
  const stringValue = value == null ? '' : String(value);
  if (/[",\r\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function buildClickpostReportOutputFileName_(fileName) {
  const normalizedFileName = String(fileName || '').replace(/\.csv$/i, '');
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  return `${normalizedFileName}_deduped_${timestamp}.csv`;
}

function getClickpostReportOutputFolder_() {
  if (DRIVE_FOLDERS.output) {
    return DriveApp.getFolderById(DRIVE_FOLDERS.output);
  }

  const inputFolder = DriveApp.getFolderById(DRIVE_FOLDERS.input);
  const parents = inputFolder.getParents();
  if (!parents.hasNext()) {
    throw new Error('clickpostReport 出力先の親フォルダが取得できません');
  }

  const parentFolder = parents.next();
  const folders = parentFolder.getFoldersByName(CLICKPOST_REPORT_OUTPUT_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }

  return parentFolder.createFolder(CLICKPOST_REPORT_OUTPUT_FOLDER_NAME);
}
