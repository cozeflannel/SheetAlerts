# SheetAlerts

A Google Workspace Add-on that monitors Google Sheets for configured conditions and sends Slack notifications. When a Slack user clicks the "Take Action" button on a notification, a modal opens where they fill in data that writes directly back to the original Sheet row — with no new rows created.

---

## Architecture

Apps Script handles only the UI (Google Workspace Cards) and sheet-event detection. It never stores or touches Slack tokens. The Supabase Edge Function (`alert-bot`) owns everything else: Slack OAuth, token storage, Slack messaging, interactive modal handling, and Google Sheets row updates via a GCP service account. The Supabase database holds all installation config and alert records. There are no ScriptProperties anywhere in the system.

```
Google Sheet ──(edit trigger)──► Apps Script ──(POST /notify, Bearer token)──► Edge Function
                                                                                      │
                                                                               Supabase DB
                                                                                      │
                                                                              Slack API (bot token)
                                                                                      │
                                                                         Slack User clicks "Take Action"
                                                                                      │
                                                                         Edge Function ──► Sheets API (service account)
```

---

## What You Must Do Manually (one-time setup)

| Step | What to do |
|------|-----------|
| **Supabase project** | Create a project at [supabase.com](https://supabase.com). Note the project ref (`hywqqgvcrpnfcatvvozg`) and generate a `SERVICE_ROLE_KEY` under Settings → API. |
| **Slack app** | Create an app at [api.slack.com/apps](https://api.slack.com/apps). Enable OAuth & Permissions with scopes: `chat:write chat:write.public channels:read groups:read im:write users:read`. Set the redirect URL to: `https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot?action=oauth_callback`. Enable Interactivity and set the Request URL to the same base URL (without query string): `https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot`. Note `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET`. |
| **GCP service account** | Go to [console.cloud.google.com](https://console.cloud.google.com) → IAM → Service Accounts. Create a service account, enable the Sheets API on the project, download a JSON key, and base64-encode it: `base64 -i key.json`. Store as `GOOGLE_SERVICE_ACCOUNT_BASE64`. The service account email is already set in `src/Cards.js`. |
| **GitHub Secrets** | In your repo Settings → Secrets → Actions, add all 8 secrets listed in the env vars table below. |
| **Apps Script deploy** | Push the `src/` files with `clasp push` (or manually paste into the Apps Script editor). Install the add-on from the Google Workspace Marketplace or test it as a developer add-on. Set up the `onSheetEdit` installable trigger in the Apps Script editor. |

---

## Environment Variables Reference

| Variable | Where set | Description |
|---|---|---|
| `SUPABASE_URL` | Auto-injected by Supabase runtime | Supabase project REST URL |
| `SERVICE_ROLE_KEY` | Supabase Secrets + GitHub Secrets | Custom service role key for DB writes |
| `SLACK_CLIENT_ID` | Supabase Secrets + GitHub Secrets | Slack app client ID |
| `SLACK_CLIENT_SECRET` | Supabase Secrets + GitHub Secrets | Slack app client secret |
| `SLACK_SIGNING_SECRET` | Supabase Secrets + GitHub Secrets | Slack signing secret (interactive payloads) |
| `GOOGLE_SERVICE_ACCOUNT_BASE64` | Supabase Secrets + GitHub Secrets | base64-encoded service account JSON |
| `FUNCTION_BASE_URL` | Supabase Secrets + GitHub Secrets | `https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot` |
| `SUPABASE_ACCESS_TOKEN` | GitHub Secrets only | Supabase personal access token (CI auth) |
| `SUPABASE_PROJECT_REF` | GitHub Secrets only | `hywqqgvcrpnfcatvvozg` |

---

## What Is Automated

- **`./scripts/deploy_all.sh`** — runs migrations, sets secrets, deploys the function, smoke tests.
- **GitHub Actions (`.github/workflows/deploy.yml`)** — every push to `main` automatically runs the full deploy pipeline.

---

## One-Command Local Deploy

```bash
# 1. Create your local secrets file (never commit this)
cp .env.local.example .env.local   # or create from scratch
# Fill in all 8 required vars in .env.local

# 2. Source and deploy
source .env.local && ./scripts/deploy_all.sh
```

`.env.local` template:
```bash
export SUPABASE_ACCESS_TOKEN=""
export SUPABASE_PROJECT_REF="hywqqgvcrpnfcatvvozg"
export SERVICE_ROLE_KEY=""
export SLACK_CLIENT_ID=""
export SLACK_CLIENT_SECRET=""
export SLACK_SIGNING_SECRET=""
export GOOGLE_SERVICE_ACCOUNT_BASE64=""
export FUNCTION_BASE_URL="https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot"
```

---

## Running Tests

```bash
# Requires Deno installed: https://deno.land
deno test --allow-env tests/bot_handlers_test.ts
# or via npm:
npm test
```

---

## Acceptance Test Checklist

### ✅ Workflow A — Install & Connect Slack

1. Open a Google Sheet and launch the SheetAlerts add-on.
2. Verify the sidebar shows "Not connected" and a **Connect Slack** button.
3. Click **Connect Slack** — a new tab opens to Slack OAuth consent.
4. Approve the OAuth request.
5. Verify the redirect lands on the edge function success page ("Connected — you may close this window.").
6. Close the tab and **re-open** the add-on sidebar.
7. Verify the sidebar now shows the Slack workspace name and a channel dropdown.

### ✅ Workflow B — Sheet Trigger → Slack Notification

1. In the add-on sidebar: select the sheet, choose a status column, set trigger value (e.g. `Done`), pick message fields, select a Slack channel, click **Save**.
2. In the sheet, change a cell in the status column to `Done`.
3. Within a few seconds, verify a Slack notification appears in the chosen channel.
4. Verify the message shows the configured `message_fields` values.
5. Verify the message includes a **Take Action** button.

### ✅ Workflow C — Slack Modal → Sheet Update

1. Click **Take Action** on the Slack notification from Workflow B.
2. Verify a Slack modal opens with input fields for each configured actionable column.
3. Fill in the fields and click **Submit**.
4. Verify the modal closes (Slack returns to the channel view).
5. Verify the original row in the Google Sheet has been updated with the submitted values (the row was **not** duplicated).

---

## Curl Examples

### Get installation
```bash
curl -X POST \
  "https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot?action=get_installation" \
  -H "Authorization: Bearer <YOUR_GOOGLE_OAUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"spreadsheet_id":"<SHEET_ID>"}'
```

### Save installation config
```bash
curl -X POST \
  "https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot?action=save_installation" \
  -H "Authorization: Bearer <YOUR_GOOGLE_OAUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "spreadsheet_id": "<SHEET_ID>",
    "config": {
      "sheet_name": "Sheet1",
      "status_col_index": 2,
      "trigger_value": "Done",
      "message_fields": [0, 1, 2],
      "actionable_cols": [{"column_index": 3, "label": "Notes", "input_type": "textarea"}],
      "slack_channel_id": "C0123456789"
    }
  }'
```

### Get Slack channels
```bash
curl -X POST \
  "https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot?action=get_channels" \
  -H "Authorization: Bearer <YOUR_GOOGLE_OAUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"spreadsheet_id":"<SHEET_ID>"}'
```

### Trigger a test notification
```bash
curl -X POST \
  "https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot?action=notify" \
  -H "Authorization: Bearer <YOUR_GOOGLE_OAUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "alert": {
      "spreadsheet_id": "<SHEET_ID>",
      "sheet_name": "Sheet1",
      "row_index": 1,
      "values": ["Alice Smith", "Done", "High priority"],
      "created_at": "2026-06-23T00:00:00Z"
    }
  }'
```

### Disconnect Slack
```bash
curl -X POST \
  "https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot?action=disconnect" \
  -H "Authorization: Bearer <YOUR_GOOGLE_OAUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"spreadsheet_id":"<SHEET_ID>"}'
```

### Slack OAuth redirect (open in browser)
```
https://hywqqgvcrpnfcatvvozg.supabase.co/functions/v1/alert-bot?action=slack_oauth&state=<SHEET_ID>
```
