-- Per-user dashboard layout preferences (foundation for the customizable
-- Enterprise dashboard). jsonb keyed by dashboard name, e.g.
--   { "enterprise": { "order": ["stats","attention",...], "hidden": ["tier"] } }
-- Order + visibility only in v1 (no drag/resize yet). Nullable, no backfill —
-- an absent value reads as "the default built-in layout". Private to each user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_prefs jsonb;
