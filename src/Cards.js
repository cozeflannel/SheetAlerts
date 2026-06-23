/**
 * src/Cards.js
 *
 * SheetAlerts Google Workspace Add-on — Card UI builder.
 *
 * This file builds the settings card shown in the Google Sheets sidebar.
 * It:
 *  - Auto-detects all sheets and column headers
 *  - Loads existing server config via ConfigServer helpers
 *  - Renders the full settings form (sheet selector, trigger config,
 *    message fields, actionable columns, Slack connect/disconnect)
 *  - Handles Save, Connect Slack, and Disconnect actions
 *
 * Security notes:
 *  - EDGE_FUNCTION_URL is a public URL — not a secret.
 *  - SERVICE_ACCOUNT_EMAIL is the GCP service account email — not a secret.
 *  - No ScriptProperties are used anywhere.
 */

/* global SpreadsheetApp, CardService, DriveApp, ScriptApp, Session,
   getInstallation, saveInstallation, getChannels, disconnectSlack */
/* exported onHomepage, onFileScopeGranted, onSaveSettings,
             onConnectSlack, onDisconnect, buildSettingsCard */

// ─── Configuration constants ─────────────────────────────────────────────────

/**
 * Public URL of the deployed Supabase edge function.
 * Replace this value after deploying the edge function for the first time.
 * This is NOT a secret — it is the public endpoint for the Slack OAuth flow.
 */
var EDGE_FUNCTION_URL = 'https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot';

/**
 * Google service account email that will be granted Viewer/Editor access
 * to each spreadsheet when the user saves settings.
 * Find this in your GCP console under IAM → Service Accounts.
 */
var SERVICE_ACCOUNT_EMAIL = 'sheetalert@sheetadd-onsupabase.iam.gserviceaccount.com';

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Homepage trigger — called when the add-on is opened.
 * @param {Object} e - Add-on event object
 * @returns {CardService.Card}
 */
function onHomepage(e) { // eslint-disable-line no-unused-vars
  return buildSettingsCard(e);
}

/**
 * Called after the user grants file-scope access.
 * @param {Object} e
 * @returns {CardService.Card}
 */
function onFileScopeGranted(e) { // eslint-disable-line no-unused-vars
  return buildSettingsCard(e);
}

// ─── Card builder ─────────────────────────────────────────────────────────────

/**
 * Builds the full settings card.
 *
 * @param {Object} e - Add-on event object (may be null in batch contexts)
 * @returns {CardService.Card}
 */
