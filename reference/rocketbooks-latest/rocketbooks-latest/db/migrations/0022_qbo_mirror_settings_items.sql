-- Add an opt-in toggle for Item mirroring to qbo_mirror_settings.
-- Items are required for Invoice push (QBO Invoice lines need ItemRef),
-- so default to true — same convention as the other entity toggles.
-- Idempotent: safe to re-run.

ALTER TABLE public.qbo_mirror_settings
  ADD COLUMN IF NOT EXISTS mirror_items boolean NOT NULL DEFAULT true;
