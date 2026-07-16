-- Telegram as a Texts channel (shared Rocketbooks bot).
-- textMessages gets a channel discriminator (existing rows are SMS); two new
-- tables track the per-org bot connection (shareable invite token) and the
-- Telegram chats linked to an org (+ the auto-created contact they route to).

ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS channel varchar NOT NULL DEFAULT 'sms';

CREATE TABLE IF NOT EXISTS telegram_connections (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invite_token varchar NOT NULL,
  bot_username varchar,
  created_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_telegram_connections_org ON telegram_connections(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_telegram_connections_token ON telegram_connections(invite_token);

CREATE TABLE IF NOT EXISTS telegram_chats (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  chat_id varchar NOT NULL,
  chat_type varchar,
  title varchar,
  contact_id varchar REFERENCES contacts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_telegram_chats_org_chat ON telegram_chats(organization_id, chat_id);
CREATE INDEX IF NOT EXISTS ix_telegram_chats_chat ON telegram_chats(chat_id);
