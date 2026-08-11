# SmartBooks — Changelog

## 2026-02-21 (bugfix) — Inventory Migration Wire-Up

### 🐛 Root cause
User reported "Inventory doesn't show up after migration." Two coordinating bugs:

**Bug 1** — `_UPDATE_FIELDS["items"]` in `qbo_mirror/pull.py` only refreshed `["name","sku","price","active"]`. Every inventory-relevant field (`cost`, `qty_on_hand`, `track_qty_on_hand`, `asset_account_qbo_id`, `item_type`, etc.) was silently dropped on updates. Companies migrated before the Feb 21 inventory-fields patch couldn't heal by re-running Pull.

**Bug 2** — `map_item` stored QBO's account refs as QBO ID strings (`asset_account_qbo_id`, `expense_account_qbo_id`) but the local inventory system (`inventory_service.py`, `InventoryPage`) filters on:
- **`track_inventory`** — the internal app boolean flag (distinct from QBO's `TrackQtyOnHand`)
- **`inventory_account_id`** — the LOCAL account row id (not the QBO id)
- **`cogs_account_id`** / **`expense_account_id`** / **`income_account_id`** — same story

Result: even for real QBO Inventory-type items, the Inventory Management page showed "0 tracked items."

### ✅ Fix
`_pull_items` in `qbo_mirror/pull.py` now:
1. Expands `_UPDATE_FIELDS["items"]` to include every inventory field so re-pulls heal legacy rows.
2. Resolves `AssetAccountRef` → local account by `qbo_id` and stamps `inventory_account_id` + `inventory_account_name`.
3. Same for `ExpenseAccountRef` (→ `cogs_account_id` + `expense_account_id`) and `IncomeAccountRef` (→ `income_account_id`).
4. Flips `track_inventory=True` when item is `Type=Inventory` or `TrackQtyOnHand=True`.
5. On existing rows, patches all resolved local IDs + flags too (not just the `_UPDATE_FIELDS` set) so legacy items catch up cleanly.

### 🔁 User remediation
Existing production companies just need to re-run mirror pull for items:
```
POST /api/companies/{cid}/qbo/mirror/pull  Body: {"entities": ["items"]}
```
The next call auto-heals every item row — no full migration re-run needed.

### ✅ Test coverage
`backend/tests/test_qbo_items_pull_resolution.py` — 4 tests:
- New Inventory-typed item resolves all 4 local IDs + flips `track_inventory=True`
- Service-typed item leaves `track_inventory=False` (no clutter on Inventory page)
- Re-pull of a legacy pre-patch row heals it (proves `_UPDATE_FIELDS` fix works)
- Guard rail asserting `_UPDATE_FIELDS["items"]` includes every inventory field

All 248 backend tests green.

### Files touched
- `backend/qbo_mirror/pull.py::_pull_items` — full account resolution + `track_inventory` flip; `_UPDATE_FIELDS["items"]` expanded.
- `backend/tests/test_qbo_items_pull_resolution.py` (new, 4 tests).

## 2026-02-21 (later) — InventoryAdjustment Mirror Push (Bi-Directional Loop Closed)

### 🔁 Outbound push for locally-created inventory adjustments
- **New body builder** `push._inventory_adjustment_body`:
  - Resolves the contra account (`Inventory Adjustments`) to its QBO id — raises `ValueError` if the account isn't mirrored yet, so the push worker surfaces a friendly `failed` row.
  - Maps every line to QBO's `ItemAdjustmentLineDetail` shape with `QtyDiff` + `ItemRef`; silently skips lines whose item isn't mirrored (surfaces as truncated line count), raises if *every* line is unsynced.
  - Truncates `DocNumber` to QBO's 21-char cap.
  - Passes `TxnDate`, `PrivateNote` when present.
- **Twin patch** `_local_patch_from_qbo_inventory_adjustment` — mirrors QBO's authoritative echo (`DocNumber`, `TxnDate`) back onto the local JE.
- **New push worker** `_push_inventory_adjustments`: scans `journal_entries` for `source=adjustment` docs without `qbo_id` and posts them via `POST /company/{realm}/inventoryadjustment`.
- **Autopush wiring**: added `inventory_adjustment` to `_ENTITY_META` (path=`inventoryadjustment`, coll=`journal_entries`), and `_push_one_inventory_adjustment` to the dispatch table. Fires from `inventory_service.apply_adjustment` immediately after the JE is inserted — CPA sees round-trip within seconds.
- **Enriched local JE metadata**: `apply_adjustment` now stores `contra_account_id`, `inventory_account_id`, and `inventory_adjustment_lines[]` (with item_id + item_qbo_id + qty_diff + cost) on the JE doc so the push builder has everything it needs without a second query round-trip.

### ✅ Test coverage
`backend/tests/test_qbo_inv_adj_push.py` — 12 tests:
- Body writedown/writeup/multiline shape all correct
- Body silently skips items not yet synced to QBO
- Body raises when contra account isn't synced (fail loud, don't post garbage)
- Body raises when every line's item is unsynced
- Body raises when every line has QtyDiff=0
- DocNumber truncated to QBO's 21-char limit
- Twin patch reflects QBO's authoritative DocNumber + TxnDate; safely omits missing fields
- `inventory_adjustment` registered in `_ENTITY_META` with correct path/key/coll
- Push module exposes `_push_inventory_adjustments`, `_inventory_adjustment_body`, `_local_patch_from_qbo_inventory_adjustment`

