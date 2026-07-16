-- Per-org mapping from Plaid PFC (personal_finance_category.detailed) to
-- a specific chart_of_accounts row. Replaces the hardcoded
-- pfc-coa-mapping.ts slot lookup for orgs that have customized their
-- CoA (i.e. connected QuickBooks and let the AI mapper assign each PFC
-- to a QB account, with the original seed un-hidden as fallback only
-- where QB has no good equivalent).
--
-- resolve-pfc-coa.ts checks this table FIRST. Falls back to the
-- existing slot lookup when no override exists for the (org, pfc) pair
-- — covers orgs without QB.
--
-- source:
--   'ai'             — written by aiMapPfcToCoa after QB sync
--   'user'           — manually overridden via admin UI (future)
--   'seed_fallback'  — AI couldn't find a QB match; seed row un-hidden
--                       and pointed at by this override
-- confidence/reasoning/ai_model are populated for 'ai' rows; null for
-- the others.

CREATE TABLE IF NOT EXISTS public.pfc_org_overrides (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  pfc_detailed varchar NOT NULL,
  category_account_id varchar NOT NULL,
  source varchar NOT NULL,
  confidence numeric(3,2),
  reasoning text,
  ai_model varchar,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pfc_org_overrides_org_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
  CONSTRAINT pfc_org_overrides_coa_fkey
    FOREIGN KEY (category_account_id) REFERENCES public.chart_of_accounts(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_pfc_org_overrides_org_pfc
  ON public.pfc_org_overrides (organization_id, pfc_detailed);
CREATE INDEX IF NOT EXISTS ix_pfc_org_overrides_coa
  ON public.pfc_org_overrides (category_account_id);
