-- AI client outreach log: one row per (client org, issue type) tracking the
-- AI's proactive contact about a specific bookkeeping problem. Powers the
-- enterprise dashboard's "AI action / last contact / last message" columns and
-- the "Initiate AI Action" draft-for-review flow. Additive; safe to re-run.
CREATE TABLE IF NOT EXISTS ai_client_outreach (
  id                   varchar PRIMARY KEY,
  enterprise_id        varchar,
  organization_id      varchar NOT NULL,
  issue_type           varchar NOT NULL,   -- to_review | broken_bank | overdue_bills | overdue_invoices | recon_off | onboarding | meeting_followup
  channel              varchar,            -- email | sms | chat
  status               varchar NOT NULL DEFAULT 'drafted', -- drafted | sent | awaiting_response | resolved | dismissed
  target_type          varchar NOT NULL DEFAULT 'client_owner', -- client_owner | invoice_customers
  last_message_subject varchar,
  last_message_body    text,
  last_contact_at      timestamptz,
  attempts             integer NOT NULL DEFAULT 0,
  created_by_user_id   varchar,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ai_client_outreach_org_issue
  ON ai_client_outreach (organization_id, issue_type);
CREATE INDEX IF NOT EXISTS ix_ai_client_outreach_enterprise
  ON ai_client_outreach (enterprise_id);
