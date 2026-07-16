-- Phase 1: Fixed Assets foundation.
--
-- Four new tables:
--
--   asset_categories         — the COA-triple mapping (Asset, Accumulated
--                              Depreciation, Depreciation Expense). One per
--                              category × org. Drives the dropdown on asset
--                              create.
--   fixed_assets             — the register. Cost, in-service date, salvage,
--                              status, plus the trust-specific acquisition
--                              extensions (inherited / 1031 / cost-seg).
--   asset_books              — per-asset, per-book (tax | fiduciary) depreciation
--                              schedule + accumulated state. Dual-book is in
--                              from day one even if v1 only auto-posts the
--                              fiduciary book.
--   asset_depreciation_runs  — audit log for batched depreciation posts so the
--                              user can see which JE represents which period
--                              and reverse cleanly.

CREATE TABLE IF NOT EXISTS asset_categories (
  id                         varchar PRIMARY KEY,
  organization_id            varchar NOT NULL,
  name                       varchar NOT NULL,
  -- The three GL accounts the category uses. The asset side is debit-normal
  -- (e.g. 130 Equipment); accumulated depreciation is a contra-asset on the
  -- credit side; expense is debit-normal in the 6xx range.
  asset_account_id           varchar NOT NULL,
  accumulated_dep_account_id varchar NOT NULL,
  dep_expense_account_id     varchar NOT NULL,
  -- Defaults inherited by new assets in this category. User can override per
  -- asset.
  default_method             varchar NOT NULL DEFAULT 'straight_line',
  default_useful_life_months integer NOT NULL DEFAULT 60,
  default_salvage_pct        numeric(5,2) NOT NULL DEFAULT 0,
  -- Per-org "auto-depreciate new assets in this category" — drives the
  -- default for the per-asset toggle on create.
  default_auto_depreciate    boolean NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_account_id) REFERENCES chart_of_accounts(id),
  FOREIGN KEY (accumulated_dep_account_id) REFERENCES chart_of_accounts(id),
  FOREIGN KEY (dep_expense_account_id) REFERENCES chart_of_accounts(id),
  UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS ix_asset_categories_org_id
  ON asset_categories (organization_id);

