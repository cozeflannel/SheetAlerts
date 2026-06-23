/**
 * supabase/functions/alert-bot/index.ts
 *
 * SheetAlerts Supabase Edge Function — single entrypoint handling:
 *   - Slack OAuth install flow  (GET  ?action=slack_oauth, oauth_callback)
 *   - Installation CRUD         (POST ?action=get_installation, save_installation, disconnect)
 *   - Channel listing           (POST ?action=get_channels)
 *   - Alert notification        (POST ?action=notify)
 *   - Slack interactive payloads (block_actions, view_submission)
 *
 * All secrets are read from Deno.env — never from client storage.
 * All Apps-Script→server calls are validated via Google tokeninfo.
 * All Slack interactive payloads are validated via HMAC-SHA256 signature.
 */

// ─── Required environment variables ────────────────────────────────────────
const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "SERVICE_ROLE_KEY",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "FUNCTION_BASE_URL",
  "GOOGLE_SERVICE_ACCOUNT_BASE64",
] as const;

function checkEnvVars(): string[] {
  return REQUIRED_ENV_VARS.filter((v) => !Deno.env.get(v));
}

// ─── Types ──────────────────────────────────────────────────────────────────
interface Installation {
  spreadsheet_id: string;
  slack_bot_token: string | null;
  slack_team: Record<string, unknown> | null;
  config: InstallationConfig;
  installed_at: string | null;
  installer_email: string | null;
}

interface InstallationConfig {
  slack_channel_id?: string;
  actionable_cols?: ActionableCol[];
  message_fields?: number[];
  sheet_name?: string;
  status_col_index?: number;
  trigger_value?: string;
  installer_email?: string;
}

interface ActionableCol {
  column_index: number;
  label: string;
  input_type: "text" | "select" | "textarea";
}

interface AlertRecord {
  id: string;
  spreadsheet_id: string;
  sheet_name: string | null;
  row_index: number | null;
  payload: Record<string, unknown> | null;
  slack_sent: boolean;
  email_sent: boolean;
  resolved: boolean;
  created_at: string;
}

// ─── Supabase REST helpers ───────────────────────────────────────────────────

function supabaseHeaders(): HeadersInit {
  return {
    "apikey": Deno.env.get("SERVICE_ROLE_KEY")!,
    "Authorization": `Bearer ${Deno.env.get("SERVICE_ROLE_KEY")}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
}

async function fetchInstallation(
  spreadsheetId: string,
): Promise<Installation | null> {
  const url =
    `${Deno.env.get("SUPABASE_URL")}/rest/v1/installations?spreadsheet_id=eq.${
      encodeURIComponent(spreadsheetId)
    }&limit=1`;

  const res = await fetch(url, {
    headers: supabaseHeaders(),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("fetchInstallation failed:", res.status, body);
    return null;
  }

  const rows: Installation[] = await res.json();
  return rows.length > 0 ? rows[0] : null;
}

async function upsertInstallation(
  data: Partial<Installation>,
): Promise<Installation | null> {
  const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/installations`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Prefer": "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("upsertInstallation failed:", res.status, body);
    return null;
  }

  const rows: Installation[] = await res.json();
  return rows.length > 0 ? rows[0] : null;
}

async function insertAlert(
  alertData: Omit<AlertRecord, "id" | "slack_sent" | "email_sent" | "resolved" | "created_at">,
): Promise<AlertRecord | null> {
  const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/alerts`;

  const res = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify(alertData),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("insertAlert failed:", res.status, body);
    return null;
  }

  const rows: AlertRecord[] = await res.json();
  return rows.length > 0 ? rows[0] : null;
}

async function updateAlert(
  alertId: string,
  patch: Partial<Pick<AlertRecord, "slack_sent" | "resolved">>,
): Promise<void> {
  const url =
    `${Deno.env.get("SUPABASE_URL")}/rest/v1/alerts?id=eq.${
      encodeURIComponent(alertId)
    }`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: supabaseHeaders(),
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("updateAlert failed:", res.status, body);
  }
}

// ─── Google token validation ─────────────────────────────────────────────────

/**
 * Validates a Google OAuth access token via the tokeninfo endpoint.
 * Returns the verified email on success, throws on failure.
 */
async function verifyGoogleToken(accessToken: string): Promise<string> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${
      encodeURIComponent(accessToken)
    }`,
  );

  if (!res.ok) {
    throw new Error(`Google tokeninfo HTTP ${res.status}`);
  }

  const info = await res.json();

  if (info.error || !info.email) {
    throw new Error(`Invalid Google token: ${info.error ?? "no email"}`);
  }

  return info.email as string;
}