All 216 backend tests still green across the QBO/mirror/PFC/bank-match/accounting-mode/editor suites.

### Files touched
- `backend/qbo_mirror/push.py` — new body builder + twin patch + `_push_inventory_adjustments` worker + registered in `run_push` entity list.
- `backend/qbo_mirror/autopush.py` — imports body/patch helpers, added `_push_one_inventory_adjustment`, registered in `_ENTITY_META` + dispatch table.
- `backend/inventory_service.py::apply_adjustment` — enriches the JE with mirror-consumable metadata + fires `try_auto_push('inventory_adjustment', je_id)` after insert.
- `backend/tests/test_qbo_inv_adj_push.py` (new, 12 tests).

## 2026-02-21 — InventoryAdjustment History Migration

### 🗂️ Full audit trail migration for inventory adjustments
QBO's `InventoryAdjustment` entity carries the *history* of every write-up / writedown / count correction. Previously we only migrated the current on-hand snapshot; the trail was gone. Now:

- **New mapper** `qbo_service.map_inventory_adjustment` extracts DocNumber, TxnDate, PrivateNote, AdjustAccountRef, and every Line's QtyDiff + ItemRef into a `qbo_inv_adj`-sourced doc shape.
- **New pull step** `_pull_inventory_adjustments` in `qbo_mirror/pull.py`:
  - Loads `1300 Inventory Asset` once, resolves the contra account (AdjustAccountRef → local qbo-mirrored account).
  - Prices each line at the local item's `cost` field (already migrated in the Items pull).
  - Builds a **balanced two-legged JE**: positive net → Dr Inventory Asset / Cr contra; negative net → reverse.
  - Skips zero-cost items and $0 net adjustments (no ledger clutter).
  - Stamps `posted=True`, `human_reviewed=True`, `_sync_origin=mirror_pull`, `source=qbo_inv_adj`.
- **Registered in `run_pull`** and the migration finisher — the initial migration now pulls Estimates + POs + InventoryAdjustments in one shot.
- **DuplicateKey resilience** — race-condition inserts fall through to `update_one` instead of surfacing to the user.
- **Idempotent re-pulls** — same QBO id updates the existing JE rather than stacking a second one.

### 🖼️ Migration Completion Banner — new tile
Expanded to 6 columns; added **Inv adjustments** counter (`data-testid="qbo-stat-inv-adjustments"`) with a tooltip explaining the value proposition.

