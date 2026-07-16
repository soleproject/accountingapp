-- Beneficial-trust accounting foundation. Adds the schema scaffolding for
-- entity-type-aware accounting (beneficial trust first; business trust +
-- nonprofit slot in later as new enum values + COA templates + rules
-- modules, no migrations).
--
-- The Enterprise toggle (organizations.entity_type_onboarding_enabled)
-- gates whether client orgs under that Enterprise see the entity-type
-- step during onboarding. Default false everywhere → zero behavior change
-- for any existing org and any org whose Enterprise hasn't opted in.
--
-- New tables introduced here (all empty until Phase 2/3/4 starts writing):
--
--   organization_accounting_features  — per-(org, feature_pack) toggles
--                                        modeled on qbo_mirror_settings
--   trust_beneficiaries               — beneficiary roster for trust orgs;
--                                        each row owns a 265.x demand-note
--                                        sub-account in chart_of_accounts
--   loans + loan_amortization_schedules
--                                      — supports 250 principal/interest
--                                        split on every payment
--   rental_properties                 — per-property sub-ledger header;
--                                        per-line linkage is via the new
--                                        rental_property_id column on
--                                        journal_entry_lines
--   personal_use_lease_agreements     — drives 440 lease-income detection
--                                        when a trustee/beneficiary uses a
--                                        trust-owned house/vehicle
--
-- Edits to existing tables:
--
--   organizations.entity_type        — varchar → org_entity_type enum
--                                       (defensive USING preserves nulls,
--                                       routes any unexpected legacy value
--                                       to 'other')
--   organizations + entity_type_onboarding_enabled boolean
--   journal_entry_lines + rental_property_id varchar (nullable FK)
--
-- chart_of_accounts already supports parent/child sub-accounts via
-- parent_account_id (self-FK, fully wired in seed-default-coa.ts and the
-- CoaBrowser UI) — Phase 3 reuses it for 121/122 savings, 161-164
-- investments, 251/252 loans, and 265.x beneficiary demand notes.
--
-- Hand-written (skipping drizzle-kit generate) per the project's schema-
-- drift convention. Idempotent: safe to re-run.

------------------------------------------------------------------------
-- 1. org_entity_type pgEnum
------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'org_entity_type') THEN
    CREATE TYPE public.org_entity_type AS ENUM (
      'llc',
      'c_corp',
      's_corp',
      'partnership',
      'sole_prop',
      'beneficial_trust',
      'business_trust',
      'nonprofit',
      'other'
    );
  END IF;
END $$;

------------------------------------------------------------------------
-- 2. Convert organizations.entity_type from varchar → org_entity_type.
--    The column is varchar today and (per prior scan) mostly null with
--    only a handful of free-form values used as AI context. The USING
--    clause preserves null, maps known patterns to their canonical enum
--    value, and routes anything else to 'other' so no data is lost.
--    Wrapped in a guard so re-running is a no-op.
------------------------------------------------------------------------

DO $$
DECLARE
  current_udt text;
BEGIN
  SELECT udt_name INTO current_udt
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'organizations'
     AND column_name = 'entity_type';

  IF current_udt IS DISTINCT FROM 'org_entity_type' THEN
    ALTER TABLE public.organizations
      ALTER COLUMN entity_type TYPE public.org_entity_type
      USING (
        CASE
          WHEN entity_type IS NULL OR btrim(entity_type) = '' THEN NULL
          WHEN lower(btrim(entity_type)) IN ('llc') THEN 'llc'::public.org_entity_type
          WHEN lower(btrim(entity_type)) IN ('c_corp','c-corp','c corp','corp','corporation','ccorp') THEN 'c_corp'::public.org_entity_type
          WHEN lower(btrim(entity_type)) IN ('s_corp','s-corp','s corp','scorp') THEN 's_corp'::public.org_entity_type
          WHEN lower(btrim(entity_type)) IN ('partnership','lp','llp') THEN 'partnership'::public.org_entity_type
          WHEN lower(btrim(entity_type)) IN ('sole_prop','sole-prop','sole prop','sole proprietor','sole proprietorship') THEN 'sole_prop'::public.org_entity_type
          WHEN lower(btrim(entity_type)) IN ('beneficial_trust','beneficial trust','beneficiary trust') THEN 'beneficial_trust'::public.org_entity_type
          WHEN lower(btrim(entity_type)) IN ('business_trust','business trust') THEN 'business_trust'::public.org_entity_type
          WHEN lower(btrim(entity_type)) IN ('nonprofit','non-profit','non profit','501c3','501(c)(3)') THEN 'nonprofit'::public.org_entity_type
          ELSE 'other'::public.org_entity_type
        END
      );
  END IF;