// ─── Slack signature verification ────────────────────────────────────────────

/**
 * Verifies the X-Slack-Signature header using HMAC-SHA256.
 * Rejects if signature is invalid or timestamp is older than 5 minutes.
 */
async function verifySlackSignature(
  rawBody: string,
  headers: Headers,
): Promise<boolean> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");

  if (!timestamp || !signature) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parseInt(timestamp, 10)) > 300) {
    console.warn("Slack signature timestamp too old");
    return false;
  }

  const signingSecret = Deno.env.get("SLACK_SIGNING_SECRET")!;
  const baseString = `v0:${timestamp}:${rawBody}`;

  const keyData = new TextEncoder().encode(signingSecret);
  const msgData = new TextEncoder().encode(baseString);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expected = `v0=${hex}`;

  // Constant-time comparison
  if (expected.length !== signature.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }

  return diff === 0;
}

// ─── Google Service Account JWT + Sheets API ─────────────────────────────────

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/**
 * Decodes the base64 service account, builds an RS256 JWT, and exchanges it
 * for a short-lived access token scoped to Google Sheets.
 */
async function getGoogleAccessToken(): Promise<string> {
  const b64 = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_BASE64")!;
  const json = atob(b64);
  const key: ServiceAccountKey = JSON.parse(json);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  };

  function b64url(obj: unknown): string {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  const headerB64 = b64url(header);
  const claimB64 = b64url(claim);
  const signingInput = `${headerB64}.${claimB64}`;

  // Import the PEM private key
  const pemBody = key.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const rawKey = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    rawKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const jwt = `${signingInput}.${sigB64}`;

  // Exchange JWT for access token
  const tokenRes = await fetch(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Google token exchange failed: ${body}`);
  }

  const tokenJson = await tokenRes.json();
  return tokenJson.access_token as string;
}

/**
 * Updates specific cells in a Google Sheet row using batchUpdate.
 *
 * @param spreadsheetId  - Target spreadsheet ID
 * @param rowIndex       - 0-based row index in the sheet
 * @param columnMappings - Array of { column_index (0-based), label, input_type }
 * @param values         - Map of column_index → submitted value
 */
async function updateSheetRow(
  spreadsheetId: string,
  sheetName: string,
  rowIndex: number,
  columnMappings: ActionableCol[],
  values: Record<number, string>,
): Promise<void> {
  const accessToken = await getGoogleAccessToken();

  // Build batchUpdate data array — one ValueRange per cell
  const data = columnMappings
    .filter((col) => values[col.column_index] !== undefined)
    .map((col) => {
      // Sheets API uses 1-based row and column in A1 notation
      const colLetter = columnIndexToLetter(col.column_index);
      const rowNum = rowIndex + 1; // rowIndex is 0-based
      const range = sheetName
        ? `'${sheetName}'!${colLetter}${rowNum}`
        : `${colLetter}${rowNum}`;

      return {
        range,
        values: [[values[col.column_index]]],
      };
    });

  if (data.length === 0) {
    console.warn("updateSheetRow: no values to update");
    return;
  }

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${
      encodeURIComponent(spreadsheetId)
    }/values:batchUpdate`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets batchUpdate failed: ${body}`);
  }
}

function columnIndexToLetter(index: number): string {
  let letter = "";
  let n = index + 1; // 1-based
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// ─── Slack API helpers ────────────────────────────────────────────────────────

async function slackPost(
  method: string,
  body: Record<string, unknown>,
  botToken: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Slack ${method} HTTP ${res.status}`);
  }

  return res.json();
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function jsonResponse(
  data: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ─── Modal builder ────────────────────────────────────────────────────────────

function buildModal(
  actionableCols: ActionableCol[],
  privateMetadata: string,
): Record<string, unknown> {
  const blocks = actionableCols.map((col) => {
    const blockId = `col_${col.column_index}`;
    const actionId = `input_${col.column_index}`;

    if (col.input_type === "textarea") {
      return {
        type: "input",
        block_id: blockId,
        label: { type: "plain_text", text: col.label },
        element: {
          type: "plain_text_input",
          action_id: actionId,
          multiline: true,
        },
      };
    }

    // Default: single-line text input
    return {
      type: "input",
      block_id: blockId,
      label: { type: "plain_text", text: col.label },
      element: {
        type: "plain_text_input",
        action_id: actionId,
      },
    };
  });

  return {
    type: "modal",
    title: { type: "plain_text", text: "Take Action" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: privateMetadata,
    blocks,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // ── Startup: validate required env vars ────────────────────────────────────
  const missing = checkEnvVars();
  if (missing.length > 0) {
    console.error("Missing required env vars:", missing);
    return jsonResponse({ error: "Missing required env vars", missing }, 500);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const method = req.method.toUpperCase();

  // ── Route: GET requests ────────────────────────────────────────────────────
  if (method === "GET") {
    // ── GET ?action=slack_oauth ──────────────────────────────────────────────
    if (action === "slack_oauth") {
      const spreadsheetId = url.searchParams.get("state");
      if (!spreadsheetId) {
        return jsonResponse({ error: "Missing state (spreadsheet_id)" }, 400);
      }

      const redirectUri = `${Deno.env.get("FUNCTION_BASE_URL")}?action=oauth_callback`;
      const scopes = "chat:write chat:write.public channels:read groups:read im:write users:read";

      const oauthUrl = new URL("https://slack.com/oauth/v2/authorize");
      oauthUrl.searchParams.set("client_id", Deno.env.get("SLACK_CLIENT_ID")!);
      oauthUrl.searchParams.set("scope", scopes);
      oauthUrl.searchParams.set("redirect_uri", redirectUri);
      oauthUrl.searchParams.set("state", spreadsheetId);

      return Response.redirect(oauthUrl.toString(), 302);
    }

    // ── GET ?action=oauth_callback ───────────────────────────────────────────
    if (action === "oauth_callback") {
      const code = url.searchParams.get("code");
      const spreadsheetId = url.searchParams.get("state");

      if (!code || !spreadsheetId) {
        return jsonResponse({ error: "Missing code or state" }, 400);
      }

      const redirectUri = `${Deno.env.get("FUNCTION_BASE_URL")}?action=oauth_callback`;

      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: Deno.env.get("SLACK_CLIENT_ID")!,
          client_secret: Deno.env.get("SLACK_CLIENT_SECRET")!,
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        console.error("Slack oauth.v2.access HTTP error:", tokenRes.status);
        return jsonResponse({ error: "Slack token exchange failed" }, 500);
      }

      const tokenData = await tokenRes.json();

      if (!tokenData.ok) {
        console.error("Slack oauth.v2.access error:", tokenData.error);
        return jsonResponse(
          { error: "Slack OAuth failed", slack_error: tokenData.error },
          500,
        );
      }

      const installation = await upsertInstallation({
        spreadsheet_id: spreadsheetId,
        slack_bot_token: tokenData.access_token,
        slack_team: tokenData.team ?? null,
        config: {},
        installed_at: new Date().toISOString(),
      });

      if (!installation) {
        return jsonResponse({ error: "Failed to save installation" }, 500);
      }

      return htmlResponse(
        `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>SheetAlerts — Connected</title></head>
  <body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>✅ Slack Connected</h2>
    <p>SheetAlerts is now connected to your Slack workspace.<br>You may close this window.</p>
  </body>
</html>`,
      );
    }

    return jsonResponse({ error: "Unknown GET action" }, 400);
  }

  // ── Route: POST application/json — url_verification challenge ────────────
  // Slack sends url_verification as JSON (not form-urlencoded) when you first
  // save the Interactivity Request URL in the Slack app settings.
  // This MUST be handled before the form-urlencoded branch below, and it does
  // NOT require signature verification (Slack sends no signature for this type).
  const contentType = req.headers.get("content-type") ?? "";
  if (method === "POST" && contentType.includes("application/json")) {
    // Peek at the body only long enough to check for url_verification.
    // Clone the request so the body stream remains readable for the JSON
    // routes below if this is not a url_verification request.
    const cloned = req.clone();
    let jsonBody: Record<string, unknown> = {};
    try {
      jsonBody = await cloned.json();
    } catch {
      // Not valid JSON — fall through to the form-urlencoded and JSON routes.
    }
    if (jsonBody.type === "url_verification") {
      return new Response(String(jsonBody.challenge ?? ""), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    // Not url_verification — fall through. The JSON POST routes below will
    // re-read the body from the original `req` object (not the clone).
  }

  // ── Route: POST with application/x-www-form-urlencoded (Slack interactive) ─
  if (method === "POST" && contentType.includes("application/x-www-form-urlencoded")) {
    const rawBody = await req.text();

    // Parse Slack payload first so url_verification can short-circuit
    const params = new URLSearchParams(rawBody);
    const payloadStr = params.get("payload");

    if (!payloadStr) {
      return jsonResponse({ error: "Missing payload field" }, 400);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return jsonResponse({ error: "Invalid payload JSON" }, 400);
    }

    const payloadType = payload.type as string;

    // ── Verify Slack signature ─────────────────────────────────────────────
    // (url_verification is handled above in the JSON branch — it never arrives
    // as form-urlencoded, so every payload here must pass signature checking.)
    const valid = await verifySlackSignature(rawBody, req.headers);
    if (!valid) {
      console.error("Slack signature verification failed");
      return new Response("Unauthorized", { status: 401 });
    }

    // ── block_actions ───────────────────────────────────────────────────────
    if (payloadType === "block_actions") {
      const triggerId = payload.trigger_id as string;
      if (!triggerId) {
        return jsonResponse({ error: "Missing trigger_id" }, 400);
      }

      const actions = payload.actions as Array<Record<string, unknown>>;
      if (!actions || actions.length === 0) {
        return jsonResponse({ error: "No actions in payload" }, 400);
      }

      const buttonValue = actions[0].value as string;
      let alertMeta: { alert_id: string; spreadsheet_id: string; row_index: number };
      try {
        alertMeta = JSON.parse(buttonValue);
      } catch {
        return jsonResponse({ error: "Invalid button value JSON" }, 400);
      }

      const installation = await fetchInstallation(alertMeta.spreadsheet_id);
      if (!installation || !installation.slack_bot_token) {
        return jsonResponse({ error: "Installation not found" }, 404);
      }

      const actionableCols: ActionableCol[] =
        installation.config?.actionable_cols ?? [];

      if (actionableCols.length === 0) {
        console.warn(
          "block_actions: no actionable_cols configured for",
          alertMeta.spreadsheet_id,
        );
      }

      const modal = buildModal(actionableCols, JSON.stringify(alertMeta));

      const viewsRes = await slackPost(
        "views.open",
        { trigger_id: triggerId, view: modal },
        installation.slack_bot_token,
      );

      if (!viewsRes.ok) {
        console.error("views.open failed:", viewsRes);
        return jsonResponse({ error: "Failed to open modal", detail: viewsRes }, 500);
      }

      return new Response("", { status: 200 });
    }

    // ── view_submission ──────────────────────────────────────────────────────
    if (payloadType === "view_submission") {
      const view = payload.view as Record<string, unknown>;
      const privateMetaStr = view.private_metadata as string;

      let alertMeta: { alert_id: string; spreadsheet_id: string; row_index: number };
      try {
        alertMeta = JSON.parse(privateMetaStr);
      } catch {
        return jsonResponse({ error: "Invalid private_metadata JSON" }, 400);
      }

      const installation = await fetchInstallation(alertMeta.spreadsheet_id);
      if (!installation) {
        return jsonResponse({ error: "Installation not found" }, 404);
      }

      const actionableCols: ActionableCol[] =
        installation.config?.actionable_cols ?? [];
      const sheetName = installation.config?.sheet_name ?? "";

      // Extract submitted values from view state
      const stateValues = (view.state as Record<string, unknown>)
        ?.values as Record<string, Record<string, unknown>>;

      const submittedValues: Record<number, string> = {};
      for (const col of actionableCols) {
        const blockId = `col_${col.column_index}`;
        const actionId = `input_${col.column_index}`;
        const block = stateValues?.[blockId];
        if (block) {
          const inputEl = block[actionId] as Record<string, unknown>;
          if (inputEl?.value !== undefined) {
            submittedValues[col.column_index] = String(inputEl.value);
          }
        }
      }

      // Update Google Sheet row
      try {
        await updateSheetRow(
          alertMeta.spreadsheet_id,
          sheetName,
          alertMeta.row_index,
          actionableCols,
          submittedValues,
        );
      } catch (err) {
        console.error("updateSheetRow failed:", err);
        return jsonResponse({ error: "Failed to update sheet", detail: String(err) }, 500);
      }

      // Mark alert as resolved
      await updateAlert(alertMeta.alert_id, { resolved: true });

      // Instruct Slack to close the modal
      return jsonResponse({ response_action: "clear" });
    }

    return jsonResponse({ error: `Unknown payload type: ${payloadType}` }, 400);
  }

  // ── Route: POST JSON endpoints ─────────────────────────────────────────────
  if (method === "POST") {
    // Validate Google OAuth token (present in Authorization header)
    const authHeader = req.headers.get("authorization") ?? "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!bearerToken) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }

    let verifiedEmail: string;
    try {
      verifiedEmail = await verifyGoogleToken(bearerToken);
    } catch (err) {
      console.error("Google token validation failed:", err);
      return jsonResponse({ error: "Invalid or expired Google token" }, 401);
    }

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    // ── POST ?action=get_installation ───────────────────────────────────────
    if (action === "get_installation") {
      const spreadsheetId = body.spreadsheet_id as string;
      if (!spreadsheetId) {
        return jsonResponse({ error: "Missing spreadsheet_id" }, 400);
      }

      const installation = await fetchInstallation(spreadsheetId);
      if (!installation) {
        return jsonResponse({ ok: false, error: "not_found" }, 404);
      }

      return jsonResponse({ ok: true, installation });
    }

    // ── POST ?action=save_installation ──────────────────────────────────────
    if (action === "save_installation") {
      const spreadsheetId = body.spreadsheet_id as string;
      const config = body.config as InstallationConfig;

      if (!spreadsheetId || !config) {
        return jsonResponse({ error: "Missing spreadsheet_id or config" }, 400);
      }

      // Preserve existing slack_bot_token — only update config fields
      const existing = await fetchInstallation(spreadsheetId);
      const saved = await upsertInstallation({
        spreadsheet_id: spreadsheetId,
        slack_bot_token: existing?.slack_bot_token ?? null,
        slack_team: existing?.slack_team ?? null,
        config: {
          ...existing?.config,
          ...config,
          installer_email: verifiedEmail,
        },
        installed_at: existing?.installed_at ?? new Date().toISOString(),
        installer_email: verifiedEmail,
      });

      if (!saved) {
        return jsonResponse({ error: "Failed to save installation" }, 500);
      }

      return jsonResponse({ ok: true, installation: saved });
    }

    // ── POST ?action=get_channels ───────────────────────────────────────────
    if (action === "get_channels") {
      const spreadsheetId = body.spreadsheet_id as string;
      if (!spreadsheetId) {
        return jsonResponse({ error: "Missing spreadsheet_id" }, 400);
      }

      const installation = await fetchInstallation(spreadsheetId);
      if (!installation || !installation.slack_bot_token) {
        return jsonResponse({ ok: false, error: "Slack not connected" }, 404);
      }

      const listRes = await fetch(
        "https://slack.com/api/conversations.list?limit=500&types=public_channel,private_channel",
        {
          headers: { "Authorization": `Bearer ${installation.slack_bot_token}` },
        },
      );

      if (!listRes.ok) {
        return jsonResponse({ error: "Slack API error" }, 500);
      }

      const listData = await listRes.json();

      if (!listData.ok) {
        return jsonResponse(
          { ok: false, error: listData.error ?? "slack_error" },
          500,
        );
      }

      const channels = (listData.channels ?? []).map(
        (ch: Record<string, unknown>) => ({
          id: ch.id,
          name: ch.name,
          is_private: ch.is_private ?? false,
        }),
      );

      return jsonResponse({ ok: true, channels });
    }

    // ── POST ?action=notify ─────────────────────────────────────────────────
    if (action === "notify") {
      const alert = body.alert as {
        spreadsheet_id: string;
        sheet_name: string;
        row_index: number;
        values: unknown[];
        created_at?: string;
      };

      if (!alert?.spreadsheet_id) {
        return jsonResponse({ error: "Missing alert.spreadsheet_id" }, 400);
      }

      // Insert alert row first
      const alertRow = await insertAlert({
        spreadsheet_id: alert.spreadsheet_id,
        sheet_name: alert.sheet_name ?? null,
        row_index: alert.row_index ?? null,
        payload: { values: alert.values, created_at: alert.created_at },
      });

      if (!alertRow) {
        return jsonResponse({ error: "Failed to insert alert" }, 500);
      }

      const installation = await fetchInstallation(alert.spreadsheet_id);
      if (!installation || !installation.slack_bot_token) {
        return jsonResponse({ error: "Slack not connected" }, 404);
      }

      const config = installation.config;
      const channelId = config?.slack_channel_id;
      if (!channelId) {
        return jsonResponse({ error: "No slack_channel_id configured" }, 400);
      }

      // Build message blocks using message_fields (array of column indexes)
      const messageFields: number[] = config?.message_fields ?? [];
      const values = alert.values ?? [];

      const fieldBlocks = messageFields.map((colIdx) => ({
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Column ${colIdx + 1}:*\n${values[colIdx] ?? "—"}`,
          },
        ],
      }));

      const alertMetaValue = JSON.stringify({
        alert_id: alertRow.id,
        spreadsheet_id: alert.spreadsheet_id,
        row_index: alert.row_index,
      });

      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🔔 *SheetAlerts — New Alert*\nSheet: *${alert.sheet_name ?? "unknown"}* | Row: *${alert.row_index + 1}*`,
          },
        },
        ...fieldBlocks,
        {
          type: "divider",
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Take Action" },
              style: "primary",
              value: alertMetaValue,
              action_id: "take_action",
            },
          ],
        },
      ];

      const slackResult = await slackPost(
        "chat.postMessage",
        { channel: channelId, blocks, text: "SheetAlerts — New Alert" },
        installation.slack_bot_token,
      );

      const slackOk = Boolean(slackResult.ok);
      await updateAlert(alertRow.id, { slack_sent: slackOk });

      return jsonResponse({ ok: true, slackResult });
    }

    // ── POST ?action=get_alert_for_row ──────────────────────────────────────
    // Used by runConditionCheck() in Apps Script to check whether a row has
    // already been successfully alerted before sending a duplicate notification.
    if (action === "get_alert_for_row") {
      const spreadsheetId = body.spreadsheet_id as string;
      const rowIndex = body.row_index as number;

      if (!spreadsheetId || rowIndex === undefined || rowIndex === null) {
        return jsonResponse({ error: "Missing spreadsheet_id or row_index" }, 400);
      }

      // Return the most recent alert for this spreadsheet + row, if any.
      const url =
        `${Deno.env.get("SUPABASE_URL")}/rest/v1/alerts` +
        `?spreadsheet_id=eq.${encodeURIComponent(spreadsheetId)}` +
        `&row_index=eq.${rowIndex}` +
        `&order=created_at.desc&limit=1`;

      const res = await fetch(url, { headers: supabaseHeaders() });

      if (!res.ok) {
        const errBody = await res.text();
        console.error("get_alert_for_row DB query failed:", res.status, errBody);
        return jsonResponse({ error: "DB query failed" }, 500);
      }

      const rows: AlertRecord[] = await res.json();
      if (rows.length === 0) {
        return jsonResponse({ ok: false, error: "not_found" }, 404);
      }

      const { id, slack_sent, resolved } = rows[0];
      return jsonResponse({ ok: true, alert: { id, slack_sent, resolved } });
    }

    // ── POST ?action=disconnect ─────────────────────────────────────────────
    if (action === "disconnect") {
      const spreadsheetId = body.spreadsheet_id as string;
      if (!spreadsheetId) {
        return jsonResponse({ error: "Missing spreadsheet_id" }, 400);
      }

      const existing = await fetchInstallation(spreadsheetId);
      if (!existing) {
        return jsonResponse({ error: "Installation not found" }, 404);
      }

      const updated = await upsertInstallation({
        ...existing,
        slack_bot_token: null,
        slack_team: null,
      });

      if (!updated) {
        return jsonResponse({ error: "Failed to disconnect" }, 500);
      }

      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: `Unknown POST action: ${action}` }, 400);
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
});