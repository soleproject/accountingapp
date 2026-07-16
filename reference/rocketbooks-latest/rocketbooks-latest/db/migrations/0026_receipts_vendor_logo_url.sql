-- Add vendor_logo_url to receipts so the /receipts list can render a
-- per-row vendor logo without re-parsing veryfi_raw_json on every read.
-- Populated from Veryfi's `vendor.logo` field at upload time.
-- Idempotent — safe to re-run.

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS vendor_logo_url varchar;
