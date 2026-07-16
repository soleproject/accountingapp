-- Add contact fields to organizations so businesses can manage their
-- own profile (address, website, phone, fax, email). All nullable —
-- mirrors the optional shape of contact fields.
-- Idempotent — safe to re-run.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS address jsonb,
  ADD COLUMN IF NOT EXISTS website varchar,
  ADD COLUMN IF NOT EXISTS phone varchar,
  ADD COLUMN IF NOT EXISTS fax varchar,
  ADD COLUMN IF NOT EXISTS email varchar;
