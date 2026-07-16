-- QBO has two distinct payment entities: Payment (customer→business, AR side)
-- and BillPayment (business→vendor, AP side). The original QBO scaffolding
-- only included staging for Payment; this adds the BillPayment counterpart
-- so the migration can pull both sides of the cash flow.
--
-- Shape mirrors qbo_payment_staging but tracks vendor_qbo_id instead of
-- customer_qbo_id. Idempotent.

CREATE TABLE IF NOT EXISTS public.qbo_bill_payment_staging (
  id varchar PRIMARY KEY NOT NULL,
  migration_job_id varchar NOT NULL,
  realm_id varchar NOT NULL,
  raw_qbo_id varchar NOT NULL,
  vendor_qbo_id varchar,
  total_amount numeric(18, 2) NOT NULL,
  txn_date date,
  raw_json json NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT qbo_bill_payment_staging_migration_job_id_fkey
    FOREIGN KEY (migration_job_id) REFERENCES public.qbo_migration_jobs(id)
);

CREATE INDEX IF NOT EXISTS ix_qbo_bill_payment_staging_migration_job_id
  ON public.qbo_bill_payment_staging (migration_job_id);
CREATE INDEX IF NOT EXISTS ix_qbo_bill_payment_staging_raw_qbo_id
  ON public.qbo_bill_payment_staging (raw_qbo_id);
CREATE INDEX IF NOT EXISTS ix_qbo_bill_payment_staging_realm_id
  ON public.qbo_bill_payment_staging (realm_id);
CREATE INDEX IF NOT EXISTS ix_qbo_bill_payment_staging_vendor_qbo_id
  ON public.qbo_bill_payment_staging (vendor_qbo_id);
