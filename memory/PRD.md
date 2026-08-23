# Axiom (Enterprise AI Accounting SaaS) — PRD

## Original problem statement
Build an enterprise-level AI accounting SaaS software. Features include manual/auto transaction management, AI categorization, Plaid/Veryfi integration, white-labeling, 3-tier branding cascade, Partner roles with scoped data, and QBO bi-directional sync. Complete 1:1 report parity (Accrual & Cash basis) between Axiom and QuickBooks Online, fixing mapping discrepancies, missing transaction types, and deploying a multi-company backfill to correct historical data drift.

## Personas
- **Superadmin** — platform owner (michael@bigsaas.ai, admin@axiom.ai)
- **Pro / Accountant** — firm CPA managing many client books (pro@axiom.ai)
- **Partner** — reseller with white-labeled sub-brand (partner@axiom.ai / AxiomPartners)
- **Client** — small-business owner viewing their own books (client@axiom.ai, client2@axiom.ai)
- **UK Demo user** — non-US persona (demo-uk@smartbooks.ai)

## Key Architectural Concepts
- **GL-as-source-of-truth**: For QBO-connected companies, `qbo_gl_lines` (raw QBO GL, dual-basis) drives every summary report for 1:1 parity. Legacy entities (`transactions/invoices/payments/bills`) only power drill-downs.
- **3-tier branding cascade**: Enterprise → Partner → Company overrides.
- **Preview → Prod hydration**: Real prod companies are cloned into preview with `id` suffix `-preview-clone` (Emeral Coast, BM QBO 2, Nicole Pettyjohn).

## What's Implemented (as of 2026-08-23)
- Phase 2 hybrid QBO migration with dual-basis GL pull (`qbo_gl_lines`).
- Report engine reads directly from GL for QBO companies; legacy `_signed_balances` for native/Plaid.
- Superadmin GL Lab (`/admin/qbo-gl-lab`) for parity spot-checks.
- Date-range preset picker across P&L, BS, Cash Flow, GL.
- QBO Reconciliation panel with CSV export + auto-refresh.
- Full backfill endpoint (`POST /api/admin/qbo/full-backfill`) with per-company parity output.
- **Preview DB cleanup (2026-08-23)** — purged 945 test companies + 248 orphan users + 22 test enterprises. Backups in `/app/backups/`.
- **Native document JE posting (2026-08-23)** — `posting_service.py` now auto-posts double-entry JEs on:
   invoice create/update/delete, bill create/update/delete, payment (in/out) create/update/delete,
   sales receipt create/update/delete, estimate → invoice conversion, and PO → bill conversion.
   Reports engine gated on `posted: True` to prevent double-counting. Native Accrual Balance Sheet
   now balances (Assets = L + E) end-to-end. Includes:
   - Type-scoped `_resolve_account` (was accidentally matching "Sales Tax Payable" for revenue).
   - Cash-basis filter for `auto_accrual` JEs (invoice-at-issue only recognizes on accrual).
   - `auto_cash` tag on receipt JEs so cash-basis P&L still surfaces sales receipts.
   - QBO-sourced docs defensively skip local JE posting (they use the GL / synthesis path).
   - Backfill script `scripts/backfill_document_jes.py` re-postable across all doc types.

## Prioritized Backlog

### P0 — In progress
- (none active)

### P0 — Awaits user action
- (none — Emeral Coast re-auth dropped 2026-08-23; parity gap accepted as-is on prod)

### P1
- QBO Piece 2: AI Merchant → Contact match (removes "?" placeholders)
- Recon panel label alias map (Advertising ↔ Advertising & Marketing)
- Enterprise WL self-service toggle
- PDF export on QBO Reconciliation panel
- Real-time inbound webhooks for QBO (Phase 4)
- `_signed_balances` rewrite to Mongo `$group` aggregation
- AI rule confidence sort on Rules page (sort miner rules by `mined_confidence` DESC)
- **Runtime Rules Precedence** — wire `db.rules` into `merchant_cache.categorize_with_cache` as Step 0 (before static merchant_rules → cache → PFC → LLM), so user-created rules from the Rules page apply to incoming Plaid txns instead of only retroactively via `apply_to_existing`. ~20-line change + Mongo index on `(company_id, match_type, match_value)`. Discovered 2026-08-23 during rules-flow audit.

### P2
- Dead OAuth orphans cleanup (`qbo_connections` for deleted companies)
- Set-Password page design polish (lockup / accent color)
- Restaurant Vertical foundation (locations, multi-loc reports, feature flags)

### P3 / Backlog
- QBO Attachable file downloads
- Background auto-pull polling
- Native `.IIF` QBD import
- Transaction CSV import in Transactions page (paused)

## Preview Cleanup Scripts (2026-08-23)
- `/app/backend/scripts/purge_test_companies.py` — deletes non-protected companies + child rows across 52 collections
- `/app/backend/scripts/purge_orphan_users_enterprises.py` — initial orphan cleanup
- `/app/backend/scripts/purge_final_pass.py` — email-pattern-based user purge (STOP backend before running to avoid Firm Books auto-reseed loop from `enterprises.py:307`)

## Notes for Future Prod Cleanup
Before running any cleanup on prod, add to protected set:
- Enterprises: **CypherPro, Aquila Tax Services, ProactiveBooks**
- Partners: **Partner, ScarlettBooks**
- All companies inside them + their users