function buildSettingsCard(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var spreadsheetId = ss.getId();

  // ── Load server config ────────────────────────────────────────────────────
  var installation = null;
  try {
    installation = getInstallation(spreadsheetId);
  } catch (err) {
    // Non-fatal: proceed with an empty config; user can still connect
    installation = null;
  }

  var config = (installation && installation.config) ? installation.config : {};
  var isConnected = !!(installation && installation.slack_bot_token);

  // ── Auto-detect sheets ────────────────────────────────────────────────────
  var sheets = ss.getSheets();
  var sheetNames = sheets.map(function (s) { return s.getName(); });
  var savedSheetName = config.sheet_name || (sheetNames.length > 0 ? sheetNames[0] : '');

  // ── Auto-detect column headers from the configured sheet ──────────────────
  var headers = [];
  if (savedSheetName) {
    var targetSheet = ss.getSheetByName(savedSheetName);
    if (targetSheet && targetSheet.getLastColumn() > 0) {
      var headerRow = targetSheet.getRange(1, 1, 1, targetSheet.getLastColumn()).getValues()[0];
      headers = headerRow.filter(function (h) { return h !== '' && h !== null; });
    }
  }

  var hasHeaders = headers.length > 0;

  // ── Load Slack channels if connected ──────────────────────────────────────
  var channels = [];
  if (isConnected) {
    try {
      channels = getChannels(spreadsheetId) || [];
    } catch (_) {
      channels = [];
    }
  }

  // ─── Build card ────────────────────────────────────────────────────────────
  var card = CardService.newCardBuilder();
  card.setName('SheetAlerts Settings');

  // ── Header ────────────────────────────────────────────────────────────────
  var header = CardService.newCardHeader()
    .setTitle('SheetAlerts')
    .setSubtitle('Monitor sheets · Notify Slack')
    .setImageUrl('https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/notifications_active/default/48px.svg');
  card.setHeader(header);

  // ── Slack connection section ───────────────────────────────────────────────
  var slackSection = CardService.newCardSection().setHeader('Slack Connection');

  if (isConnected) {
    var teamName = (installation.slack_team && installation.slack_team.name)
      ? installation.slack_team.name
      : 'connected';

    slackSection.addWidget(
      CardService.newDecoratedText()
        .setText('✅ Connected to: *' + teamName + '*')
        .setWrapText(true)
    );

    slackSection.addWidget(
      CardService.newTextButton()
        .setText('Disconnect Slack')
        .setTextButtonStyle(CardService.TextButtonStyle.TEXT)
        .setOnClickAction(
          CardService.newAction().setFunctionName('onDisconnect')
        )
    );
  } else {
    slackSection.addWidget(
      CardService.newDecoratedText()
        .setText('Not connected. Click below to authorise SheetAlerts in your Slack workspace.')
        .setWrapText(true)
    );

    var oauthUrl = EDGE_FUNCTION_URL + '?action=slack_oauth&state=' + encodeURIComponent(spreadsheetId);
    slackSection.addWidget(
      CardService.newTextButton()
        .setText('Connect Slack')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOpenLink(CardService.newOpenLink().setUrl(oauthUrl))
    );
  }

  card.addSection(slackSection);

  // ── Sheet & trigger section ────────────────────────────────────────────────
  var sheetSection = CardService.newCardSection().setHeader('Sheet & Trigger');

  // Sheet selector
  var sheetSelector = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle('Sheet to monitor')
    .setFieldName('sheet_name');

  sheetNames.forEach(function (name) {
    sheetSelector.addItem(name, name, name === savedSheetName);
  });

  sheetSection.addWidget(sheetSelector);

  // Status column selector
  var statusColInput = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle('Status column (trigger column)')
    .setFieldName('status_col_index');

  if (!hasHeaders) {
    statusColInput.addItem('— No columns detected —', '-1', true);
  } else {
    headers.forEach(function (header, idx) {
      statusColInput.addItem(header, String(idx), idx === (config.status_col_index || 0));
    });
  }

  sheetSection.addWidget(statusColInput);

  // Trigger value
  var triggerInput = CardService.newTextInput()
    .setTitle('Trigger value (alert when cell equals this)')
    .setFieldName('trigger_value')
    .setValue(config.trigger_value || '');

  if (!hasHeaders) {
    triggerInput.setHint('Add column headers to row 1 first');
  }

  sheetSection.addWidget(triggerInput);

  if (!hasHeaders) {
    sheetSection.addWidget(
      CardService.newDecoratedText()
        .setText('⚠️ No column headers detected. Add headers to row 1, then re-open this widget — columns will appear automatically.')
        .setWrapText(true)
    );
  }

  card.addSection(sheetSection);

  // ── Message fields section ─────────────────────────────────────────────────
  var msgSection = CardService.newCardSection()
    .setHeader('Message Fields')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(1);

  msgSection.addWidget(
    CardService.newDecoratedText()
      .setText('Choose which columns to include in the Slack notification.')
      .setWrapText(true)
  );

  if (hasHeaders) {
    var msgFieldsInput = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setTitle('Columns to show in Slack message')
      .setFieldName('message_fields');

    var savedMessageFields = config.message_fields || [];
    headers.forEach(function (header, idx) {
      msgFieldsInput.addItem(header, String(idx), savedMessageFields.indexOf(idx) !== -1);
    });

    msgSection.addWidget(msgFieldsInput);
  } else {
    msgSection.addWidget(
      CardService.newDecoratedText()
        .setText('Add column headers to row 1 to configure message fields.')
        .setWrapText(true)
    );
  }

  card.addSection(msgSection);

  // ── Actionable columns section ─────────────────────────────────────────────
  var actionSection = CardService.newCardSection()
    .setHeader('Actionable Columns (Slack Modal)')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(1);

  actionSection.addWidget(
    CardService.newDecoratedText()
      .setText('Choose which columns Slack users can fill in when they click "Take Action".')
      .setWrapText(true)
  );

  if (hasHeaders) {
    var actionColsInput = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setTitle('Editable columns in Slack modal')
      .setFieldName('actionable_cols_indexes');

    var savedActionableCols = (config.actionable_cols || []).map(function (c) { return c.column_index; });
    headers.forEach(function (header, idx) {
      actionColsInput.addItem(header, String(idx), savedActionableCols.indexOf(idx) !== -1);
    });

    actionSection.addWidget(actionColsInput);
  } else {
    actionSection.addWidget(
      CardService.newDecoratedText()
        .setText('Add column headers to row 1 to configure actionable columns.')
        .setWrapText(true)
    );
  }

  card.addSection(actionSection);

  // ── Slack channel section (only if connected) ──────────────────────────────
  if (isConnected) {
    var channelSection = CardService.newCardSection().setHeader('Slack Channel');

    if (channels.length > 0) {
      var channelSelector = CardService.newSelectionInput()
        .setType(CardService.SelectionInputType.DROPDOWN)
        .setTitle('Send alerts to channel')
        .setFieldName('slack_channel_id');

      var savedChannelId = config.slack_channel_id || '';
      channels.forEach(function (ch) {
        var label = (ch.is_private ? '🔒 ' : '#') + ch.name;
        channelSelector.addItem(label, ch.id, ch.id === savedChannelId);
      });

      channelSection.addWidget(channelSelector);
    } else {
      channelSection.addWidget(
        CardService.newDecoratedText()
          .setText('No channels found. Make sure the SheetAlerts bot is added to at least one channel.')
          .setWrapText(true)
      );
    }

    card.addSection(channelSection);
  }

  // ── Save button ────────────────────────────────────────────────────────────
  var saveSection = CardService.newCardSection();
  saveSection.addWidget(
    CardService.newTextButton()
      .setText('Save Settings')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(
        CardService.newAction().setFunctionName('onSaveSettings')
      )
  );

  card.addSection(saveSection);

  return card.build();
}

