-- Month-end close ladder. One row per org-month advanced past 'open'; an absent
-- row means the month is open (default). Status: open → reviewed → closed.
-- A 'closed' month hard-blocks posting/edits dated in it (enforced by
-- assertPeriodOpen in lib/accounting/posting.ts) until reopened.
--
-- Hand-written (skipping drizzle-kit generate) per the project's schema-drift
-- convention. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.accounting_periods (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  year integer NOT NULL,
  month integer NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'open',
  reviewed_by_user_id varchar,
  reviewed_at timestamp with time zone,
  closed_by_user_id varchar,
  closed_at timestamp with time zone,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT accounting_periods_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT accounting_periods_reviewed_by_user_id_fkey
    FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id),
  CONSTRAINT accounting_periods_closed_by_user_id_fkey
    FOREIGN KEY (closed_by_user_id) REFERENCES public.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_accounting_periods_org_year_month
  ON public.accounting_periods (organization_id, year, month);
