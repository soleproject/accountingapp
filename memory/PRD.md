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
