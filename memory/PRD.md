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

## What's Implemented (as of 2026-08-25)
- **Veryfi Multi-Statement Splitter (2026-08-25)** — Support for combined-PDF or `.zip` bank-statement uploads via Veryfi's `/api/v8/partner/bank-statements-set` async endpoint.
   • UI: New `☐ This PDF contains multiple statements` checkbox in the pre-check modal (default OFF, auto-ON for `.zip`). Single-statement flow untouched.
   • Backend: `statements.upload_statement_multi()` posts to splitter, creates a parent `statement_imports` row with `status='splitting'`, `is_multi=True`, `veryfi_document_set_id=<int>`. Returns immediately.
   • Webhook: `POST /api/webhooks/veryfi/bank-statement-set` (public, HMAC-SHA256 verified via `VERYFI_CLIENT_SECRET`) fetches each child `document_id` via GET, creates a child `statement_imports` row (`parent_import_id=<parent>`), runs the shared `_process_veryfi_result()` pipeline (identical to sync single-statement path).
   • Refactor: Extracted post-Veryfi logic in `upload_statement()` into `_process_veryfi_result()` so both entry paths share categorization/OCR guards/OBE/auto-recon.
   • Frontend polls the imports list every 8s (5-min cap) while a splitter parent is `status='splitting'`. Parent shows `multi · N` badge; children indent with `↳` under the parent.


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
   Cascade helpers in `link_cascade.py` and `transactions.py::_reverse_and_delete_payment` also
   reverse the JE so orphan ledger legs can't survive a cascade delete. Reports engine gated on
   `posted: True` to prevent double-counting. Native Accrual Balance Sheet now balances
   (Assets = L + E) end-to-end. Includes:
   - Type-scoped `_resolve_account` (was accidentally matching "Sales Tax Payable" for revenue).
   - Cash-basis filter for `auto_accrual` JEs (invoice-at-issue only recognizes on accrual).
   - `auto_cash` tag on receipt JEs so cash-basis P&L still surfaces sales receipts.
   - QBO-sourced docs defensively skip local JE posting (they use the GL / synthesis path).
   - Backfill script `scripts/backfill_document_jes.py` re-postable across all doc types.
- **QBO Recon 5-column overlay (2026-08-23)** — Reconciliation panel on BS + P&L now
   renders `Line | Official QBO | Imported QBO | + Native | Our Report | Δ vs QBO`.
   Backend adds an `imported_only=true` query param on the report endpoints that returns
   the GL-only slice. Legend cards show 3 trust KPIs (migration parity / native
   adjustments / unattributed drift) + filter toggles (All rows / Migration drift only /
   Native adjustments only). CSV export mirrors all 5 columns. Verified on
   Test QBO 431 LLC: `Imported = Official` (green ✓ across every row), `+Native = +$50k`
   on A/R fully attributes the drift, `Unattributed = $0`.
- **QBO + Native additive overlay (2026-08-23)** — `_signed_balances` on QBO-connected
   companies now layers native activity (invoices/bills/JEs/txns created in Axiom
   post-migration) on top of `qbo_gl_lines`. `_superseded_by_gl_ids` prevents double
   counting for docs that have been mirrored back to QBO. `_open_ar_ap` filters
   `source='qbo'` when GL data exists. Every doc counts exactly once in exactly one lane.
- **Deposit guard + UF safety net (2026-08-23)** — `merchant_cache.categorize_with_cache`
   force-routes every positive-amount Plaid txn to `4999 Uncategorized Income` (with
   `needs_review=true`) unless a deterministic rule matches (Interest, Bank Fee reversal).
   The LLM is never asked to guess an income account. Belt-and-suspenders post-LLM override
   refuses any account whose `detail_type=money_in_transit` for a bank-feed txn. Historical
   sweep on Plaid Test LLC re-routed 8 mis-categorized DDA→DDA deposits to 4999; UF is no
   longer negative and BS now balances. Rules Miner also blocks learning rules that target
   `4999 / 6999 / money_in_transit` so bad historical patterns can't get codified.

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
