# SmartBooks — Changelog

## 2026-02-20 — Transfers Mirror verified · Migration Banner · Plaid Transfer Bugfix

### 🪞 QBO Mirror — Transfers verified (Phase 4d closeout)
- Added regression suite `backend/tests/test_qbo_mirror_transfer_push.py` (13 tests): body-builder happy path, absolute-value guard, required accounts, non-zero amount, memo fallback chain (memo → notes → description), twin-patch round-trip, autopush/dispatch registration guards. All 171 QBO mirror + PFC tests green.
- Transfers now covered end-to-end: `_transfer_body` (push.py) + `_local_patch_from_qbo_transfer` (twin patch) + `_push_one_transfer` (autopush) + entity-meta registration → PATCH/DELETE cascades know how to talk to `/company/{realm}/transfer`.

### 🎉 QBO Migration Completion Banner (Frontend)
- After a migration finishes, `QboConnect.jsx` now surfaces a summary card (`data-testid="qbo-migration-complete-banner"`) with four stat tiles:
  - `qbo-stat-seeded-deactivated` — seeded accounts auto-tidied
  - `qbo-stat-estimates-pulled` — mirror pulled Estimates count
  - `qbo-stat-pos-pulled` — mirror pulled Purchase Orders count
  - `qbo-stat-skipped-dupkey` — duplicates adopted (previously invisible to users)
- Backend: `qbo_service.run_migration` now aggregates `skipped_dupkey` across estimate + PO pulls and stores it on the job doc alongside the existing `seeded_deactivated` / `mirror_*_pulled` fields.

### 🐛 Plaid Transfer Bug — TRANSFER_OUT_ACCOUNT_TRANSFER → Uncategorized (P1, recurring)
- **Root cause**: PFC codes like `TRANSFER_OUT_ACCOUNT_TRANSFER` / `TRANSFER_IN_ACCOUNT_TRANSFER` / `TRANSFER_*_SAVINGS` were mapped to `1010` (Checking) with `asset_movement` classification. The resolver's bank-account guard (correctly) blocked routing to another bank, and the row fell all the way through to Step 3 → `6999` Uncategorized Expense (or `4999` Uncat Income). Real inter-account transfers were inflating P&L reports.
- **Fix**: Added **Step 2b** in `pfc_resolver.py`: when the primary is blocked *and* classification is `asset_movement`, resolve to an equity clearing account (`Inter-Account Transfer`, subtype='transfer'). Idempotently auto-created via `_ensure_transfer_clearing_account` — matches parity with `_ensure_transfer_account` already used by mark-as-transfer / detect-transfers.
- **New tests** in `test_pfc_resolver.py`:
  - `test_transfer_in_account_transfer_routes_to_clearing`
  - `test_transfer_out_account_transfer_routes_to_clearing`
  - `test_transfer_clearing_is_idempotent` (multiple resolutions reuse the same account)
- Result source is now `transfer_clearing` (new source enum). Legacy stale test that asserted the old buggy `fallback_uncategorized` behavior was replaced.

### Files touched
- `backend/pfc_resolver.py` (+82 lines: helper + Step 2b + import uuid/now_iso)
- `backend/tests/test_pfc_resolver.py` (replaced 1 stale test with 3 new ones)
- `backend/qbo_service.py` (skipped_dupkey aggregation)
- `backend/tests/test_qbo_mirror_transfer_push.py` (new — 13 tests)
- `frontend/src/pages/QboConnect.jsx` (Migration Completion Banner)


## 2026-08-08 — QBO Mirror Phase 1a + Migration Fixes

### 🪞 QBO Mirror Phase 1a (Dry-Run Preview)

**New module** — `/app/backend/qbo_mirror/` (fully isolated from existing code)

**Backend**
- `qbo_mirror/settings.py` — per-company `mirror_config` model with hard-locked `dry_run: true`, master kill-switch via `QBO_MIRROR_MASTER_DISABLE` env, append-only `mirror_log`
- `qbo_mirror/engine.py` — dry-run diff engine for 4 Foundation entities (accounts, customers, vendors, items). Reads both sides, matches by qbo_id → natural key fallback, classifies rows as in_sync / field_drift / push_to_qbo / pull_from_qbo. Zero writes anywhere.
- `routes/qbo_mirror.py` — 4 endpoints under `/api/companies/{cid}/qbo/mirror/*`:
  - `GET /config`
  - `PUT /config` (whitelisted patch, `dry_run` forced True)
  - `POST /dry-run` (executes preview)
  - `GET /log?limit=N`

