-- Four new staging tables for the rest of QBO's transaction entities:
-- Purchase (cash/credit expense without a Bill), Deposit (cash incoming
-- without an Invoice), Transfer (between own accounts), and JournalEntry
-- (manual adjusting entries). These complete the QBO migration coverage
-- alongside the existing invoice/bill/payment/billPayment staging tables.

CREATE TABLE IF NOT EXISTS public.qbo_purchase_staging (
  id varchar PRIMARY KEY NOT NULL,
  migration_job_id varchar NOT NULL,
  realm_id varchar NOT NULL,
  raw_qbo_id varchar NOT NULL,
  -- AccountRef: source-of-funds account (bank / credit card)
  account_qbo_id varchar,
  -- EntityRef.value when EntityRef.type='Vendor'; null for non-vendor purchases
  vendor_qbo_id varchar,
  total_amount numeric(18, 2) NOT NULL,
  txn_date date,
  raw_json json NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT qbo_purchase_staging_migration_job_id_fkey
    FOREIGN KEY (migration_job_id) REFERENCES public.qbo_migration_jobs(id)
);
CREATE INDEX IF NOT EXISTS ix_qbo_purchase_staging_migration_job_id
  ON public.qbo_purchase_staging (migration_job_id);
CREATE INDEX IF NOT EXISTS ix_qbo_purchase_staging_raw_qbo_id
  ON public.qbo_purchase_staging (raw_qbo_id);
CREATE INDEX IF NOT EXISTS ix_qbo_purchase_staging_realm_id
  ON public.qbo_purchase_staging (realm_id);

CREATE TABLE IF NOT EXISTS public.qbo_deposit_staging (
  id varchar PRIMARY KEY NOT NULL,
  migration_job_id varchar NOT NULL,
  realm_id varchar NOT NULL,
  raw_qbo_id varchar NOT NULL,
  -- DepositToAccountRef: bank account the money landed in
  deposit_to_account_qbo_id varchar,
  total_amount numeric(18, 2) NOT NULL,
  txn_date date,
  raw_json json NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT qbo_deposit_staging_migration_job_id_fkey
    FOREIGN KEY (migration_job_id) REFERENCES public.qbo_migration_jobs(id)
);
CREATE INDEX IF NOT EXISTS ix_qbo_deposit_staging_migration_job_id
  ON public.qbo_deposit_staging (migration_job_id);
CREATE INDEX IF NOT EXISTS ix_qbo_deposit_staging_raw_qbo_id
  ON public.qbo_deposit_staging (raw_qbo_id);
CREATE INDEX IF NOT EXISTS ix_qbo_deposit_staging_realm_id
  ON public.qbo_deposit_staging (realm_id);

CREATE TABLE IF NOT EXISTS public.qbo_transfer_staging (
  id varchar PRIMARY KEY NOT NULL,
  migration_job_id varchar NOT NULL,
  realm_id varchar NOT NULL,
  raw_qbo_id varchar NOT NULL,
  from_account_qbo_id varchar,
  to_account_qbo_id varchar,
  amount numeric(18, 2) NOT NULL,
  txn_date date,
  raw_json json NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT qbo_transfer_staging_migration_job_id_fkey
    FOREIGN KEY (migration_job_id) REFERENCES public.qbo_migration_jobs(id)
);
CREATE INDEX IF NOT EXISTS ix_qbo_transfer_staging_migration_job_id
  ON public.qbo_transfer_staging (migration_job_id);
CREATE INDEX IF NOT EXISTS ix_qbo_transfer_staging_raw_qbo_id
  ON public.qbo_transfer_staging (raw_qbo_id);
CREATE INDEX IF NOT EXISTS ix_qbo_transfer_staging_realm_id
  ON public.qbo_transfer_staging (realm_id);

CREATE TABLE IF NOT EXISTS public.qbo_journal_entry_staging (
  id varchar PRIMARY KEY NOT NULL,
  migration_job_id varchar NOT NULL,
  realm_id varchar NOT NULL,
  raw_qbo_id varchar NOT NULL,
  doc_number varchar,
  total_amount numeric(18, 2) NOT NULL,
  txn_date date,
  raw_json json NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT qbo_journal_entry_staging_migration_job_id_fkey
    FOREIGN KEY (migration_job_id) REFERENCES public.qbo_migration_jobs(id)
);
CREATE INDEX IF NOT EXISTS ix_qbo_journal_entry_staging_migration_job_id
  ON public.qbo_journal_entry_staging (migration_job_id);
CREATE INDEX IF NOT EXISTS ix_qbo_journal_entry_staging_raw_qbo_id
  ON public.qbo_journal_entry_staging (raw_qbo_id);
CREATE INDEX IF NOT EXISTS ix_qbo_journal_entry_staging_realm_id
  ON public.qbo_journal_entry_staging (realm_id);
