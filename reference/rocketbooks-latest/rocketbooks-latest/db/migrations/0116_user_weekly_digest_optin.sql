-- Proactive weekly digest opt-in. Owner-only, opt-in: NULL = off. Set when the
-- user enables the digest in Settings; cleared when they unsubscribe (via the
-- signed unsubscribe link or the Settings toggle). Mirrors the sms_opt_in_at
-- pattern on the same table.
--
-- Hand-written (skipping drizzle-kit generate) per the project's schema-drift
-- convention. Idempotent: safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS weekly_digest_opt_in_at timestamp with time zone;
