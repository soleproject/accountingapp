-- Human-review flag, distinct from `reviewed` (which the AI sets when it
-- confidently auto-categorizes, and which the learning system — vendor memory,
-- rule promotion — reads as "trusted"). `verified` is true ONLY when a person
-- clicks the reviewed toggle. Default false so nothing starts human-reviewed.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
