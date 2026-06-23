#!/usr/bin/env bash
# scripts/deploy_all.sh
#
# SheetAlerts — one-command local deploy script.
#
# Usage:
#   source .env.local && ./scripts/deploy_all.sh
#
# All values must be present as environment variables before running.
# The script validates everything first and exits with a clear error if
# any required variable is missing.
#
# Required env vars (set in .env.local or your shell):
#   SUPABASE_ACCESS_TOKEN   - Supabase personal access token
#   SUPABASE_PROJECT_REF    - Supabase project reference (e.g. hywqqgvcrpnfcatvvozg)
#   SERVICE_ROLE_KEY        - Supabase service role key (custom, not the built-in one)
#   SLACK_CLIENT_ID         - Slack app client ID
#   SLACK_CLIENT_SECRET     - Slack app client secret
#   SLACK_SIGNING_SECRET    - Slack app signing secret
#   GOOGLE_SERVICE_ACCOUNT_BASE64  - base64-encoded GCP service account JSON
#   FUNCTION_BASE_URL       - Public URL of the deployed edge function

set -euo pipefail

# ─── Colour output ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Colour

ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }
info() { echo -e "${YELLOW}[INFO]${NC} $*"; }

# ─── 1. Validate required env vars ─────────────────────────────────────────────
info "Checking required environment variables..."

REQUIRED_VARS=(
  SUPABASE_ACCESS_TOKEN
  SUPABASE_PROJECT_REF
  SERVICE_ROLE_KEY
  SLACK_CLIENT_ID
  SLACK_CLIENT_SECRET
  SLACK_SIGNING_SECRET
  GOOGLE_SERVICE_ACCOUNT_BASE64
  FUNCTION_BASE_URL
)

MISSING=()
for VAR in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!VAR:-}" ]; then
    MISSING+=("$VAR")
  fi
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  err "The following required environment variables are not set:"
  for VAR in "${MISSING[@]}"; do
    echo "    • $VAR"
  done
  echo ""
  err "Set them in .env.local and run:  source .env.local && ./scripts/deploy_all.sh"
  exit 1
fi

ok "All required environment variables are set."

# ─── 2. Check Supabase CLI is installed ────────────────────────────────────────
if ! command -v supabase &> /dev/null; then
  err "Supabase CLI not found. Install it: https://supabase.com/docs/guides/cli"
  exit 1
fi

SUPABASE_VERSION=$(supabase --version 2>&1 | head -1)
ok "Supabase CLI found: $SUPABASE_VERSION"

# ─── 3. Authenticate with Supabase ─────────────────────────────────────────────
info "Logging in to Supabase..."
supabase login --token "$SUPABASE_ACCESS_TOKEN"
ok "Authenticated."

# ─── 4. Link project ───────────────────────────────────────────────────────────
info "Linking project: $SUPABASE_PROJECT_REF"
supabase link --project-ref "$SUPABASE_PROJECT_REF"
ok "Project linked."

# ─── 5. Run database migrations ────────────────────────────────────────────────
info "Pushing database migrations..."
supabase db push
ok "Migrations applied."

# ─── 6. Set edge function secrets ──────────────────────────────────────────────
info "Setting Supabase edge function secrets..."
supabase secrets set \
  SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  SLACK_CLIENT_ID="$SLACK_CLIENT_ID" \
  SLACK_CLIENT_SECRET="$SLACK_CLIENT_SECRET" \
  SLACK_SIGNING_SECRET="$SLACK_SIGNING_SECRET" \
  GOOGLE_SERVICE_ACCOUNT_BASE64="$GOOGLE_SERVICE_ACCOUNT_BASE64" \
  FUNCTION_BASE_URL="$FUNCTION_BASE_URL"
ok "Secrets set."

# ─── 7. Deploy edge function ───────────────────────────────────────────────────
info "Deploying alert-bot edge function..."
supabase functions deploy alert-bot --no-verify-jwt
ok "Edge function deployed."

# ─── 8. Smoke test ─────────────────────────────────────────────────────────────
info "Running smoke test against: $FUNCTION_BASE_URL"
HTTP_STATUS=$(curl -o /dev/null -s -w "%{http_code}" "${FUNCTION_BASE_URL}?action=ping")
echo "    HTTP status: $HTTP_STATUS"

if [ "$HTTP_STATUS" = "500" ]; then
  err "Smoke test FAILED — edge function returned 500 (possible missing env var)."
  err "Check Supabase function logs: supabase functions logs alert-bot"
  exit 1
fi

ok "Smoke test passed (HTTP $HTTP_STATUS)."

# ─── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  SheetAlerts deploy complete! ✅${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo "  Function URL : $FUNCTION_BASE_URL"
echo "  Project ref  : $SUPABASE_PROJECT_REF"
echo ""
echo "Next steps:"
echo "  1. Deploy the Apps Script add-on (clasp push or Apps Script editor)"
echo "  2. Open a Google Sheet, launch the add-on, click 'Connect Slack'"
echo "  3. Verify Workflow A, B, and C per the README acceptance checklist"
