-- 001_create_installations.sql
-- Stores one row per Google Sheet that has connected SheetAlerts to a Slack workspace.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS installations (
  spreadsheet_id   text        PRIMARY KEY,
  slack_bot_token  text,
  slack_team       jsonb,
  config           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  installed_at     timestamptz,
  installer_email  text
);

-- Row-Level Security: only the service role may read/write this table.
-- Anon and authenticated roles have zero access.
ALTER TABLE installations ENABLE ROW LEVEL SECURITY;

-- Drop policy if it already exists so the migration is idempotent.
DROP POLICY IF EXISTS "service_role_only" ON installations;

CREATE POLICY "service_role_only"
  ON installations
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
