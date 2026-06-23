/**
 * src/Main.js
 *
 * SheetAlerts Apps Script trigger handlers.
 *
 * Two trigger entry points:
 *  1. onSheetEdit(e)       — installable edit trigger; fires on cell edits
 *  2. runConditionCheck()  — time-based scheduled trigger; scans all rows
 *
 * Both handlers:
 *  - Load installation config from the server (no ScriptProperties)
 *  - Check for configured trigger conditions
 *  - Call notifyServer() when a condition is met
 *
 * Security notes:
 *  - No secrets are stored anywhere in this file.
 *  - No ScriptProperties are used.
 *  - All server calls go through ConfigServer.js helpers.
 */

/* global SpreadsheetApp, Logger, Session,
   getInstallation, notifyServer */
/* exported onSheetEdit, runConditionCheck */

// ─── Edit trigger ─────────────────────────────────────────────────────────────

/**
 * Installable edit trigger. Attach this to the spreadsheet via the Apps Script
 * editor: Triggers → + Add Trigger → onSheetEdit → From spreadsheet → On edit.
 *
 * @param {GoogleAppsScript.Events.SheetsOnEdit} e
 */
function onSheetEdit(e) {
  var ss = e.source;
  var spreadsheetId = ss.getId();

  // Load installation config from server
  var installation = null;
  try {
    installation = getInstallation(spreadsheetId);
  } catch (err) {
    Logger.log('[SheetAlerts] onSheetEdit: getInstallation threw: ' + err.toString());
    return;
  }

  if (!installation) {
    Logger.log('[SheetAlerts] onSheetEdit: no installation found for ' + spreadsheetId);
    return;
  }

  var config = installation.config;
  if (!config || !config.sheet_name || config.status_col_index === undefined || !config.trigger_value) {
    Logger.log('[SheetAlerts] onSheetEdit: incomplete config, skipping');
    return;
  }

  var editedSheet = e.source.getActiveSheet();
  var configuredSheetName = config.sheet_name;

  // Only act on the configured sheet
  if (editedSheet.getName() !== configuredSheetName) {
    return;
  }

  var editedRange = e.range;
  var editedRow = editedRange.getRow();
  var editedCol = editedRange.getColumn(); // 1-based

  // Check if the edited cell is in the status column (0-based index → 1-based column)
  var statusColOneBased = (config.status_col_index || 0) + 1;
  if (editedCol !== statusColOneBased) {
    return;
  }

  // Skip header row
  if (editedRow === 1) {
    return;
  }

  var newValue = e.value !== undefined ? e.value : editedRange.getValue();
  var triggerValue = config.trigger_value;

  if (String(newValue).trim() !== String(triggerValue).trim()) {
    return;
  }

  // Condition matched — build alert payload
  var sheet = ss.getSheetByName(configuredSheetName);
  if (!sheet) { return; }

  var lastCol = sheet.getLastColumn();
  var rowValues = [];
  if (lastCol > 0) {
    rowValues = sheet.getRange(editedRow, 1, 1, lastCol).getValues()[0];
  }

  var alertPayload = {
    spreadsheet_id: spreadsheetId,
    sheet_name: configuredSheetName,
    row_index: editedRow - 1, // 0-based for the server
    values: rowValues,
    created_at: new Date().toISOString(),
  };

  Logger.log('[SheetAlerts] onSheetEdit: condition matched — notifying server. row=' + editedRow);

  var result = notifyServer(alertPayload);
  if (!result.ok) {
    Logger.log('[SheetAlerts] onSheetEdit: notifyServer failed: ' + JSON.stringify(result.data));
  }
}

// ─── Scheduled trigger ────────────────────────────────────────────────────────

/**
 * Time-based scheduled trigger. Set this up in Apps Script:
 * Triggers → + Add Trigger → runConditionCheck → Time-driven → (your schedule).
 *
 * Scans all non-header rows in the configured sheet and calls notifyServer()
 * for any row whose status column matches the trigger value.
 *
 * Note: This trigger does NOT track which rows have already been alerted.
 * To avoid duplicate notifications, use the edit trigger (onSheetEdit) as the
 * primary mechanism and this as a fallback sweep.
 */
function runConditionCheck() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var spreadsheetId = ss.getId();

  var installation = null;
  try {
    installation = getInstallation(spreadsheetId);
  } catch (err) {
    Logger.log('[SheetAlerts] runConditionCheck: getInstallation threw: ' + err.toString());
    return;
  }

  if (!installation) {
    Logger.log('[SheetAlerts] runConditionCheck: no installation found');
    return;
  }

  var config = installation.config;
  if (!config || !config.sheet_name || config.status_col_index === undefined || !config.trigger_value) {
    Logger.log('[SheetAlerts] runConditionCheck: incomplete config, skipping');
    return;
  }

  var sheet = ss.getSheetByName(config.sheet_name);
  if (!sheet) {
    Logger.log('[SheetAlerts] runConditionCheck: sheet not found: ' + config.sheet_name);
    return;
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow < 2 || lastCol === 0) {
    Logger.log('[SheetAlerts] runConditionCheck: no data rows to scan');
    return;
  }

  // Read all data rows (skip header row 1)
  var statusColOneBased = (config.status_col_index || 0) + 1;
  var dataRange = sheet.getRange(2, 1, lastRow - 1, lastCol);
  var allValues = dataRange.getValues();

  var triggerValue = String(config.trigger_value).trim();
  var notified = 0;

  for (var i = 0; i < allValues.length; i++) {
    var rowValues = allValues[i];
    var cellValue = String(rowValues[config.status_col_index] || '').trim();

    if (cellValue !== triggerValue) {
      continue;
    }

    var rowIndex = i + 1; // 0-based (row 2 → index 1)
    var alertPayload = {
      spreadsheet_id: spreadsheetId,
      sheet_name: config.sheet_name,
      row_index: rowIndex,
      values: rowValues,
      created_at: new Date().toISOString(),
    };

    Logger.log('[SheetAlerts] runConditionCheck: condition matched at row ' + (rowIndex + 1));

    var result = notifyServer(alertPayload);
    if (!result.ok) {
      Logger.log(
        '[SheetAlerts] runConditionCheck: notifyServer failed for row ' +
        (rowIndex + 1) + ': ' + JSON.stringify(result.data)
      );
    } else {
      notified++;
    }
  }

  Logger.log('[SheetAlerts] runConditionCheck: scan complete. Notified ' + notified + ' row(s).');
}