**Frontend**
- `pages/QboMirror.jsx` — full settings + preview page at `/settings/qbo-mirror`
- Nav entry: **"Live Mirror (preview)"** button on QboConnect page

**Isolation guarantees**
- New Mongo collections (`mirror_config`, `mirror_log`) — zero schema change to existing tables
- No touches to `qbo_service.py`, `pfc_resolver.py`, `reports.py`, etc.
- Backend forces `dry_run=true` even if a client sends `false`
- Kill switch via `QBO_MIRROR_MASTER_DISABLE=true` env

### QBO Migration Improvements (10 fixes bundled earlier this session)

1. Deactivate ALL seeded button — keeps `6999`/`4999` Plaid fallbacks + referenced accounts
2. Export CoA to CSV button
3. QBO sub-account hierarchy fix + Rebuild button (splits colon-joined names into parent-child tree)
4. Hide inactive accounts on CoA by default + Show inactive toggle
5. Plaid resolver: filter inactive + QBO Uncategorized last-resort fallback
6. Double-pass AI PFC mapping — auto-run and manual button both run twice, merge by highest confidence
7. QBO transaction category promotion — AccountRef → Item's income/expense account → Uncategorized fallback (direction-aware)
8. QBO transaction amount signing + `direction` field (in/out/transfer)
9. QBO bank/asset account field extraction + resolver (fills Account column on Transactions page)
10. QBO transactions post to ledger (`posted: True`) — reports (P&L, Balance Sheet, GL) now include them

### Next Action Items

- **Phase 1b** — Flip Mirror `dry_run: false`, enable live outbound writes for Foundation entities
- **Phase 2** — Mirror existing doc types (Invoices, Bills, Purchases, Deposits, Transfers, Payments, Bill Payments, Journal Entries)
- **Phase 3** — Build new document types: Estimates (convert-to-Invoice) + Purchase Orders (convert-to-Bill), wired to Mirror from day one
- **Phase 4** — Webhooks + real-time inbound + conflict resolution UI

### Deferred bugs

- Plaid `TRANSFER_OUT_ACCOUNT_TRANSFER` still routing to Uncategorized instead of Inter-Account Transfer (identified in Show LLC diagnostic)
- Restaurant Vertical Foundation (P0 from earlier fork)
- `_signed_balances` Mongo aggregation rewrite (scaling)
- Veryfi multi-page PDF ~40% line-item drop warning banner


## 2026-08-09 — QBO Mirror Phase 2c: Invoice Push (Outbound)

**Bi-directional Invoice sync complete.** Local invoices now push to
QBO in real-time, on create / update / delete, with the same
anti-loop tagging (`_sync_origin: "mirror_push"`) already used for
Foundation entities.

**Backend**
- `qbo_mirror/push.py`:
  - `_invoice_body()` — translates local `contact_id` → QBO
    `CustomerRef.value` and per-line `item_id` → `ItemRef.value`.
    Falls back to a QBO-side Service item ("Services" / "Hours" /
    "General" or any Service-typed item) when a line lacks
    `item_id`.
  - `_push_invoices()` — bulk pusher. Filters out drafts, voided
    invoices, and rows already carrying a `qbo_id`.
- `qbo_mirror/autopush.py`:
  - `_push_one_invoice()` single-shot pusher + invoice registered in
    `_ENTITY_META`, `_HANDLERS`, and `_ENTITY_TO_CFG_KEY`.
  - `_run_auto_update()` — invoice branch does a doc-level sparse
    update (DueDate, TxnDate, CustomerMemo, PrivateNote). Line-level
    drift is deliberately deferred to Phase 3 because QBO requires
    matching `Line.Id`/`Detail` to preserve payment linkage and our
    local line model doesn't yet carry QBO's per-line Id.
  - `_run_auto_delete()` — invoice supports QBO hard-delete via
    `?operation=delete` (same shape as items).
  - `_run_one()` — filters invoice drafts / voids from auto-push.
  - `_run_auto_update()` — a draft → sent transition on an
    unmirrored invoice routes to the fresh-push path so the row
    lands on QBO for the first time on the status flip.
- `routes/invoices.py`:
  - `create_invoice`, `update_invoice`, `delete_invoice`,
    `duplicate_invoice` now fire the corresponding
    `try_auto_push` / `try_auto_update` / `try_auto_delete` hook.
  - Duplicate strips the source `qbo_id`, so the copy is treated as
    fresh push candidate.

