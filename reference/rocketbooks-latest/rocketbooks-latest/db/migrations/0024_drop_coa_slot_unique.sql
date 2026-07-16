-- Drop the (organization_id, gaap_type, detail_type) unique constraint on
-- chart_of_accounts. It encoded an assumption — "one row per category slot
-- per org" — that doesn't hold against real QuickBooks data: a single QB
-- workspace routinely has multiple Bank/Checking accounts, multiple
-- Fixed Assets/Buildings, multiple Expenses/EntertainmentMeals, etc. With
-- the constraint in place, the promoter's slot-match either silently
-- collapsed N distinct QB accounts onto one local row (losing identity
-- and per-account history) or hit a unique violation on insert.
--
-- After this migration, multiple rows can share (gaap_type, detail_type).
-- Identity is the row id itself; the slot is just a categorical label.
-- PFC resolution disambiguates by preferring system_generated=true (the
-- seed default for each category), see lib/accounting/resolve-pfc-coa.ts.
-- Plaid-side disambiguation uses plaid_accounts.chart_of_account_id;
-- QB-side uses qbo_entity_map.

ALTER TABLE public.chart_of_accounts
  DROP CONSTRAINT IF EXISTS chart_of_accounts_org_gaap_detail_unique;
