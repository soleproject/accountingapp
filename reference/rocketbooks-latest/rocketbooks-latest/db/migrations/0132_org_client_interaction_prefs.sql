-- Client Interaction preferences set in the enterprise "Set up your firm" wizard
-- (the "Client Interaction" step). Booleans for each automatic client-facing
-- email: ask-about-new-contacts, IRS documentation requests, review reminders,
-- weekly digest, monthly report. Nullable jsonb, no backfill — an absent value
-- reads as "all interactions enabled".
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_interaction_prefs jsonb;
