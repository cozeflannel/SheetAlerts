/**
 * src/ConfigServer.js
 *
 * Lightweight HTTP helper functions for calling the SheetAlerts edge function
 * from Apps Script. All server communication goes through callEdgeFunction().
 *
 * Security notes:
 *  - No secrets are stored anywhere in this file.
 *  - Every request uses ScriptApp.getOAuthToken() for authentication.
 *  - EDGE_FUNCTION_URL is a public, non-secret URL constant defined in Cards.js.
 */

/* global UrlFetchApp, ScriptApp, Logger */
/* exported callEdgeFunction, getInstallation, saveInstallation,
             getChannels, notifyServer, disconnectSlack, getAlertForRow */

/**
 * Core HTTP wrapper. Calls the edge function with the Google OAuth token header.
 *
 * @param {string} action - The ?action= query parameter value
 * @param {string} method - "GET" or "POST"
 * @param {Object|null} body - Request body (will be JSON-serialised) or null
 * @returns {{ ok: boolean, data: Object, status: number }}
 */
function callEdgeFunction(action, method, body) {
  var url = EDGE_FUNCTION_URL + '?action=' + encodeURIComponent(action);

  var options = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Type': 'application/json',
    },
    muteHttpExceptions: true,
  };

  if (body !== null && body !== undefined && method !== 'GET') {
    options.payload = JSON.stringify(body);
  }

  var response;
  try {
    response = UrlFetchApp.fetch(url, options);
  } catch (e) {
    Logger.log('[SheetAlerts] UrlFetchApp.fetch threw an exception: ' + e.toString());
    return { ok: false, data: { error: e.toString() }, status: 0 };
  }

  var status = response.getResponseCode();
  var raw = response.getContentText();

  if (status < 200 || status >= 300) {
    Logger.log(
      '[SheetAlerts] Non-2xx response for action=' + action +
      ' status=' + status + ' body=' + raw
    );
  }

  var data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    data = { raw: raw };
  }

  return { ok: status >= 200 && status < 300, data: data, status: status };
}

/**
 * Fetches the current installation for a spreadsheet.
 *
 * @param {string} spreadsheetId
 * @returns {Object|null} Installation object or null if not found
 */
function getInstallation(spreadsheetId) {
  var result = callEdgeFunction('get_installation', 'POST', {
    spreadsheet_id: spreadsheetId,
  });

  if (!result.ok || !result.data.ok) {
    Logger.log(
      '[SheetAlerts] getInstallation failed: ' + JSON.stringify(result.data)
    );
    return null;
  }

  return result.data.installation || null;
}

/**
 * Saves (upserts) the installation config for a spreadsheet.
 *
 * @param {string} spreadsheetId
 * @param {Object} config - { sheet_name, status_col_index, trigger_value,
 *                            message_fields, actionable_cols, slack_channel_id }
 * @returns {{ ok: boolean, installation: Object|null }}
 */
function saveInstallation(spreadsheetId, config) {
  var result = callEdgeFunction('save_installation', 'POST', {
    spreadsheet_id: spreadsheetId,
    config: config,
  });

  if (!result.ok) {
    Logger.log(
      '[SheetAlerts] saveInstallation failed: ' + JSON.stringify(result.data)
    );
    return { ok: false, installation: null };
  }

  return { ok: true, installation: result.data.installation || null };
}

/**
 * Retrieves the list of Slack channels for the connected workspace.
 *
 * @param {string} spreadsheetId
 * @returns {Array<{ id: string, name: string, is_private: boolean }>|null}
 */
function getChannels(spreadsheetId) {
  var result = callEdgeFunction('get_channels', 'POST', {
    spreadsheet_id: spreadsheetId,
  });

  if (!result.ok || !result.data.ok) {
    Logger.log(
      '[SheetAlerts] getChannels failed: ' + JSON.stringify(result.data)
    );
    return null;
  }

  return result.data.channels || [];
}

/**
 * Sends an alert payload to the server for Slack notification.
 *
 * @param {{ spreadsheet_id, sheet_name, row_index, values, created_at }} alertPayload
 * @returns {{ ok: boolean, data: Object }}
 */
function notifyServer(alertPayload) {
  var result = callEdgeFunction('notify', 'POST', { alert: alertPayload });

  if (!result.ok) {
    Logger.log(
      '[SheetAlerts] notifyServer failed: ' + JSON.stringify(result.data)
    );
  } else {
    Logger.log('[SheetAlerts] notifyServer success: ' + JSON.stringify(result.data));
  }

  return { ok: result.ok, data: result.data };
}

/**
 * Disconnects (clears) the Slack bot token for a spreadsheet.
 *
 * @param {string} spreadsheetId
 * @returns {boolean} true on success
 */
function disconnectSlack(spreadsheetId) {
  var result = callEdgeFunction('disconnect', 'POST', {
    spreadsheet_id: spreadsheetId,
  });

  if (!result.ok) {
    Logger.log(
      '[SheetAlerts] disconnectSlack failed: ' + JSON.stringify(result.data)
    );
    return false;
  }

  return true;
}
/**
 * Returns the most recent alert record for a specific spreadsheet row, or null
 * if no alert has been recorded for that row yet.
 *
 * Used by runConditionCheck() to skip rows that have already been successfully
 * notified (slack_sent === true), preventing duplicate Slack messages.
 *
 * @param {string} spreadsheetId
 * @param {number} rowIndex - 0-based row index (same value stored in alerts table)
 * @returns {{ id: string, slack_sent: boolean, resolved: boolean }|null}
 */
function getAlertForRow(spreadsheetId, rowIndex) {
  var result = callEdgeFunction('get_alert_for_row', 'POST', {
    spreadsheet_id: spreadsheetId,
    row_index: rowIndex,
  });

  if (!result.ok) {
    if (result.data && result.data.error === 'not_found') {
      return null; // No alert exists yet for this row — expected case
    }
    Logger.log(
      '[SheetAlerts] getAlertForRow failed: ' + JSON.stringify(result.data)
    );
    return null;
  }

  return result.data.alert || null;
}