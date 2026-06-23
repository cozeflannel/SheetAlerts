-- 002_create_alerts.sql
-- Stores one row per alert triggered by a Google Sheet condition match.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS alerts (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  spreadsheet_id  text        NOT NULL,
  sheet_name      text,
  row_index       integer,
  payload         jsonb,
  slack_sent      boolean     NOT NULL DEFAULT false,
  email_sent      boolean     NOT NULL DEFAULT false,
  resolved        boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Row-Level Security: only the service role may read/write this table.
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_only" ON alerts;

CREATE POLICY "service_role_only"
  ON alerts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