END $$;

------------------------------------------------------------------------
-- 3. Enterprise toggle: visibility of the entity-type onboarding step.
--    Lives on the Enterprise org (planType='enterprise'). Client orgs
--    under that Enterprise read it via the enterprise_clients junction.
--    Default false → existing orgs and new orgs both unchanged until
--    explicitly opted in.
------------------------------------------------------------------------

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS entity_type_onboarding_enabled boolean NOT NULL DEFAULT false;

------------------------------------------------------------------------
-- 4. organization_accounting_features
--    Tall schema (one row per org × feature_pack) for flexibility — new
--    packs (business_trust, nonprofit, …) can be added without a
--    migration. Mirrors qbo_mirror_settings' "explicit settings table"
--    pattern, but keyed by a pack identifier instead of fixed columns.
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.organization_accounting_features (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  feature_pack varchar(64) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb,
  enabled_at timestamp with time zone,
  enabled_by_user_id varchar,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT organization_accounting_features_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT organization_accounting_features_user_id_fkey
    FOREIGN KEY (enabled_by_user_id) REFERENCES public.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_org_acct_features_org_pack
  ON public.organization_accounting_features (organization_id, feature_pack);

CREATE INDEX IF NOT EXISTS ix_org_acct_features_enabled
  ON public.organization_accounting_features (feature_pack)
  WHERE enabled = true;

------------------------------------------------------------------------
-- 5. trust_beneficiaries
--    Beneficiary roster for any trust-type org. dob + is_incapacitated
--    are load-bearing: Phase 4 reads them at posting time to enforce the
--    815/820 eligibility rule (Food/Clothing only postable when recipient
--    is <21 OR incapacitated). demand_note_account_id is the 265.x
--    sub-account auto-seeded for this beneficiary in Phase 3.
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.trust_beneficiaries (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  full_name varchar NOT NULL,
  date_of_birth date,
  is_incapacitated boolean NOT NULL DEFAULT false,
  relationship varchar,
  legal_guardian_contact_id varchar,
  notes text,
  demand_note_account_id varchar,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT trust_beneficiaries_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT trust_beneficiaries_demand_note_account_id_fkey
    FOREIGN KEY (demand_note_account_id) REFERENCES public.chart_of_accounts(id),
  CONSTRAINT trust_beneficiaries_legal_guardian_contact_id_fkey
    FOREIGN KEY (legal_guardian_contact_id) REFERENCES public.contacts(id)
);

CREATE INDEX IF NOT EXISTS ix_trust_beneficiaries_org_id
  ON public.trust_beneficiaries (organization_id);

------------------------------------------------------------------------
-- 6. loans
--    Header record for every note payable held by the trust. Each loan
--    points at a 250.x liability sub-account (251 Mortgage, 252 Auto,
--    etc.). Phase 4 uses original_principal + interest_rate + term to
--    generate an amortization schedule that drives the principal/
--    interest split on each payment.
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.loans (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  liability_account_id varchar NOT NULL,
  interest_expense_account_id varchar,
  lender_contact_id varchar,
  display_name varchar NOT NULL,
  original_principal numeric(14,2) NOT NULL,
  current_principal numeric(14,2) NOT NULL,
  annual_interest_rate numeric(8,5) NOT NULL,
  term_months integer NOT NULL,
  payment_amount numeric(14,2),
  first_payment_date date,
  start_date date NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  note_document_url varchar,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT loans_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT loans_liability_account_id_fkey
    FOREIGN KEY (liability_account_id) REFERENCES public.chart_of_accounts(id),
  CONSTRAINT loans_interest_expense_account_id_fkey
    FOREIGN KEY (interest_expense_account_id) REFERENCES public.chart_of_accounts(id),
  CONSTRAINT loans_lender_contact_id_fkey
    FOREIGN KEY (lender_contact_id) REFERENCES public.contacts(id)
);

CREATE INDEX IF NOT EXISTS ix_loans_org_id
  ON public.loans (organization_id);
CREATE INDEX IF NOT EXISTS ix_loans_liability_account_id
  ON public.loans (liability_account_id);
CREATE INDEX IF NOT EXISTS ix_loans_org_active
  ON public.loans (organization_id)
  WHERE status = 'active';

------------------------------------------------------------------------
-- 7. loan_amortization_schedules
--    One row per scheduled payment for a loan. posted_journal_entry_id
--    is set when the payment is actually posted, allowing the rules
--    engine to (a) know which schedule row to consume next and (b)
--    detect missed/duplicated payments. principal_amount + interest_
--    amount are pre-computed at schedule generation, not at post time.
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.loan_amortization_schedules (
  id varchar PRIMARY KEY NOT NULL,
  loan_id varchar NOT NULL,
  payment_number integer NOT NULL,
  due_date date NOT NULL,
  principal_amount numeric(14,2) NOT NULL,
  interest_amount numeric(14,2) NOT NULL,
  remaining_balance numeric(14,2) NOT NULL,
  posted_journal_entry_id varchar,
  posted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT loan_amortization_schedules_loan_id_fkey
    FOREIGN KEY (loan_id) REFERENCES public.loans(id) ON DELETE CASCADE,
  CONSTRAINT loan_amortization_schedules_posted_je_id_fkey
    FOREIGN KEY (posted_journal_entry_id) REFERENCES public.journal_entries(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_loan_amort_loan_payment_num
  ON public.loan_amortization_schedules (loan_id, payment_number);
CREATE INDEX IF NOT EXISTS ix_loan_amort_due_date
  ON public.loan_amortization_schedules (due_date)
  WHERE posted_journal_entry_id IS NULL;

------------------------------------------------------------------------
-- 8. rental_properties
--    Per-property header row. The asset_account_id points at the
--    property's 125 (Land) / 126 (Buildings) sub-account. The actual
--    per-property income/expense register is materialized by joining
--    journal_entry_lines on the new rental_property_id column (added
--    below in section 10).
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rental_properties (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  display_name varchar NOT NULL,
  address jsonb,
  asset_account_id varchar,
  status varchar(16) NOT NULL DEFAULT 'active',
  acquired_on date,
  disposed_on date,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT rental_properties_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT rental_properties_asset_account_id_fkey
    FOREIGN KEY (asset_account_id) REFERENCES public.chart_of_accounts(id)
);

CREATE INDEX IF NOT EXISTS ix_rental_properties_org_id
  ON public.rental_properties (organization_id);

------------------------------------------------------------------------
-- 9. personal_use_lease_agreements
--    Documents that a specific user (trustee or beneficiary) leases a
--    specific trust-owned asset for personal use. Phase 4 reads this to
--    decide whether to auto-post the 440 lease-income entry every
--    period and to gate certain expense flows on the asset.
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.personal_use_lease_agreements (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  lessee_user_id varchar NOT NULL,
  lessee_role varchar(32) NOT NULL,
  asset_account_id varchar NOT NULL,
  monthly_amount numeric(14,2) NOT NULL,
  start_date date NOT NULL,
  end_date date,
  agreement_document_url varchar,
  status varchar(16) NOT NULL DEFAULT 'active',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT personal_use_lease_agreements_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT personal_use_lease_agreements_lessee_user_id_fkey
    FOREIGN KEY (lessee_user_id) REFERENCES public.users(id),
  CONSTRAINT personal_use_lease_agreements_asset_account_id_fkey
    FOREIGN KEY (asset_account_id) REFERENCES public.chart_of_accounts(id)
);

CREATE INDEX IF NOT EXISTS ix_personal_use_lease_org_id
  ON public.personal_use_lease_agreements (organization_id);
CREATE INDEX IF NOT EXISTS ix_personal_use_lease_org_active
  ON public.personal_use_lease_agreements (organization_id)
  WHERE status = 'active';

------------------------------------------------------------------------
-- 10. journal_entry_lines.rental_property_id
--     Optional per-line link to a rental_properties row. Lets Phase 4
--     compute net rental income per property by summing the income
--     and expense lines tagged with the same property_id, then post
--     only the net to account 430. Existing journal entries (no
--     rental property association) are unaffected.
------------------------------------------------------------------------

ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS rental_property_id varchar;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'journal_entry_lines_rental_property_id_fkey'
  ) THEN
    ALTER TABLE public.journal_entry_lines
      ADD CONSTRAINT journal_entry_lines_rental_property_id_fkey
      FOREIGN KEY (rental_property_id) REFERENCES public.rental_properties(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_jel_rental_property_id
  ON public.journal_entry_lines (rental_property_id)
  WHERE rental_property_id IS NOT NULL;