**Frontend**
- `pages/QboMirror.jsx` — "Invoices (Phase 2 · preview only)" label
  dropped; invoices now behave identically to Foundation entities
  in Push / Pull / Preview flows.

**Tax handling** — doc-level `TxnTaxDetail` is deliberately skipped.
QBO recomputes tax from its own TaxCode/AST config; forcing our
locally-rolled tax onto QBO for non-mirrored tax codes either
errors out (non-AST companies with unmapped codes) or is silently
overridden (AST-enabled companies). Full tax mirroring lands in
Phase 3 alongside a `taxes` mirror scope.

**Regression coverage**
- `tests/test_qbo_mirror_invoice_push.py` — 5 unit tests verifying
  happy path, missing customer, missing item + no fallback, empty
  line items, DocNumber truncation.


## 2026-08-09 — QBO Mirror Phase 2d: Bills (Outbound + Inbound)

**Bi-directional Bills sync complete.** Bills now enjoy the same
autopush + manual push + dry-run + pull treatment invoices got.
~200 LOC of net-new code; ~90% reused from the invoice path.

**Backend**
- `qbo_mirror/push.py`:
  - `_resolve_vendor_ref`, `_resolve_account_ref`,
    `_default_expense_account_qbo` (fallback: "Uncategorized
    Expense" / "Miscellaneous" / alphabetically first Expense).
  - `_bill_body()` — builds QBO Bill payload with `VendorRef` +
    `AccountBasedExpenseLineDetail.AccountRef` per line.
  - `_local_patch_from_qbo_bill()` — twin patch (TotalAmt,
    Balance, TxnDate, DueDate, DocNumber, computed status
    "paid"/"open").
  - `_push_bills()` — 2-pass: create rows without qbo_id, then
    full-replace UPDATE any locally-authored bill that has
    drifted (compares TotalAmt with SyncToken lookup).
- `qbo_mirror/pull.py`:
  - `_pull_bills()` — mirror of `_pull_invoices` including
    reclaim-by-DocNumber for legacy bills without qbo_id.
- `qbo_mirror/engine.py`:
  - `_norm_bill_local` / `_norm_bill_qbo` normalizers.
  - `_DRIFT_FIELDS["bills"]` = number/date/total/balance/status.
  - Bills wired into `_fetch_local`, `_fetch_qbo`, dry-run loop.
- `qbo_mirror/autopush.py`:
  - `_push_one_bill()` single-shot pusher returning twin patch.
  - Bill registered in `_ENTITY_META`, `_HANDLERS`,
    `_ENTITY_TO_CFG_KEY`.
  - `_run_auto_update()` — bill branch: full replace via
    `_bill_body`, sparse=false, twin-patch merged into set doc.
  - `_run_auto_delete()` — bill uses `?operation=delete` (QBO
    hard delete, same as invoice).
  - `_run_one()` — void filter now covers both invoice and bill.
- `qbo_mirror/settings.py` — DEFAULTS now enables `bills: True`.
- `routes/bills.py`:
  - `create_bill`, `update_bill`, `delete_bill`, `duplicate_bill`
    wire `try_auto_push` / `try_auto_update` / `try_auto_delete`
    hooks.
  - PATCH clears stale `_sync_origin` for the same reason
    invoices do.

**Frontend**
- `pages/QboMirror.jsx` — Bills added to ENTITIES list and
  Push/Pull whitelists.

**Deliberately deferred**
- Item-based expense lines (`ItemBasedExpenseLineDetail`) — every
  local line pushes as `AccountBasedExpenseLineDetail` for now.
  Adding inventory-item support requires resolving item_id to a
  QBO Item + selecting the right detail type per line.
- Doc-level tax on bills — same reason as invoices (tax library
  not mirrored). Bills carry `tax` locally; QBO recomputes on
  its own tax code.

**Regression coverage**
- `tests/test_qbo_mirror_bill_push.py` — 6 unit tests: happy
  path, missing vendor, missing account + no fallback, empty
  line items, DocNumber truncation, twin patch shape.
- Combined with invoice tests: **11/11 pass**.


## 2026-08-09 — QBO Mirror Phase 2e: Payments + Bill Payments

**Money movement now syncs bi-directionally.** Customer Payments
(money in) and Bill Payments (money out) auto-push to QBO on
create/delete, pull via manual button, and resolve invoice/bill
balances on both sides.

**Backend**
- `qbo_mirror/push.py`:
  - `_payment_body_in()` — Customer Payment: CustomerRef +
    LinkedTxn[Invoice] + DepositToAccountRef (optional; QBO uses
    Undeposited Funds if omitted).
  - `_payment_body_out()` — Bill Payment: VendorRef + PayType=Check
    + LinkedTxn[Bill] + CheckPayment.BankAccountRef (required).
  - `_push_payments_in()` / `_push_payments_out()` — bulk pushers.
  - `_local_patch_from_qbo_payment()` — twin patch (amount, date).
- `qbo_mirror/pull.py`:
  - `_pull_payments()` — direction-aware; resolves QBO LinkedTxn
    (Invoice / Bill) back into local `linked_invoice_id` /
    `linked_bill_id` via qbo_id lookup so balance-heal in list
    endpoints works.
- `qbo_mirror/autopush.py`:
  - Two entity registry slots: `payment_in` (Payment endpoint) and
    `payment_out` (BillPayment endpoint). Both share the
    `payments` collection but hit different QBO paths.
  - `_push_one_payment_in` / `_push_one_payment_out` handlers.
  - `_run_auto_delete()` — both directions hard-delete via
    `?operation=delete`.
  - `_run_auto_update()` — payment updates are deliberately a
    no-op (amount/linkage changes require reversing old LinkedTxn
    effect on QBO — non-trivial). Users delete + recreate.
- `qbo_mirror/engine.py`:
  - Minimal payment normalizers (match by qbo_id only, no drift
    detection — payment drift signals are too fragile).
  - `_DRIFT_FIELDS["payments"] = []`, same for bill_payments.
  - Payments included in dry-run loop → preview cards for both.
- `qbo_mirror/settings.py` — DEFAULTS enables `payments: True`
  and `bill_payments: True`.
- `routes/payments.py`:
  - `_payment_mirror_entity()` helper dispatches on
    `linked_invoice_id` vs `linked_bill_id` → `payment_in` /
    `payment_out` / None (unlinked; skip).
  - `create_payment` / `update_payment` / `delete_payment` all
    fire the right autopush hook via the dispatch helper.

**Frontend**
- `pages/QboMirror.jsx` — Two new rows: "Customer Payments" and
  "Bill Payments". Push/Pull whitelist extended.

**Deliberately deferred**
- Payment UPDATE mirroring — linkage/amount changes need QBO's
  LinkedTxn to be manually unrolled. UX guidance: delete +
  recreate the local payment; both operations auto-mirror.
- Multi-invoice / multi-bill payments — single-link only for MVP.
- Payment drift detection — qbo_id-only matching.

**Regression coverage**
- `tests/test_qbo_mirror_payment_push.py` — 8 unit tests: both
  directions happy paths, missing customer/vendor, missing linked
  doc, unsynced linked doc, missing bank account, twin patch.
- All 3 mirror test files: **19/19 pass**.
- Fixed cross-file `db` monkeypatch bug: `from db import db`
  binds the reference at import time; tests now also patch
  `qbo_mirror.push.db` directly so the fake propagates.


## 2026-08-10 — QBO Mirror Phase 2f: Journal Entries

**JE mirror complete.** Journal Entries authored in-app auto-push
to QBO; QBO JEs pull down into local ledger. Rounds out the last
common transaction type pros need bi-directionally synced.

**Scope decision**: This phase covers **Journal Entries only**.
Deposits and Transfers live in `db.transactions` (mixed with Plaid
and every other transaction type) and have no in-app authoring
UI, so push has no source and pull would duplicate the existing
migration/sync path. Deferred to a later phase where we build
"Add Deposit" / "Add Transfer" UIs and integrate carefully with
the Plaid pipeline.

**Backend**
- `qbo_mirror/push.py`:
  - `_journal_entry_body()` — builds a QBO JournalEntry payload
    with proper `PostingType: Debit|Credit` + `AccountRef` per
    line. Rejects on any of: same-line-both-postings,
    unbalanced totals, unmapped account, empty JE. DocNumber
    caps at 21 chars.
  - `_push_journal_entries()` — bulk pusher (create only; JE
    updates are documented no-op).
  - `_local_patch_from_qbo_je()` — twin patch (date, number, memo).
  - `_resolve_account_ref_by_id_or_name()` — resilient resolver
    that falls back to `account_name` when `account_id` is
    missing (legacy GL imports).
- `qbo_mirror/pull.py`:
  - `_pull_journal_entries()` — matches by qbo_id, resolves each
    line's `account_qbo_id` back to local `account_id` so
    downstream reports don't need name-based joins.
- `qbo_mirror/autopush.py`:
  - `_push_one_journal_entry()` handler.
  - `journal_entry` registered in `_ENTITY_META`, `_HANDLERS`,
    `_ENTITY_TO_CFG_KEY`.
  - `_run_auto_update()` — JE branch documented no-op (audit
    trail preservation would require QBO Line.Ids we don't
    carry locally).
  - `_run_auto_delete()` — JE uses `?operation=delete`.
- `qbo_mirror/engine.py`:
  - JE normalizers (`_norm_je_local` / `_norm_je_qbo`).
  - qbo_id-only matching, no field drift for MVP.
  - JE included in dry-run entity loop.
- `qbo_mirror/settings.py` — `journal_entries: True` in defaults.
- `routes/journal.py` — `create_je` fires `try_auto_push`;
  `delete_je` captures qbo_id and fires `try_auto_delete`.

**Frontend**
- `pages/QboMirror.jsx` — "Journal Entries" row added to
  ENTITIES + push/pull whitelists.

**Deliberately deferred**
- JE UPDATE mirroring (audit-trail preservation needs QBO
  per-line Ids). UX: delete + recreate.
- Deposits/Transfers push (no in-app authoring surface yet).
- Deposits/Transfers pull-via-mirror (existing migration path
  already covers this).

**Regression coverage**
- `tests/test_qbo_mirror_je_push.py` — 8 unit tests: happy path,
  same-line rejects, unbalanced, unmapped account, empty, doc
  truncation, twin patch, account_name fallback.
- All 4 mirror test files: **28/28 pass**.


## 2026-08-10 — Phase 3: Estimates + Purchase Orders

**New doc types, mirror-native from day one.** Estimates (sales
quotes) and Purchase Orders (vendor commitments) are the two
pre-transactional docs pros use throughout the sales/procurement
cycle. Both auto-push to QBO on save/delete, pull down cleanly
from QBO, and offer one-click convert to their transactional
sibling.

**Backend**
- `models.py`: `EstimateCreate`, `PurchaseOrderCreate`.
- `routes/estimates_pos.py` (new file): full CRUD for both plus
  convert endpoints:
  - `POST /companies/{cid}/estimates/{eid}/convert` → creates a
    new Invoice with copied lines/contact, back-links the source
    estimate (`source_estimate_id`, `converted_invoice_id`), flips
    Estimate status to `converted`, fires invoice autopush.
  - `POST /companies/{cid}/purchase-orders/{pid}/convert` → same
    for PO → Bill.
- `qbo_mirror/push.py`: `_estimate_body`, `_po_body`,
  `_local_patch_from_qbo_estimate`, `_local_patch_from_qbo_po`,
  `_push_estimates`, `_push_purchase_orders`. Status vocab maps:
  Estimate `sent/draft → Pending`, `accepted → Accepted`,
  `rejected → Rejected`, `closed/converted → Closed`. PO
  `open → Open`, `closed/converted → Closed`.
- `qbo_mirror/pull.py`: `_pull_estimates`, `_pull_purchase_orders`
  with contact_id + line account_id / item_qbo_id resolution.
- `qbo_mirror/autopush.py`: `_push_one_estimate`, `_push_one_po`,
  registered in `_ENTITY_META`, `_HANDLERS`, `_ENTITY_TO_CFG_KEY`.
  Full-replace update path, hard-delete via `?operation=delete`.
- `qbo_mirror/engine.py`: 4 new normalizers, drift fields
  (number/date/total/status — no balance since pre-transactional).
- `qbo_mirror/settings.py`: `estimates: True`, `purchase_orders: True`.

**Frontend**
- `pages/Estimates.jsx` (~260 LOC): list + inline create dialog
  + one-click convert-to-invoice + delete.
- `pages/PurchaseOrders.jsx` (~250 LOC): same pattern for
  vendor side.
- `App.js`: routes wired at `/estimates` and `/purchase-orders`.
- `components/Sidebar.jsx`: "Estimates" under Sales, "Purchase
  Orders" under Purchases.
- `pages/QboMirror.jsx`: new entity rows, whitelists extended.

**Deliberately deferred**
- Full editor page (multi-line grid + PDF preview + attachments) —
  the create dialog handles the single-line MVP case. Users
  needing complex quotes can convert-to-invoice and finish there.
- Reverse-linking on invoice/bill delete → convert flag
  (deleting a converted invoice doesn't reopen the estimate).

**Regression coverage**
- `tests/test_qbo_mirror_estimate_po_push.py` — 7 unit tests
  covering happy path, status mapping (both), missing refs, twin
  patches for both entities.
- All 5 mirror test files: **35/35 pass**.