// ─── Action handlers ──────────────────────────────────────────────────────────

/**
 * Handles the Save Settings button click.
 * Builds config from form inputs, saves to server, shares sheet with service account.
 *
 * @param {Object} e - Add-on action event
 * @returns {CardService.ActionResponse}
 */
function onSaveSettings(e) {
  var formInput = e.commonEventObject.formInputs || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var spreadsheetId = ss.getId();

  // Collect raw form values
  var sheetName = getFormString(formInput, 'sheet_name') || '';
  var statusColIndex = parseInt(getFormString(formInput, 'status_col_index') || '0', 10);
  var triggerValue = getFormString(formInput, 'trigger_value') || '';

  // message_fields: array of column indexes (integers)
  var messageFieldStrs = getFormStrings(formInput, 'message_fields');
  var messageFields = messageFieldStrs.map(function (s) { return parseInt(s, 10); });

  // actionable_cols: build ActionableCol objects from checked indexes
  var actionableColStrs = getFormStrings(formInput, 'actionable_cols_indexes');
  var actionableCols = actionableColStrs.map(function (idxStr) {
    var idx = parseInt(idxStr, 10);
    // Derive the column label from the sheet headers
    var label = 'Column ' + (idx + 1);
    try {
      var targetSheet = ss.getSheetByName(sheetName);
      if (targetSheet && targetSheet.getLastColumn() > idx) {
        var h = targetSheet.getRange(1, idx + 1).getValue();
        if (h) { label = String(h); }
      }
    } catch (_) { /* use default label */ }

    return { column_index: idx, label: label, input_type: 'text' };
  });

  var slackChannelId = getFormString(formInput, 'slack_channel_id') || '';

  var config = {
    sheet_name: sheetName,
    status_col_index: statusColIndex,
    trigger_value: triggerValue,
    message_fields: messageFields,
    actionable_cols: actionableCols,
    slack_channel_id: slackChannelId,
  };

  // Save to server
  var saveResult = saveInstallation(spreadsheetId, config);
  if (!saveResult.ok) {
    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification()
          .setText('❌ Failed to save settings. Check Apps Script logs.')
      )
      .build();
  }

  // Share spreadsheet with service account so the edge function can write back
  try {
    DriveApp.getFileById(spreadsheetId).addEditor(SERVICE_ACCOUNT_EMAIL);
  } catch (shareErr) {
    // Non-fatal: log and continue — user may need to share manually
    Logger.log('[SheetAlerts] Could not share sheet with service account: ' + shareErr.toString());
  }

  // Refresh the card to reflect saved state
  return CardService.newActionResponseBuilder()
    .setNotification(
      CardService.newNotification().setText('✅ Settings saved.')
    )
    .setNavigation(
      CardService.newNavigation().updateCard(buildSettingsCard(e))
    )
    .build();
}

/**
 * Handles the Disconnect Slack button.
 *
 * @param {Object} e
 * @returns {CardService.ActionResponse}
 */
function onDisconnect(e) {
  var spreadsheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  var ok = disconnectSlack(spreadsheetId);

  var notification = ok
    ? CardService.newNotification().setText('Slack disconnected.')
    : CardService.newNotification().setText('❌ Failed to disconnect. Check logs.');

  return CardService.newActionResponseBuilder()
    .setNotification(notification)
    .setNavigation(
      CardService.newNavigation().updateCard(buildSettingsCard(e))
    )
    .build();
}

/**
 * Handles the Connect Slack button click.
 * Opens the OAuth URL in a new browser tab.
 *
 * @returns {CardService.ActionResponse}
 */
function onConnectSlack() {
  var spreadsheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  var oauthUrl = EDGE_FUNCTION_URL + '?action=slack_oauth&state=' + encodeURIComponent(spreadsheetId);

  return CardService.newActionResponseBuilder()
    .setOpenLink(CardService.newOpenLink().setUrl(oauthUrl))
    .build();
}

// ─── Form input helpers ───────────────────────────────────────────────────────

/**
 * Safely reads a single string value from the form inputs map.
 *
 * @param {Object} formInputs
 * @param {string} key
 * @returns {string|null}
 */
function getFormString(formInputs, key) {
  var entry = formInputs[key];
  if (!entry) { return null; }
  // Apps Script wraps values in { stringInputs: { value: [..] } }
  if (entry.stringInputs && entry.stringInputs.value && entry.stringInputs.value.length > 0) {
    return entry.stringInputs.value[0];
  }
  return null;
}

/**
 * Safely reads all string values from a multi-select form input.
 *
 * @param {Object} formInputs
 * @param {string} key
 * @returns {string[]}
 */
function getFormStrings(formInputs, key) {
  var entry = formInputs[key];
  if (!entry) { return []; }
  if (entry.stringInputs && entry.stringInputs.value) {
    return entry.stringInputs.value;
  }
  return [];
}
