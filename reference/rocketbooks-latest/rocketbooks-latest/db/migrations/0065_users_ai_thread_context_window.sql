-- Per-user preference for how many prior thread messages the AI
-- includes when drafting an email reply. Lives on `users` because
-- it's a personal preference, not org-scoped.
--
-- Values:
--   3  — minimal context, cheapest, fastest
--   5  — DEFAULT, covers most threads
--   10 — wider window for complex discussions
--   0  — "full thread" (no cap)
--
-- Stored as a plain integer (not enum) so future values (e.g. 20,
-- 50) don't need a schema migration — application validates instead.
-- CHECK constraint enforces only the four current options; relax it
-- if/when we add more.
--
-- NULL is treated as the default (5) at read time, so existing rows
-- don't need a backfill. NOT NULL would require updating every users
-- row in a single statement, which is heavier than necessary.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS ai_thread_context_window integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_ai_thread_context_window_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_ai_thread_context_window_check
      CHECK (ai_thread_context_window IS NULL OR ai_thread_context_window IN (0, 3, 5, 10));
  END IF;
END $$;