### ✅ Test coverage
`backend/tests/test_qbo_inventory_adjustments.py` — 7 tests:
- Mapper shape (DocNumber, TxnDate, AdjustAccountRef, Line[])
- Writedown (negative net) posts Cr 1300 / Dr contra
- Writeup (positive net) posts Dr 1300 / Cr contra
- Zero-cost items are skipped (no $0 legs)
- Missing 1300 returns `{error: ...}` gracefully (doesn't crash)
- Re-pull is idempotent (`update_one` fallback)
- Multi-line adjustment netting to $0 skipped (no clutter)

All 232 backend tests green (was 197, +7 new + 28 in other suites).

### Files touched
- `backend/qbo_service.py` — new `map_inventory_adjustment`, wired `inventory_adjustments` into the migration mirror pull.
- `backend/qbo_mirror/pull.py` — new `_pull_inventory_adjustments`, registered in `_ENTITIES` + `run_pull`.
- `backend/tests/test_qbo_inventory_adjustments.py` (new, 7 tests).
- `frontend/src/pages/QboConnect.jsx` — 6-column banner grid + Inv adjustments tile.

## 2026-02-20 (very late) — Inventory Migration (Phase 5)

### 📦 Extended `Item` pull (`qbo_service.map_item`)
Beyond the existing name/price/cost/sku fields, we now capture every inventory-relevant field QBO exposes:
- `qty_on_hand` — current on-hand quantity per item
- `track_qty_on_hand` — the QBO flag distinguishing "Inventory" items from Service/NonInventory
- `cost` — unit cost basis (already captured; used for COGS math)
- `asset_account_qbo_id` — the `1300 Inventory Asset` account the item posts to
- `income_account_qbo_id` / `expense_account_qbo_id` — sales + COGS accounts
- `inv_start_date` — when QBO began inventory tracking for this item
- `reorder_point` — reorder threshold

Service items still pass through the same mapper harmlessly (all inventory fields default to `0` / `None` / `False`).

### 💰 Opening Inventory JE (`qbo_service._post_opening_inventory_je`)
After the migration finishes pulling accounts + items, we now post a single balanced JE that seeds the local `1300 Inventory Asset` account with the QBO-reported opening value.
- **Debit**: `1300 Inventory Asset · SUM(qty × cost)` across every inventory item with `qty > 0` AND `cost > 0`.
- **Credit**: `3900 Opening Balance Equity` (auto-falls back to the transfer clearing equity account if 3900 isn't seeded).
- Skips zero-qty or zero-cost items to avoid $0 clutter lines.
- **Idempotent** — deterministic JE id `qbo-opening-inv-<cid>` upserts on re-migration instead of stacking a second one.
- Fires only when there's real inventory value to post; service-only companies short-circuit before any equity account lookup runs.

### 📋 Preview scope now includes `InventoryAdjustment`
Bumped `PREVIEW_ENTITIES` from 16 to 17 types. The migration preview tile grid now shows a count of QBO Inventory Adjustments so CPAs know upfront how much inventory-history is (and isn't) being pulled — currently we only pull the count as diagnostic; adjustment ingestion itself is a future task.

### 🎨 Migration Completion Banner — new tile
Bumped the banner grid to 5 columns and added an **Opening inventory** tile showing the total dollar value posted to `1300` during migration. `data-testid="qbo-stat-opening-inventory"`.

### ✅ Test coverage
- `backend/tests/test_qbo_inventory_migration.py` — 8 tests: mapper captures inventory fields for Inventory items and safely defaults for Service items; opening JE posts a balanced debit/credit with correct 1300 / 3900 accounts; zero-qty and zero-cost items are skipped; JE is idempotent on re-run; empty-inventory + missing-1300 short-circuit paths return 0.0 without crashing; `InventoryAdjustment` is in `PREVIEW_ENTITIES`.
- 197 backend tests all green (was 189, added 8).

### What's still ahead
- **`InventoryAdjustment` pull** — bring adjustment history in as journal entries so the audit trail is preserved.
- **`InventoryAdjustment` mirror push** — so Advanced-mode users can adjust stock here and have it flow to QBO.
- **Class / Department / Location** entities — critical for the upcoming Restaurant Vertical.
- **TaxAgency / TaxRate / TaxCode** — sales-tax setup migration.
- **Terms / PaymentMethod / RecurringTransaction** — the "boring but important" QBO admin objects.

### Files touched
- `backend/qbo_service.py` — extended `map_item`, added `_post_opening_inventory_je`, wired the JE step into `run_migration`, added `InventoryAdjustment` to `PREVIEW_ENTITIES`, stored `opening_inventory_value` on the completed job doc.
- `backend/tests/test_qbo_inventory_migration.py` (new, 8 tests).
- `frontend/src/pages/QboConnect.jsx` — 5-column banner grid + Opening inventory tile.

## 2026-02-20 (midnight) — Match Indicators Everywhere

### 🎯 Consistent match visual language across the app
- **Shared component**: extracted `deriveMatchStatus` + `MatchDot` into `/app/frontend/src/components/MatchDot.jsx`. Two render modes: `full` (icon + label, for dedicated lists) and `compact` (icon-only, for dense rows). Single source of truth for reconciliation state — a tone tweak now ripples everywhere.
- **`TxnTypeListPage.jsx`**: refactored to import the shared component (deleted its local copy).

### 🏷️ Chip strip pending-review badges on `/transactions`
- Each entity chip (Expenses, Sales Receipts, Deposits, Credit Memos, Refund Receipts, Transfers) now shows a small amber counter badge when silent-matched pairs of that type are awaiting the CPA's review.
- Badge lives inside the chip button, tabular-nums-aligned so a `12` and a `1` look tidy side-by-side. Different tone on active chips (semi-transparent amber against the dark background) vs inactive (soft amber).
- Counts fetched once from `GET /bank-matches?status=unconfirmed` and grouped client-side by `editor.txn_type` — no new backend endpoint needed. Advanced-mode only.

### 🚦 Match dot on individual transaction rows
- The **Merchant / Description** cell on the main Transactions ledger now shows a compact `MatchDot` (icon-only, tooltip on hover) whenever the row carries an editor-authored `txn_type` (Purchase, SalesReceipt, Deposit, CreditMemo, RefundReceipt).
- Regular Plaid rows stay untouched — no visual clutter for the 90% case.
- Reuses the exact same 4 tones as the Sales Receipts list (Reconciled / Matched pending / Manually unlinked / Awaiting bank feed).

### ✅ Testing
- 189 backend tests still green.
- Screenshot verified: Sales Receipts chip shows amber "2" badge, Expenses chip shows amber "1" badge (matches the 3 seeded pending pairs); every seeded SalesReceipt row displays the amber clock indicator inline; unmatched pre-existing SalesReceipt row shows the outline "awaiting bank feed" state.

### Files touched
- `frontend/src/components/MatchDot.jsx` (new — shared component).
- `frontend/src/pages/TxnTypeListPage.jsx` — replaced local `deriveMatchStatus` + `MatchDot` with the shared import.
- `frontend/src/pages/Transactions.jsx` — imported `MatchDot`, added compact indicator in the description cell, added `pendingByType` state + one-shot fetch + badges on entity chip strip.

## 2026-02-20 (late night) — Match Indicators + Bulk Match Actions

### 🚦 Match indicators on `/sales-receipts`
- New **Bank match** column showing each row's reconciliation state at a glance:
  - Green solid ✓ · **Reconciled** — CPA confirmed the pair
  - Amber solid ✓ · **Matched · pending review** — silent matcher paired it, awaiting confirmation
  - Slate slash icon · **Manually unlinked** — CPA broke a prior match (tombstoned)
  - Amber outline ⏳ · **Awaiting bank feed** — no bank row seen yet
- Icons carry the label inline on md+ screens; mobile shows icon-only with tooltip. Every dot has a `data-testid="match-dot-{key}"` for automation.
- **Credit Memos intentionally skipped** — they're A/R adjustments with no cash leg, so a bank match will never exist. Toggle via new `showMatchStatus` prop on `TxnTypeListPage`.

### ⚡ Bulk match actions on Bank Match Review
- New action bar above the pair cards: **"Reviewing a big batch? Act on all N pairs at once."** with:
  - **Confirm all** (emerald) — hidden on the Confirmed tab where it'd be a no-op
  - **Unlink all** (rose) — always visible, requires a `window.confirm` guard
- Frontend passes the exact list of currently-visible bank ids in the request body — deterministic, no filter-based race between UI state and DB state.

### 🔌 New backend endpoints
- `POST /api/companies/{cid}/bank-matches/bulk-confirm` — body `{"bank_ids": [...]}`, returns `{ok, confirmed}` count. Uses `update_many` on both sides (1 round-trip per side, not N).
- `POST /api/companies/{cid}/bank-matches/bulk-unlink` — same shape, tombstones both sides with `match_unlinked_at`.
- Both endpoints defensively filter non-string ids so a client bug can't confuse the Mongo `$in` operator.

### ✅ Test coverage
- `backend/tests/test_bank_match_bulk.py` — 7 tests: happy-path confirm/unlink of 2 pairs, empty list is a no-op, stale/unmatched ids are silently ignored, non-string ids are filtered, unrelated pairs (unmatched control row + already-confirmed Pair C) are left untouched by an unrelated bulk-unlink.
- 189 backend tests green across the full accounting stack (bank_match + review + bulk + accounting_mode + editor + txn_type + QBO mirror + PFC).
- Screenshots verified: Sales Receipts list shows the amber clock "Awaiting bank feed" dot for an unmatched row; Bank Match Review with 3 seeded pairs surfaces the bulk bar with "Act on all 3 pairs at once" and both bulk buttons.

### Files touched
- `backend/routes/transactions.py` — 2 new bulk endpoints at file bottom.
- `backend/tests/test_bank_match_bulk.py` (new, 7 tests).
- `frontend/src/pages/TxnTypeListPage.jsx` — `deriveMatchStatus` helper + `MatchDot` component + `showMatchStatus` prop + new column.
- `frontend/src/pages/SalesReceipts.jsx` — `showMatchStatus={true}`.
- `frontend/src/pages/BankMatchReview.jsx` — bulk bar with Confirm all / Unlink all + `bulkBusy` state guard.

## 2026-02-20 (evening) — Bank Match Review Screen (Trust Loop)

### 🔍 New page: Bank Match Review
- **Route**: `/accounting/bank-matches` (Advanced-mode-only via `<AdvancedModeRoute>`)
- **What it shows**: every silent-matched bank ↔ editor pair from `bank_match.auto_match_bank_feed` — side-by-side card layout with bank row on the left, editor row on the right, matched-at timestamp in the header strip.
- **Actions per pair**: **Confirm** (locks it in — hidden from the default "Awaiting review" queue) or **Unlink** (breaks the pair, editor row reappears in the ledger, both sides tombstoned so the matcher won't re-pair them).
- **Filter chips**: Awaiting review (default) · Confirmed · All. Live totals at top-right ("N pairs · $X total").
- **Sidebar**: new "Bank Match Review" entry under Accounting group (advancedOnly, hidden in Simple mode).

### 🔌 New backend endpoints (`routes/transactions.py`)
- `GET /api/companies/{cid}/bank-matches?status=unconfirmed|confirmed|all` — one round-trip pair fetch (both sides hydrated), sorted by `matched_at` desc, capped at 500.
- `POST /api/companies/{cid}/bank-matches/{bank_id}/confirm` — stamps `match_confirmed=True` + timestamp on both rows.
- `POST /api/companies/{cid}/bank-matches/{bank_id}/unlink` — `$unset` every match pointer on both sides + `$set` a `match_unlinked_at` tombstone. Silent matcher now respects the tombstone via a `match_unlinked_at: {$exists: False}` guard in `bank_match.py` so re-syncs don't undo the CPA's decision.

### ✅ Test coverage
- `backend/tests/test_bank_match_review.py` — 10 tests: default status returns unconfirmed only, confirmed filter, all filter, both-sides hydration, confirmed flag reflected, confirm stamps both sides, confirm 404 for non-matched row, unlink wipes all 4 fields + tombstones both sides, unlink 404 for missing pair, unlink-then-confirm 404s (proves severance was structural not cosmetic).
- 137 backend tests green (bank_match + review + accounting_mode + editor + txn_type + QBO mirror + pfc).
- Screenshots verified end-to-end: empty state renders per-filter copy, seeded pair renders with confirm/unlink buttons, side-by-side comparison shows both amounts + dates + descriptions.

### Files touched
- `backend/routes/transactions.py` — 3 new endpoints (list / confirm / unlink) at file bottom.
- `backend/bank_match.py` — matcher now respects `match_unlinked_at` tombstone on both sides.
- `backend/tests/test_bank_match_review.py` (new, 10 tests).
- `frontend/src/pages/BankMatchReview.jsx` (new, ~280 lines).
- `frontend/src/components/Sidebar.jsx` — new advancedOnly entry under Accounting.
- `frontend/src/App.js` — new guarded route.

## 2026-02-20 (later still) — Accounting Mode Toggle + Silent Bank Matcher

### 🎚️ Two-tier UX: Simple / Advanced accounting mode
- **New company setting**: `accounting_mode` on `companies` collection (default: `"simple"`). Validated as enum `{"simple","advanced"}` on PATCH.
- **Simple mode** (default for regular business owners):
  - Sidebar hides "Sales Receipts" and "Credit Memos" entries (tagged `advancedOnly` in the group config).
  - Entity chip strip on `/transactions` is hidden entirely.
  - The "New transaction" dropdown reverts to a single "Manual Transaction" button (no QBO-shaped editors surfaced).
  - Backdoor URLs (`/purchases/new`, `/sales-receipts`, `/credit-memos`, `/deposits/new`, `/refund-receipts/new`) redirect to `/accounting/transactions` via the new `<AdvancedModeRoute>` guard.
- **Advanced mode** (opt-in for CPAs / bookkeepers): full QBO parity restored — chip strip, dedicated ledger lists, QBO-shaped editors all visible.
- **Company Settings page**: added a two-tile radio card with plain-English explanations of each mode. Priya (CPA) can flip per-client from the Settings page.
- **`useCompany` context**: now exposes `accountingMode` and `isAdvancedMode` so any component can conditionally render without a fetch.

### 🤝 Silent bank-feed ↔ editor-authored matcher (`bank_match.py`)
- New module fires as a **fire-and-forget task** after every Plaid `insert_many` — never slows down the Plaid hot path.
- **Strict pairing rules**: same bank + absolute amount + date within ±3 days + sign agreement + neither side pre-matched + editor row has `txn_type` in {Purchase, SalesReceipt, Deposit, CreditMemo, RefundReceipt}. No LLM. Deterministic.
- **What it prevents**: the double-count bug where a CPA-authored Sales Receipt + Plaid deposit for the same money movement inflated cash on the Balance Sheet.
- **Match anchor**: bank row's `id` (the actual money movement is on the bank side). Both sides get `matched_bank_txn_id`. Editor row also gets `hidden_by_match=true`.
- **Default `list_transactions` view** now filters out `hidden_by_match=true` rows so the ledger stays clean. Callers can opt back in with `include_matched=true` (SalesReceipts/CreditMemos lists + Transactions chip strip already do this so entity-typed views still show every row).

### ✅ Test coverage
- `backend/tests/test_bank_match.py` — 10 tests: happy paths (Purchase, SalesReceipt), all 5 rejection reasons (different bank/amount/window/sign, pre-matched on either side), empty-batch shortcut, batch of 2 pairing simultaneously.
- `backend/tests/test_accounting_mode.py` — 4 tests: mode accepted for both values, invalid value rejected 400, other-field PATCH preserves existing mode.
- 127 QBO-mirror + editor + PFC + accounting-mode + bank-match tests all pass.
- Screenshots verified end-to-end: flipping `accounting_mode` between simple/advanced via PATCH correctly hides/shows sidebar items, chip strip, and dropdown menu.

### Files touched
- `backend/models.py` — no changes needed (patch dict was open-shape).
- `backend/routes/companies.py` — allowed `accounting_mode` in PATCH, enum-validated, default `"simple"` on create.
- `backend/routes/transactions.py::list_transactions` — added `include_matched` query param + default filter on `hidden_by_match`.
- `backend/plaid_connect.py` — fires `auto_match_bank_feed` as a background task after `insert_many`.
- `backend/bank_match.py` (new) — the silent matcher.
- `backend/tests/test_bank_match.py`, `test_accounting_mode.py` (new).
- `frontend/src/lib/company.jsx` — exposes `accountingMode` and `isAdvancedMode`.
- `frontend/src/components/Sidebar.jsx` — filters items via `advancedOnly` tag.
- `frontend/src/components/AdvancedModeRoute.jsx` (new) — route guard.
- `frontend/src/pages/Transactions.jsx` — chip strip & NewTransactionMenu gated on `isAdvancedMode`; include_matched wired for txn_type slice.
- `frontend/src/pages/TxnTypeListPage.jsx` — passes `include_matched=true`.
- `frontend/src/pages/CompanySettings.jsx` — mode radio card.
- `frontend/src/App.js` — wraps editor + list routes in `<AdvancedModeRoute>`.

## 2026-02-20 (later) — Dedicated Ledger Views: Sales Receipts, Credit Memos, Entity-Type Chip Strip

### 📋 Two new list pages
- **`/sales-receipts`** — dedicated Sales Receipts ledger with search, running totals ("N shown · $X total"), QBO sync indicator dot per row, edit/delete actions.
- **`/credit-memos`** — dedicated Credit Memos ledger with an extra "Applies to" column showing whether the CM is linked to an invoice.
- Both pages share `TxnTypeListPage.jsx` (config-driven internal component) so future entity-typed lists stay consistent.
- Sidebar updated: both entries added under "Sales & Payments" group alongside Estimates and Invoices.

### 🎛️ Entity-type chip strip on `/transactions`
- Added an orthogonal filter chip strip above the existing status tabs: `All types · Expenses · Sales Receipts · Deposits · Credit Memos · Refund Receipts · Transfers`.
- Wired to a new `txn_type` query param on `GET /api/companies/{cid}/transactions` (backend). CPA can now slice the ledger by QBO entity type without leaving the page.
- All 7 chips carry `data-testid="txn-type-chip-{k}"` for automation.

### ✅ Test coverage
- `backend/tests/test_txn_type_filter.py` — 8 unit tests verifying the new `txn_type` query param correctly narrows the Mongo query (including a parametrized test across all 6 editor entity types + Transfer).
- 165 backend tests still green.
- Verified end-to-end via screenshots: Sales Receipts list renders with 1 row ($250 total), Credit Memos list renders with linked-invoice indicator, chip strip on /transactions shows all 7 chips with correct active state.

### Files touched
- `backend/routes/transactions.py::list_transactions` (+txn_type query param)
- `backend/tests/test_txn_type_filter.py` (new, 8 tests)
- `frontend/src/pages/TxnTypeListPage.jsx` (new, shared list component)
- `frontend/src/pages/SalesReceipts.jsx` / `CreditMemos.jsx` (new, thin config wrappers)
- `frontend/src/pages/Transactions.jsx` (chip strip + txn_type filter state + query wiring)
- `frontend/src/components/Sidebar.jsx` (+2 sales items)
- `frontend/src/App.js` (2 new routes)

## 2026-02-20 — Full-Page Editors for Purchase / Sales Receipt / Deposit / Credit Memo / Refund Receipt

### 🧾 Five new full-page editors (parity with Invoice/Bill editors)
- `/purchases/new` + `/:id/edit`  → **Expense** (Purchase)
- `/sales-receipts/new` + `/:id/edit`  → **Sales Receipt**
- `/deposits/new` + `/:id/edit`  → **Bank Deposit**
- `/credit-memos/new` + `/:id/edit`  → **Credit Memo**
- `/refund-receipts/new` + `/:id/edit`  → **Refund Receipt**
- One shared config-driven `TransactionEditor.jsx` component + 5 thin wrappers — keeps every editor in lockstep (a UX fix ripples to all 5 at once).
- Header fields per entity: contact combobox (customer/vendor/none per type), bank picker (deposit-to / paid-from / hidden for CreditMemo), payment method, doc number, date. Line items with description + category picker + amount. Memo/notes. Attachments.
- Launcher: replaced the "Manual Transaction" button on `/transactions` with a **New transaction** dropdown that surfaces Quick manual entry + all 5 QBO-shaped editors, each with a descriptive subtitle and `data-testid`.

### 🔌 Backend wiring
- **NEW endpoint**: `GET /api/companies/{cid}/transactions/{tid}` — single-transaction fetch used by editors to hydrate edit mode. Registered at bottom of `transactions.py` so literal routes (`/transfer-pairs`, `/split-suggestion`, `/cleanup-suggestions`) still match first.
- Extended `TransactionCreate` model with editor-only fields: `txn_type`, `line_items`, `number`, `memo`, `notes`, `payment_type`, `linked_invoice_id`, `transfer_to_account_id`.
- Editor-branch in `create_transaction`: when `txn_type` ∈ {Purchase, SalesReceipt, Deposit, CreditMemo, RefundReceipt, Transfer}, the qualifier is bypassed and the doc is stamped directly with `posted=True`, `human_reviewed=True`.
- **Sign convention**: outflow types (Purchase, RefundReceipt) are stored negative; inflow types (SalesReceipt, Deposit, CreditMemo) positive. Backend flips the sign — editors always send positive numbers.
- **CreditMemo bank guard**: server clears `bank_account_id` on CreditMemo docs even if the editor sends one (A/R adjustment doesn't hit cash).
- **Autopush**: `_maybe_autopush_purchase` now short-circuits on explicit `txn_type` and fires the entity-specific autopush directly (Purchase → 'purchase', CreditMemo → 'credit_memo', etc.) — skips double-stamping.

### ✅ Test coverage
- `backend/tests/test_editor_txn_flow.py` (7 unit tests) — sign flip per type, CreditMemo bank clear, qualifier fallback, unknown-type ignore.
- `backend/tests/test_editor_endpoints_live.py` (10 live-HTTP tests, added by testing agent) — full round-trip against deployed backend using `pro@axiom.ai` credentials. All 10 pass.
- Regressions: 164 pytest tests still green (QBO mirror + PFC + editor suites).
- Testing agent verdict: **no critical or minor backend/UI issues**. Frontend Save round-trip couldn't be fully driven by Playwright because ContactCombobox/SearchableAccountPicker don't expose `role=option` — noted as optional future work.

### Files touched
- `backend/models.py` (TransactionCreate — 8 new optional fields)
- `backend/routes/transactions.py` (editor branch in POST, autopush short-circuit, new GET at file end)
- `backend/tests/test_editor_txn_flow.py` (new, 7 tests)
- `backend/tests/test_editor_endpoints_live.py` (new, 10 tests by testing agent)
- `frontend/src/pages/TransactionEditor.jsx` (new, ~550 lines, config-driven shared editor)
- `frontend/src/pages/PurchaseEditor.jsx` / `SalesReceiptEditor.jsx` / `DepositEditor.jsx` / `CreditMemoEditor.jsx` / `RefundReceiptEditor.jsx` (new, thin wrappers)
- `frontend/src/pages/Transactions.jsx` (NewTransactionMenu dropdown)
- `frontend/src/App.js` (10 new routes)

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