CREATE TABLE IF NOT EXISTS fixed_assets (
  id                         varchar PRIMARY KEY,
  organization_id            varchar NOT NULL,
  category_id                varchar NOT NULL,
  -- Display + audit
  name                       varchar NOT NULL,
  asset_number               varchar,
  serial_number              varchar,
  location                   varchar,
  notes                      text,
  -- Status enum: 'draft' (editable) | 'active' (registered, depreciating) |
  -- 'disposed' (immutable, kept for history). Match the Xero / Intacct
  -- lifecycle.
  status                     varchar NOT NULL DEFAULT 'draft',
  -- Acquisition + basis
  acquisition_type           varchar NOT NULL DEFAULT 'purchased', -- purchased | inherited | exchanged_1031 | contributed
  in_service_date            date NOT NULL,
  cost_basis                 numeric(15,2) NOT NULL,
  -- Inherited (stepped-up basis): FMV at decedent's date of death replaces
  -- cost_basis for depreciation purposes. alternate_valuation_date is
  -- populated when the estate elected AVD (6 months after DOD).
  fmv_at_dod                 numeric(15,2),
  alternate_valuation_date   date,
  -- 1031 like-kind exchange: carry-over basis + excess basis (if user paid
  -- boot). replaced_asset_id is the asset traded away.
  replaced_asset_id          varchar,
  carryover_basis            numeric(15,2),
  excess_basis               numeric(15,2),
  -- Cost segregation: parent asset (e.g. building) split into children
  -- (building, land improvements, personal property). NULL for top-level
  -- assets. Children sum to the parent's cost.
  parent_asset_id            varchar,
  -- Depreciation defaults (snapshot from category at create — user can edit
  -- per-asset). Salvage is absolute dollars, not a percent.
  salvage_value              numeric(15,2) NOT NULL DEFAULT 0,
  -- Per-asset toggle for the monthly auto-depreciation cron. Defaults to
  -- the category's default_auto_depreciate at create time.
  auto_depreciate            boolean NOT NULL DEFAULT false,
  -- Source linkage: when the asset was created from a Plaid/manual txn,
  -- we record the source so the books stay traceable.
  source_transaction_id      varchar,
  -- Disposal: populated when status='disposed'.
  disposed_at                date,
  disposal_proceeds          numeric(15,2),
  disposal_fees              numeric(15,2),
  disposal_journal_entry_id  varchar,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES asset_categories(id),
  FOREIGN KEY (replaced_asset_id) REFERENCES fixed_assets(id),
  FOREIGN KEY (parent_asset_id) REFERENCES fixed_assets(id),
  FOREIGN KEY (source_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL,
  FOREIGN KEY (disposal_journal_entry_id) REFERENCES journal_entries(id)
);

CREATE INDEX IF NOT EXISTS ix_fixed_assets_org_id
  ON fixed_assets (organization_id);
CREATE INDEX IF NOT EXISTS ix_fixed_assets_category_id
  ON fixed_assets (category_id);
CREATE INDEX IF NOT EXISTS ix_fixed_assets_parent_id
  ON fixed_assets (parent_asset_id)
  WHERE parent_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_fixed_assets_replaced_id
  ON fixed_assets (replaced_asset_id)
  WHERE replaced_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_fixed_assets_status_active
  ON fixed_assets (organization_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS asset_books (
  id                          varchar PRIMARY KEY,
  organization_id             varchar NOT NULL,
  asset_id                    varchar NOT NULL,
  -- 'fiduciary' = book/GAAP depreciation that drives the trust's accounting
  -- income (TAI) reported on 1041. 'tax' = MACRS schedule used for the
  -- 1041 tax depreciation calculation. v1 auto-posts the fiduciary book;
  -- tax book is data-only for now (1041 reporting comes later).
  book_type                   varchar NOT NULL,
  -- Per-book method / life / convention can diverge. Methods supported in
  -- v1: 'straight_line', 'declining_balance_150', 'declining_balance_200',
  -- 'macrs_gds', 'macrs_ads'. v1 calculator only implements straight_line +
  -- declining_balance; MACRS is data-only for now.
  method                      varchar NOT NULL,
  useful_life_months          integer NOT NULL,
  convention                  varchar NOT NULL DEFAULT 'half_year', -- half_year | mid_month | mid_quarter | full_month
  -- Running totals updated by the depreciation engine. Lets us answer
  -- "what's the current book value?" without re-summing every prior JE.
  accumulated_depreciation    numeric(15,2) NOT NULL DEFAULT 0,
  accumulated_through_date    date,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES fixed_assets(id) ON DELETE CASCADE,
  UNIQUE (asset_id, book_type)
);

CREATE INDEX IF NOT EXISTS ix_asset_books_org_id
  ON asset_books (organization_id);
CREATE INDEX IF NOT EXISTS ix_asset_books_asset_id
  ON asset_books (asset_id);

CREATE TABLE IF NOT EXISTS asset_depreciation_runs (
  id                         varchar PRIMARY KEY,
  organization_id            varchar NOT NULL,
  book_type                  varchar NOT NULL,
  -- The period whose depreciation expense this run posted. period_end is
  -- the last day of the period (e.g. 2026-05-31 for May 2026).
  period_start_date          date NOT NULL,
  period_end_date            date NOT NULL,
  journal_entry_id           varchar NOT NULL,
  -- Which trigger fired this run — for support / audit.
  triggered_by               varchar NOT NULL, -- manual | cron
  triggered_by_user_id       varchar,
  -- Snapshot of how many assets were covered, total expense booked. Lets
  -- the Assets page show "May 2026 run — 14 assets — $2,341.10" without a
  -- recompute.
  assets_included            integer NOT NULL DEFAULT 0,
  total_expense              numeric(15,2) NOT NULL DEFAULT 0,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY (triggered_by_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS ix_asset_depreciation_runs_org_period
  ON asset_depreciation_runs (organization_id, period_end_date DESC);

-- Per-org preferences. We piggy-back on organization_accounting_features
-- when the feature_pack is 'beneficial_trust' isn't relevant here, so use
-- a simple settings table. Future: roll into a general org_settings.
CREATE TABLE IF NOT EXISTS asset_settings (
  organization_id            varchar PRIMARY KEY,
  -- Per-org "enable auto-depreciate by default on new assets" — sets the
  -- initial value of fixed_assets.auto_depreciate at create time. Per-
  -- asset toggle still wins.
  default_auto_depreciate    boolean NOT NULL DEFAULT false,
  -- Whether the monthly cron runs for this org at all. Even if some assets
  -- are flagged auto, the cron won't touch them when this is false.
  cron_enabled               boolean NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
