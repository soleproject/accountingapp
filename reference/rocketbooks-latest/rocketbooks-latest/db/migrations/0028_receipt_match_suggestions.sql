-- Phase 1 of the receipt ↔ transaction match feature.
--
-- Detection-only: when a receipt uploads, the matcher writes one row
-- here per candidate transaction it found (top-N, ranked by confidence).
-- No UI consumption yet — phase 2 will surface these on /ai-chat; phase
-- 3 wires up the accept action (link + splits + JE rewrite).
--
-- Confidence is 0..1; status='pending' until the user accepts/dismisses
-- from the AI-chat card. Unique on (receipt_id, transaction_id) so the
-- matcher can be re-run without duplicating candidates — re-running a
-- match upserts the score rather than appending.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.receipt_match_suggestions (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL,
  receipt_id varchar NOT NULL,
  transaction_id varchar NOT NULL,
  confidence numeric(4, 3) NOT NULL,
  amount_diff numeric(12, 2) NOT NULL,
  date_diff_days integer NOT NULL,
  vendor_match boolean NOT NULL DEFAULT false,
  status varchar NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_receipt_match_suggestions_receipt_txn
  ON public.receipt_match_suggestions (receipt_id, transaction_id);

CREATE INDEX IF NOT EXISTS ix_receipt_match_suggestions_org_status
  ON public.receipt_match_suggestions (organization_id, status);

CREATE INDEX IF NOT EXISTS ix_receipt_match_suggestions_receipt
  ON public.receipt_match_suggestions (receipt_id);

CREATE INDEX IF NOT EXISTS ix_receipt_match_suggestions_transaction
  ON public.receipt_match_suggestions (transaction_id);
