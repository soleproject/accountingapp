-- Capture invoice + bill tax and discount amounts so local totals can
-- match QBO's TotalAmt. Before this column existed, our JE credited
-- revenue for the gross-with-tax amount — overstating revenue and never
-- recording the tax liability. The mirror creators/promoter post a
-- three-line JE going forward (debit AR full, credit revenue net,
-- credit tax liability).
--
-- Defaults to 0 so existing rows are valid; new rows from the mirror
-- pick up the actual values.
--
-- Bills get the same columns for forward-compat even though we don't
-- mirror bill tax yet; adding both now avoids a second migration when
-- bill tax handling lands.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS tax_amount numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS discount_amount numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS tax_amount numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS discount_amount numeric(12,2) NOT NULL DEFAULT 0;
