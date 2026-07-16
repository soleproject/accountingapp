-- Phase 3: deposit-vs-withdrawal-aware categorization rules.
-- A contact's deposits and withdrawals can map to different accounts (e.g. a
-- vendor refund deposit vs a purchase withdrawal). transaction_type scopes a rule
-- to one direction; NULL keeps the legacy "matches any type" behavior.
ALTER TABLE categorization_rules ADD COLUMN IF NOT EXISTS transaction_type varchar;
