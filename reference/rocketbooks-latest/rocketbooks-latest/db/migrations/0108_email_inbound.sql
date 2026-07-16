-- Inbound client email replies. When a client replies to a firm's outreach
-- email, the reply-to carries a signed token (reply+<token>@<INBOUND_DOMAIN>);
-- the /api/email/inbound webhook decodes it to the originating outreach row and
-- stores the reply here so the firm sees it in-app. Additive; dormant until the
-- inbound domain + webhook are configured.
CREATE TABLE IF NOT EXISTS email_inbound (
  id varchar PRIMARY KEY,
  outreach_id varchar,
  enterprise_id varchar,
  organization_id varchar,
  from_email varchar,
  to_email varchar,
  subject varchar,
  body text,
  raw jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_email_inbound_outreach ON email_inbound(outreach_id);
CREATE INDEX IF NOT EXISTS ix_email_inbound_org ON email_inbound(organization_id);
CREATE INDEX IF NOT EXISTS ix_email_inbound_enterprise ON email_inbound(enterprise_id);
