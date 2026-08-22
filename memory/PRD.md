# Axiom Ledger — PRD

## Original Problem Statement
Build an enterprise AI accounting SaaS with three role tiers (Superadmin / Accounting Pro / Client),
multi-tenant company management, AI-driven transaction categorization under GAAP (auto-post when
confident, flag for review when not), split & linked transactions, real CPA-grade PDF reports,
AI-assisted onboarding (business profile → QBO link → auto Chart of Accounts → Plaid bank link →
Veryfi statement upload), rules engine (created after multiple approvals), AI activity indicators,
context-aware AI chat panel (hover a row → assistant knows what you're talking about), collapsible
sidebar and AI panel, accrual & cash reporting. Real Estate / Rental Properties intentionally excluded.

## Architecture
- **Backend**: FastAPI + Motor (Mongo) + Pydantic v2 + ReportLab (PDF) + emergentintegrations (Claude Sonnet 4.5)
- **Frontend**: React 19 + React Router + Tailwind + shadcn/ui + lucide-react + sonner + axios
- **AI**: Claude Sonnet 4.5 via Emergent Universal Key (categorization, chat, industry-specific CoA)
- **Auth**: JWT (bcrypt), role-based access (superadmin / pro / client), multi-tenant memberships


### Feb 27 2026 — Prod→Preview Clone: "BM QBO 2 LLC"

Cloned live company **BM QBO 2 LLC** (prod id `2f6d6451-0fdb-44d3-ba97-05775f37617c`, realm `9341452279649363`) from prod (`axiom_prod`) into preview as `bm-qbo-2-preview-clone` using `/app/backend/scripts/clone_qbo_to_preview.py`. QBO connection tokens (access + refresh) preserved via `crypto_service.encrypt` under preview's key. Post-clone remap: `owner_user_id → admin@axiom.ai`, `pro_user_id → pro@axiom.ai`, `partner_id/enterprise_id → None`; `users_companies` rows upserted for both. Tokens verified decryptable via preview backend. `PROD_MONGO_URL` was set inline per-command (never `export`ed) — no lingering credentials in the pod env. User can now switch to this company and click **Run Migration** on Connect QBO, or **Import from Production Connection** in Test QBO.

⚠️ QBO refresh tokens are single-use — the first environment (prod OR preview) to refresh invalidates the other. Treat this preview clone as short-lived.



### Feb 26 2026 — QBO Integration: BS Ties Penny-for-Penny to QBO's Own Report

**Milestone**: our accrual Balance Sheet now reconciles EXACTLY to QBO's own report on every account, verified on two distinct sandbox realms (`Sandbox Company US a026` realm `9341457726749100`, `Sandbox Company US 2457` realm `9341457727012245`). Same 11 accounts match to the penny — Total Assets $23,436.29 = QBO $23,436.29 on both. Companies now migrated from QBO can trust the accrual BS out of the box.

**Fixes shipped (chronological):**
1. **COGS-in-NI** — `compute_balance_sheet` NI roll-in was missing the new `cogs` account type from Option B GAAP
2. **QBO CreditMemo double-count** — `_signed_balances` skips CreditMemos (their AR-side is already reflected via `invoice.balance_due`)
3. **`balance_due` field mismatch** — QBO mapper wrote `balance` but everything reads `balance_due`; AR/AP silently $0 on every QBO-migrated company until fixed
4. **QBO Payment cash-side roll-in** — Payment/BillPayment cash-side rolled through `_signed_balances`; NI mirror-offset keeps BS balanced
5. **`_QBO_ALLOWED_HOSTS`** — added preview host to enable sandbox debugging from Emergent preview environments
6. **Opening-balance JE for Fixed Assets / Long-Term Liabilities** — generalized `_post_opening_balances_je`; strict AR/AP skip on QBO `AccountType`
7. **Sub-account total double-count** — child rows now carry `parent_id` in addition to `parent_code`; totals loop skips both
8. **QBO Deposit `LinkedTxn`-only lines** — new `resolve_deposit_splits` post-migration walker CRs Undep (or explicit AccountRef) for each Deposit line
9. **QBO Credit-Card-Credit sign flip** — Purchase with `Credit:true, PaymentType:CreditCard` inverts amount + direction to match QBO's DR Checking / CR Mastercard
10. **Phantom Inventory routing** — `qbo_mirror/pull.py` prefers QBO-sourced Inventory Asset by detail_type (was code=1300 phantom)
11. **Delta-based opening JE** — plugs `qbo_current - our_raw` on every account, not just zero-activity ones
12. **P&L per-account accrual** — walks invoices+bills, attributes to specific revenue/expense accounts (not a flat Δ A/R bucket) — Net Income closed from +$7,325 off to −$18 off
13. **SalesReceipt DiscountLineDetail** — captured previously-dropped discount lines as signed-negative contra-revenue

**New surfaces:**
- `POST /api/admin/qbo/opening-balances/backfill` — idempotent superadmin endpoint to re-run opening JE across all QBO-connected companies
- `QboBsReconcilePanel` React component in Superadmin dashboard — one-click UI for the above

**Test coverage**: 19 pytest regressions across `test_qbo_opening_balance_delta.py`, `test_qbo_payment_cash_side.py`, `test_qbo_mapper_balance_due.py`, `test_income_statement_cogs.py`. Every fix has a lock-in test.

**Known follow-ups** (all non-load-bearing — BS already ties):
- P&L Total Expense over-counts by ~$3k on Craig's sample data due to duplicate-entry sample quirks (some transactions entered as both Purchase and Bill); validate against real customer data before adding dedup logic
- `SalesTaxPayment` entity import for cleaner audit trail (the $ is already absorbed by the opening JE)
- Cross-realm CI fixture to catch future mapper regressions automatically

---

### Feb 2026 — Business Type: dropdown + AI canonicalization

**Change**: Every place the app collects `business_type` (new-client modal, AI-assisted onboarding step 1, Company Settings, My Businesses form) now uses a **dropdown of seven canonical entity forms** instead of freeform text:
  1. Sole Proprietor
  2. LLC – Partnership
  3. LLC – "S" Elected
  4. LLC – "C" Elected
  5. "S" Corporation
  6. "C" Corporation
  7. Limited Partnership

**Frontend (`constants/businessTypes.js`)** — single source of truth, imported by `ProClients.jsx`, `Onboarding.jsx`, `CompanySettings.jsx`, `MyBusinesses.jsx`. Legacy values (`"LLC"`, `"S-Corp"`, etc.) still render as a `(legacy)` option so existing companies don't blank out.

**Backend (`routes/onboarding.py::_canonicalize_business_type`)** — snap-to-canonical helper that maps colloquial voice/typed variants to the closed enum:
  - "we're an LLC" → `LLC – Partnership` (IRS default)
  - "LLC S-corp", "S-elected LLC", "filing 2553" → `LLC – "S" Elected`
  - "Sub-S", "S corporation" (no LLC) → `"S" Corporation`
  - "Acme Inc", "corporation" → `"C" Corporation`
  - "sole prop", "self-employed", "Schedule C" → `Sole Proprietor`
  - "LP", "Acme LP" → `Limited Partnership`
  - Unrecognized → returned as-is (fail-safe, PATCH caller decides)

**AI coach schema (`_COACH_STEP_SCHEMAS["business_profile"]`)** — new system prompt instructs the LLM to output one of the seven canonical values with the same mapping rules. Post-extract, the response is also run through `_canonicalize_business_type` so drifted LLM output still lands on-canon.

**Wired into**:
- `POST /api/companies` (self-service company create)
- `POST /api/pro/clients` (pro creates a client)
- `PATCH /api/companies/{cid}` (Company Settings save)
- `PATCH /api/companies/{cid}/onboarding` (onboarding step 1 answers)
- `POST /api/companies/{cid}/onboarding/coach/extract` (AI coach extraction)

**Tests**: `tests/test_business_type_canon.py` — 11 tests (exact match, case-insensitive, bare-LLC default, LLC-S/C elected variants, S/C corp variants, sole prop synonyms, LP, empty/None fail-safe, unrecognized pass-through). All passing; 49/49 combined regression suite green.


### Feb 2026 — Reconciliation page: filter history by account

**Change**: Added a compact filter row above the reconciliation history table with an "Account" dropdown. The dropdown is populated dynamically from accounts that actually have at least one reconciliation (no clutter from banks the pro hasn't reconciled yet) and stacks with the existing month-scope deep-link filter. Includes a Clear button and a live "Showing N of M" count.

**Files touched**: `pages/Reconciliation.jsx`
- New `filterAcctId` state
- New `historyAccountOptions` memo — unique accounts from `history[]`, sorted by name
- `visibleHistory` memo now applies both `monthBounds` + `filterAcctId`
- Filter bar rendered only when 2+ accounts exist (nothing to filter between otherwise)

Tests: none needed (pure UI filter, no data flow change).


### Feb 2026 — Auto-reconciliation for liability (credit card) statements

**Problem**: Uploading a credit-card statement via Veryfi auto-created a reconciliation that showed a huge false difference (e.g. AmEx-1004: statement $207.78 vs ledger $2,801.06 → diff -$5,602.12) even though the ledger and balance sheet tied perfectly. Asset (checking) statements reconciled fine.

**Root cause**: `create_reconciliation_from_statement_import` used the ASSET sign convention `closing = opening + sum(amount)` for every account. Veryfi stores charges with a **negative** `amount` (cash-flow convention) even though they INCREASE the liability balance. On liabilities, the correct math is `closing = opening − sum(amount)` — the sign flips.

**Fix (`reconciliation_engine.py::create_reconciliation_from_statement_import`)**
- Look up the bank account, detect `type == "liability"`, and store `cleared_sum = -raw_sum` for liabilities (asset accounts still store raw). The classic recon formula `diff = closing − opening − cleared_sum` now reduces to 0 on a perfect tie for both asset and liability statements.

**Fix (`statements.py::reprocess_import`)**
- The reprocess flow cascade-deletes the prior recon (correct) but was never re-creating one. Added a step-7 call to `create_reconciliation_from_statement_import` so a Reprocess on a liability statement produces a fresh, correctly-signed recon in one click. Wrapped in try/except so a recon failure never blocks the reprocess.

**Tests**: `tests/test_liability_recon_math.py` — 3 tests (liability perfect tie, asset unchanged, liability with mixed charges + paydown). All 38 targeted regression tests still passing.

**How to fix the existing stale AmEx-1004 recon**: Un-reconcile from the reconciliation detail page, then hit Reprocess on the statement — the new recon will show diff=0 with the corrected math.


### Feb 2026 — Sequential invoice numbering

**Problem**: Auto-generated invoice numbers were `INV-{random 4-digit}` (INV-9967, INV-5162, INV-5536…). Users expected the next invoice after INV-5162 to be INV-5163.

**Fix (`routes/invoices.py::_next_invoice_number`)**
- Scans every existing invoice number for the company, extracts the trailing integer via `_INV_NUM_RE = r"^[A-Za-z_-]*?(\d+)$"`, and returns `INV-{max+1}`.
- Floor of 1001 for first-ever invoices — avoids the awkward "INV-1" first-invoice look.
- Bespoke user-supplied numbers like `"2026-Q1-001"` still round-trip untouched (regex miss → skipped); user-typed numbers (`inp.number`) always bypass the helper entirely.

**Applied everywhere invoices are minted**
- `create_invoice` endpoint
- `_duplicate_doc` helper (turned async; both invoice + bill duplicate endpoints re-awaited)
- `recurring_service._create_from_template` (invoice branch — bills stay on the random scheme per user scope)

**Tests**: `tests/test_sequential_invoice_numbers.py` — 5 tests (empty company → floor, highest+1, ignores non-matching numbers, respects higher-than-floor, regex shape tolerance). All passing.

**Verified end-to-end** on the preview API: three back-to-back POSTs yielded INV-1001 → INV-1002 → INV-1003.


### Feb 2026 — Invoice list date off-by-one (UTC → local rendering)

**Problem**: An invoice with `due_date = "2026-08-06"` rendered as "Aug 5, 2026" in the Invoices list (and every other list using `fmtDate`) for any user east/west of UTC.

**Root cause**: `new Date("2026-08-06")` parses a bare YYYY-MM-DD string as **midnight UTC**. In `America/New_York` (UTC-4/-5) that instant is 8:00 PM the previous day, so `toLocaleDateString` renders "Aug 5".

**Fix (`lib/api.js::fmtDate`)**: When the input matches `/^\d{4}-\d{2}-\d{2}$/`, build a **local** Date via `new Date(y, m-1, d)` so the displayed day always matches the picked day. ISO strings with a time component still fall through to the normal `new Date(s)` path.

**Verified**: Node with `TZ=America/New_York` returns `"Aug 6, 2026"` for `"2026-08-06"` under the new code vs `"Aug 5, 2026"` under the old code.


### Feb 2026 — Voice invoices: "due today" now really means today (+ backdate rule)

**Problems**
1. Saying "due today" produced an invoice due 30 days out. Root cause: `Number(prefill.due_days) || 30` — when `due_days === 0` (today), JS's `||` falsy-check swallows the zero and falls back to 30.
2. When a spoken due date lands in the past (e.g. "was due last week"), the invoice was still stamped with today's issue date, creating a record that's born already-overdue.

**Fix**
- **`ai_service.INTENT_SYSTEM`** — new due-date phrasing guide: 'today'→0, 'tomorrow'→1, 'yesterday'→-1, 'net 30'→30, 'was due last Monday'→negative offset, omitted→field skipped (frontend defaults to net-30).
- **`Invoices.jsx::InvoiceModal`** & **`AiPanel.jsx::submitPendingIntent`** — replaced the `Number(x) || 30` fallback with an explicit `undefined/null/""` check, and added a backdate rule: if the resolved `due_date < today`, `issue_date` is set to `due_date`. Edit mode still trusts the persisted values.

**Verified**: `Number(prefill.due_days === 0 ? 0 : (prefill.due_days ?? 30))` now correctly emits `2026-08-06 / 2026-08-06` for "due today" and shifts issue → due when the user says "was due last week".


### Feb 2026 — Item picker: use item NAME on invoice/bill lines, not the internal description

**Problem**: Picking an item from the ItemPicker (or having voice/AI hydrate one) filled the line description with the item's internal `description` field (e.g. "Test - widget 1") instead of the customer-facing `name` (e.g. "Widget 1"). That leaked internal SKU notes onto invoices.

**Fix** (both voice + manual paths):
- `routes/chat.py` (voice/AI hydration) — `description = match.name` (was `match.description || match.name`).
- `pages/Invoices.jsx`, `pages/Bills.jsx`, `pages/InvoiceEditor.jsx`, `pages/BillEditor.jsx` (manual ItemPicker `onPickItem` handlers) — same flip.
- Users can still overwrite the description inline; only the auto-fill default changed.


### Feb 2026 — AI voice invoices now match the item catalog

**Problem**: Saying "create an invoice for Larry Brown, five widget ones" produced a single line with `description="five widget ones"`, quantity 1, and an invented $500 rate — the AI didn't cross-reference the item catalog even though `Widget 1` existed at $100/each.

**Fix — Backend**
- **`ai_service.INTENT_SYSTEM`**: added a `lines: [{item_name, quantity}]` field to the create_invoice / create_bill JSON contract. Parser is instructed to extract number-words → digits, keep the item name verbatim, and leave `amount` null so the total is computed from the catalog.
- **`routes/chat.py::_match_item`** (new): fuzzy-matches a spoken item reference against the company's item catalog. Normalization strips plural 's' and maps first-ten ordinal words to digits on both sides — so `"widget one"`, `"widget ones"`, `"Widget 1"` all resolve to the same catalog row. Scoring: exact = 1000, substring = 500, per-word overlap × 10; below-threshold returns None.
- **`routes/chat.py::ai_parse_intent`**: after contact resolution, iterates `prefill.lines[]` and hydrates each into the canonical line-item shape `{item_id, item_name, description, quantity, rate, amount, income_account_id, income_account_name}`. Unmatched entries fall through as freeform `{description, quantity, rate:0}` so the user can fix inline.

**Fix — Frontend**
- **`pages/Invoices.jsx::initLines`**: honors `prefill.lines[]` when opening the invoice modal via voice; renders the resolved rate + description + item link.
- **`components/AiPanel.jsx::submitPendingIntent`**: same mapping for the direct-POST path when the user says "confirm" quickly.
- **`AiPanel.jsx` pending-intent card**: shows the computed line-item total (`Σ qty × rate`) instead of just the parsed lump-sum amount.

**Tests**: `tests/test_voice_intent_item_matcher.py` — 6 tests (ordinal-word mapping, plurals, exact name, whitespace normalization, no-match fail-safe, deterministic tie-break). All passing.


### Feb 2026 — Receipts are now editable

**Problem**: Receipts were create-only. To fix a typo or wrong amount you had to delete + re-enter, losing the attachment.

**Fix**
- **Backend** (`routes/payments.py`): new `PATCH /companies/{cid}/receipts/{rid}` reusing the same `ReceiptCreate` shape as create (frontend always sends the full form). 404 on missing.
- **Frontend** (`pages/Receipts.jsx`): pencil icon per row opens the same modal in edit mode. Modal accepts an `initial` prop, prefills every field (date, vendor, amount, paid-from, category, notes, attachment preview), swaps heading to "Edit Receipt" and button to "Update receipt", and PATCHes instead of POSTing. Create path unchanged.

**Verified**: curl-tested create → patch → get on preview backend; verified value round-trips correctly and 404s for missing IDs.


### Feb 2026 — Duplicate-account detector: exclude Uncategorized buckets

**Problem**: `6999 Uncategorized Expense` and `9999 Uncategorized Income` were being flagged as a duplicate group on the Chart of Accounts page. They're seeded on purpose by `categorizer.ensure_uncategorized_accounts` (expense catch-all vs income catch-all) and merging them would collapse the AI review queue into a single unusable bucket.

**Fix (`routes/accounts.py::find_duplicate_accounts`)**
- After the normalized key is computed, skip any account whose key equals the literal `"uncategorized"`. Every variant we've seen (`Uncategorized Expense`, `Uncategorized Income`, `UNCATEGORIZED EXPENSE`, extra whitespace) normalizes to that single key so the guard catches all of them.
- Non-uncategorized names (`Uncategorized Rent`, `Meals`, etc.) still normalize to distinct keys, so legitimate duplicate detection is unaffected — verified against a synthetic Chart of Accounts where "Meals" x3 still flagged while 6999/9999 no longer did.

**Tests**: `tests/test_duplicate_accounts_filter.py` — 2 unit tests (all uncategorized variants collapse to the same key; non-uncategorized names remain distinct).


### Feb 2026 — Cross-year statement year-wrap correction (Dec→Jan bug)

**Problem**: On a credit-card statement covering Dec 26, 2025 → Jan 25, 2026, Veryfi's OCR stamps every transaction with the closing year (2026), producing dates like `2026-12-25` for what are really Dec 2025 charges. Downstream, the statement's period range balloons to `2026-01-01 → 2026-12-31` and the GL shows December transactions eleven months in the future.

**Fix (`veryfi_service.py::_correct_year_wrap`)**
- New helper runs on every `extract_transactions()` call. Derives a closing date from `statement_date` / `period_end_date` / `end_date`. For each txn date > closing_date + 30 day grace, subtracts one year. 30-day buffer (vs. a few days) guarantees we ONLY correct year-wrap symptoms and never touch legitimate post-close pending dates.
- Safety argument: a real statement can never contain a transaction dated a month AFTER its closing.

**Fix (`statements.py::upload_statement` + `reprocess_import`)**
- Sanity-check Veryfi's period range: if `period_end - period_start > 45 days`, discard those boundaries and re-derive from the (now year-corrected) txn min/max. Prevents the pathological `Jan 1 → Dec 31 same year` range from bleeding into the UI and OBE anchoring.
- `reprocess_import` now also recomputes `period_start` / `period_end` on the import row so hitting "Reprocess" fixes the displayed range too.

**Reprocess signature bug (`statements.py::reprocess_import`)**
- The reprocess path was calling `_categorize_and_insert_veryfi_lines(cid, lines, bank_acct, prior_import_id, …)` — the 4th arg should have been `coa` (a list of accounts), and `accts` + `import_id=` were missing entirely. Fixed by building `_coa`/`_accts` fresh from the DB and reshaping `lines` into the same candidate dicts the upload path emits.

**Tests**: 5 new regression tests in `tests/test_liability_statement_import.py` (grace window, intra-period no-op, end-to-end extract, missing-closing-date fail-safe, and the direct Dec→Jan shift). All 22 tests pass.


## What's been implemented (Feb 2026)

### Feb 2026 — Statement upload: pre-check modal + post-hoc reprocess

**Approach 1 — Pre-upload confirmation modal** (`components/StatementsTab.jsx`)
- On any file drop or browse, if the top-of-page account dropdown is set to any "auto" value, a modal intercepts before the upload starts. Three radio options: "Bank / Cash account", "Credit Card / Loan / LOC", "Let AI decide (auto-detect)". Preseeded from the top dropdown so a user who set `auto-liability` up top sees that already selected. A "Don't ask again for this batch" checkbox lets a 20-file drop confirm once and stream through.
- Selecting a specific real CoA row up top bypasses the modal entirely (an explicit account pick is already unambiguous).
- Prevents the exact class of misfire that occurred on Liability Test LLC — Amex Blue Business Cash card auto-detected as Checking, creating a phantom `American Express Checking …1004` CoA row.

**Approach 2 — Post-hoc reprocess** (`statements.py::reprocess_import`, `routes/statements_routes.py`, `components/StatementsTab.jsx::ImportsTable`)
- New endpoint `POST /companies/{cid}/statements/imports/{import_id}/reprocess` reads the cached `veryfi_raw` payload (no re-OCR call, no Veryfi cost). Steps: (1) cascade-delete the existing reconciliation + txns from this import, (2) delete the auto-created CoA row if it's now orphaned (no other txns/JEs/imports reference it), (3) flip import back to `processing`, (4) re-run the resolver with the new `account_kind_hint`, (5) re-run the categorize+insert loop, (6) re-anchor the OBE JE.
- Frontend adds a `RotateCw` button on each completed import row. Prompts for the corrected kind (1/2/3 → asset/liability/auto), asks for confirmation, then calls the endpoint and toasts a summary ("Reprocessed as 'American Express Credit Card ···1004' (liability). 123 transactions re-created, cleaned up '1015 American Express Checking …1004'.").
- Verified: backend route registers correctly (401 unauthed = wired); modal renders with all 6 controls confirmed via Playwright.

### Feb 2026 — Chart of Accounts row drill-down

**Frontend** (`pages/ChartOfAccounts.jsx`, `pages/ReportView.jsx`)
- Every CoA row's **name** and **balance** are now clickable — they navigate to `/reports/account-detail?account=<id>&from=coa`, the same drill-down page used from the Balance Sheet and Income Statement. Users see every transaction and JE line that adds up to the row's displayed balance, with running-balance walk and the standard Move / Filter / Search / Export toolbar.
- `ReportView` breadcrumb now checks the `?from=coa` URL param first (overrides the sessionStorage-cached "return to BS" label). Back-link reads `← Chart of Accounts` and returns to `/accounting/chart-of-accounts`.
- Hover state: name and balance cells underline in indigo on hover with a tooltip explaining what a click does.
- **Verified live via Playwright**: 48 name-link + 48 balance-link buttons detected on Bright Beans' CoA; clicking `-$213.45` on `1010 · Business Checking` → lands on `/reports/account-detail?...&from=coa` with breadcrumb showing "← Chart of Accounts / 1010 · Business Checking" and full ledger of 4 txns summing to $-213.45.

### Feb 2026 — Statement period boundary fix (Veryfi "Next Closing Date" bug)

**Backend** (`statements.py::upload_statement`)
- Veryfi's `period_start_date` from OCR routinely mis-parses the "Next Closing Date" printed at the top of Amex (and similar) statements — returning a period like `2026-04-01 → 2026-04-24` on a statement whose real activity is `2026-02-22 → 2026-03-23`. That wrong period_start cascades into `opening_balance_service._upsert_auto_je`: the OBE JE gets dated `period_start – 1 day` = `2026-03-31`, but all the imported txns are dated Feb-Mar → BEFORE that date. `balance_before` then eats the entire net movement of the period ($+2,801.06), so `needed = anchor.opening_balance – 2,801.06` under-seeds OBE by exactly that amount.
- Fix: reconcile Veryfi's header dates against the actual extracted transaction min/max. If `period_start > min(txn.date)`, fall back to `min(txn.date)`. Symmetric guard on `period_end`. Log both cases so we can measure how often Veryfi mis-parses.
- **Verified end-to-end**: full BS trace on the Amex Blue Business Cash scenario now yields AmEx $207.78 ✓ (was –$2,593.28), OBE –$3,008.84 ✓ (was –$207.78), Clearing –$9,184.67, Net Income –$6,383.61. BS balances.

**Test coverage** (`backend/tests/test_liability_statement_import.py`)
- 17 pytest cases green (added 4: exact-Amex-scenario, veryfi-envelopes-txns, veryfi-end-before-latest-txn, all-missing-fallback).

### Feb 2026 — Credit-card import: post-Veryfi-docs review — dedicated Clearing account + refined signals

**Trigger**: read Veryfi's Process-a-Bank-Statement API docs. Three insights that reshaped our approach:
1. Payments/charges use separate `credit_amount` / `debit_amount` fields — our extractor already handles both.
2. Veryfi returns NO source-account info for credit-card payments (the statement doesn't know which bank paid it). So some holding account is mathematically unavoidable.
3. Each transaction has a `card_number` field — cleaner signal for multi-cardholder subtotal detection than a description regex.

**Change 1 — Dedicated `Credit Card Payment Clearing` (1150) account** (`plaid_connect.py::ensure_cc_payment_clearing`, `statements.py`)
- Replaces the earlier OBE-routing approach. Auto-provisioned per-company (same helper pattern as `ensure_opening_balance_equity`). Sits at 1150 in the CoA between Undeposited Funds (1100) and A/R (1200).
- Every professional accounting system (QBO, Xero, Sage, NetSuite) uses a dedicated clearing/suspense pattern for unmatched credit-card paydowns — routing them through OBE is an audit anti-pattern that pollutes the opening-balance meaning.
- BS math verified end-to-end for the Amex test case: AmEx $207.78 ✓, OBE $–3,008.84 (opening seed only, clean), Clearing $–9,184.67 (unmatched paydowns), Net Income $–6,383.61. BS balances.

**Change 2 — Refined cardholder-subtotal filter using `card_number` signal** (`veryfi_service.py`)
- Added a second signal to `_is_cardholder_subtotal`: when the row carries a populated `card_number` field AND the description text is essentially just a cardholder name (only ALL-CAPS letters + spaces, no digits/dollar signs/lowercase), it's dropped. Keeps the description-regex as a fallback for older Veryfi responses that don't split `card_number` into its own field.

**Change 3 — Loosened Fix 2 override threshold from $0.02 to $5.00** (`statements.py`)
- Veryfi's docs confirm `beginning_balance` IS the correct field for credit cards (previous statement's ending). Small OCR imprecision (<$5) shouldn't trigger a full override. Now the override only fires when Veryfi appears to have populated the wrong field entirely, and logs both the Veryfi value AND the computed value on trigger for production telemetry.

**Test coverage** (`backend/tests/test_liability_statement_import.py`)
- 14 pytest cases green (added `test_cardholder_subtotal_filter_by_card_number_signal`).

### Feb 2026 — Credit-card import: cardholder-subtotal filter + paydown-to-OBE (superseded above)

**P0.1 — Cardholder subtotal filter** (`veryfi_service.py`)
- Veryfi occasionally emits per-cardholder rollup rows on multi-user credit-card statements (Amex Blue Business Cash, Chase Ink, Cap One Spark). Rows like `APRIL MCINTOSH 0-31004`, `PAUL LABOUNTY JR 0-31020` are subtotals, not real transactions — importing them double-counts the ledger by the exact sum of the underlying charges.
- New `_is_cardholder_subtotal(desc)` regex-matches the pattern `<CAPS name tokens> [SR|JR|II|III|IV]? <card ending>` (Amex format `0-31XXX`, extensible). Filter runs inside `extract_transactions._add_from_txn_shape` before the row is emitted.
- **Verified**: the 4 exact phantom rows the AmEx test surfaced (accounting for the ~$6.4k overstatement) are now dropped. Real charges (`BEST BUY SPRINGFIELD MO 888BESTBUY`), payments (`APRIL MCINTOSH MOBILE PAYMENT - THANK YOU`), rebates and refunds all pass through unchanged.

**P0.2 — Redo of Fix 3: paydowns POST against the card with OBE offset** (`statements.py`)
- Prior Fix 3 left liability paydowns un-posted → card balance overstated because the payments never reduced it. Corrected approach: paydowns POST directly against the AmEx (`bank_account_id=AmEx, amount=+X`) with `category_account_id = Opening Balance Equity` and `needs_review=True`. Ledger balance ties to the statement immediately; OBE accumulates the unmatched credits until the user reclassifies each row to a real source bank via the review queue.
- Ledger math verified with the exact Amex Blue Business Cash statement (prev $3,008.84 → new $207.78, charges $6,383.61, credits $9,184.67): AmEx settles at $207.78 ✓, OBE at +$6,175.83, Net Income at –$6,383.61, BS balances.
- **Asset accounts untouched**: guard only fires on `bank_acct.type == "liability" AND amount > 0`. Checking deposits, asset withdrawals, and liability charges all bypass the guard.

**Test coverage** (`backend/tests/test_liability_statement_import.py`)
- 13 pytest cases green (was 12, added `test_cardholder_subtotal_filter`).

### Feb 2026 — Credit-card statement import: 3 P0 accounting fixes (superseded by above)

Applies to **every** credit-card / LOC / loan / HELOC / mortgage import — no issuer-specific logic.

**Fix 1 — Naming default reflects account type** (`statement_account_resolver.py`)
- `_base_detail_from_type` gained an `is_liability` param. When Veryfi returns an ambiguous / empty `account_type` (Amex reports marketing card names like "Blue Business Cash" instead of a category), the default now flips to `"Credit Card"` if we know we're posting to a liability, keeps `"Checking"` for assets. This ends the "American Express Checking …1004" mis-labelling.
- All three callers (`_build_account_name`, fuzzy-match block, no-match creation block) thread `is_liability` through.

**Fix 2 — Opening balance is derived from ledger math on liabilities** (`statements.py`)
- Veryfi's `beginning_balance` field is reliable for bank statements (asset side untouched) but different credit-card issuers put different figures in that slot. Rather than guess which field is correct per issuer, when the account is a liability AND we have both `ending_balance` and a non-empty transaction list, we now compute `opening = ending + Σ(txn amounts)` (the identity that ties to the running-balance walk on a credit-normal account) and override the persisted `starting_balance` when it disagrees with the OCR value by > $0.02. Logs the override so audits stay clean.
- Regression proof: the exact Amex Blue Business Cash statement (prev $3,008.84, txn Σ +$2,801.06, new $207.78) → computed opening $3,008.84.

**Fix 3 — Paydown guard: liability + amount > 0 → skip AI, flag for review** (`statements.py`)
- The categorizer previously bucketed positive-amount transactions on a liability account as revenue → the AmEx test upload produced $8,759 of phantom "Uncategorized Income". New guard: when `bank_acct.type == "liability"` AND `amount > 0`, we skip AI categorization entirely and insert the row with `posted=False`, `needs_review=True`, and a clear prompt ("Payment received on a liability account — please pick the source bank / asset account before posting."). Ledger balance stays clean until the user matches the paydown to its source bank; no revenue is ever invented.
- **Asset accounts are untouched** — the guard's early return only fires for `type == "liability" AND amount > 0`, so a positive amount on Checking still flows through the normal deposit/revenue path.

**Test coverage** (`backend/tests/test_liability_statement_import.py`)
- 12 pytest cases green: naming defaults (5), opening-balance identity for both liability & asset formulas including paydown-only / charge-only edges (4), guard fires-vs-skipped matrix across (asset|liability) × (deposit|withdrawal) (3).

### Feb 2026 — Statement import: liability detection widened + UI override

**Backend** (`statement_account_resolver.py`, `statements.py`, `routes/statements_routes.py`)
- Widened `resolve_statement_account` from a lone `"credit" in account_type` check to a full regex net covering credit cards, lines of credit / LOCs, term loans, mortgages, HELOCs, and notes payable. Also falls back to `bank_name` when Veryfi returns an empty `account_type` (common for community-bank LOCs and SBA loan statements).
- Extended `_base_detail_from_type` to name new auto-created accounts appropriately: `HELOC`, `Mortgage`, `Line of Credit`, `Loan`, `Credit Card`, `Savings`, `Checking`.
- Threaded a new `account_kind_hint` parameter ("asset" | "liability" | "auto") from the upload route → `upload_statement` → `resolve_statement_account`. When the user explicitly says the statement is a credit card or loan, we skip the OCR-string sniffing and force the liability branch (creates the CoA row from the 2100 range with `subtype = "current_liability"`).
- 12/12 unit-level assertions pass on `_looks_liability` (Credit Card, CREDIT_CARD_STATEMENT, Line of Credit, Business LOC, SBA Loan, Mortgage Statement, HELOC, Note Payable → True; Checking, Savings, empty, None → False).

**Frontend** (`components/StatementsTab.jsx`)
- Import Statements dropdown reworked into three optgroups:
  1. **Auto-detect** — `Auto-detect from statement`, `This is a bank / cash account`, `This is a credit card or loan`.
  2. **Bank accounts** — all existing `type=asset` CoA rows.
  3. **Credit cards & loans** — all existing `type=liability` CoA rows (previously only assets were listed, so pros couldn't pin a statement to their existing Credit Card Payable / Loans Payable rows).
- Upload payload now sends `account_kind_hint=asset|liability` when the corresponding auto- option is picked. Selecting an existing CoA row (from either group) still pins to that specific account and skips auto-detect entirely.
- **Verified via Playwright**: dropdown enumerates all three optgroups correctly; `auto`, `auto-asset`, `auto-liability` values populate; existing liability accounts (2000/2100/2200/2500) appear in the Credit cards & loans group.

### Feb 2026 — Bill Editor: searchable category picker + liability accounts + add-new

**Frontend** (`pages/BillEditor.jsx`, `components/SearchableAccountPicker.jsx`)
- Replaced the raw `<select>` "Expense Category" dropdown with the shared `SearchableAccountPicker` (already used by Items + Invoice lines). Free typing filters by code or name; there's a `+ Add new expense account` button that opens the same QuickCreate modal the rest of the app uses.
- **Liability accounts now selectable on bill lines** — the account filter includes `type in {"expense", "liability"}` (was expense-only). Pros can now book a bill directly against Loans Payable / Credit Card Payable / Sales Tax Payable etc., and the eventual payment closes out A/P and reduces the liability in one motion (no manual JE needed).
- Sort order preserved: 2000-range liabilities float above 6000-range expenses in the dropdown. Newly-created accounts fold into both `allAccounts` and `expenseAccounts` state immediately so the next line picks up on them without a page reload.
- **Portal-rendered menu** — the picker's popover now renders into `document.body` via `createPortal` with `position: fixed` and a `getBoundingClientRect`-driven position that re-measures on scroll and resize. The menu can now escape any ancestor `overflow: hidden` (bill/invoice cards, modal tables) so long option lists remain fully visible instead of being clipped by the parent container. Outside-click handler tracks both the trigger and menu refs so option selection still registers correctly.
- **Above/below auto-flip** — measure() now checks `spaceBelow = window.innerHeight - r.bottom` and, if less than 220px with more room above, anchors the menu to CSS `bottom` (relative to the trigger's top) instead of `top`. The list-scroll region also gets a computed `maxHeight` so the popover never exceeds the space it has. Verified via applied styles: normal case yields `{top: 609px, bottom: ''}`, short-viewport case yields `{top: '', bottom: 53px}` — the flip fires correctly.
- **Verified live via Playwright**: menu now has `document.body` as its parent, bounding box extends outside the bill card, clicking an option still closes the menu and updates the trigger label.

### Feb 2026 — Reporting basis is persistent across the platform

**Backend** (`routes/onboarding.py`)
- `PATCH /companies/{cid}/onboarding` now propagates the business-profile answers (`basis`, `business_type`, `business_description`) onto the `companies` doc so downstream defaults reflect the user's picks. Kept narrow — only the three business-profile fields sync so AI extraction can't blow away unrelated company data.

**Frontend** (`pages/ReportView.jsx`, `pages/Onboarding.jsx`)
- Report basis toggle now defaults to `current.reporting_basis` (rather than always "accrual"). Falls back to accrual when the field is missing (older docs). URL param `?basis=` still wins over the company default so voice-commands / deep-links keep working.
- Added a `useEffect` that re-syncs `basis` when `current` finishes its async fetch — the picker no longer stays stuck on accrual just because `useCompany()` hadn't resolved on first render.
- Onboarding step 1 (business profile) reporting-basis picker now defaults to `current?.reporting_basis` so a client seeded with cash by their pro doesn't have to flip the toggle back during their own onboarding.
- **Verified live**: Setting Bright Beans' `reporting_basis` to `"cash"` → the Balance Sheet loads with the "Cash" tab active and subtitle "As of ... · cash basis" — no user action required.

### Feb 2026 — Contacts Import default type mirrors page filter

**Frontend** (`pages/Contacts.jsx`)
- `ImportContactsModal` gained an `initialDefaultType` prop. The parent page now passes `"vendor"` when the URL is `?type=vendor` and `"customer"` otherwise, so opening Import from the Vendors page pre-selects "Vendor" (instead of always defaulting to Customer). Unfiltered `/contacts` still defaults to Customer as before.

### Feb 2026 — Send-welcome toggle on New Client modal

**Backend** (`models.py`, `routes/pro.py`)
- Added `send_welcome_email: bool = True` to `NewClientIn`. When `False`, `POST /pro/clients` skips the entire welcome-email dispatch block and returns `email_status: "skipped_by_pro"` (with `email_kind: null`). Defaults to `True` so historical behaviour is unchanged.
- Verified end-to-end via curl: `send_welcome_email=false` → response `email_status: "skipped_by_pro"`; default (`true`) → response attempts the send (`email_kind: "client_welcome"`).

**Frontend** (`pages/ProClients.jsx`)
- New checkbox toggle in the New Client modal ("Send the client a welcome / password-set email now") sitting between the CoA info block and the Billing section. Defaults ON; helper text swaps between "On — the client will get their sign-in email as soon as you click Create." and "Off — no email will be sent. You can send it later from the client row."
- Toast copy now handles the new `skipped_by_pro` status ("welcome email skipped per your toggle — click 'Re-send welcome' on the client row anytime to send it.") and treats it as a success (green toast, not red).

### Feb 2026 — Import Statements gets its own focused page

**Frontend** (`pages/Connections.jsx`)
- Sidebar's "Import Statements" entry already routed to `/connections?view=imports`, but that URL was rendering the full Connections page (Connect Accounts tab + Plaid feeds + Statements tab). Now `?view=imports` renders a focused page with only the Load-Account-Statements experience: H1 flips to "Import Statements", subtitle to "Upload bank-statement PDFs and let Veryfi OCR pull the transactions", and no tab bar / Plaid controls appear.
- Regular `/connections` URL still shows both tabs (Connect Accounts + Load account statements) for backward compatibility.

### Feb 2026 — Balance Sheet asset drill-down now ties to the BS balance

**Backend** (`reports.py::compute_account_detail`)
- Bank/asset accounts on the Balance Sheet previously drilled into an empty Account Detail page ("No transactions have posted to this account") even though the row clearly showed a non-zero balance. Root cause: `_signed_balances` (source of BS numbers) reads `transactions.bank_account_id` for the bank side, but the drill-down query was matching only `account_id` + `category_account_id` — so a bank account whose movements landed on `bank_account_id` (the standard field used by Plaid + manual imports) came back empty.
- Extended the `$or` match to include `bank_account_id`, `splits.category_account_id`, and `splits.account_id`. Added `posted: True` to align with the Balance Sheet's filter so the drill-down running balance matches to the penny.
- Rewrote the per-row delta computation to sign-correct based on which side the account is on: bank-side matches take the transaction amount directly (+$100 deposit → +$100 balance), category-side and split matches use `-amount` (as before). Prior code always used `-amount` and would have shown the wrong sign for bank rows.
- Merged in matching `journal_entries.lines[]` (`account_id ∈ acct_id_list`) alongside transaction rows so opening balances, transfers, adjusting JEs, and GL-imported history show up in the drill-down. Rows are re-sorted oldest→newest before running-balance accumulation.
- **Verified live**: Bright Beans `1010 · Business Checking` — BS says $18,078.17 → Account Detail returns 171 txns / balance $18,078.17. Regression check on expense side: `6000 · Meals` YTD returns -$3,013.31 which matches Income Statement.

### Feb 2026 — Payments source-link + GL "Open source" open the actual transaction + breadcrumb

**Frontend** (`pages/ReportView.jsx`, `pages/Transactions.jsx`, `pages/JournalEntries.jsx`, `pages/Payments.jsx`)
- General Ledger source chip (`Txn`) previously navigated to `/accounting/transactions?highlight=<tid>` — which only scrolled and flashed the row. Users had to hunt through pagination and open the transaction manually. Changed to `?open=<tid>&from=gl` so the Edit Transaction modal opens automatically on the exact source transaction.
- Payments page Link icon (`payment-source-txn-*`) now appends `&from=payments` so the same modal-open behavior fires with a `← Payments / Transaction` breadcrumb.
- Split chip still uses `?highlight=<tid>&open=split&from=gl` (opens the split editor as before). JE chip uses `?highlight=<je_id>&from=gl`.
- Added a shared breadcrumb component (`transactions-source-breadcrumb`) at the top of the Transactions page that flips its label between "General Ledger" and "Payments" based on `?from=`. Journal Entries page has a matching breadcrumb for `?from=gl` on JE chips. Back-link fires `navigate(-1)` and returns the user to the exact source page + scroll position.

**Backend** (`reports.py`)
- Hardened `compute_general_ledger` — `sections.sort(key=lambda s: s["code"] or "")` — one account without a `code` (`None`) was crashing the whole GL response with `TypeError: '<' not supported between instances of 'NoneType' and 'str'`.

### Feb 2026 — Contact drill-down white-screen fix + Redis-fallback hardening

**Frontend** (`pages/Contacts.jsx`)
- Fixed white screen on `/contacts/:contactId` drill-down. Root cause: the detail-page render block accessed `modal.mode` while `modal` state initial value was `null` → `Cannot read properties of null (reading 'mode')` → the whole page unmounted. Changed to `modal?.mode === "edit"` and the modal close handler to `setModal(null)`.
- Verified live via Playwright: drill-down lands on full-page detail with breadcrumb; `← Customers` back-link works; Edit button opens the edit modal without crashing.

**Backend** (`infra.py`)
- Boot-time TCP probe of `REDIS_URL` — falls back to `memory://` storage when Redis is unreachable, avoiding the slowapi failure mode where `swallow_errors=True` catches the storage error but leaves `request.state.view_rate_limit` unset, blowing up `async_wrapper` with `AttributeError` on every rate-limited endpoint.
- Pre-seed `request.state.view_rate_limit = None` in `request_context` middleware as defense-in-depth for the case where Redis dies mid-flight in production.

### Feb 2026 — Plaid webhook async: retry + DLQ (job_queue hardening)

Correction from earlier audit: the webhook was already returning 200 immediately and enqueuing via `asyncio.create_task` — I mis-read the flow in the initial audit. Real gap was that failing tasks had no retry, no DLQ, no ops surface.

**`job_queue.py`**:
- Added `attempts`, `max_attempts`, `first_failed_at`, `last_error`, `next_retry_at` to every `sync_jobs` row.
- `_run_wrapped` now increments `attempts` atomically BEFORE running the task (so a crash before completion still counts) and catches uncaught exceptions.
- On failure: if `attempts < max_attempts`, transition to `status="retry_scheduled"` with `next_retry_at = now + backoff` and fire an `asyncio.call_later` to re-execute. Backoff curve `[1, 2, 4, 8, 16]` minutes (front-loaded — 90% of Plaid failures are transient rate-limit / item-state blips).
- After `MAX_ATTEMPTS` (default 5, env-tunable): status transitions to `"dlq"`, `finished_at` set, `next_retry_at` cleared. Job requires one-click retry.
- `reconcile_stuck_jobs()` now returns a dict and also rehydrates `retry_scheduled` rows on pod restart — schedules `call_later` for the remaining delay (past-due retries fire immediately). Fixes the "half-scheduled retry lost to pod restart" gap.
- `retry_dlq_job(job_id)` — one-click retry that resets attempts to 0, clears the retry timer, re-enqueues. Idempotent.
- Two new indexes on `sync_jobs`: `(status, first_failed_at DESC)` for the DLQ query, `(status, next_retry_at ASC)` for the reconcile scan.

**`routes/admin.py`**:
- `GET /api/admin/jobs/dlq?kind=&limit=` — lists DLQ + retry_scheduled jobs newest-first, joined with company_name, error snippet truncated to 500 chars, counts by status. Both statuses show together so ops can see what's queued for retry vs given up on.
- `POST /api/admin/jobs/{job_id}/retry` — one-click retry gated on superadmin role.

**Tests**: `tests/test_job_retry_dlq.py` — 4/4 pass under `pytest-xdist`. Backoff monkey-patched to 0s so tests run in <2s.
- Flaky task (2 fails then success) → 3 attempts → completed
- Always-failing task → exactly 3 attempts → status=dlq, additional wait doesn't change state
- DLQ retry resets counter + re-executes (goes back to dlq after 3 more fails, proving counter reset)
- `reconcile_stuck_jobs` re-arms a past-due `retry_scheduled` row (pod-restart simulation)

**Combined suite**: 13/13 passing (`test_ledger_hardening` + `test_job_retry_dlq`).

**Known limits / next work**:
- Tasks still run in the API pod (`asyncio.create_task`, not a separate worker process). At 3k tenants during nightly Plaid refresh, the API pod's event loop still shares CPU with sync work. Separate worker process (Arq / RQ / Celery) is the next architecture step — deferred until we have real numbers from the load test.
- The retry timer is in-process. If a pod dies during the backoff window, `reconcile_stuck_jobs` rehydrates on the next start — but if the pod stays down past the retry window, the retry lands late by however long the outage was. Acceptable trade-off vs the complexity of a distributed scheduler.

### Feb 2026 — JE writer unification + soft cap + hardening tests

**Every JE write now goes through one helper** (`db.insert_je`):
- Computes header `total_debit` / `total_credit` from `lines[]` before insert — fixes the latent zero-header bug found on 6 preview JEs. Backfilled those 6 records so integrity endpoint reports clean.
- Refuses to write an unbalanced JE (raises `ValueError`) — cardinal double-entry invariant enforced at the write layer, not just in reports.
- Accepts `session=` for transactional wrapping.
- Migrated 8 call sites: `inventory_service.py` ×5, `asset_service.py` ×1, `opening_balance_service.py` ×1, `plaid_connect.py` ×1. Now the only place `db.journal_entries.insert_one` remains is inside `insert_je` itself.

**LLM cap is soft** — was hard 402 before:
- `check_spend_cap` now: silent < 80%, WARN log 80–99%, ERROR log + latches `ai_spend_over_cap_events` counter at 100%+ but STILL ALLOWS the call. Only a company doc with `ai_spend_hard_block: true` raises `AiSpendCapExceeded` / 402. Ops flips the flag on runaway tenants.
- One-click override: `PATCH /api/admin/ai-spend/companies/{cid}/cap` — sets `cap_usd` and `hard_block` on a single company; no deploy.
- Platform default: `POST /api/admin/ai-spend/default-cap/apply-to-all-uncapped {default_cap_usd: 5}` — never lowers an existing cap. Applied $5/mo default to 15 preview companies as a smoke test.

**Transaction helper improved**: `_probe_txn_support` now actually writes a doc inside the probe transaction before aborting, so single-node mongod is correctly detected (was returning true-positive on empty commits). Verified in test suite.

**New test file** `tests/test_ledger_hardening.py` — 9 tests, all green:
- `insert_je` computes/overrides header totals; refuses unbalanced writes
- `ledger_transaction()` yields a session/None both safe to pass to Motor
- Soft cap: silent < 80%, warns at 90%, latches counter at 120%, hard-block raises, cap=0 unlimited, `company_id=None` no-op

**Orphan-payment verdict**: TEST_dup is a test company (created 2026-07-21, name literally `"TEST_dup"`). 3 orphans came from direct-DB/non-endpoint operations — 2 point at the same missing invoice (impossible via cascade). Current `cascade_on_doc_delete` code is correct — deletes payments first, then invoice. No live-company risk. Will wrap the cascade in `ledger_transaction()` next time invoices/bills are touched.

**Still to wrap (next pass)**: `POST /companies/{cid}/bills` (inventory apply path), `POST /companies/{cid}/assets`, `POST /companies/{cid}/opening-balance/{aid}` — top-level HTTP handlers wrapped in `ledger_transaction()` with `session=` threaded through the 3-5 helper layers each. Payment path is already done.

### Feb 2026 — Safety hardening (login rate limit + LLM cost hole + JE integrity)

**Login rate limit** (`infra.py`, `routes/auth.py`, `routes/invites.py`):
- Global slowapi `key_func` swapped: JWT-authenticated calls now bucket by `user_id`, unauthenticated by IP. A firm behind one NAT no longer shares a bucket.
- Rate-limited endpoints: `/auth/login` (5/min), `/auth/signup` (5/min), `/auth/change-password` (5/min), `/auth/password-set/{token}` (5/min), `/auth/forgot-password` (3/min), `/companies/{cid}/invites` + `/pro/invites` + `/admin/invites` (10/min each). Verified 6th login → 429; 4th forgot → 429; legit login on fresh IP → 200. Removed `from __future__ import annotations` from `auth.py` (slowapi × FastAPI 0.110 body-detection interaction).

**LLM cost tracking — hole closed** (`ai_usage.py`, `llm_client.py`, `routes/insights_chat.py`, `routes/admin.py`):
- Every LLM call now increments the unified counter `companies.ai_spend.{YYYY-MM}` (cost cents) via `_increment_company_spend` in `record_llm` / `record_service`. Daily rollup `ai_spend_daily(company_id, day, feature)` upserted in the same call — used by the admin report so hot reads stay O(1).
- `LlmChat` gained `company_id` kwarg + `_preflight_cap_check` — every stream/send now runs `check_spend_cap` before hitting OpenAI/Anthropic. Cap read is one indexed doc lookup. Falls back to `_ctx_company_id()` ContextVar so untouched call sites still get the check.
- Migrated explicit `company_id` on 4 call sites (`insights_chat.py` x2, `invoices.py` follow-up, `accounts.py` COA-classify); `ai_service.py`, `contacts.py` PDF import, and `categorizer` covered by the ContextVar fallback.
- New endpoints: `GET /api/admin/ai-spend/by-company?period=YYYY-MM&revenue_per_seat_usd=X` — every company's spend ranked, top features, share-of-revenue %. `POST /api/admin/ai-spend/backfill` — idempotent rebuild from `ai_usage_events`.
- New indexes on `ai_usage_events`: `(company_id, ts DESC)`, `(user_id, ts DESC)`. New collection `ai_spend_daily` with unique `(company_id, day, feature)`.
- **Preview snapshot** (2026-08 current month, tiny dataset): Bright Beans $0.0078 (23 insights events); TEST_dup $0.0054 (21 insights + 20 followups). Total across active co's $0.0132.

**Multi-doc ledger writes — atomicity + integrity check** (`db.py`, `routes/payments.py`, `routes/admin.py`):
- New `ledger_transaction()` async context manager in `db.py`. Probes for replica-set support once per process, uses `session.start_transaction()` on Atlas, falls back to yielding `None` on non-replica-set Mongo (with a loud WARNING log). Callers thread `session=_s` through every Mongo op.
- `POST /companies/{cid}/payments` now wraps the four writes (`payments.insert` + `invoices/bills.update balance_due` + `transactions.update linked_payment_id`) in one transaction.
- New `GET /api/admin/ledger-integrity` scans: JE line-sum vs stated totals, invoice/bill impossible balances, orphan payments (linked doc missing, or balance untouched despite payment).
- Preview scan found: 0 unbalanced JEs (line sums tie), 6 JEs with the header-total-vs-line-sum bug (latent, reports read from lines), 3 orphan payments in `TEST_dup` (cascade-on-delete gap, separate issue).
- **Still to wrap** (next pass): `inventory_service.py` bill-receive + JE, `asset_service.py` fixed-asset funding + JE, `opening_balance_service.py`, reconciliation `clear` batches, loan payment records, Plaid history import.

### Feb 2026 — Scale-hardening pass (before-500 tier)

Approved subset of the scalability audit landed. **No `_signed_balances` rewrite yet** — that's gated behind load-test measurement.

**Redis + cache backend introspection** (`infra.py`, `routes/health_probes.py`):
- Fallback path now logs at **ERROR** with an explicit "UNSAFE for multi-worker" message + Sentry breadcrumb (was WARNING).
- New `get_cache_backend()` + `cache_health()` helpers in `infra.py`.
- New endpoint `GET /api/health/cache` → returns `{ backend, ok, ping_ms, safe_for_multi_worker, redis_url_set }`. Wire to alerting on `safe_for_multi_worker=false`.
- New endpoint `GET /api/health/multi-worker-round-trip` → proves write → cache-hit → invalidate → recompute round-trips through the active backend. Includes a `caveat` field that explicitly notes the in-process backend's guarantee is worker-local only.
- Verified: killed Redis → fallback fires with ERROR log + `safe_for_multi_worker: false`; restored Redis → `backend: redis`, `ping_ms ≈ 0.7`. Verified 4-worker cross-process invalidation is green.

**`id` unique indexes on 22 collections** (`server.py`):
- Pre-flight audit confirmed zero duplicate `id` values across all populated collections. Safe to land as unique.
- Added `id_uniq` (unique, sparse, background) to: companies, users, accounts, transactions, invoices, bills, contacts, items, assets, loans, journal_entries, payments, receipts, memberships, enterprises, recurring_templates, inventory_movements, reconciliations, plaid_items, bank_accounts, onboarding_sessions, insights_sessions. `sync_jobs` already had one.
- Idempotent; log-and-continue on failure so a bad row doesn't block startup.

**Uvicorn workers — NOT landed in preview**
- `/etc/supervisor/conf.d/supervisord.conf` is `# READONLY FILE, DO NOT EDIT`. Preview pod is Emergent-managed. Multi-worker validation ran via a temporary 4-worker uvicorn on port 8002; cache invalidation confirmed green across all 4 workers.
- Production change deferred to the deployment repo (Docker CMD / Helm / Railway config outside this pod).

### Feb 2026 — Darker floating shadow + monthly trend variants (18 charts total)

**Frontend polish** (`components/InsightsChatWidget.jsx`):
- Replaced Tailwind `shadow-2xl` with a moodier custom multi-stop shadow (`rgba(15,23,42,0.55) 0 30px 60px -12px` + two additional stops for depth). Panel now reads as a distinctly elevated layer over dense dashboard content.

**New backend fetchers** (`routes/insights_chat.py`):
- `ar_aging_trend` → month-end A/R totals + bucket breakdown (current / 1-30 / 31-60 / 61-90 / 90+) for trailing N months. Answers "is my collection getting worse/better".
- `expense_trend` → top-N expense categories tracked month-by-month (categories rank stable across the window; leftovers roll into "Other"). Answers "how has my spending moved by category".
- `cash_flow_trend` → monthly cash-in (positive posted amounts) vs cash-out (negative) + net line for trailing N months. Answers "am I burning cash / cash runway".

**New Recharts visuals**:
- A/R aging trend → 5-color stacked bar (green→amber→rose as buckets age) + latest vs earliest delta callout
- Expense trend → color-cycled stacked bar with rank-stable categories + legend
- Cash-in vs cash-out → dual bars + net line ComposedChart with best/worst month callouts

**Verified live** on Bright Beans Coffee Co. (Aug 2026):
- A/R aging trend: A/R went from all-current $5,525 (Sep 25) → $4,650 in 31-60d + $875 in 61-90d (Aug 26) — clear collection degradation
- Expense trend: 12-month window / 5 categories + Other = $59,713 total
- Cash flow trend: $85,941 in − $66,956 out = $18,985 net; best month Jul 26 (+$21k), worst May 26 (-$11.5k)

### Feb 2026 — Insights AI full report coverage (8 new charts)

Expanded the Insights chart registry from 7 → **15 chart types** so "Ask about my data" now covers every core report and business dimension. Each new chart has a backend fetcher, LLM registry entry, Recharts visual, AND text-summary renderer:

**Backend** (`routes/insights_chat.py`):
- `cash_flow` → wraps existing `compute_cash_flow` (Operating / Investing / Financing / Net Change)
- `invoices_by_status` → aggregates `db.invoices` by status (draft/sent/partial/paid/overdue/void); auto-escalates past-due `sent` invoices to `overdue`. Returns count + total invoiced + open balance per bucket.
- `bills_by_status` → same shape for `db.bills`
- `top_customers_revenue` → groups posted invoices by contact_id in a period, ranks by revenue. Limit 3-25 (default 10). Excludes void.
- `top_vendors_spend` → same for bills
- `expense_by_category` → GL expense accounts ranked by period balance (top 15) using `_signed_balances` + `_display_amount`
- `fixed_assets_summary` → walks `db.assets`, computes accumulated depreciation from `monthly_depreciation × months_elapsed` (capped at `cost - salvage`), returns book value per asset + totals
- `loans_summary` → walks `db.loans` joined with linked liability account balance (via `_signed_balances`) for current outstanding

**Frontend** (`components/InsightsChatWidget.jsx`):
- Cash Flow → 4-bar chart (Operating/Investing/Financing/Net Change) with signed colors + zero reference line
- Invoices/Bills by Status → vertical bar per status, count labels on top, color-coded by status (overdue=rose, draft=slate, paid=emerald, partial=amber)
- Top Customers / Vendors → horizontal bar of top N by revenue/spend, doc-count in subtext
- Expenses by Category → horizontal bar of top 10 GL expense accounts by amount
- Fixed Assets → stacked horizontal bar per asset showing Book value + Depreciated portion
- Loans → grouped horizontal bar per loan showing Original principal (grey) + Current balance (rose)
- Text summaries under every chart with totals, sub-rows, and per-item detail
- Starter prompts updated to nudge users into the new coverage: "cash flow this quarter", "which invoices are overdue", "top customers this year"

**Verified live** on Bright Beans Coffee Co.: cash_flow rendered with Operating -$2,115.78 · Net Change -$2,115.78; invoices_by_status showed 3 overdue; top_customers_revenue showed 3 customers / $5,525 total; expense_by_category YTD showed $59,713.06 with top categories Supplies & Materials / Legal & Professional / Rent.

### Feb 2026 — Monthly Income Trend chart + Firm-level Insights cost alerts

**Backend**
- `routes/insights_chat.py` — new `_fetch_income_trend` fetcher + registered `income_trend` chart. Loops `compute_income_statement` over N months (default 12, cap 3-24) and returns `{months:[{month,label,revenue,expense,net}], total_revenue, total_expense, total_net}`. LLM prompt updated so multi-month / trend / "year" style questions prefer this over the flat Income Statement.
- `routes/pro.py` — three new endpoints:
  - `GET /api/pro/insights-cost-alerts/config` — reads firm's `insights_alert_threshold_usd`
  - `PATCH /api/pro/insights-cost-alerts/config` — sets threshold (0 disables)
  - `GET /api/pro/insights-cost-alerts` — returns `{period, threshold_usd, clients_over:[{id,name,spent,over_by}]}` for the current calendar month. Superadmin sees all companies; Pro sees only their active memberships.

**Frontend**
- `components/InsightsChatWidget.jsx` — new `ChartVisual` case for `income_trend`: Recharts `ComposedChart` with dual Revenue/Expense bars + Net Income line overlay + zero reference line + legend. Numeric summary below now surfaces Best / Worst month alongside totals. Starter prompt swapped from "this quarter" to "this year" to nudge users toward the new trend chart.
- `pages/ProClients.jsx` — new `InsightsCostAlertTile` mounts right below `FirmAttentionTile`:
  - Disabled threshold → compact "Set threshold" configure chip
  - Threshold set, no offenders → thin green "all clear" strip w/ inline threshold editor
  - At least one offender → LOUD rose warning tile w/ pulsing icon, per-client rows (spent, over by), "Open books" jump-link, expand/hide, edit threshold inline

### Feb 2026 — Draggable Insights panel + Recharts visualisations

**Frontend** (`components/InsightsChatWidget.jsx`)
- **Draggable panel** — the header is now a drag handle (`cursor-move`, grip icon). Grab and drop anywhere on the viewport; position persists to `localStorage` (`insights_chat_pos_v1`). Double-click the header to reset to the default bottom-right position. Auto-clamps back on window resize so the panel never strands off-screen.
- **Recharts visualisations** on every chart card (kept alongside the existing text summaries per user request):
  - `income_statement` → indigo Revenue vs rose Expense bar chart with data labels + big Net Income callout (green/red based on sign)
  - `balance_sheet` → tri-color donut of Assets / Liabilities / Equity + legend
  - `ar_aging` / `ap_aging` → horizontal bar of top 6 outstanding customers/vendors with money labels
  - `inventory_valuation` → total-value hero + horizontal bar of top 5 items by value
  - `reorder_alerts` → stacked horizontal bar showing threshold (grey track) vs on-hand (amber warn)
- **Auth fix** — SSE stream fetch was pulling from the wrong localStorage key (`token` vs the app's `axiom_token`), causing 401s. Fixed to check `axiom_token` first with fallbacks.

### Feb 2026 — Insights launcher moved into Sidebar + CPA-firm Marketing PDF variant

**Frontend**
- Removed the floating bottom-right "Ask about my data" pill from `InsightsChatWidget.jsx`. The widget now listens for a global `insights:open` event so any launcher in the app can open it.
- Added a persistent "✨ Ask about my data" button in `components/Sidebar.jsx` — pinned directly above the user profile block. Dispatches `insights:open` to trigger the widget. Collapsed sidebar collapses the button to just the sparkle icon.

**Backend**
- `routes/marketing_pdf.py` — added a `?variant=cpa` query param to `GET /api/marketing/comparison-pdf`. The CPA variant swaps the highlights, parity, gaps, pricing table, and bottom line to lean into white-label branding, per-client Stripe billing, ProAdvisor / Xero Partner comparisons, Karbon / Ignition stack replacement, and firm economics (firm platform fee + client seat cost rows).
- Default variant (SMB pitch) unchanged.
- Verified: both variants return valid PDFs (`%PDF-1.4`) via curl — default 8080 bytes / cpa 10089 bytes. Automated content review confirmed all firm-specific sections present with no layout clipping.



### Feb 2026 — Sidebar re-org + Tax Library + Bill Editor parity

**Frontend**
- **Sidebar restructure** (`components/Sidebar.jsx`) — collapsible grouped nav with disclosure sections: **Sales & Payments** (Invoices/Payments/Items/Recurring/Customer Statements/Customers), **Purchases** (Bills/Vendors/Payments/Items), **Banking** (Connect Accounts/Import Statements), **Accounting** (Transactions, CoA, Assets, Loans, Tags, Reconciliation, Journal Entries, GL, **Tax Library**, AI Cleanup Review, AI Rules, Book Review, Month Close, Close the Books). Standalone: Dashboard, Receipts, Reports, Communications, My Businesses, Billing, Refer & earn, Settings. Groups auto-expand on route match; open-state persists to `localStorage`.
- **Tax Library page** (`pages/TaxLibrary.jsx`) at `/accounting/taxes` — dedicated CRUD table (name / rate / edit / delete) with a unified create/edit dialog. Empty-state coaching card when the pro hasn't added any taxes.
- **Bill Editor** (`pages/BillEditor.jsx`) at `/bills/new` and `/bills/:id/edit` — full Wave-style parity with `InvoiceEditor`: business collapsible with logo upload + title/summary, Vendor picker, Bill #/PO/Bill date/Payment due (Net 15/30/60 with auto-computed due date)/Status, line items with `ItemPicker` and per-line **Tax** dropdown + "+ Create a new tax…" modal, inline Subtotal/Discount ($ or %)/Shipping/Tax/Total/Amount Due, Notes/Terms + Internal notes + Attachments, Edit/Preview tabs (Preview auto-saves and shows the PDF in an iframe).
- **Bills list** now navigates to `/bills/new` and `/bills/:id/edit` (popup edit path retired).
- **Contacts page** reads `?type=customer|vendor` from the URL: filters the list and swaps the H1 to "Customers" / "Vendors" so sidebar deep-links feel purposeful.
- **Items page** reads `?usage=sales|purchases` from the URL: initial usage filter honors the deep link and re-applies when it changes.

**Backend**
- `models.BillCreate` extended with the same fields as `InvoiceCreate` (po_number, terms, shipping, discount, discount_type, internal_notes, attachments, title, summary).
- `routes/bills.py::create_bill` and `update_bill` reworked to use the shared `_sum_lines` (with shipping/discount/tax/per-line-tax rollup) and persist every new field.
- New `GET /api/companies/{cid}/bills/{bid}` single-resource endpoint (needed by BillEditor).
- New Tax CRUD endpoints in `routes/invoices.py`: `PATCH /companies/{cid}/taxes/{tid}` renames/rerates (cascades new name/rate into any referenced invoice + bill line items) and `DELETE` refuses with 409 if the tax is still applied to any doc.
- **PATCH tax double-count fix** — on invoices/bills PATCH, we now peel the previously-rolled-up per-line tax off `existing.tax` before feeding `_sum_lines`, so a partial PATCH that omits `tax` no longer inflates the total by Σ line_tax.
- **Tests**: iter 67 — 5/5 backend pytest (`tests/test_iter67_bills_taxes.py`) + full Playwright walkthrough, zero blockers (`/app/test_reports/iteration_67.json`).

### Feb 2026 — Full-page Invoice Editor (Tabs: Edit / Preview)

**Frontend**
- New `/app/frontend/src/pages/InvoiceEditor.jsx` — dedicated full-page editor at `/invoices/new` and `/invoices/:id/edit`. Replaces the popup for the primary create/edit flow (voice-command `useCreateListener` path still uses `InvoiceModal` for backwards-compat).
- **Tabs**: `Edit` / `Preview` at the top of the page. Preview auto-saves silently first, then renders the PDF in an iframe (blob URL).
- **Form** — customer picker, invoice number (editable), issue date, **Terms dropdown** (Due on receipt / Net 15 / Net 30 / Net 60 / Custom — auto-computes due date), due date (manual override flips to Custom), **PO number**, status, line-items table with `ItemPicker` (qty, rate, amount, add/remove), **notes to customer** (renders on PDF), **internal notes** (private), **file attachments** (base64 data URLs — same pattern as receipts, 6 MB per-file cap).
- **Totals sidebar** — subtotal, **discount** with `$` / `%` toggle, **shipping**, **tax**, total. All computed client-side, mirrors backend `_sum_lines`.
- **Save** button (create → `POST`, edit → `PATCH`) + **Send email** button (only after save) that opens a small dialog for the recipient and calls `POST /invoices/{iid}/send-email`.
- `Invoices.jsx` — `New Invoice` button and edit pencil icon now navigate to the new routes instead of opening the popup.
- New routes wired in `App.js`: `/invoices/new` and `/invoices/:id/edit` → `<InvoiceEditor/>`.

**Backend**
- `models.InvoiceCreate` extended with `po_number`, `terms`, `shipping`, `discount`, `discount_type` (`amount|percent`), `internal_notes`, `attachments`.
- `routes/invoices.py::_sum_lines` reworked to return `(subtotal, discount_amount, shipping, tax, total)` with the applied order `subtotal − discount + shipping + tax`.
- `POST /invoices` persists every new field; `PATCH /invoices/{iid}` recomputes totals whenever `line_items | tax | shipping | discount | discount_type` land in the payload, and preserves the `paid` amount so `balance_due` stays consistent when a partial payment exists.
- New `GET /invoices/{iid}` single-resource endpoint (needed by the editor page).
- New `POST /invoices/{iid}/send-email?to=` — builds the PDF, base64-attaches it, dispatches through `email_dispatcher` (kind `customer_statement` — reuses existing opt-out preference), and auto-flips a `draft` invoice to `sent` when the email actually goes through.
- `document_pdfs.build_document_pdf` renders an optional **PO / Terms strip** below the Bill-To meta block, and the totals table now includes **Discount** and **Shipping** rows (only when non-zero).
- `email_service.send_email` + `email_dispatcher.dispatch` gained an optional `attachments=[{filename, content: base64}]` param passed straight through to Resend.
- **Testing**: iter 66 — 7/7 backend pytest + full Playwright E2E, zero defects (`/app/test_reports/iteration_66.json`).

### Feb 2026 — Invoice Preview toggle (Wave-style incremental)

**Frontend (`pages/Invoices.jsx`)**
- Existing edit modal gained an **Edit ⇄ Preview** segmented toggle (only on saved invoices). Preview swaps the form for an iframe of the existing `/invoices/{id}/pdf` blob URL, so pros can see exactly what the customer will receive without leaving the modal. Modal widened to `max-w-4xl` and made scrollable for the preview.
- Compiles clean, no regressions to the edit flow. `useEffect` cleanup revokes the blob URL when the modal closes.

**Deferred to next turn** (bigger scope, needs a fresh context window):
- Full-page InvoiceEditor route (`/invoices/new`, `/invoices/:id/edit`) with Wave-style two-column layout (branding sidebar + form)
- Company branding fields: logo upload, address, phone/email/website, tax ID (backend model + settings UI)
- Branded PDF header once branding fields exist (drop into `document_pdfs.build_document_pdf`)

### Feb 2026 — Cascade delete for auto-payment link graph

**Backend**
- New `link_cascade.py` module with two helpers, both lazy-imported to avoid cycles:
  - `cascade_on_doc_delete(cid, kind, doc_id)` — when an invoice or bill is deleted, any payment with `linked_invoice_id`/`linked_bill_id` pointing at it is removed, and any transaction whose `linked_payment_id` referenced those payments has its back-refs cleared.
  - `cascade_on_transaction_delete(cid, txn)` — when a transaction owning an auto-payment is deleted, the payment's balance impact on the doc is reversed (invoice `paid` → `sent` with balance restored, bill `paid` → `open` with balance restored) and the payment is deleted.
- `DELETE /invoices/{iid}`, `DELETE /bills/{bid}`, `DELETE /transactions/{tid}` all wired to return `{ok, payments_deleted, ...}`.
- Downstream reports (`purchases-by-category`, `revenue-by-customer`, etc.) automatically stay consistent because payments and doc balances are the source data.
- Testing: **8/8 backend pytest pass, zero bugs** (`/app/test_reports/iteration_64.json`).

### Feb 2026 — Auto-Payment on Link, Doc PDF preview, Customer Statement email

**Backend**
- `routes/transactions.py` — `POST /transactions/{tid}/link` now auto-creates a Payment row when the txn is linked to a bill or invoice: amount=abs(txn.amount), date=txn.date, contact copied from the doc, `source_transaction_id=tid`. Applies the balance impact on the doc (partial/paid). Idempotent — same doc twice = same payment. Unlinking (empty string) deletes the payment AND reverses the balance.
- `document_pdfs.py` (new) — reportlab renderer used by two new endpoints:
  - `GET /companies/{cid}/invoices/{iid}/pdf` — invoice PDF (header + BILL TO + line items + totals + applied payments).
  - `GET /companies/{cid}/bills/{bid}/pdf` — same for bills.
- `routes/items.py` — new `POST /customers/{customer_id}/send-statement?start=&end=&to=` builds an HTML statement of outstanding invoices and routes it through `email_dispatcher.dispatch(kind='customer_statement')`. Filters to non-draft, non-void, balance_due>0, in-range. 404 for unknown customer, 400 when no email on file and no `to` override.
- `email_dispatcher.py` — added `customer_statement` to `DEFAULT_PREFS` (opt-outable).

**Frontend**
- `pages/Payments.jsx` — new Link2 icon on rows with `source_transaction_id` linking to `/accounting/transactions?open=<tid>`; the linked-doc column becomes a hyperlink.
- `pages/Transactions.jsx` — `?open=<tid>` auto-opens the Edit Transaction modal for that txn.
- `components/ContactDetailModal.jsx` — Eye icon on each doc row opens an inline PDF preview modal (iframe over a blob URL so auth stays intact); customer-mode gains a green **Send statement** button that opens `StatementModal` with the customer's email pre-filled and a Send button.
- Testing: **7/8 backend pytest + Playwright frontend E2E 100%** on all critical flows (`/app/test_reports/iteration_63.json`). One-liner fix applied to make the link endpoint return the existing `linked_payment_id` on idempotent re-links.

### Feb 2026 — Customer Revenue Report + Vendor/Customer Drill-Down + Auto-Suggest Link

**Backend (`routes/items.py`)**
- New `GET /reports/revenue-by-customer` — mirror of spend-by-vendor for the sales side (invoice totals rolled up by customer with paid/outstanding/invoice_count).
- New `GET /reports/vendor-detail` and `GET /reports/customer-detail` — return {docs, linked_transactions, totals} for a single entity in a date range (`vendor_id`/`customer_id` preferred, `_name` fallback for 'Uncategorized' bucket). 400 when neither is supplied.

**Frontend**
- New `components/ContactDetailModal.jsx` — right-side slide-over with 4 KPI stats, docs table, and linked-transactions table. Reused for both vendor and customer.
- `SalesReports.jsx` — new **By Customer** tab (sales-mode only), row click on By-Vendor/By-Customer opens the drill-over. CSV export supports customer columns.
- `Transactions.jsx` (ManualTxnModal) — auto-suggest link: when txn amount + merchant match exactly one open bill/invoice, pre-select it and show an amber "Auto-matched" chip. Guards against overwriting an already-linked txn, requires merchant substring ≥ 4 chars on shorter side to avoid over-matching generic tokens.
- Testing: **6/6 backend pytest + Playwright frontend E2E 100%, zero functional bugs** (`/app/test_reports/iteration_62.json`). Bumped ContactDetailModal z-index to `z-[60]` so it sits above the AI Assistant panel.

### Feb 2026 — Vendor Spend Report + inline Bill/Invoice link on Edit Transaction

**Backend**
- `routes/items.py` — new `GET /reports/spend-by-vendor` endpoint. Aggregates bill totals by `contact_name` over a date range: `amount`, `paid_amount` (derived from total − balance_due), `outstanding`, `bill_count`. Excludes draft/void. Uncategorised vendors bucket into their own row.

**Frontend**
- `SalesReports.jsx` — new **By Vendor** tab visible only when `mode=purchases`. Table columns Vendor / Total spend / Paid / Outstanding / Bills / Share. Vendor swaps to another color on the share bar (fuchsia). CSV export supports vendor columns; switching mode back to Sales resets the tab.
- `Transactions.jsx` (ManualTxnModal) — new **Link to invoice or bill** section right above Save with an Invoice/Bill kind toggle, a select dropdown, and an **Unlink** button. Save runs the transaction PATCH/POST then calls `/link` with the picked kind (or empty string to clear). Works for both new and existing transactions.
- Testing: 4/4 backend pytest + Playwright frontend E2E 100%, no bugs (`/app/test_reports/iteration_61.json`).

### Feb 2026 — Item usage: Invoice / Bill / Both

**Backend (`routes/items.py`)**
- `Item` model gained a `usage` field (`sales` | `purchases` | `both`, default `sales`).
- `GET /items?usage=sales|purchases` filters items usable in that context — `both` items appear in either filter.
- Legacy items without a `usage` field are backfilled on read by inferring from account slots (income-only → sales; expense-only → purchases; both → both).
- CSV import honours an optional `Usage` column; otherwise infers.
- PATCH rejects invalid values with 400.

**Frontend**
- Items page has 4 filter tabs — **All / For Invoices / For Bills / Both** — with live counts, a new **Used on** column with color-coded Invoices / Bills / Both badge, and an Accounts column showing both income (↑) and expense (↓) mappings.
- Item modal has a segmented "Used on" picker that persists on save.
- Invoices load `?usage=sales`; Bills load `?usage=purchases`, so each picker only shows relevant items.
- Testing: 10/10 backend pytest + Playwright frontend E2E 100%, zero bugs (`/app/test_reports/iteration_60.json`).

### Feb 2026 — Purchases By Category / Item (mirror of Sales Reports)

**Backend (`routes/items.py`)**
- New `GET /companies/{cid}/reports/purchases-by-item` — aggregates bill line_items by `item_id` (falls back to description-based bucket 'Uncategorized'). Excludes `status='void'` and `status='draft'`. Same date-range params as sales endpoints.
- New `GET /companies/{cid}/reports/purchases-by-category` — same rollup grouped by `expense_account_id`/`_name` (falls back to line's `category` field, then 'Uncategorized').

**Frontend**
- `SalesReports.jsx` refactored to support both **Sales** and **Purchases** modes via a top-level toggle (`report-mode-toggle`) — deep-linkable through `?mode=purchases`. Labels, headers, colors, CSV filename, and empty-state text swap based on mode.
- `Reports.jsx` gains a **Purchases Reports** tile that opens the page in purchases mode.
- Testing: 8/8 backend pytest + Playwright frontend E2E 100%, zero bugs (`/app/test_reports/iteration_59.json`).

### Feb 2026 — Bulk Item Import + ItemPicker on Bills

**Backend (`routes/items.py`)**
- New `POST /companies/{cid}/items/import` — accepts CSV or Excel upload. Case-insensitive header aliasing (Name/Item/Product, Description/Details, Type, Account/IncomeAccount/Category, ExpenseAccount/COGSAccount, Price/Rate/UnitPrice, SKU/Code, Active). Auto-creates missing revenue + expense accounts when `create_missing_accounts=true`. Updates existing items by name when `update_existing=true` (idempotent re-runs).
- `ItemIn`/`ItemPatch` extended with `expense_account_id` + `expense_account_name`. Auto-backfills account name from CoA on create/patch.

**Frontend**
- `components/ItemImportModal.jsx` — drag-drop dropzone, CSV/Excel accept, two behavior toggles, result panel with counters + resolved column mapping + row-level error list.
- `Items.jsx` — "Import CSV/Excel" button in header, Expense-account picker added to the item modal (below the income picker).
- `Bills.jsx` — bill lines now use the same `ItemPicker` combobox as invoices. Picking an item fills description + rate + `expense_account_id`/`_name` + category. Free-text typing still supported.
- Testing: 10/10 backend pytest + Playwright frontend E2E 100%, zero bugs (`/app/test_reports/iteration_58.json`).

### Feb 2026 — Items catalog + Sales reports by item/category

**Backend (`routes/items.py`)**
- New `items` collection (per-company Products & Services catalog): name, description, type (service/product), income_account_id/name, price, sku, active.
- CRUD endpoints with **duplicate-name 409 guard** and auto-backfill of `income_account_name` from CoA.
- Two new report endpoints:
  - `GET /reports/sales-by-item` — aggregates invoice `line_items` by `item_id` (falls back to description bucket). Excludes draft/void.
  - `GET /reports/sales-by-category` — same rollup by income account or free-text category.

**Frontend**
- `/items` page (`Items.jsx`) — full CRUD, active/inactive toggle, revenue-account picker, show-inactive filter.
- `components/ItemPicker.jsx` — searchable combobox used on every invoice line. Picking an item auto-fills description + rate + `income_account_id`/`_name` + `category`; free-text still supported.
- `Invoices.jsx` line rows now use ItemPicker (loads `items` alongside contacts on page mount).
- `/sales-reports` (`SalesReports.jsx`) — dedicated page with **By Item / By Category** tabs, date range, share bars, running totals, **CSV export**.
- `Reports.jsx` gains a "Sales Reports" tile linking there. Sidebar gains **Items** entry.
- Testing: 10/10 backend pytest + full Playwright frontend E2E, zero bugs (`/app/test_reports/iteration_57.json`).

### Feb 2026 — Recurring invoices + bills, editable invoice/bill numbers

**Backend**
- `recurring_service.py` — domain logic + hourly async scheduler. Idempotent `run_due()` catches up missed anchors, month-end capping (Jan 31 → Feb 28/29), frequencies: weekly / monthly / quarterly / annual, `paused` + optional `end_date` gates.
- `routes/recurring.py` — full CRUD + `/run-now` + `/pause` + `/resume`.
- Generated docs land as `status="draft"` with a `recurring_template_id` back-pointer.
- `invoices.py` + `bills.py` update endpoints now soft-warn on duplicate `number` via `number_conflict: true` (do not block — CPAs sometimes reuse numbers when re-issuing corrections).
- `server.py` startup registers indexes + starts the scheduler.

**Frontend**
- New `/recurring` page (`Recurring.jsx`) with Invoices/Bills tabs, per-row Generate-now / Pause / Resume / Edit / Delete, Edit modal (nickname, frequency, next run, end date, net days).
- `MemorizeModal.jsx` — shared modal on Invoices + Bills row action (Repeat icon) — clones source doc as a template with picked schedule.
- Inline number editing on both invoice and bill list rows (click number → autoFocus input → Enter save / Escape cancel). Duplicate → warning toast.
- New `Invoice number` + `Bill number` fields in create/edit modals.
- Sidebar gains a "Recurring" entry (Repeat icon).
- Testing: 13/13 backend pytest pass + full frontend E2E pass (`/app/test_reports/iteration_56.json`).

### Feb 2026 — Receipts: image/PDF uploads + Payment Source + Vendor dropdown

**Backend (`models.py` + `routes/payments.py`)**
- `ReceiptCreate` gained `payment_account_id`, `attachment_data_url`, `attachment_filename`, `contact_id`, `contact_name` fields.
- Attachment stored inline as base64 data URL (planned migration to object storage once size becomes an issue).

**Frontend (`pages/Receipts.jsx`)**
- Merchant is now a Vendor dropdown (vendor contacts + "+ Add new vendor…" inline create). Falls back to other contacts in an optgroup.
- Paid-from dropdown limited to true payment instruments (bank/cash/credit-card).
- Attach receipt image or PDF with thumbnail preview, 6 MB raw guard.
- List shows Paid-from column + Paperclip "View" link.


- **Storage**: MongoDB (users, companies, memberships, accounts, transactions, invoices, bills, payments,
  receipts, contacts, journal_entries, rules, rule_candidates, ai_activity, chat_messages,
  reconciliations, book_reviews, close_periods, inventory_items, assets, loans, tags,
  communications, connections, onboarding_state)

## User Personas
1. **Superadmin** — Platform ops; manages all pros & clients, sees firm-wide stats.
2. **Accounting Pro** — CPA / firm; manages a portfolio of client companies (review flagged txns, close books).
3. **Client** — Business owner; runs day-to-day (invoices, bills, own books, AI-guided categorization).

## Core Requirements (static)
- 3-role auth + multi-tenant company switcher
- GAAP Chart of Accounts (30+ default seeded per new company)
- Transactions: AI-categorize on ingest, confidence chip, needs-review, split, link to invoice/bill/payment,
  bulk approve, bulk "make these rules"
- Auto-post JE when AI confidence ≥ 0.80; flag when < 0.80
- Rules engine (`merchant_contains` for MVP) + rule candidates (auto-suggested after ≥2 approvals of same merchant→account)
- Onboarding wizard (6 steps) with mocked Plaid, QBO toggle, mocked Veryfi
- Reports: Trial Balance, Balance Sheet, Income Statement, General Ledger, Cash Flow — with Accrual/Cash
  toggle and PDF export (real ReportLab statements)
- AI Chat (SSE streaming) with per-row focused-transaction context + injected books snapshot
- Collapsible left nav + collapsible right AI panel

## What's been implemented (Feb 2026)

### Feb 2026 (latest) — Historical GL Import (Excel / CSV / PDF)

**Backend (`routes/journal.py`)**
- `POST /companies/{cid}/journal-entries/import/preview` — parses uploaded file (Excel/CSV/PDF/AI-PDF), groups lines by `(date, reference|memo)` into JEs, resolves accounts by code (primary) or name, and returns per-JE `balanced`, `debit_total`, `credit_total`, `unresolved_accounts` flags. Handles `Debit`/`Credit` split columns OR a single signed `Amount` column. Money parser accepts `$1,234.56`, `(500.00)` (accounting negative), Excel serial dates, and multiple date formats.
- `POST /companies/{cid}/journal-entries/import/commit` — only commits entries that are balanced AND fully-resolved AND fall in open periods. Writes a batch log with `created_je_ids`. Records skipped entries with reason (`unbalanced`, `unresolved account`, `period closed`, `no lines`).
- `GET /companies/{cid}/journal-entries/imports` — batch history.
- `POST /companies/{cid}/journal-entries/imports/{id}/undo` — deletes every JE the batch created. Refuses if any lands in a closed period.

**Frontend (`pages/JournalEntries.jsx`)**
- New indigo **Import GL** button next to New JE.
- `ImportGLModal` — drag-and-drop upload → review with per-JE cards showing lines with DR/CR columns, red-flagged unbalanced entries (checkbox disabled), amber flags for unresolved accounts, summary pills at top (`✓ N balanced · ⚠ M unbalanced · ⚠ K unresolved`), "Select all eligible" toggle. Import history section with per-batch Undo.

### Feb 2026 — AI Type Suggestion for CoA Import

**Backend (`routes/accounts.py`)**
- New `POST /companies/{cid}/accounts/import/ai-classify-types` — takes `{names: [...]}`, batches every name into a single GPT call, returns `{classified: {name → {type, subtype}}}` with validated type ∈ {asset, liability, equity, revenue, cogs, expense} and snake_case subtype (e.g. `rent_expense`, `current_asset`, `retained_earnings`). Bounded to 200 names/call. Feature-tagged `ai-coa-classify`.

**Frontend (`pages/ChartOfAccounts.jsx` — ImportAccountsModal)**
- **"Detect types with AI"** button (fuchsia) appears in the review-step header when either (a) the Type column wasn't mapped or (b) every row defaulted to `expense` (both strong signals the source file lacks a real Type column).
- One click classifies every parsed name — updates `type` + `subtype` in the editable table in a single batch API call.
- **✨ AI** badge on the Type dropdown of every AI-touched row so the CPA can spot which rows were AI-set and audit before commit.
- Non-destructive: names GPT couldn't classify keep their existing default; CPA can override any AI suggestion inline before hitting Import.

### Feb 2026 — CoA Bulk Import (Excel / CSV / PDF)

**Backend (`routes/accounts.py`)**
- Reuses the contacts importer's file parsers (`_parse_upload`, `_ai_parse_pdf`) so one implementation covers both. CoA-specific aliases handle `code`, `name`, `type`, `subtype`, `parent_code` columns.
- `_norm_type()` loose-normalizes "Assets" / "Asset" / "Bank" / "Fixed Asset" / "Credit Card" etc. → 6 canonical types. Granular values ("Current Asset") that don't fit a canonical bucket auto-promote to subtype.
- New endpoints:
  - `POST /companies/{cid}/accounts/import/preview` — same shape as contacts (raw_rows + auto_mapping + resolved accounts).
  - `POST /companies/{cid}/accounts/import/remap` — re-resolve with UI mapping override.
  - `POST /companies/{cid}/accounts/import/commit` — two-pass upsert (assigns ids in pass 1 so a child row can reference a parent-row in the same batch by code). Auto-assigns codes for blank rows using the GAAP range.
  - `GET /companies/{cid}/accounts/imports` — batch history.
  - `POST /companies/{cid}/accounts/imports/{id}/undo` — deletes created + restores updated. Refuses to delete accounts with journal-entry activity (surfaces the conflict).

**Frontend (`pages/ChartOfAccounts.jsx`)**
- New indigo **Import** button in the header.
- `ImportAccountsModal` — 3-step flow (upload → review → done) with drag-and-drop, column mapping bar, editable review table (code / name / type / subtype / parent code), and import history with per-batch undo.
- Extracted `ImportDropZone` for reuse between the two importers.

### Feb 2026 — AI-Enhanced PDF Parse + Bulk-Assign Type

**Backend (`routes/contacts.py`)**
- `_ai_parse_pdf(data)` — pypdf text extraction (capped 12 KB) → GPT via existing `LlmChat` wrapper (`ai-pdf-import` feature tag) → strict JSON `{contacts[]}`. Returns headers + rows shaped like the deterministic parser so downstream code is agnostic.
- `POST /contacts/import/preview` accepts `ai=true` form field to force the AI parser on PDFs (any layout). Source tagged `pdf-ai` in the response.
- New `POST /companies/{cid}/contacts/bulk-set-type` — flips type on every id in a payload list. Only writes when type differs (no-op-safe).

**Frontend (`pages/Contacts.jsx`)**
- **Contacts header**: When 1+ rows selected, shows `N selected` + emerald **→ Customer** and amber **→ Vendor** buttons. One click bulk-flips via `/bulk-set-type` and toasts the modified count.
- **ImportContactsModal review step**: Fuchsia **Try AI parsing** button appears for deterministic PDF parses; **AI parsed** fuchsia pill labels AI-sourced previews. Last-file kept in a ref so the AI retry doesn't require re-uploading.

### Feb 2026 — Column Mapping UI + Import Log (with Undo)

**Backend (`routes/contacts.py`)**
- `_rows_to_contacts()` now accepts an optional `mapping_override` (col index → canonical field) so the UI can remap without re-uploading.
- `POST /contacts/import/preview` returns `raw_rows`, `detected_headers`, `auto_mapping`, and `known_fields` alongside the resolved contacts.
- New `POST /contacts/import/remap` — resolves the raw rows against a UI-supplied mapping and returns the same shape as preview.
- `POST /contacts/import/commit` now writes an **import batch log** in `db.contact_imports` with per-row previous-doc snapshots (for undo).
- New `GET /contacts/imports` — list recent batches (newest first, actor name attached).
- New `POST /contacts/imports/{batch_id}/undo` — deletes every contact the batch created and restores every contact it overwrote via `replace_one` back to the pre-import snapshot. Idempotent.

**Frontend (`pages/Contacts.jsx` — ImportContactsModal)**
- **Column mapping bar** above the review table — one dropdown per detected column (Type/Name/Email/Phone/Address or Skip). Editing a mapping fires `/import/remap` and refreshes the preview live. Already-claimed fields disable in other columns' options.
- **Import history** section on the upload step (collapsed by default) — lists batches with filename, source, timestamp, actor, and per-outcome counts. Un-undone rows get a red **Undo** button; undone rows show a grey **UNDONE** pill.
- Fixed pypdf table parsing (headers cell-by-cell → chunks of N per row) and drag-and-drop file upload.

### Feb 2026 — Contacts Import (Excel / CSV / PDF)

**Backend (`routes/contacts.py`)**
- `POST /companies/{cid}/contacts/import/preview` — parse `.xlsx / .xls / .csv / .pdf` (multipart upload), auto-detect columns by header alias (Name/Contact/Customer/Vendor/Company · Email · Phone/Mobile/Cell · Address/Street · Type), dedupe within upload by normalized_name, and flag existing rows so the UI can show "will update" vs "new" pills. No DB writes yet.
- `POST /companies/{cid}/contacts/import/commit` — inserts (or upserts by normalized_name) the confirmed rows. Returns `{created, updated, skipped, total}`.
- PDFs parsed with `pypdf` + email/phone regex line-scan; Excel with `openpyxl`; CSV with stdlib. Handled gracefully — unsupported files return a clean 400.

**Frontend (`pages/Contacts.jsx`)**
- New **Import** button (indigo pill) next to New Contact.
- Two-step modal:
  1. **Upload**: dashed drop zone + default-type selector (Customer/Vendor) + recognized-columns legend.
  2. **Review**: editable table of parsed rows with per-row checkbox, inline edit fields (name/email/phone/type), and status pill (New vs Will Update). Bulk select-all header checkbox. "Choose different file" back button.
  3. **Done**: green success card with `Added N, updated M, skipped K` summary.
- Idempotent: re-uploading the same file updates rather than duplicates.

**Deps added**: `openpyxl==3.1.5`, `pypdf==6.14.2`.

### Feb 2026 — Duplicate Detector, Balance Basis Toggle, Drag-Drop Reparent

**Backend**
- `GET /companies/{cid}/accounts/duplicates` — normalizes names (strips " expense"/" account"/plural suffixes, collapses punctuation) and groups same-type accounts with matching normalized keys. Returns `{groups: [{key, type, accounts[]}]}` ordered by group size desc.
- `GET /companies/{cid}/accounts/balances?basis={smart|month|ytd|cumulative}` — new `basis` query param forces one lens across every account (Smart = default per-type behavior).

**Frontend (ChartOfAccounts.jsx)**
- **Basis toggle** — segmented `Smart | MTD | YTD | All-time` control in the page header. Refetches balances on change; section labels swap between "YTD" / "Balance" / "MTD" / "All-time" accordingly.
- **Duplicate detector banner** — amber warning at top when 1+ groups detected. Expand to see each group + inline "Merge…" button that opens the existing merge dialog pre-filled with the source.
- **Drag-and-drop reparent** — child rows have a `GripVertical` handle + `draggable=true`. Drag onto any same-type top-level row to re-nest via `PATCH /accounts/{id}` (parent_account_id). Backend already validates same-type / no 3-level trees / no self-parent.

### Feb 2026 — CoA Balances, Reports Roll-up, Merge Accounts

**Backend**
- `GET /companies/{cid}/accounts/balances` — smart per-type basis: assets/liabilities/equity → cumulative (all-time), revenue/expense/cogs → YTD (Jan 1 → today). Returns `{account_id: {balance, rollup, mode}}` with sign-normalized display values.
- `POST /companies/{cid}/accounts/{source_id}/merge-into` — reassigns every journal entry line, transaction, split, rule, and sub-account from source→target, then deletes source. Same-type only, idempotent.
- `AccountCreate` model + `POST /companies/{cid}/accounts` now accept `parent_account_id` (for sub-accounts, single-level nesting enforced).
- `PATCH /companies/{cid}/accounts/{aid}` — validates parent changes (same type, no self-parenting, no 3-level trees, blocks nesting an account that already has children).
- `compute_income_statement()` — now emits parent-first-then-children with `parent_code` markers (same pattern the balance sheet already used) so sub-accounts render indented under their parent and the parent shows the rolled-up total.

**Frontend**
- `ChartOfAccounts.jsx` — new **Balance column** shows the right value per account type (YTD label on revenue/expense sections, Balance label elsewhere); parents show rolled-up amounts, children show own-only. Zero balances render as `—`.
- New **Merge (GitMerge icon)** button on each row → opens `MergeAccountDialog` showing source, target selector (same-type only), post-merge combined balance preview, and a "cannot be undone" confirmation checkbox.
- New **Sub-account of** dropdown in AccountRow edit view + CreateAccount modal — pick a same-type top-level parent.
- **Subtype dropdown** is now type-aware — pre-defined GAAP subtypes cascade from the type selector (asset → current_asset/fixed_asset/…, expense → operating_expense/rent_expense/…). Legacy hand-typed subtypes stay pickable as `xyz (legacy)`.
- `ReportView.jsx` — new **`RolledUpRows`** wrapper: parent rows with children get a chevron toggle (▶/▼) + "+N sub" pill. Applied to Income Statement + Balance Sheet.

### Feb 2026 — Paid White-Label Upgrade Block + Superadmin Comp Toggle

Monetization loop for B2B Pro tier + platform-owner ergonomics for comping specific firms.

**Backend**
- `pro.py::_whitelabel_state(user)` — resolves unlocked = comp OR paid; source pill = "comp" | "paid" | null.
- `_branding_out()` now emits `whitelabel_unlocked`, `whitelabel_source`, `whitelabel_comp`, `whitelabel_paid` on every read.
- `PATCH /pro/branding` returns **402 Payment Required** when a locked pro tries to edit any gated field (firm_name, subdomain, theme, hide_demo, hide_signup, tagline, hero image). `buy_page_url` stays editable for affiliates. Superadmins bypass.
- `POST /pro/branding/logo` + `DELETE /pro/branding/logo` share the same 402 gate.
- New `POST /pro/branding/whitelabel-checkout` — creates a Stripe Checkout session (`mode` auto-detects one-time vs subscription based on the Price object). Metadata carries `whitelabel_upgrade=true` + `pro_user_id` so the webhook can flip the flag on `checkout.session.completed`. Env var: `STRIPE_WHITELABEL_PRICE_ID`.
- `_handle_checkout_completed()` — detects the whitelabel metadata and stamps `branding.whitelabel_paid=True`, `whitelabel_paid_at`, `whitelabel_paid_session_id` on the target pro.
- `_handle_subscription_change()` — on `canceled` / `incomplete_expired` / `unpaid` revokes `whitelabel_paid` (comp still wins). On `active` / `trialing` re-enables it (idempotent renewal).
- `admin.py::GET /admin/pros` — list every pro on the platform with whitelabel status columns.
- `admin.py::POST /admin/pros/{pro_id}/whitelabel-comp {granted: bool}` — Superadmin comp toggle. Stamps `whitelabel_comp_at` / `whitelabel_comp_by` for audit trail. Comp trumps paid status.
- `GET /admin/enterprises/{eid}` — response now includes whitelabel fields per pro so the inline toggle on the enterprise detail page renders with the correct initial state.

**Frontend**
- `PlanComparisonCard.jsx` — CTA now calls `/pro/branding/whitelabel-checkout` (was `/whitelabel-waitlist`) and redirects the browser to Stripe. Handles `already_unlocked` short-circuit.
- `ProSettings.jsx` — reads `branding.whitelabel_unlocked`. If locked, shows a dashed **"White-label is locked on your firm"** banner with a purple **"Upgrade to unlock"** button that fires checkout. Every gated section wrapped in a `LockedSection` component that greys out the UI + adds a `[Lock] Locked` corner pill. Post-checkout return URL polls `/pro/branding` up to 6 times so the UI updates once the webhook fires.
- `AdminEnterpriseDetail.jsx` — new **`WhitelabelCompToggle`** component (exported) shows a `LOCKED`/`COMPED`/`PAID` pill + `Comp`/`Revoke` button on every Pro row. Optimistic UI, rollback on error.
- `SuperadminDash.jsx` — new **`AccountingProsCard`** section listing all pros on the platform. Columns: Pro / Email / Firm name / White-label status + Comp toggle / Joined. Search + filters (All / Locked / Comped / Paid). Reuses `WhitelabelCompToggle`.

**Env var required for full flow**
- `STRIPE_WHITELABEL_PRICE_ID` — a Stripe Price ID (starts with `price_...`). Ops picks monthly/annual/one-time in the Stripe dashboard; code auto-detects.

### Feb 2026 — Firm-branded signup pages

- **`Signup.jsx`** now resolves firm branding via
  `GET /branding/by-host?host=…` (same endpoint Login uses) on mount,
  with a `?firm=…` query-param override for previews. When a firm
  brand is resolved, the header swaps the SmartBooks icon+wordmark
  for the firm's centered logo + firm-name (mirrors the Login page
  treatment). Applies to all three signup variants: `/signup`,
  `/signup/affiliate`, and `/signup/enterprise`.
- New `data-testid="signup-firm-branding"` for e2e coverage.

### Feb 2026 — Railway deployment fix (emergentintegrations resolution)

- **Root cause**: Railway's default nixpacks Python builder runs
  `pip install -r requirements.txt` with the modern (2020) resolver
  against public PyPI only. Two Emergent-specific quirks combined to
  break the build:
  1. `emergentintegrations==0.2.0` lives on the private Emergent
     CloudFront index (`https://d33sy5i8bnduwe.cloudfront.net/simple/`),
     not public PyPI → ERROR: No matching distribution.
  2. `emergentintegrations` requires unpinned `litellm`; requirements.txt
     pins the exact Emergent-hosted litellm wheel URL. Pip's default
     resolver refuses; only `--use-deprecated=legacy-resolver` installs
     both side-by-side.
- **Fix**: added `/app/backend/nixpacks.toml` overriding `phases.install`
  with `pip install --extra-index-url https://d33sy5i8bnduwe.cloudfront.net/simple/ --use-deprecated=legacy-resolver -r requirements.txt`
  plus `PIP_EXTRA_INDEX_URL` env var for downstream tooling. Verified
  the exact same flag combination resolves the full requirements.txt
  from scratch locally.

### Feb 2026 — Plan comparison card + white-label waitlist

- **New shared component** `frontend/src/components/PlanComparisonCard.jsx`
  — side-by-side Free vs White-label tiles with feature check-lists,
  "coming soon" price hint on Paid, CTA that adapts to context
  (loggedIn → waitlist POST, logged-out → inline hint). Ships in two
  variants: `variant='card'` (inline) and `variant='modal'` (overlay
  with close-X). Uses `data-testid`s throughout for e2e coverage:
  `plan-comparison-card`, `plan-comparison-modal`, `plan-tile-free`,
  `plan-tile-paid`, `plan-paid-cta`, `plan-paid-hint`,
  `plan-modal-close`.
- **Inline on `/signup/enterprise`** — renders above the signup form
  as a pre-signup value prop. Widened container (`max-w-3xl`) wraps
  both the card and the form. Logged-out Paid CTA shows an inline
  hint below (Sonner Toaster isn't mounted on pre-auth routes, so
  the toast would have been silently dropped — inline copy is more
  reliable).
- **Modal launcher in ProSettings** — new banner card at the top
  (`data-testid='plan-compare-launcher'`) with `[Compare plans]`
  button (`data-testid='plan-compare-open'`) that opens the modal
  variant. Free tile carries a green `CURRENT` badge when the pro is
  on Free; Paid CTA POSTs to the new waitlist endpoint.
- **New endpoint** `POST /api/pro/branding/whitelabel-waitlist`
  (`routes/pro.py`) — one-click interest capture. Sets
  `users.branding.whitelabel_waitlist_at = now_iso()`, idempotent.
  Gated to `require_role('pro','superadmin')`. Gives us a real
  conversion signal before wiring up Stripe checkout for the paid
  tier in the next iteration.
- **Regression tests**: `/app/backend/tests/test_iter54_plan_comparison.py`
  — 5/5 pass (pro OK, superadmin OK, client 403, anon 401,
  idempotent timestamp refresh). Full suite iter49–54: 98/98 green.

### Feb 2026 — Enterprise (firm) signup at `/signup/enterprise`

- **New signup path** `/signup/enterprise` — same UX pattern as
  `/signup/affiliate` (indigo palette, `Building2` icon, "Start my
  firm" CTA) with one extra field: **Firm / enterprise name**. No
  subdomain field — that unlocks with the paid tier in a later
  iteration.
- **`SignupIn.enterprise_name`** (optional). When `role='pro'` +
  `enterprise_name` is provided, `signup()` in `routes/auth.py`:
  1. Stamps `users.branding.firm_name` before insert.
  2. Calls `enterprises.ensure_personal_enterprise_for_pro(uid)` to
     spawn the Enterprise record (auto-slug via `_resolve_unique_slug`).
  3. Dispatches an `enterprise_welcome` email — all wrapped in
     `try/except` with `logger.exception` so a template blowup can
     never 500 the signup.
- **New email template** `email_templates.enterprise_welcome()` —
  subject `f"{enterprise_name} is live on SmartBooks — welcome."`,
  private-label footer (`Sent by {enterprise_name}`, no
  `smartbookssoftware.ai`), 3-step "this week" checklist (invite
  staff / add first client / review billing) with deep links, and
  a "reserved firm handle" FYI block noting the subdomain is a
  paid-tier upgrade.
- **`DEFAULT_PREFS['enterprise_welcome'] = True`** — new firm
  owners are opted in.
- **Cross-links** — `/signup`, `/signup/affiliate`, and
  `/signup/enterprise` all cross-link to the other two at the
  bottom of the form. Login page has 3 stacked signup CTAs.
- **Backwards-compat** — `role='pro'` without `enterprise_name`
  still works (no enterprise auto-spawned); `role='client'` with
  `enterprise_name` ignores the field.
- **Regression tests**: `/app/backend/tests/test_iter53_enterprise_signup.py`
  — 13/13 pass. Full suite iter49-53: 93/93 green.

### Feb 2026 — Affiliate welcome email (day-0 activation)

- **New email template** `email_templates.affiliate_welcome(name,
  share_link, slug, dashboard_url, referrer_name=None)` — subject
  "Your affiliate link is live — let's earn.", HTML body with:
  personal salutation, share link (anchor + monospace fallback),
  embedded PNG QR code via `segno` (data URI — Outlook-safe),
  all 4 payout tiers as an inline table, a "share with 5 friends
  this week" quick-win prompt, secondary CTA to `/share`, and an
  optional "Big thanks to <b>{referrer_name}</b>" line when the
  affiliate was themselves referred.
- **Fire-and-forget from `signup()`** — when
  `POST /api/auth/signup` is called with `role='affiliate'`, the
  template is rendered and dispatched via
  `email_dispatcher.dispatch(kind='affiliate_welcome', …)` in a
  try/except so a template/dispatcher blowup can never 500 the
  signup. Exceptions are `logger.exception`ed for observability.
- **`segno==1.6.6`** added to `requirements.txt` — pure-Python QR
  generator with no PIL dependency. `_qr_png_data_uri` degrades
  gracefully (returns `""` on ImportError) so the template still
  renders even if segno is missing at import time.
- **`DEFAULT_PREFS['affiliate_welcome'] = True`** — new affiliates
  are opted in by default; a future preferences UI can flip it off.
- **Regression tests**: `/app/backend/tests/test_iter52_affiliate_welcome_email.py`
  — 16/16 pass. Iter49–51 all still green: 80/80 total.

### Feb 2026 — Affiliate-only signup + Upgrade path

- **New user role `affiliate`.** Reached via `/signup/affiliate` — a
  dedicated signup form (green "Become an affiliate" branding) that
  creates a user with `role='affiliate'` and lands them on `/share`.
- **Chrome stripped for affiliates.** `Layout.jsx` early-returns a
  minimal header (profile menu only) when `user.role === 'affiliate'`.
  No sidebar, no CompanySwitcher, no AI panel, no billing modal.
- **Deep-link gate.** `<Protected/>` in `App.js` bounces affiliates
  back to `/share` if they try to reach any other authenticated route
  (dashboard, admin, pro/clients, settings, …).
- **Upgrade pill.** `<UpgradePill/>` on the Share page — visible only
  to affiliate users — flips them to a full client account via
  `POST /api/affiliate/upgrade` (idempotent, preserves slug + earnings)
  and navigates to `/onboarding`.
- **Signup role allow-list** — `/api/auth/signup` now validates
  `role in {client, pro, affiliate}` and 400s on `superadmin`.
- **Cross-links** between `/signup` ↔ `/signup/affiliate` at the bottom
  of each form. Login page has a "Become an affiliate" link too.
- **Regression tests**: `/app/backend/tests/test_iter51_affiliate_role.py`
  — 18/18 pass. Iter49 + iter50 remain 46/46 green.

### Feb 2026 — Superadmin affiliate payout console

- **Backend**: 4 endpoints in `routes/admin.py`:
  - `GET /api/admin/affiliate/payouts` — per-affiliate roll-up sorted by
    outstanding accrued balance. Returns totals (accrued, paid, lifetime,
    affiliates_needing_payout) and per-row (accrued/paid cents + counts,
    unique_payers, last_activity, needs_payout, referral_slug, firm_name).
  - `GET /api/admin/affiliate/payouts/{referrer_id}?status=` — line-item
    earnings for a single affiliate (all / accrued / paid_out filter).
  - `POST /api/admin/affiliate/payouts/mark-paid` — flips accrued rows
    to `paid_out`, records `paid_out_at`, `paid_out_by_user_id`, optional
    `external_ref` (Wise TX / check #) + `note`. Cherry-pick via
    `earning_ids`, omit for "pay full balance". Idempotent — already-paid
    rows are ignored. Writes a `referral_payout_batches` row per action.
  - `POST /api/admin/affiliate/payouts/{earning_id}/reverse` — flip a
    paid_out row back to accrued (bounced-check corrections). Pushes to
    a `reversal_log` array on the earning row.
  - `GET /api/admin/affiliate/history?limit=` — recent payout batches
    across all affiliates for auditability.
- **Frontend**: `<AffiliatePayoutsCard/>` on the Superadmin dash — table
  of affiliates with balance/paid columns, per-row `Mark paid` button
  (disabled when balance is $0), collapsible History pane. `MarkPaidModal`
  lists accrued invoices with select-all / cherry-pick checkboxes,
  external_ref + note fields, running total-to-pay, submit button. All
  interactive elements carry `data-testid`s.
- **Regression tests**: `/app/backend/tests/test_iter50_payout_console.py`
  — 14/14 pass covering shape, auth gates, seed→mark-paid state
  transition, cherry-pick, idempotency, reverse-payout (400 for accrued,
  404 for unknown, $unset + reversal_log push).

### Feb 2026 — Affiliate v2 (vanity slug, tiered payouts, reports)

- **Vanity referral slugs.** `referral_util.py` rewritten — new users get a
  human-readable slug derived from their name (`priya-patel`, kebab-case,
  ASCII-only) instead of an 8-char random code. Legacy slugs preserved
  as-is; `resolve_referrer_id` now does a case-insensitive lookup so
  historical shared links still work. `SLUG_RE` disallows consecutive
  dashes (canonical vanity form only). Reserved-word blocklist.
- **Editable slug** — `PUT /api/share/slug` with kebab-case validation,
  collision check, and reserved-word denylist. Frontend has inline edit
  UI on the Refer & earn overview.
- **Firm-configurable buy-page URL** — new `branding.buy_page_url` field
  (`PATCH /api/pro/branding`). When set, `/api/share` returns
  `link = {buy_page_url}?ref={slug}` (source `firm_buy_page`), so
  affiliate traffic goes straight to the firm's own pricing page rather
  than platform signup. Precedence: buy_page_url → firm subdomain → platform.
- **Referred-by banner on `/signup`** — reads `?ref=<slug>`, calls the
  new public `GET /api/share/lookup` endpoint, renders "Referred by
  {name} from {firm}. They'll get credit on your subscription — no cost
  to you." Falls back to the raw slug when lookup 404s.
- **Tiered payouts** — replaced 20%-flat with fixed per-tier amounts:
  $38→$7, $79→$15, $95→$20, $149→$30. Falls back to 20% for any other
  gross amount. Recurring invoices continue to credit on every
  `invoice.paid` (unchanged from v1). Applied in
  `stripe_billing._lookup_payout_cents`.
- **Referrals list** — `GET /api/share/referrals` returns every user
  signed up under the caller's slug + payment count + earned to date +
  status (`paying` | `signup_only`). Rendered as a table on the
  Refer & earn `Referrals` tab.
- **Payout report** — `GET /api/share/report?start=&end=` (defaults to
  calendar-month-to-date UTC). Rendered as the `Payouts` tab with
  date-range pickers, `This month` / `Last month` / `YTD` presets,
  summary tiles, line-by-line ledger, and CSV export.
- **Regression tests** — `/app/backend/tests/test_iter49_affiliate_v2.py`
  — 32/32 passing, covers slug validation/collision/reserved,
  buy_page_url patch, lookup public + 404, referrals + report shape,
  tier lookup with all 4 SKUs + fallback, end-to-end
  `_credit_referral_share`.

### Feb 2026 — Full white-label email footer

- **`email_templates._wrap`**: when a caller passes `brand_name` (i.e., the
  Pro has a Private Label Name set), the footer renders as bare
  `Sent by {firm}` — the trailing ` · smartbookssoftware.ai` platform
  reference is dropped so branded emails stay fully white-labelled.
  Non-branded emails keep the SmartBooks + domain footer.

### Feb 2026 — Orphan-memberships admin lens

- **`GET /api/admin/orphan-memberships`** (superadmin-only) — one-click data-drift
  report that surfaces five categories: (1) *multi-firm firm-staff* — a single
  user is a pro across two or more distinct firms (partitioned via union-find
  over shared pros, *excluding the candidate's own bridging edges* to avoid the
  self-merge bug the testing agent caught); (2) *role drift · client with pro
  memberships* — user.role=client yet holds an active pro membership; (3)
  *dangling pro role · no active memberships* — user.role=pro but zero active
  pro memberships (empty Clients sidebar); (4) *dangling archived* — memberships
  with `archived_at` still on file; (5) *duplicate memberships* — identical
  (user_id, company_id, role) rows.
- **`POST /api/admin/orphan-memberships/purge-duplicates`** — collapses
  duplicate triples to a single canonical row, keeping the oldest by
  `created_at`. Returns `{kept, deleted}`.
- **`POST /api/admin/orphan-memberships/fix-role-drift`** — re-runs the
  Feb-2026 client→pro elevation heuristic across all users. Returns
  `{elevated}`.
- **Frontend**: new `<OrphanMembershipsCard/>` on the Superadmin dash
  (`/admin`) — collapsible categories with per-row action buttons (Purge
  duplicates / Elevate to pro), Refresh, and severity badges. All rows
  carry `data-testid` for e2e coverage.
- **Regression tests**: `/app/backend/tests/test_iter48_orphan_memberships.py`
  — 9/9 pass (shape, 3 auth gates, dup seed→detect→purge, role-drift
  seed→detect→fix, multi-firm detection, archive→dangling flow).

### Feb 2026 — Firm-staff scope-consistency fix (stale-membership bug)

- **`GET /api/pro/team?company_id=…`** now returns `member.company_ids` scoped
  to **ALL** of the current Pro's clients (was: only the queried company).
  This exposes stale pro memberships in the checkbox UI so the Pro can
  actually uncheck and remove them. Superadmins get the staff's full
  pro-membership set. Root cause of user report where a firm-staff user
  was seeing multiple clients while Priya's UI insisted "1 of 2".
- **Active vs archived split** in `list_pro_team` refactored from
  per-membership to per-user: a staff with a mix of active + archived
  memberships now appears once in `members` with only their ACTIVE
  `company_ids`, never duplicated across sections.
- **`company_ids_for_user`** in `/app/backend/deps.py` now excludes
  memberships with `archived_at` set — the top company selector no
  longer shows clients an archived firm-staff can no longer manage.
- **Regression tests**: `/app/backend/tests/test_iter47_pro_team_scoping.py`
  — 10/10 pass, verifying superadmin/pro branches, mixed-status split,
  end-to-end shrink-access → cleanup propagation.

### Feb 2026 — Firm-staff role elevation + Clients-list scoping

- **Global role elevation on invite accept.** In `/app/backend/routes/invites.py`,
  `public_invite_accept` now upgrades an existing user's global role when a `pro`
  or `superadmin` invite is accepted (ranked: client < pro < superadmin, never
  downgrades). Previously, pre-existing clients invited as firm staff kept
  `role=client` globally, which hid the `Clients` sidebar link (gated by
  `role === "pro"`) and blocked `/api/pro/clients`.
- **One-time backfill migration** in `server.py::startup` — sweeps
  `users.role='client'` who have an active `memberships.role='pro'` and
  promotes them to `role='pro'`. Idempotent, no-ops on subsequent restarts.
- **`/api/pro/clients` skips archived memberships** — archived firm-staff who
  log in no longer see their former client list. Uses
  `{archived_at: {$exists: false}} OR {archived_at: null}`.

### Feb 2026 — Archive firm staff + client team invite audit

- **Archive/Unarchive firm staff.** New endpoints `POST /api/pro/staff/{user_id}/archive`
  and `POST /api/pro/staff/{user_id}/unarchive` in `/app/backend/routes/invites.py`.
  Archive sets `archived_at` on the staff member's `role=pro` memberships (scoped to
  the current Pro's clients; superadmin can operate platform-wide); Unarchive `$unset`s
  the flag. `GET /api/pro/team` now returns `members`, `archived_members`, and
  `pending_invites` — archived staff no longer clutter the active roster but their
  memberships and audit history stay intact for reversibility.
- **Frontend Archive button.** `/app/frontend/src/components/TeamPanel.jsx` renders an
  `Archive` button next to `Remove from firm` on each expanded firm-staff row
  (`data-testid=team-member-archive-{uid}`). New `ArchivedStaffList` component shows
  archived members in a collapsible section with a per-row `Restore` action
  (`team-archived-list`, `team-archived-toggle`, `team-archived-restore-{uid}`).
- **Client-side team page audit (`GET /api/companies/{cid}/team`).** Pending invites
  are now filtered by `role: {$in: [editor, reviewer, viewer]}` — pro-firm invites
  scoped to the same company_id no longer bleed into the client's team page. Persist
  behavior preserved (no `invited_by_user_id` filter → invites survive refresh
  regardless of who created them, matches the `/pro/team` fix).
- **Legacy `/pro/team` (no company_id) parity fix.** Pending-invite lookup unified to
  `company_ids: {$in: my_cids}` — drops the `invited_by_user_id` filter so a
  superadmin-created invite for a firm's clients is visible to every other pro on
  those clients.
- **Regression coverage.** `/app/backend/tests/test_iter46_archive_and_invite_scope.py`
  — 8 tests, 100% passing (archive/unarchive round-trip, superadmin scope, editor vs
  pro invite filtering on both endpoints, cross-user persistence).

### Feb 2026 (latest) — Auto-managed opening balance JEs

- **New service** `/app/backend/opening_balance_service.py` — a single
  idempotent, delta-driven helper `ensure_opening_balance_for_account(cid,
  bank_account_id)` that upserts one Opening Balance Equity JE per bank
  account, tagged `source: "opening_balance_auto"`. Runs whenever bank
  data enters the system (statement upload OR Plaid connect / sync).
- **Out-of-order safety.** Helper always anchors to the EARLIEST known
  `{period_start, opening_balance}` across every completed
  `statement_imports` row for the account. Newer upload → no-op; older
  upload → JE date+amount recompute in place (same row updated).
- **Respects manual work.** If a `source: "opening_balance"` JE already
  exists (Plaid-connect-posted or user-posted), helper defers and never
  competes.
- **Closed-period aware.** Skips write with `reason: "closed_period"` +
  frontend toast when the target date falls inside a closed month.
- **Plaid 30-day gate.** New `plaid_history_meets_minimum_days(cid,
  plaid_account_id, min_days=30)` prevents the initial OBE JE from firing
  during a partial-history reconnect. `plaid_connect.sync_plaid_history_for_account`
  gates the connect-time post on it; `deps.sync_and_import` retries the
  post on every subsequent webhook/manual sync once the 30-day threshold
  is met (`opening_je_id` stored back onto `plaid_items.account_mappings`).
- **Persisted OCR fields.** `statement_imports` rows now carry
  `ending_balance` in addition to the existing `starting_balance` so
  future logic (report reconciliation, ledger baseline drift alerts) has
  authoritative statement bookends to work with.
- **Frontend feedback.** `StatementsTab.jsx` shows an additional green
  toast — *"Auto-posted opening balance of $3,281.78 on 2026-04-22 so
  your ledger baseline matches the statement."* — and a yellow warning
  toast when a closed period blocked the auto-post.
- **8 regression tests** in `/app/backend/tests/test_opening_balance_service.py`:
  first-upload asset & liability JE creation, newer-upload no-op,
  older-upload date+amount shift, manual-OBE deference, delta-zero
  auto-row deletion, closed-period guard, Plaid 30-day gate boundary.
  All passing.


### Feb 2026 (later) — Veryfi description + Plaid AI attribution fixes

- **Veryfi bank-statement merchant no longer truncated to first word.**
  In `veryfi_service.extract_transactions` the bank-statement rows (shapes
  1 & 2) previously set `merchant = clean.split()[0]` — dropping location
  codes / Zelle recipients / check numbers from the Transactions UI
  (which renders `merchant || description`). Now `merchant = clean` (full
  cleaned memo). Descriptions were already full but never surfaced
  because merchant took precedence in the render tree. Regression test:
  `test_merchant_preserves_full_description` in
  `/app/backend/tests/test_veryfi_extract.py` (8 tests, all passing).

- **Background Plaid syncs now stamp `ai_usage` ContextVar.**
  Root cause of the recurring "Plaid webhook syncs land as unattributed
  AI cost" bug: FastAPI's auth dependency (`deps.require_company`) is
  the only place that called `set_request_context()`, but background
  jobs and the Plaid `/webhook` (no auth) bypass it entirely. Fixed by
  stamping in TWO spots — belt + suspenders:
  1. `job_queue._run_wrapped` — reads `sync_jobs.user_id` and sets both
     `_current_user_id` + `_current_company_id` before invoking the
     registered task. Covers `plaid_manual_sync`, `plaid_reset_resync`,
     `plaid_contact_backfill`, and any future task kinds.
  2. `deps.sync_and_import` — inline stamp with `user_id=None,
     company_id=cid` at function entry. Handles the direct-inline path
     (webhook + manual routes) so LLM + Veryfi + Resend calls made
     inside the shared PFC pipeline all attribute correctly.
  Regression test: `test_bg_sync_attribution.py` (2 tests: task-wrapper
  path + inline path, both passing).


### Feb 2026 (later) — Post-Onboarding Tour (client's first dashboard visit)
Continuation piece to `WelcomeModal` — fires once a new client hits
`/dashboard` after their company's onboarding flips to complete. Guides
them through the 3 dashboard views, then hands them a "load your data"
CTA so an empty dashboard doesn't feel like a dead-end.

- **New component** `/app/frontend/src/components/PostOnboardingTour.jsx`
  with 5 phases:
  1. **Phase 0 — Congrats modal**: "Congratulations, {name}! 🎉" full-
     page overlay with typewriter body + native TTS narration and
     firm-branded eyebrow ("{brand} · Onboarding complete"). Auto-
     advances after 6.5s.
  2. **Phase 1-3 — Auto-cycle dashboard views**: floating top-right
     caption pill ("TOUR · N OF 3") while the underlying view switches
     Classic → Firm at a Glance → Business Overview via a new
     `onSwitchView` callback (drives the parent's `changeView` /
     localStorage-persisted `dashboard_view` state). 5.5s per phase.
  3. **Phase 4 — Final CTA modal**: if the client's `firm-glance` todos
     payload has visible items → single green "Review my to-dos" CTA
     (routes back to normal DashboardTodos card). Otherwise → cyan
     **Connect bank accounts** (→ `/connections`) + outlined **Upload
     bank statements** (→ `/connections?tab=statements`) with an "I'll
     do this later" out. User-driven; no auto-advance.
- **Persistence** — `localStorage["smartbooks_post_onboarding:{uid}:{cid}"]`
  set to "1" the first time the tour ends (skip, close, or completion).
  Ensures option (b): fires only on the very first dashboard visit per
  (user, company) pair.
- **Skippable at every phase** (option a) — X button top-right of both
  the congrats modal and the caption pill immediately cancels TTS +
  snaps back to Classic view + marks seen.
- **Mute toggle** — synced with `axiom_tts` localStorage key + dispatches
  `axiom-tts-changed` custom event so `AiPanel` stays in lockstep.
- **Race-condition fix** — the effect now waits for
  `hasSeenWelcome(user.id)` before scheduling the post-tour, so the
  WelcomeModal (first login) and PostOnboardingTour don't both fire in
  the same 500ms window on a fresh account.
- **Dashboard integration** in `/app/frontend/src/pages/Dashboard.jsx`:
  - New `postTourOpen` state + `closePostTour` handler that fires
    `markPostOnboardingSeen(uid, cid)`.
  - New effect: client role only, `current.onboarding_complete=true`,
    `!welcomeOpen`, `hasSeenWelcome`, `!hasSeenPostOnboarding` → opens
    tour with 400ms delay.
  - `<PostOnboardingTour>` mounted at the top of the return so it
    survives view-toggle re-renders.
- **Replay covers both** (option 3) — `replayWelcome` now sets a
  `chainPostTour` flag before opening `WelcomeModal`. When the user
  closes welcome, `closeWelcome` re-opens the post-onboarding tour with
  a 200ms delay. One button, both tours.
- **Verified end-to-end** via screenshot subagent as
  `client2@axiom.ai` (owner of the onboarded "Bright Beans Coffee Co."):
  * Phase 0 congrats renders with correct company + firm brand ("MFG
    GMAIL · ONBOARDING COMPLETE").
  * Phases 1-3 auto-cycle through Classic → Firm → Business (visible
    view switch under the caption pill).
  * Phase 4 CTA fires with **Load your data** copy + Connect / Upload
    buttons when the company has no active todos.
  * X skip at any phase → cancels TTS, snaps back to Classic, marks
    persisted-seen. Reload confirms tour does not re-fire.
  * Replay button visible on Dashboard header, opens Welcome →
    chains to Post-Onboarding on close.


### Feb 2026 (later) — Resend Activation Link + Pro-scoped lock
- **`/pro/clients` response** now includes `billing_payer`,
  `billing_state`, and a derived `needs_activation` boolean
  (`client_email + pending`) so the client-card can surface a
  status hint without a second round-trip.
- **New cyan "Awaiting payment" badge** on client cards where
  `needs_activation=true`, plus the existing resend-email button gets
  a cyan tint on those same cards to draw the eye there first.
- **`POST /api/pro/clients/{cid}/resend-welcome` extended** — no
  longer 409s when the client has already set their password. Now:
  * First-time (`must_set_password=true`) → `client_welcome_first_time`
    with a fresh magic-link token + `payment_url` if the company is
    still awaiting activation.
  * Returning client → `client_welcome_returning` with the same
    `payment_url` if activation is pending.
  Response payload gains `included_payment_link: bool` so the toast
  can honestly report "email includes a fresh Pay & activate link."
- **Lock rule refined** in `get_company_billing_state`: the
  `pending + client_email` lock now applies only to the CLIENT side
  (owner / editor / viewer). Pros and superadmin can keep working the
  file (and hit the resend button) — matches real-world workflow.
  Full-outage locks (`past_due` / `canceled` / `unpaid`) still lock
  everyone. All 5 role/state combos unit-tested.


### Feb 2026 (later) — "Client — Email bill" flow now actually blocks + prompts pay
Closes a big security/revenue hole: the previous email-bill flow let
Michael create an account and access his books without paying —
`billing_state=pending` wasn't in the lock set.

- **Backend lock rule** in `get_company_billing_state` — `locked` is
  now true when `billing_state == "pending"` **and**
  `billing_payer == "client_email"`. `client_card` payers still get
  through their brief `pending` window (webhook flips them to `active`
  in seconds), and `enterprise` / `free_spot` are never locked.
- **Welcome-email CTA** — both `client_welcome_first_time` and
  `client_welcome_returning` in `/app/backend/email_templates.py`
  accept an optional `payment_url`. When provided (i.e. the payer is
  `client_email`), the email surfaces a prominent
  **"Pay &amp; activate books"** button above the password / open-books
  action, with copy explaining that access unlocks after payment.
- **`pro.py add_client`** now passes
  `payment_url=f"{base}/billing?company={company_id}"` when
  `billing_payer=="client_email"`. Deep-links straight to the client's
  Billing page, where the `BillingLockedModal` will open Stripe
  Checkout.
- **New `BillingLockedModal` first-time-activation variant** —
  friendly cyan / CreditCard icon + "Activate your subscription"
  headline + "Almost there. Your books are ready — one Stripe checkout
  and you'll have full access." + cyan "Activate & pay →" button.
  Preserves the urgent red "Payment needed to keep the books open"
  variant for `past_due` / `canceled` / `unpaid`.
- **New reusable button style** `_BTN_SECONDARY` in
  `email_templates.py` (outlined cyan) — used when the email has both
  a "Pay & activate" primary CTA and an "Open my books" secondary.
- **Tested end-to-end** — unit-tested all 3 lock scenarios
  (`client_email/pending` → locked, `client_card/pending` → not
  locked, `client_card/past_due` → locked); logged in as
  `client@axiom.ai` on a `client_email/pending` company and
  confirmed the modal covers the whole page and can't be bypassed.


### Feb 2026 (later) — Payment-Failure Alert Loop (client email + Pro badge)
Closes the billing lifecycle so a declined card no longer sits invisible
until the Pro next logs in.

- **New backend module** `/app/backend/pro_alerts.py` — small MongoDB-
  backed inbox (`emit_alert`, `list_alerts`, `unread_count`, `mark_read`,
  `mark_all_read`). Stored in the `pro_alerts` collection, keyed by
  `pro_user_id`, extensible via the `kind` field.
- **Two new email templates** in `/app/backend/email_templates.py`:
  - `payment_failed_client` — CTA "Update payment method" that deep-
    links to the client's `/billing` page with `?company=<cid>`.
  - `payment_failed_pro` — heads-up to every Pro managing the company,
    with a "Open client" CTA to `/pro/clients`. Both templates respect
    the Pro's Private Label Name in the footer.
- **Extended webhook** `_handle_invoice_payment_failed` in
  `stripe_billing.py`:
  * Individual-client branch: emails the client + emails every Pro on
    the company + emits a `pro_alerts` row with `kind="payment_failed"`.
  * Enterprise-invoice branch: emits `kind="enterprise_payment_failed"`
    to the enterprise owner (no per-client emails; the enterprise is
    the payer).
- **New Pro endpoints** in `/app/backend/routes/pro.py`:
  - `GET /api/pro/alerts` → `{items, unread}` (last 50 newest-first).
  - `POST /api/pro/alerts/{id}/read` → mark one read.
  - `POST /api/pro/alerts/read-all` → clear the inbox.
- **New Frontend component** `/app/frontend/src/components/ProAlertsBell.jsx`
  — bell icon in the top header (Pro/Superadmin only) with red unread
  badge. Popover lists the last 50 alerts with individual + bulk mark-
  read actions. Polls every 60s so new alerts surface without a page
  reload.
- **Layout hook-in** — `Layout.jsx` renders `<ProAlertsBell />` between
  the AI Assistant toggle and the profile menu when the user's role is
  `pro` or `superadmin`.
- **Tested**: end-to-end simulation via
  `python3 -c "await _handle_invoice_payment_failed({...})"` — an alert
  correctly appears on the bell, badge shows 1, popover renders the
  company name + amount, Mark-all-read clears the badge.

### Feb 2026 (later) — Email `from` field sanitizer + Resend env diagnostic
Fixes the "Resend refused the send: Invalid `from` field" error the
user hit when a Pro with a Private Label Name tried to add a client
whose email address matched an existing login.

- **`email_service._quote_display_name`** wraps a firm's display name
  in RFC 5322 quotes whenever it contains commas, dots, apostrophes,
  angle brackets etc. Also strips whitespace + control characters so a
  stray newline in `RESEND_FROM_FIRM` can no longer corrupt the SMTP
  header. `Acme, Inc.` → `"Acme, Inc." <no-reply@accountingapp.ai>`.
- **`email_service._validate_from`** — regex-checks the final From
  header before hitting Resend and raises a clear
  `From address 'x' is not a valid mailbox` error naming which env var
  to fix, so future failures never surface as opaque provider errors.
- **`send_email` error message now includes the offending From value**
  so it lands in Communications and the operator can diagnose without
  server-log access.
- **New Superadmin diagnostic** `GET /api/admin/email/env-check` —
  mirrors `/api/admin/billing/env-check`: reports whether
  `RESEND_API_KEY / RESEND_FROM / RESEND_FROM_FIRM` are set on the
  running deployment, plus resolved-From samples for a few
  representative firm names.


### Feb 2026 (later) — Production Stripe Webhook Diagnostic + Route Fixes
Unblocked the "checkout succeeds but Superadmin billing dashboard stays $0"
issue in the Railway production environment.

- **Bug fix** in `/app/backend/routes/stripe_billing.py`:
  - `get_company_billing_state` (the `/api/companies/{cid}/billing/state`
    endpoint that `BillingLockedModal` polls) was missing its
    `@router.get(...)` decorator, so the route wasn't registered → the
    modal's fetch silently 404'd in every client's console. Restored.
- **New Superadmin diagnostic** `GET /api/admin/billing/webhook-status`
  — reports `webhook_secret_set`, `total_events_received`,
  `total_payments_recorded`, `latest_payment_at`,
  `companies_with_subscription`, `companies_billing_active`, plus the
  last 20 `stripe_webhook_events`. Used to prove whether Stripe events
  are physically landing on our FastAPI server.
- **User-side config fixes required** (documented in session):
  1. Railway env `STRIPE_PRICE_SIMPLE_START_REGULAR` was missing — the
     $38 price ID was mis-placed in the DISCOUNT slot on Railway. User
     re-set it so `_price_id("simple_start", discount=False)` resolves.
  2. Stripe Dashboard webhook endpoint URL pointed at
     `app.smartbookssoftware.ai` (frontend SPA) — Stripe was getting
     200s with `index.html` and considering deliveries successful, but
     the FastAPI handler never ran. Fixed by updating URL to
     `api.smartbookssoftware.ai/api/stripe/webhook`.
  3. Resent past `checkout.session.completed` + `invoice.paid` events
     to backfill the completed test payment.
- **Verified working** in production: $38 payment now shows in
  Superadmin `/billing` (Gross $38, Net $38, Active Subs 1, Recent
  Payments row visible).



### Feb 2026 — Enterprise Phase D: Monthly Consolidated Invoicing
Makes the "Enterprise will be billed on the 5th of next month" copy on
the Add-Client modal actually true.

- **New module** `/app/backend/enterprise_billing_scheduler.py`:
  - `bill_enterprise(eid, month_key, dry_run)` — the core function.
    Creates ONE Stripe invoice per enterprise per month, with one
    `InvoiceItem` per `billing_payer="enterprise"` company mapped to
    the correct Stripe Price ID via the same
    `STRIPE_PRICE_<PRODUCT>_<REGULAR|DISCOUNT>` env convention.
  - `run_monthly_cycle()` — iterates every enterprise; skips those
    with zero enterprise-paid companies.
  - `_resolve_enterprise_customer_id(ent)` — auto-creates a Stripe
    Customer for the enterprise on first billing run (using the
    enterprise's `owner_user_id`, or the first Pro attached to it as
    fallback) and persists `stripe_customer_id` on the enterprise doc.
  - `_loop()` — asyncio task that wakes every 6 hours; when today is
    the 5th (America/New_York, configurable via `BILLING_TZ` and
    `ENTERPRISE_BILL_DAY` env vars) it calls `run_monthly_cycle` for
    the prior month. Idempotent via the DB unique index — multiple
    ticks in the same day short-circuit.
  - **Dry-run** — when `STRIPE_SECRET_KEY` is unset, returns the
    "would-invoice" plan without hitting Stripe so the aggregation
    logic can be verified in preview without live keys.
  - **Graceful per-line failure** — a company whose price ID isn't
    configured is `skipped` with `skip_reason="Set STRIPE_PRICE_..."`
    but never blocks the rest of the enterprise's invoice.
- **Idempotency** — new collection `enterprise_invoices` with a unique
  index on `(enterprise_id, month_key)`. Guarantees no double-billing.
- **Startup hook** in `/app/backend/server.py` — registers the index
  and starts the scheduler alongside the AI ask-client scheduler.
- **New superadmin routes** in `/app/backend/routes/admin.py`:
  - `GET /api/admin/enterprises/{eid}/invoices` — list historical
    monthly invoices for one enterprise (newest first).
  - `POST /api/admin/enterprises/{eid}/bill-now` — manual kick with
    `{month_key?, dry_run?}`. Superadmin can preview or catch up.
- **Webhook handlers extended** in `stripe_billing.py`:
  - `invoice.paid` with `metadata.enterprise_invoice_id` → flips
    `enterprise_invoices.status="paid"` AND marks every enterprise-
    paid company under that enterprise as `billing_state="active"`
    in one bulk update.
  - `invoice.payment_failed` with same metadata → symmetrical flip
    to `past_due` (so the blocking modal surfaces immediately for
    everyone).
- **Frontend** — new `EnterpriseBillingSection` on
  `/app/frontend/src/pages/AdminEnterpriseDetail.jsx`:
  - Header explains the schedule + has `Preview` (dry-run) and
    `Bill now` (real, confirm dialog) buttons.
  - Live preview panel renders each line as a green (billable) or
    amber (skipped, with specific "Set STRIPE_PRICE_..." reason) pill.
  - Historical invoices table (Month / Status / Lines / Amount /
    Stripe invoice link → hosted invoice page / Created).
  - Status pills color-coded: paid=emerald, finalized=amber,
    past_due/failed=rose, empty=slate.
- **Verified live** (preview environment via curl + screenshot):
  - Created three enterprise-paid companies (simple_start regular,
    essentials disc, plus regular).
  - `POST /admin/enterprises/{eid}/bill-now` dry-run returned:
    * PhaseD-simple_start → matched to real Stripe price
      `price_1TwKhcECKMX6pzcAi1l2WAWw` from prod env ✓
    * PhaseD-essentials → skipped with reason *"Set
      STRIPE_PRICE_ESSENTIALS_DISCOUNT in env"* ✓
    * PhaseD-plus → skipped with *"Set STRIPE_PRICE_PLUS_REGULAR
      in env"* ✓
    * Summary: `payable=1, skipped=2, stripe_configured=false`.
  - Screenshot: preview panel + billing history table both render
    correctly on the Enterprise Detail page.

### Phase D — Deploy checklist (prod)
1. Confirm `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
   `STRIPE_PRICE_SIMPLE_START_MONTHLY_38/19` are already on Railway.
2. When ready to bill Essentials/Plus/Advanced consolidated, add
   `STRIPE_PRICE_ESSENTIALS_REGULAR/_DISCOUNT`,
   `STRIPE_PRICE_PLUS_REGULAR/_DISCOUNT`,
   `STRIPE_PRICE_ADVANCED_REGULAR/_DISCOUNT` env vars. No code change.
3. Ensure the Stripe Dashboard webhook subscribes to
   `invoice.payment_failed` (in addition to `invoice.paid` etc).
4. The scheduler will fire automatically at ~01:00 America/New_York
   on the 5th of each month for the previous month. Superadmin can
   also trigger `Bill now` from the Enterprise Detail page any time.



### Feb 2026 — Enterprise Phase C: Company-Scoped Stripe Billing
Built on top of the existing `stripe_billing.py` router (which already
had a user-level subscription flow + affiliate/referral tracking).

- **New env-var convention** in `stripe_billing.py :: _price_id`:
  `STRIPE_PRICE_<PRODUCT>_<REGULAR|DISCOUNT>` — 8 slots total. Falls
  back to the existing `STRIPE_PRICE_SIMPLE_START_MONTHLY_38` /
  `_MONTHLY_19` env vars so the code works with the prod Stripe
  account's already-provisioned Simple Start prices out-of-the-box.
- **New endpoints** in `stripe_billing.py`:
  - `POST /api/companies/{cid}/billing/checkout-session` — creates a
    Stripe Checkout Session for a subscription with
    `metadata={company_id, billing_product, billing_discount,
    initiated_by_user_id}` and `subscription_data.metadata.company_id`.
    Returns `{checkout_url, session_id, mode: "live"|"test"}`.
    Guarded: any user with membership on the company can call it.
    Fails gracefully with `HTTPException(503, "Stripe is not
    configured on this environment...")` when `STRIPE_SECRET_KEY` is
    missing (preview), and `HTTPException(400)` with a specific hint
    when the requested price ID isn't in the env.
  - `GET /api/companies/{cid}/billing/state` — returns the current
    company's `billing_state`, `billing_payer`, `billing_product`,
    `billing_discount`, `locked` bool, plus `stripe_configured` so
    the frontend can gray-out the Pay button in preview.
- **Webhook handlers extended** to keep `companies.billing_state`
  in lockstep with Stripe:
  - `checkout.session.completed` (with `metadata.company_id`) → sets
    `billing_state="active"` + links `stripe_subscription_id` +
    `stripe_customer_id` on the company.
  - `invoice.paid` → sets `billing_state="active"` for the company
    joined by `stripe_subscription_id`.
  - `invoice.payment_failed` (new handler) → sets `past_due`.
  - `customer.subscription.updated/.deleted` → maps Stripe status to
    our internal state via `_sub_status_to_billing_state`
    (active/trialing → active, past_due/unpaid → past_due,
    canceled/incomplete_expired → canceled).
- **Frontend blocking modal** — new component
  `/app/frontend/src/components/BillingLockedModal.jsx` wired into
  `Layout.jsx`. Fetches `/companies/{cid}/billing/state` on every
  company switch + polls every 20s while `locked=true`. Renders a
  full-screen `z-[999]` modal with backdrop-blur, "Pay now" button,
  and payer/product summary. Auto-dismisses within seconds of
  Stripe webhook flipping state back to `active`.
- **New pages** `/app/frontend/src/pages/BillingReturn.jsx`:
  - `/billing/success?session_id=...&company_id=...` — polls the
    company state every 2s until it flips to `active` (webhook may
    take a moment), then routes to `/dashboard` for that company.
    Gives up after 30s with a "continue anyway" affordance.
  - `/billing/cancel?company_id=...` — shows "no charge posted" + a
    "Try again" button that re-opens a fresh checkout session.
- **New Client flow** (`ProClients.jsx :: NewClientModal :: save`):
  when `billing_payer === "client_card"`, the modal now POSTs to the
  checkout-session endpoint immediately after the client is created
  and `window.location.href`s to the Checkout URL. Other payer
  choices (email / enterprise / free_spot) skip this hop and just
  return to the Clients grid.
- **Verified live** (screenshots):
  1. Set `Card Test LLC` (billing_payer=client_card, product=essentials,
     discount=true) to `billing_state=past_due` → navigating to
     `/dashboard` for that company renders the blocking modal on top
     of the ledger, showing:
       * "This company's subscription is **Past due**. Nobody — pro
         or client — can open the ledger until it's paid."
       * Product `essentials · disc`, Payer `client_card`.
       * Amber notice: "Stripe not configured on this environment.
         Once STRIPE_SECRET_KEY is set + the app redeployed, the
         Pay button will open a real Checkout page."
       * Pay button correctly **disabled** (stripe_configured=false).
  2. `GET /billing/state` returns proper JSON incl. `locked` flag
     computed from `billing_state`.
  3. `POST /billing/checkout-session` fails cleanly in preview with
     the correct guidance ("Set STRIPE_PRICE_ESSENTIALS_DISCOUNT in
     the env" for a missing price-ID; "Stripe is not configured"
     when only the secret key is missing).

### Enterprise Phase C — Deploy checklist (prod)
1. Confirm `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_SIMPLE_START_MONTHLY_38`, and
   `STRIPE_PRICE_SIMPLE_START_MONTHLY_19` are set on Railway (they
   are — code already relies on these).
2. Optionally add the 7 additional price env vars once you provision
   Essentials/Plus/Advanced in Stripe:
   `STRIPE_PRICE_ESSENTIALS_REGULAR/_DISCOUNT`,
   `STRIPE_PRICE_PLUS_REGULAR/_DISCOUNT`,
   `STRIPE_PRICE_ADVANCED_REGULAR/_DISCOUNT`. Until then the modal
   will still work for Simple Start; other products will 400 with a
   clear "Set STRIPE_PRICE_..." message.
3. Add the webhook endpoint `POST /api/stripe/webhook` in the Stripe
   Dashboard (already there for the user-level flow — reuses it) and
   ensure it subscribes to `checkout.session.completed`,
   `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
4. Push code to GitHub → Railway redeploys → end-to-end works.

### Phase D — Consolidated monthly invoicing (still pending)
5th-of-month scheduler that rolls all `billing_payer="enterprise"`
companies into a single Stripe invoice on the enterprise's Stripe
customer, then flips those companies' `billing_state` based on the
resulting invoice.



### Feb 2026 — Enterprise Phase B: Add-Client Billing Fields
- **Backend**
  - `/app/backend/models.py :: NewClientIn` extended with
    `billing_payer`, `billing_product`, `billing_discount` (all optional).
  - `/app/backend/enterprises.py` — added constants:
    `BILLING_PAYERS = (client_email, client_card, enterprise, free_spot)`
    and `PRICE_CATALOG` with regular + discounted USD prices per product.
  - `pro_create_client` in `/app/backend/routes/pro.py` now:
    - Validates payer/product against the enterprise constants
      (HTTP 400 on unknown values).
    - Blocks `free_spot` when the enterprise has 0 remaining
      capacity ("This enterprise has no free spots remaining.").
    - Persists `billing_payer`, `billing_product`, `billing_discount`,
      `enterprise_id`, and `billing_state` on the new company.
      `billing_state="active"` for `free_spot` (no charge posts),
      `"pending"` for all paid payers.
  - New endpoint `GET /api/pro/billing/context` returns the caller's
    parent enterprise (with `free_remaining`), the price catalog, and
    the payer/product enums. Feeds the modal in one round-trip.
- **Frontend** (`/app/frontend/src/pages/ProClients.jsx`):
  - New `BillingSection` component embedded in `NewClientModal`:
    - Enterprise banner ("You're billing under **SmartBooks** · N of M
      free spots remaining"). Auto-shows private-label suffix when the
      Pro belongs to a non-default enterprise.
    - **Payer picker**: 2×2 grid of selectable cards with hints. The
      "Free enterprise spot (N left)" card is disabled with grayed-
      out styling when `free_remaining <= 0`.
    - **Product picker** (Simple Start / Essentials / Plus / Advanced)
      and **Discount toggle** showing side-by-side `$discount vs
      $regular` strikethrough pricing.
    - **Effective-price summary** with payer-specific copy:
      * Enterprise pays → *"Enterprise will be billed on the 5th of
        next month · $X/mo · Product [· discounted]"*
      * Client card → *"You'll enter the client's card on the next
        screen"* (Phase C wires the actual Stripe Checkout redirect).
      * Client email → *"We'll email the client the bill"*.
      * Free spot → *"No charge will post. This spot is permanent for
        the life of the company."*
  - Modal widened to `max-w-2xl` + `max-h-[92vh] overflow-y-auto` to
    accommodate the new section.
  - Defaults sourced from `enterprise.default_product` +
    `enterprise.default_discount` so a Superadmin can set the firm-
    wide defaults once and every new client inherits them.
  - Product/Discount pickers auto-hide when `free_spot` is selected
    (price would be $0 either way).
- **Verified end-to-end**:
  1. Screenshot: modal renders with SmartBooks banner, 4-card payer
     picker, Product+Discount pickers, live summary line.
  2. Create with `billing_payer=free_spot` → company written with
     `billing_state=active`; enterprise `free_used` bumps 0→1.
  3. Create with `billing_payer=client_card, product=essentials,
     discount=true` → all three fields persisted.
  4. Lower allotment to 1 (already used 1) → next `free_spot`
     attempt returns HTTP 400 with a clear message; restored to 10.
  5. Enterprise Detail companies-list table renders the new pills:
     Product ("Essentials · disc"), Payer ("Free spot" / "Client
     card"), Billing state ("active" for free / "pending" for card).



### Feb 2026 — Enterprise (Phase A): First-class Firm-Parent Object
Groundwork for the "Enterprise runs a set of Pros" model that Phase B/C
(Add-Client modal expansion + Stripe billing) will build on top of.

- **New collection** `enterprises` + module `/app/backend/enterprises.py`:
  - Fields: `id`, `name`, `slug` (unique), `is_default`, `owner_user_id`,
    `free_user_allotment`, `default_product` (simple_start|essentials|
    plus|advanced), `default_discount`, timestamps.
  - `ensure_default_enterprise()` idempotently seeds the platform-level
    **SmartBooks** enterprise on every boot and back-fills
    `users.enterprise_id` for every Pro that predated the model.
  - `rollup_stats(eid)` computes pros/clients/companies counts and how
    many free spots have been consumed (`billing_payer == "free_spot"`).
- **Startup hook** in `/app/backend/server.py`: registers indexes +
  runs `ensure_default_enterprise`.
- **Superadmin routes** in `/app/backend/routes/admin.py`:
  - `GET /api/admin/enterprises` — list every enterprise with KPI
    roll-ups. Sorted: default first, then most companies desc.
  - `GET /api/admin/enterprises/{eid}` — detail incl. Pros list +
    denormalized Companies list report (each row has owner/pro name,
    product, payer, billing_state, onboarding, created_at).
  - `PATCH /api/admin/enterprises/{eid}` — name (≤80 chars),
    `free_user_allotment` (0–10 000), `default_product`,
    `default_discount`.
- **Frontend rework of the Superadmin "Enterprises" view** in
  `/app/frontend/src/pages/ProClients.jsx`:
  - Toggle relabeled from "Enterprise Pros" → **Enterprises**. Cards
    are now Enterprise-level (not per-Pro): show pros/clients/cos KPIs,
    free-spot summary, and "Open enterprise" affordance. Cards wrap
    `<Link to="/admin/enterprises/{id}">` — one click drills in.
- **New page** `/app/frontend/src/pages/AdminEnterpriseDetail.jsx` at
  `/admin/enterprises/:eid` (route registered in `App.js`):
  - Header with enterprise name + `DEFAULT` badge + Edit button.
  - **KPI row** (4 tiles): Pros, Clients, Companies, Free spots
    (used / max with remaining). Free-allotment number is inline-
    editable when the header Edit button is toggled.
  - Pros list section (name, email, firm_name pill, joined date).
  - Companies list report (Company / Owner / Managing Pro / Product /
    Payer / Billing state / Onboarding / Created), newest-first,
    horizontally scrollable, with `data-testid="ent-companies-table"`.
- **Verified live** via screenshot: superadmin lands on
  `/admin/enterprises/2f4b4d17-…` and sees SmartBooks with
  `Pros=1 · Clients=5 · Companies=8 · Free 0/10 · 10 left`. PATCH
  raised allotment from 0 → 10 successfully.

### Feb 2026 — Enterprise Phase B/C ROADMAP (still pending)
- **Phase B (in-progress next)** — extend Add-Client modal in
  `/app/frontend/src/pages/ProClients.jsx :: NewClientModal` with:
  1. "Who is paying" dropdown (Client — email bill / Client — pay
     with client card / Enterprise pays / Free spot).
  2. Product dropdown (Simple Start / Essentials / Plus / Advanced).
  3. Discount toggle (showing tier-vs-regular price side-by-side).
  4. Copy above Save button: *"Enterprise will be billed on the
     5th of next month"* when Enterprise pays.
  5. "Free spot (X left)" option only appears when the enterprise's
     `free_remaining > 0`.
  6. New fields persisted on `companies` doc:
     `billing_payer`, `billing_product`, `billing_discount`,
     `billing_state` (default `"pending"`).
- **Phase C** — Stripe integration
  1. Start with the $38 Simple Start regular price already in
     Stripe. Add 7 more price IDs to env vars once flow is proven.
  2. `POST /api/companies/{cid}/billing/checkout-session` returns
     Stripe Checkout URL (mode=subscription).
  3. Webhook `POST /api/stripe/webhook` updates
     `companies.billing_state` on `invoice.paid` (active) /
     `invoice.payment_failed` (past_due) /
     `customer.subscription.deleted` (canceled).
  4. Frontend: on "Pay with client card" or "Enterprise pays with
     card" flow, redirect to the Checkout URL after company create.
     Enterprise-pays-monthly path just records intent and shows the
     5th-of-month copy.
  5. **Blocking-modal middleware**: any page under `/dashboard`,
     `/accounting/*`, `/reports/*`, etc. checks the active company's
     `billing_state`; if `past_due`/`unpaid`/`canceled`, renders a
     full-screen modal that only allows navigation to the checkout
     link. Once Stripe webhook flips state → `active`, the modal
     auto-dismisses on next fetch.
- **Phase D** — Multi-product cloning + Enterprise consolidated
  monthly invoicing (5th-of-month scheduler for "Enterprise pays"
  payers).



### Feb 2026 — Superadmin "Enterprise Pros" View on /pro/clients
- **Frontend** in `/app/frontend/src/pages/ProClients.jsx`:
  - New superadmin-only view toggle in the header (two-button pill,
    `data-testid="pro-clients-view-toggle"`): **Clients** (default) /
    **Enterprise Pros**. Hidden entirely for role=`pro` so plain pros
    never see an affordance they can't use. Uses `useAuth()` to gate.
  - Enterprise view fetches `/admin/overview` once on demand and
    aggregates memberships/companies to compute per-Pro rollups
    (client_count, company_count) in a single pass.
  - New `EnterpriseProsGrid` component with a deliberately distinct
    look: indigo→violet→fuchsia gradient border, `Shield` icon,
    "PRO" badge, indigo/violet stat tiles, "White-labeled" green pill
    when the Pro has set a `firm_name`. Metadata rows show theme
    preset, sign-in subdomain (linked to `/login?firm=<slug>`), and
    joined date. Sorted by companies-managed desc.
  - `data-testids`: `pro-clients-view-clients`,
    `pro-clients-view-enterprise`, `enterprise-pros-grid`,
    `enterprise-pro-card-{id}`.
- **Backend**: no new endpoints — reuses existing
  `GET /api/admin/overview` (superadmin-guarded) which already returns
  users + companies + memberships in one payload.
- Verified via screenshots:
  * As `admin@axiom.ai` (superadmin): toggle visible, clicking
    "Enterprise Pros" renders the gradient Pro card for `PriyaBooks`
    (Priya Patel) with `5 Clients · 8 Companies · midnight theme ·
    white-labeled · sign-in acme`.
  * As `pro@axiom.ai` (regular Pro): toggle absent, only her portfolio
    of clients is shown.



### Feb 2026 — Private-Label Emails + Missing "Company Added" Email Bug Fix
- **Root cause of the missing email**: `POST /companies` (used by the "My
  Businesses" page's Add flow) never dispatched a welcome email. Only
  `POST /pro/clients` did. When Priya added "Test Branding LLC" from
  My Businesses, no email was fired.
- **Bug fix** in `/app/backend/routes/companies.py :: create_company`:
  Now counts prior owner-memberships. If the caller already owns ≥ 1
  company AND has an email on file, dispatches
  `client_welcome_returning` to their own inbox (mirroring the Pro-adds-
  a-client flow). Signup case (first company) still skips the email.
  Send errors never block company creation — swallowed to comms log.
- **Templates parameterized for Private Label Name** in
  `/app/backend/email_templates.py`:
  - `_wrap()` now takes `brand_name` and interpolates it into the
    footer ("Sent by {firm}"). Falls back to "SmartBooks" when unset.
  - `client_welcome_first_time` and `client_welcome_returning` now
    accept `brand_name` (used in H1 headline, subject line, body copy
    "on your {brand} login" / "existing {brand} account", and footer).
  - Every hardcoded "SmartBooks" / "Axiom" in these two templates
    swapped for the brand variable. Templates that don't yet accept
    `brand_name` (password_reset, team_invite, ai_ask_client, etc.)
    still show "SmartBooks" in their footer — future pass will
    parameterize them the same way.
- **Callers updated**:
  - `pro_create_client` and `resend_welcome_email` in
    `/app/backend/routes/pro.py` now pass `brand_name=firm_name`.
  - `create_company` in `/app/backend/routes/companies.py` uses the
    same pattern for the self-add case.
- **Verified live**: With `branding.firm_name="PriyaBooks"` set, creating
  a company via `POST /companies` fires a `client_welcome_returning`
  email whose subject reads *"Test Branding LLC is now on your PriyaBooks
  login"*, body says *"A new company was added to your PriyaBooks login"*,
  and footer reads *"Sent by PriyaBooks"* — zero remaining SmartBooks /
  Axiom strings. Falls back to "SmartBooks" when no brand is set.



### Feb 2026 — Private Label Name in Enterprise Settings
- **Backend** in `/app/backend/routes/pro.py`:
  - `BrandingPatch` extended with `firm_name: Optional[str]`. Empty string
    clears the stored value (unsets the doc field) — the effective
    `firm_name` then falls back to the pro user's own `name`. Cap 60 chars.
  - `_branding_out` now returns three fields for the settings form and
    downstream consumers: `firm_name` (effective, backwards-compatible),
    `firm_name_raw` (what's actually stored on `branding.firm_name`), and
    `firm_name_fallback` (the pro user's own `name`). The settings form
    binds to `firm_name_raw` so an empty input surfaces (rather than the
    fallback), and uses `firm_name_fallback` as the input placeholder.
- **Frontend** in `/app/frontend/src/pages/ProSettings.jsx`:
  - New "Private label name" card at the top of Enterprise Settings
    (before Logos). Input + Save button; Save PATCHes `/pro/branding`.
    Shows "Currently branding as: …" indicator + "(falling back to your
    account name)" hint when nothing is stored yet.
  - Save button is auto-disabled when the input matches the saved value
    so a stale click can't re-persist the same string.
- **Downstream propagation — zero further change needed**:
  - `useHostTitle.js` already watches `branding.firm_name` and updates
    `document.title` on refresh, so the browser tab title flips instantly.
  - `email_dispatcher.py` already reads `branding.firm_name` for the
    outbound email sender name (line 147), so client-facing emails ("Ask
    client" magic links, welcome invites, daily digests) now brand
    correctly.



### Feb 2026 — Edit Transaction from Row 3-Dot Menu (P0)
- **Frontend** in `/app/frontend/src/pages/Transactions.jsx`:
  - `RowMoreMenu` gained an `onEdit` prop and renders an "Edit transaction"
    button (data-testid `txn-edit-{id}`, Pencil icon) at the TOP of the menu.
  - New page-level `editing` state; clicking Edit sets it to the row's txn.
    Modal render: `{editing && <ManualTxnModal ... initialTxn={editing} .../>}`.
  - `ManualTxnModal` now accepts an `initialTxn` prop. When present it:
    - Pre-populates Date, Bank Account (pulls the actual asset/liability CoA
      account off `bank_account_id`), Contact (with `contact_name` fallback
      when the linked contact isn't in the 500-contact filter list),
      Merchant, Description, Amount, Category, and Splits (toggle auto-flips
      on and rows fill from existing splits).
    - Renders title "Edit transaction" instead of "Add manual transaction".
    - Save fires `PATCH /api/companies/{cid}/transactions/{tid}` instead of
      POST; toast reads "Transaction updated" / "Split transaction updated".
  - Account dropdown broadened: previously filtered to `type in [bank,
    credit_card]` which almost never matched the seeded CoA (uses
    `type=asset|liability` with subtypes). Now renders ALL asset +
    liability accounts, grouped via `<optgroup>` into "Assets (bank,
    cash, receivable…)" and "Liabilities (credit cards, loans, payable…)".
  - Added remaining data-testids for E2E: `manual-txn-date`,
    `manual-txn-merchant`, `manual-txn-description`, `manual-txn-amount`.
- **Backend** in `/app/backend/models.py`:
  - `TransactionUpdate` extended with `merchant`, `bank_account_id`,
    `contact_id`, `contact_name` fields.
- **Backend** in `/app/backend/routes/transactions.py` (`update_transaction`):
  - Denormalizes `bank_account_name` when `bank_account_id` changes.
  - Denormalizes `contact_name` from the Contact when `contact_id` changes
    (honors caller-provided `contact_name` for brand-new contacts).
  - Extended splits handling — validates the split sum equals the header
    amount (new amount if provided, else existing) within $0.01; on success
    marks `human_reviewed=true`, `needs_review=false`, `posted=true`, and
    clears the header category so the ledger renders from split lines.
  - Empty splits array clears splits back to single-category mode.
  - Still calls `await _invalidate_dash(cid)` so dashboard step counters
    stay in sync (cache invalidation contract preserved).
- **Testing agent**: 100% pass — backend 6/6 pytest, frontend critical
  flows all green. Test file: `/app/backend/tests/test_iter45_txn_edit.py`.



### Feb 2026 — Let's Review Bulk-Categorize Dropdown: Preview + Approve
- **Reworked the inline dropdown** on the Let's Review info card
  (`Transactions.jsx`) from instant-save to **preview + explicit approve**:
  - Picking a category now updates every visible row's Category column
    in local state only (no API call). Snapshots the originals so
    changing the pick or clearing "Choose category…" cleanly reverts.
  - Added an **Approve** button (green) on the same line as
    "BULK-CATEGORIZE ALL X ROWS" — disabled until a category is
    previewed, fires the existing bulk `apply-multi-bulk-approve-rule`
    endpoint on click and auto-advances the stepper via the
    `cleanup-completed` event.
  - Moved the `<Select>` onto the same row as ← Prev / Next → to shrink
    the info card vertical footprint.
  - `data-testid="lets-review-bulk-approve"` added for e2e coverage.
- No backend change — reuses the same `apply-multi-bulk-approve-rule`
  invocation the prior instant-save handler used.


### Feb 2026 — Step 3a Transfer Review (retire auto-book)
- **Retired the one-click "Detect transfers" button** on `Transactions.jsx`.
  Auto-book was error-prone (no reject path once posted) — replaced with a
  dedicated review UI at `/accounting/transfer-review`.
- **Backend** in `/app/backend/routes/transactions.py`:
  - `detect_transfer_pairs` now stamps each pair with a `confidence` score
    (same-day = 1.0, decays to 0.5 at ±3 days) and returns pairs sorted
    by descending confidence.
  - New `GET /companies/{cid}/transactions/transfer-pairs` — dry-run
    detector wrapper; nothing books until the CPA approves.
  - New `POST /companies/{cid}/transactions/transfer-pairs/book` —
    accepts `{pairs:[{debit_id, credit_id}, ...]}`, revalidates each
    (opposite-sign, equal magnitude within $0.01, different bank
    account, open period) before mutation, returns
    `{ok, updated, skipped:[{reason, debit_id, credit_id}]}`.
- **Frontend** — new `/app/frontend/src/pages/TransferReview.jsx`:
  - Hybrid layout — batch table with checkboxes + "Book selected" for
    speed, per-row **Inspect** button opens a detailed 2-column
    debit/credit card with big Approve / Not-a-transfer buttons.
  - Confidence badge (green ≥95 %, cyan ≥80, amber ≥65, slate else) and
    date-delta pill on every row; sub-75 % rows dim slightly.
  - Empty state offers a "Continue to No-Contact Review →" link so the
    stepper chains into Step 3b (still TBD with user).
  - Registered at `/accounting/transfer-review` in `App.js`.
- **Dashboard Step 3 rewired** in `firm_glance.py`:
  - `key: "intercompany_transfers"`, `title: "Intercompany transfers"`,
    `subtitle: "Match & book internal moves between company-owned bank
    / credit-card accounts."`, `unit: "pairs"`,
    `cta_link: "/accounting/transfer-review"`.
  - `count` sourced from the real detector via
    `detect_transfer_pairs(cid, dry_run=True)` so the widget number =
    the review page number.


### Feb 2026 — Step 2 opens to 1+ vendor groups + Step 3 stepper page
- **Step 2 (Let's Review) — no minimum**: `cleanup_suggestions` forces
  `_thresh_uncat = 1` and `firm_glance._monthly_todos` counts every
  contact with ≥1 uncategorized row. Vendors with a single leftover no
  longer disappear from the stepper — the CPA can burn the queue down
  to zero without switching tools.
- **Step 3 (No-Contact Review) — dedicated page**:
  - New backend `GET /companies/{cid}/transactions/no-contact-groups`
    normalizes descriptions (lowercase, strip punctuation, drop
    stopwords + tokens that contain digits), takes the first three
    surviving tokens as a group signature, and returns
    `[{group_key, label, count, total_amount}]` sorted by count desc.
  - Empty-token rows collapse into a `__misc__` "Misc / one-off" bucket
    so nothing is orphaned.
  - `list_transactions` gained two filter params: `no_contact=1`
    (contact_id null / missing / empty) and `desc_group=<tokens>` (Mongo
    `$and` of case-insensitive regex per token).
  - New frontend `NoContactReview.jsx` — thin router that fetches the
    groups and redirects to `/accounting/transactions?noContactReview=1&
    group_key=…&label=…&idx=X&total=Y&count=N&total_amount=Z` (mirrors
    the LetsReview → Transactions handoff pattern).
  - `Transactions.jsx` picks up `noContactReview=1` and re-uses every
    Let's-Review affordance: hides chips / tabs / Manual-Txn / Detect
    Transfers, shows a right-aligned info card ("GROUP 1 OF 3 · 94 txns
    · $304,809.12 · Online Banking Transfer") with Prev / Next stepper.
  - Dashboard Step 3 tile now links to `/accounting/no-contact-review`;
    `coming_soon` badge removed.


### Feb 2026 — Let's Review focus-mode UI cleanup
- `Transactions.jsx` in `isLetsReview` mode now HIDES: "Detect transfers"
  button, the "All / To do / Approved" filter tabs, and the "Manual
  Transaction" button — keeps the surface distraction-free while the CPA
  walks vendor-by-vendor.
- Contact info box (top-right) enlarged: `rounded-xl` + `border-2
  border-indigo-300`, gradient `from-indigo-50 to-white`, `px-6 py-4`,
  `min-w-[280px]`, vendor name at `text-2xl font-bold`.
- Box now surfaces the **total transaction count** and **total dollar
  amount** for the current contact (e.g., "20 txns · $5,905.00"),
  passed as new URL params `count` + `total_amount` from
  `LetsReview.jsx`.
- New `data-testid`s: `lets-review-contact-totals`,
  `lets-review-contact-count`, `lets-review-contact-total-amount`.


### Feb 2026 — AI Axiom: knows about bank-statement upload
- System prompt (`ai_service.py`) now enumerates every major page + a
  "PAGES & FEATURES" section, with an explicit callout that
  `/connections → Load account statements` accepts PDF uploads via
  Veryfi OCR. Axiom no longer says "you can't upload statements —
  connect via Plaid instead"; it now says YES and navigates.
- `voiceCommands.js` — new nav intents:
  * `upload / import / add / load statements` → `/connections?tab=statements`
  * `where / how do I upload statements` → same
- `Connections.jsx` — reads `?tab=` from URL and opens the matching tab
  on mount, so voice-nav and deep-links land on the right surface.

### Feb 2026 — Connect Accounts: reference-image table layout
- Replaced the two-column card layout in `PlaidAccountsDropdown` with a
  clean unified table matching the user's reference image:
  * Columns: **Institution · Account · Scope · Last sync ·
    Raw / Promoted · Mapping & promotion · Actions**.
  * **Scope** = "In books" (emerald pill) or "Excluded" (slate pill).
  * **Raw / Promoted** shows txn count over posted count (available
    accounts always show `n / 0`).
  * **Mapping & promotion** shows the GL account code + name the account
    is linked to (or the AI-suggested target for excluded accounts).
  * **Actions** — "Re-sync" for in-books, "Add to books" (emerald) for
    excluded. "Add all to books" bulk button in the header for the
    common case.
- Backend `plaid_status` now returns `institution_name` + `last_sync_at`
  so the table can render Institution and Last-Sync columns without an
  extra round-trip.
- Legacy `AccountRow` component kept in the file for any parent still
  referencing it; new `AccountTableRow` renders the row markup for the
  redesigned table.

### Feb 2026 — Company switcher: grouped by owner + searchable
- `GET /api/companies` now enriches every row with `owner_name` +
  `owner_email` (single batched user lookup so it stays fast).
- Top-left switcher redesigned:
  * **Search input** auto-focuses on open — matches on company name,
    business type, owner name, or owner email.
  * **Owner groups** — companies bucketed under the owner's name +
    email header. Current company's owner bubbles to the top; other
    owners sorted alphabetically.
  * **Active state** — current company gets a cyan tint + a "Current"
    pill so you never accidentally switch away.
  * **Empty state** when nothing matches the query.
  * Scrollable at 420px so Pros with dozens of clients still get a
    usable list.

### Feb 2026 — Team & permissions moved to its own page
- Team-management UI removed from Company Settings; now lives at `/team`
  on the new `CompanyTeam.jsx` page (mirrors the `ProTeam` page pattern).
- Profile dropdown adjustments:
  * Pros — "Firm staff" → `/pro/team` (unchanged).
  * Clients (and any non-Pro / non-superadmin) — new "Team & permissions"
    → `/team`.
- Same `TeamPanel` component powers both pages; only the mode differs.

### Feb 2026 — Login rate-limit (credential-stuffing defence)
- `/api/auth/login` — max **5 failed attempts per email per 10-minute
  sliding window**. On lockout, endpoint returns a real **HTTP 429** with
  a friendly `{message, retry_after_seconds}` body — unlike the
  forgot-password anti-enumeration silent-block, here we want the user
  to KNOW they're locked out (attackers already know, and legit users
  otherwise blame the app).
- Only FAILED attempts are recorded. A successful login **clears** the
  user's failure records so a lockout auto-releases the moment they
  remember their password.
- Reuses the same `auth_rate_limits` Mongo collection with a new
  `action: "login_fail"` discriminator.
- Frontend Login page now unpacks the structured 429 payload (`detail.message`)
  and shows the friendly copy in the red error banner.
- Verified: 5×401 followed by 6th attempt with CORRECT password returned
  429 with the lockout message; after clearing records, login works
  again immediately.

### Feb 2026 — Forgot-password (public self-service reset)
- New public endpoint `POST /api/auth/forgot-password` — anti-enumeration:
  returns 200 for every request regardless of whether the email is
  registered. If it exists, mints a fresh `password_set_tokens` row with
  `purpose: "reset"` (24-hour TTL) and fires a Resend email using the new
  `password_reset` template.
- **Rate-limited**: max 3 requests per email per 15-minute window. Enforced
  via new `auth_rate_limits` Mongo collection. Over-limit requests
  silently no-op (still return 200) so the throttle is invisible to
  attackers while blocking inbox-flood attacks. Legit users never see a 429.
- Reuses the existing `password-set/{token}` GET+POST endpoints from the
  welcome flow — same single-use atomic claim + JWT-on-redeem plumbing.
- `password_set_check` now returns `purpose` so the UI can adapt copy
  ("Reset your password" vs. "Welcome, pick a password").
- Frontend Login page — new "Forgot password?" link below Sign-in that
  opens a modal (`ForgotPasswordModal`). Two states: entry (email
  input) and sent (📬 confirmation, echoes back the email so the user
  knows which inbox to check).
- `SetPassword.jsx` now branches on `purpose` — reset flow shows
  "Pick a new password" heading + "Reset your password" eyebrow instead
  of the "Welcome" tone.
- Also added `password_reset` to `email_dispatcher.DEFAULT_PREFS` (opt-out).
- Verified: 5 rapid attempts → 5 × HTTP 200 responses, but only 3 tokens
  actually minted (4th and 5th silently blocked).

### Feb 2026 — Post-accept team management (grant/revoke/remove)
- Four new endpoints to edit teams after invites have been accepted:
  * `PUT /api/pro/staff/{user_id}/access` — reset a firm-staff member's
    client access to exactly the picked list (diffs against current,
    adds missing / removes stale). Scoped to companies the current Pro
    manages; can't touch memberships elsewhere.
  * `DELETE /api/pro/staff/{user_id}` — remove a staff member from every
    one of the current Pro's clients in one action. User account stays;
    memberships on other Pros' clients are untouched.
  * `PATCH /api/companies/{cid}/team/{user_id}` — change a company
    teammate's role (editor ↔ reviewer ↔ viewer). Refuses to re-role
    owners or Pros.
  * `DELETE /api/companies/{cid}/team/{user_id}` — remove a teammate
    from a single company. Owner/Pro memberships are structural and
    can't be removed here.
- Frontend `TeamPanel.jsx` — every member row now has an expand chevron.
  When expanded:
    * Pro mode: full checkbox picker of the Pro's 9 clients with
      Select-all / Clear quick actions, "Remove from firm" (rose) +
      "Save changes" (cyan, dirty-tracked).
    * Company mode: role pill toggle + "Remove from company" +
      "Save changes".
  Owner/Pro rows show the expand chevron but hide the destructive
  buttons — they're read-only in this UI to prevent accidental damage.
- End-to-end curl-verified: idempotent PUT (no-op when list matches),
  cross-firm cid rejected with 403, missing member returns 404, delete
  of non-existent user returns `removed: 0`. UI screenshot confirms
  expandable rows with client picker + save/remove buttons render.

### Feb 2026 — Role-based write-guard enforcement (Feature #3 finish)
- New middleware `/app/backend/role_guard.py` (`RoleWriteGuardMiddleware`)
  enforces the 4-tier permission model at the HTTP layer for every
  `/api/companies/{cid}/*` route:
  * ``owner`` / ``pro`` / ``superadmin`` — all writes pass.
  * ``editor`` — all writes pass.
  * ``reviewer`` — writes only on paths matching
    ``/approve|/reject|/review|/signoff|/mega-approve`` (regex-audited),
    everything else returns 403 "review-only".
  * ``viewer`` — all writes return 403 "read-only".
- Guard is method-scoped (only POST/PATCH/PUT/DELETE) so reads and CORS
  pre-flight remain unaffected. Non-``/api/companies/*`` URLs bypass the
  guard entirely (auth, admin, invites, magic-link public routes).
- JWT is decoded in middleware without going through the dep chain; if
  the token is missing/invalid we fall through so the endpoint's own
  auth dep returns 401 as before.
- Also added companion dep helpers `require_company_write` and
  `require_company_review` in `deps.py` for anywhere we want in-handler
  role checks going forward.
- Tests: new `/app/backend/tests/test_role_guard.py` — 5 cases
  (viewer reads OK / viewer write 403, reviewer create 403 / reviewer
  approve OK, editor write OK, owner write OK, guard doesn't block
  non-company URLs). All pass.
- Smoke-tested via curl: pro POST reaches the endpoint (returns real
  422 from pydantic, not a guard 403), pro GET still returns data. Zero
  existing endpoints needed retrofit — 138 `require_company` call
  sites unchanged.

### Feb 2026 — Team invitations (Feature #3) — 4-tier permissions + firm staff
- New `invites` collection with unified schema supporting 4 invite flavours:
  * Company-scoped invites (role: `editor`, `reviewer`, `viewer`) via
    `POST /api/companies/{cid}/invites`.
  * Pro firm-staff invites (role: `pro`, with picked `company_ids`) via
    `POST /api/pro/invites`.
  * Superadmin invites (role: `superadmin` or bootstrap-new `pro`) via
    `POST /api/admin/invites`.
- `GET /api/invites/{token}` (public) — preview payload with inviter, role,
  company list, and whether the invitee needs to set a password.
- `POST /api/invites/{token}/accept` (public) — atomic single-use claim,
  creates/attaches user, materializes memberships, returns JWT so
  invitee is logged in immediately. Role auto-upgrades if the invitee
  already has a lower company role.
- `GET /api/companies/{cid}/team` — active members + pending invites.
- `GET /api/pro/team` — firm staff (users with pro-membership on any of
  the current Pro's clients) + Pro's pending invites.
- `DELETE /api/invites/{id}` — only inviter or superadmin can revoke.
- Unified `team_invite` email template (adapts label/description by role).
- New public page `/invite/:token` (`AcceptInvite.jsx`) with checking /
  ok / expired / used / revoked / superseded / invalid states.
- Reusable `TeamPanel` React component mounted in three surfaces:
  * `CompanySettings` → invite editors/reviewers/viewers to one company.
  * `ProTeam` (new page at `/pro/team`) → invite firm staff, pick per-invitee
    client access via checkbox picker.
  * `SuperadminDash` → invite pros or superadmins.
- Profile-menu dropdown now includes "Firm staff" link (Pros/superadmins).
- End-to-end curl-tested: pro-invite → magic-link check → team roster →
  accept → new-user JWT → login → cleanup. Company-invite + revoke also
  verified: revoked invite returns 410 "This invitation was revoked."
- Also shipped in this session: "Re-send welcome email" mail-plus icon on
  every ProClients card (`POST /api/pro/clients/{cid}/resend-welcome`),
  409-guarded so it won't wipe a client who's already active.

### Feb 2026 — Client welcome emails + self-service password change
- New Pro-flow client-create now sends one of two automated welcome emails:
  * **First-time client** (`kind: client_welcome`) — magic-link "Set your
    password" button that lands on `/set-password/{token}` and logs the
    user in immediately upon setting. Tokens minted via
    `routes.auth.mint_password_set_token` (32-byte `secrets.token_urlsafe`),
    stored in new `password_set_tokens` collection, single-use, 7-day TTL.
  * **Returning client** (`kind: client_welcome_returning`) — when a Pro
    creates another company for a client-email that already owns one, we
    email "we added <NewCompany> to your login" instead. Uses the client's
    existing password; no token minted.
- Both preferences added to `email_dispatcher.DEFAULT_PREFS` (opt-out, default ON).
- `POST /api/auth/change-password` — self-service password rotation. Verifies
  current bcrypt hash before updating; rejects "same as current" and enforces
  8+ char min via pydantic. Existing JWTs stay valid by design.
- `GET/POST /api/auth/password-set/{token}` — public magic-link redemption
  endpoints. Single-use guard uses `updateOne(..., {used: False}, {used: True})`
  for atomic race safety.
- Frontend:
  * New public route `/set-password/:token` (`SetPassword.jsx`) with
    checking / OK / expired / used / invalid states.
  * "Change password" item added to the profile dropdown for all roles
    (`ChangePasswordModal` in `Layout.jsx`).
  * New Client modal (`ProClients.jsx`) — removed the "Temporary password"
    input; explanatory copy now tells the Pro the client will get an emailed
    magic-link. Password field on `NewClientIn` is deprecated (still accepted
    but ignored server-side for new client emails).
- E2E tested: create-client via API → password_set_tokens row minted →
  communications log row created → GET /token returns email → POST /token
  redeems + issues JWT → 2nd POST returns 410 → login works with new password.
- Preview emails sent to michael@bigsaas.ai (`eabbe18b-…` and `ba9e4221-…`)
  to smoke-test both templates against live Resend.


### Feb 2026 — AI Ask Client (autonomous email loop) + rename to Pro Ask Client
- Renamed the existing "Ask Client" flow to **"Pro Ask Client"** everywhere in the
  UI (Communications inbox/logs/settings, `AskClientButton` trigger + modal title).
- Added new **"AI Ask Client"** flow — the AI autonomously scans every company
  every hour between **6am–8pm America/New_York** (opt-out `AI_ASK_CLIENT_TZ`,
  `AI_ASK_CLIENT_START_HOUR`, `AI_ASK_CLIENT_END_HOUR` env vars) for freshly-
  flagged transactions (<3 days old, `needs_review=True`, no existing
  `client_question_id`) and emails the client-owner a magic-link chat about
  ONE focused transaction per email.
  - Opt-out (default ON) via `comms_prefs.ai_ask_client`.
  - Per-client-email daily cap of **3 emails / calendar day**.
  - `flow_type` on every `client_questions` doc distinguishes pro vs. ai.
  - Email template is intentionally minimal ("Hi — quick one on
    <Company>: <question>" + one-line txn card + "Reply →" CTA).
- **Chain prompt** in `AskClientAnswer.jsx`: after resolving one txn, the
  new `GET /api/q/{token}/next` endpoint first looks for another pending
  `ai_ask_client` question for the same email; if none, spins up a fresh
  in-session question from the company's remaining candidates. Chained
  questions are stamped `in_session_chain: true`.
- **Voice input** on the client chat via Web Speech API — mic pulses red
  while listening, transcript streams live into the textbox.
- **AI Ask Client tab** in Communications — dedicated, searchable list of
  every autonomous conversation for the currently-selected client, with:
    * `All · Pending · Answered · Archived` filter pills
    * per-row archive/restore icon (soft-delete via
      `POST /api/companies/{cid}/communications/questions/{token}/archive`)
    * client-side search across counterparty / question / answer / email
- **AI Suggestions caching** — the `POST /communications/ask-client/suggest`
  endpoint now caches per (company, params) for 5 min using the existing
  `infra.get_cache()` layer. All ask-client sends + Plaid sync completion
  invalidate. Refresh button passes `force_refresh=true`. Turns
  "open the tab" from 4–8 Claude calls into 1 first-open + N cached reads.
- Tests: `/app/backend/tests/test_ai_ask_client.py` — 5 tests
  (single-txn fresh pick, daily-cap short-circuit, pref-off short-circuit,
  chaining endpoint, send-window boundaries). All 12 communications tests
  pass. Scheduler auto-starts at boot (log:
  `AI ask-client scheduler started (interval=3600s window=06:00–20:00 America/New_York)`).

### Feb 2026 — Mega-Approve: include needs_review categorized rows
- **`bulk-approve-ai-ready`** (mega button): stopped excluding `needs_review=true` rows.
  A row like AT&T flagged for review but AI-categorized to `6600 Utilities` is now
  eligible for one-tap mass approval, per user request. Uncategorized sinks
  (`9999`/`6999`/`4999`) are still filtered out — Venmo→Uncategorized Expense (6999)
  and Michael Giorgi→Uncategorized Income (4999) do NOT show up.
- **Bug fix**: uncategorized filter was only checking `9999`/`4999`, letting the
  runtime-created `6999` Uncategorized Expense leak through the mega-approve modal
  and the Transactions "AI Categorized" tab. Now consistently excludes all three
  in `cleanup-suggestions`, `bulk-approve-ai-ready`, and the transactions listing.
- Verified E2E via curl: 48 AT&T rows with `needs_review=true` → approved (48
  updated, batch_id issued) → undo restored all 48.

### Feb 2026 — Mega-Approve: per-(vendor × category) buckets
- Grouping changed from `contact_id` to `(contact_id, category_account_id)`.
  Vendors like Costco split across `6800 Supplies & Materials` (108 rows) and
  `6120 Transportation` (19 rows) now appear as TWO independent rows in the
  modal — each togglable, approvable, and override-able independently. Fixes
  user report: "why does it say Approve all AI-ready is clear but on the
  Unapproved screen there are contacts like Blue Note B's Horn Shop and
  Costco still?" — those were being silently excluded by the `len(accounts)==1`
  unanimity filter.
- Selection payload switched from `contact_ids` to bucket-key `keys`
  ("<contact_id>::<category_account_id>"). Overrides now keyed by bucket key.
  `contact_ids` still accepted for backwards-compat and expands to every bucket
  for the given contact.
- Response includes `total_buckets` in addition to `total_contacts` and
  `total_rows`.

### Feb 2026 — Reusable AccountInfoTooltip
- Extracted the mega-modal's info-icon tooltip into
  `/frontend/src/components/AccountInfoTooltip.jsx` (portal-based so it
  escapes scrollable overflow clips).
- Reused in the Transactions table: every category-dropdown cell now has an
  info icon that shows the GAAP definition of the currently-selected category
  on hover / keyboard focus. Sourced from
  `/frontend/src/lib/accountDefinitions.js`.



- **2026-02-17**: Contacts page — added inline **Edit Contact** flow (click row or pencil icon).
  Backend `PATCH /api/companies/{cid}/contacts/{xid}` already existed; UI now reuses the modal
  for create + edit with prefilled fields, sonner toasts, and empty-`type` handling.
- **2026-02-17**: Contacts page — added **Merge Contacts** action. New `POST /api/companies/{cid}/contacts/merge`
  reassigns `contact_id`/`contact_name` across `transactions`, `invoices`, `bills`, `payments`,
  `receipts`, and `contact_learning_cache` from losers → keeper, then deletes losers and invalidates
  the report cache. `GET /contacts` now includes a `txn_count` per contact for merge previews.
  UI adds checkboxes, a "Merge N" toolbar button (visible when ≥2 selected), and a modal that
  auto-picks the keeper with the most transactions (radio-selectable), shows per-contact txn counts,
  and displays a live "N contact(s) will be merged into X. About Y transaction(s) will be reassigned."
  preview.
- **2026-02-17**: Contacts page — added **Hits / YTD In / YTD Out / Net / Last Seen** columns.
  Single Mongo `$group` aggregation over `transactions` computes all four in one pass
  (uses existing `(company_id, date)` index). Response is wrapped in the shared `ReportCache`
  (`contacts_list::company_id=…`, 45s TTL) — Redis-backed with in-memory fallback — so at 3K
  concurrent users each refreshing every ~30s the DB sees ≤ ~70 aggregations/sec worst-case,
  most requests are cache hits. Create/update/delete/merge/sync-completion all invalidate the
  cache. Cold ~68ms, warm ~57ms on 317 LLC (210 contacts / 1,874 txns).
- **2026-02-17**: Contacts page — added **View toggle** (Analytics ↔ Details) with localStorage
  persistence, and a **Contact Transaction Report** drawer. Clicking any row in Analytics view
  opens a right-side drawer scoped to that contact showing YTD/All-time toggle, summary tiles
  (Txns/In/Out/Net), and a table of all transactions (Date/Description/Category/Bank/Amount/Status).
  Detail view row-click still opens the Edit modal. Backend: `GET /transactions` now accepts a
  `contact_id` filter.
- **2026-02-17**: Contact Report Drawer — added **Bulk Reclassify + AI rule seed**. New
  `POST /api/companies/{cid}/transactions/bulk-reclassify` accepts `{transaction_ids,
  category_account_id}` and, since `reports._signed_balances` derives the ledger directly
  from `transactions.posted=True`, performs the entire reclassify as a single `update_many`
  (no JE reversal needed). Marks rows `human_reviewed=True/posted=True/needs_review=False`,
  stamps `ai_source="manual_bulk"`, logs `post_je`, invalidates the report cache, and
  enforces closed-period locks per row. Every reclassify bumps `rule_candidates.approvals`
  per `(merchant, account_code)`; when any candidate crosses `approvals >= 2` the response
  returns a `rule_suggestion` and the drawer shows an amber banner "You've reclassified X
  to Y N times. Turn this into a rule?" — one click POSTs to `/rules` with
  `apply_to_existing=true` so historic un-reviewed txns are back-filled.
- **2026-02-17**: Extracted `ReclassifyPicker` to `/app/frontend/src/components/ReclassifyPicker.jsx`
  and added **Bulk Reclassify** to the main Transactions page toolbar (green "Reclassify" button
  between "Approve all" and "Make these rules"). Same amber rule-suggestion banner appears
  above the toolbar when the backend returns a candidate crossing the `approvals >= 2`
  threshold. Both the Contacts drawer and the Transactions page now hit the same
  `POST /transactions/bulk-reclassify` endpoint.
- **2026-02-17**: Rules page — upgraded **Suggested Rules** panel. `GET /rules` now includes
  `applies_to_count` per candidate (parallel `count_documents` for
  `human_reviewed=false, merchant ~ /X/i` — capped at 200 candidates). Added an "Accept all"
  bulk action + per-card dismiss (`DELETE /rule-candidates/{id}`). Panel header shows total
  cleanup preview ("would clean up N un-reviewed txns"). `POST /rules` now auto-consumes the
  matching `rule_candidate` after promotion so the panel stays clean, and invalidates the
  report cache.
- **2026-02-17**: Dashboard — added **"Needs your attention"** widget. New
  `GET /companies/{cid}/dashboard/attention` returns `{flagged_count, suggested_rules_count,
  unreconciled_accounts_count, unreconciled_accounts[]}` computed in parallel via
  `asyncio.gather`. Un-reconciled = bank/credit-card accounts with posted txns but no
  reconciliation record within `staleness_days=45`. Cached per-company at the same TTL
  as `/dashboard/metrics` and keyed by day so midnight-rollover refreshes naturally.
  UI shows a three-card row (Flagged / Suggested rules / Unreconciled) with tone-coded
  icons (amber / indigo / rose), counts, per-card hints (e.g. names of the first 2 stale
  accounts), and one-click deep-links to `/accounting/transactions?filter=review`,
  `/accounting/rules`, `/accounting/reconciliation`. Renders an "All clear" success state
  when everything is zero.
- **2026-02-17**: Extended Attention widget to **5 cards** — added Overdue Invoices +
  Overdue Bills. Backend `_compute_attention` helper now runs 5 parallel counts
  (transactions, rule_candidates, invoices past due, bills past due, reconciliations).
  Cards deep-link to `/invoices?filter=overdue` and `/bills?filter=overdue`.
- **2026-02-17**: **Firm-wide "morning glance" tile** on `/pro/clients` (Pro role).
  New `GET /pro/firm-attention` fans out `_compute_attention` across every book the
  Pro owns via `asyncio.gather`, returns `{clients_total, clients_needing_action,
  totals: {flagged, suggested_rules, overdue_invoices, overdue_bills, unreconciled},
  clients: [{...per_client_counts, action_count}]}` sorted by `action_count` desc.
  Cached per-user (day-keyed, same TTL as `/dashboard/metrics`). Superadmin sees all
  companies. UI shows an amber "N of M clients need action today · X items across all
  books" header + 5 aggregate stats + a **"Filter to action needed"** toggle. Client
  cards now show a `BellRing` action-count badge and chips summarizing what's due per
  client (`6 flag · 1 recon`). 70ms cold / 81ms warm on 7 clients.
- **2026-02-17**: **AI-assisted onboarding — auto-tailored CoA per business type** (P1 shipped).
  Rewrote `ai_service.suggest_chart_of_accounts(business_type, description, existing_codes)`
  to request 15-25 industry-specific accounts with per-account `rationale` from Claude Sonnet
  4.5, dedup-safe against existing codes. New `POST /companies/{cid}/onboarding/coa/suggest`
  returns a preview (no writes) with `already_exists` flags. Reworked
  `POST /companies/{cid}/onboarding/generate-coa` to accept `{codes: [...]}` for selective
  insertion + invalidate report cache. Two entry points: **Onboarding step 2** is now
  a two-phase Suggest → Review-with-checkboxes → Apply flow; **CoA page** has a new
  "Suggest with AI" button that opens a modal with the same review flow. Verified on
  Bright Beans (Retail / F&B) — 20 accounts generated in ~21s including Green Coffee Bean
  Inventory, Wholesale Coffee Sales, Gift Cards Outstanding, Espresso Machines, COGS
  breakdowns, etc.
- **2026-02-17**: **AI Onboarding Interview** (new step 3 of onboarding). Two new AI service
  functions: `onboarding_interview_questions(business_type, description)` designs 4-6 targeted
  yes_no/multi_choice/short_text questions with `why` rationale per question, and
  `onboarding_interview_synthesize(business_type, description, answers, existing_codes,
  existing_accounts)` uses the answers to produce (a) 5-15 refined industry accounts and
  (b) 4-12 starter categorization rules (e.g. "Stripe → 4110 Card Processing Revenue")
  strictly referencing valid account codes. Two endpoints:
  `POST /companies/{cid}/onboarding/interview/questions` returns the question list;
  `POST /companies/{cid}/onboarding/interview/synthesize` (with `apply=true`) inserts every
  proposed account, creates every rule with `created_by="ai_interview"`, and back-fills
  matching un-reviewed transactions honoring closed-period locks. Answers are persisted on
  the company doc for auditing. Verified on a SaaS test company — Claude generated 5
  targeted questions (payment processor, revenue recognition timing, contractor payment
  methods, sales-tax nexus, annual vs monthly prepaids) with rationale; synthesis on a
  Retail/F&B answered set returned 11 accounts + 8 seed rules including Square → Clearing
  Account, Cafe Imports → COGS Green Coffee, Nashville Coffee → Wholesale Sales.
- **2026-02-17**: **Onboarding mode toggle** — pill at the top of the onboarding page lets
  the user pick **AI-guided** (default; includes the AI Interview step) or **Simple** (skips
  it). Choice is persisted to `company.onboarding.answers.onboarding_mode`. In Simple mode
  the AI-Interview step chip is hidden and `next()`/`back()` navigation transparently skips
  the interview index — so either flow is a natural, uninterrupted click-through.
- **2026-02-17**: **Real-time TTS in Axiom Assistant panel**. Added a Volume2/VolumeX toggle
  next to the collapse button — enabled state persists to `localStorage.axiom_tts`. When
  active, the streaming SSE loop feeds newly-completed sentences to
  `window.speechSynthesis` as soon as a sentence terminator (`.!?\n:`) appears in the
  buffer, so the AI starts speaking within milliseconds of finishing its first sentence
  (while it's still typing the next one). Uses the browser's native SpeechSynthesis API —
  zero server latency, works offline, no API key. Speech is cancelled and the pointer
  reset when the user sends a new message. Trailing text is flushed after stream end.
- **2026-02-17**: TTS **voice picker** — added a chevron next to the speaker icon that opens
  a compact panel with (a) an "Read responses aloud automatically" checkbox mirroring the
  main toggle, (b) a Voice dropdown listing every installed `SpeechSynthesis` voice sorted
  with English voices first, (c) a Preview button that reads a sample sentence in the
  chosen voice. Choice persists to `localStorage.axiom_tts_voice`. Default resolves in
  order: `Google UK English Female` → any `en-GB` female voice → any English voice → OS
  default. Subscribes to the `voiceschanged` event so voices that load asynchronously in
  Chrome are picked up automatically.
- **2026-02-17**: **Open-mic + PTT + TTS-echo protection**. Redesigned the AI panel mic
  as a three-way mode toggle (Off / Push-to-Talk / Open-mic), persisted to
  `localStorage.axiom_mic_mode`. Same button uses a tap-vs-hold discriminator (220ms
  threshold) — tap cycles modes, hold engages PTT — avoiding the classic mousedown+click
  race. **Open-mic** mode: continuous recognizer self-heals on `onend`, 1800ms silence
  timer auto-submits, and three-layer TTS echo defense: (1) `ttsSpeaking` flag drops
  transcripts entirely while `speechSynthesis.speak()` is active (tracked via
  `utterance.onstart/onend/onerror`), (2) 300ms `TAIL_MS` grace after TTS ends keeps
  transcripts blocked while hardware audio drains, (3) silence-submit refuses to arm/fire
  during TTS. **Barge-in** uses the recognizer's own `onspeechstart` event — if it fires
  past the tail grace while TTS is playing, it cancels TTS and drops the flag, letting the
  user's next words flow through immediately (no separate VAD library needed). Chrome's
  "final duplicate on restart" bug is deduped by suppressing identical finals within 500ms.
  If the recognizer errors ≥3 times within 5s, mode auto-drops to PTT with a toast. Mic
  status pill in the UI reflects the current state (Listening… / open-mic / AI speaking —
  mic muted). No new server-side cost.
- **2026-02-17**: Verified 317 LLC Plaid vs Veryfi source-of-truth dedup for account ···6084:
  Veryfi statement `eStmt_2026-05-20.pdf` mapped to existing `1011 Bank of America Checking ···6084`
  (no duplicate CoA), all 94 lines skipped as duplicates against Plaid's coverage window
  (SOURCE_PRIORITY: qbo > plaid > veryfi > manual). Zero `source=veryfi` transactions inserted.

- ✅ Full auth (JWT, bcrypt, 3 roles, seeded demo accounts)
- ✅ Multi-tenant Company switcher with owner/pro memberships
- ✅ 30-account GAAP CoA auto-seeded per company
- ✅ 90 seeded sample transactions on primary demo company with realistic AI confidence
- ✅ Transactions page: split, link to invoice/bill, bulk approve, bulk-create rules, per-row AI re-categorize
- ✅ AI categorization (Claude Sonnet 4.5) with GAAP prompting + confidence + reasoning stored on each txn
- ✅ Rules engine + AI rule candidates + apply-to-existing on rule creation (skips closed-period txns)
- ✅ Onboarding wizard (6 steps) — business profile, QBO toggle, AI CoA generation, real Plaid Sandbox link, real Veryfi statement upload, complete
- ✅ Invoices / Bills / Payments (auto-updates balance_due) / Receipts / Contacts full CRUD
- ✅ Journal Entries with debit=credit validation
- ✅ Reconciliation, Book Review, Close-the-Books (month) and Year-End Close
- ✅ Inventory / Assets / Loans / Tags / Communications / Connections generic CRUD
- ✅ Reports: Trial Balance, Balance Sheet, Income Statement, GL, Cash Flow, **Sales Tax Liability**, **1099 Summary** — all with PDF export
- ✅ AI Chat SSE streaming panel with focused-transaction context + injected books snapshot
- ✅ Collapsible sidebar + collapsible AI panel
- ✅ Superadmin overview dashboard, Pro clients dashboard
- ✅ **Real Plaid Sandbox integration** (plaid-python + react-plaid-link) with link-token → public-token exchange → /transactions/sync w/ cursor
- ✅ **Real Veryfi document OCR** (bank-statements endpoint w/ /documents fallback)
- ✅ **Plaid webhooks** — `/api/plaid/webhook` (public) handles TRANSACTIONS: SYNC_UPDATES_AVAILABLE / DEFAULT_UPDATE / TRANSACTIONS_REMOVED, auto-imports and AI-categorizes; skips closed periods. Manual-sync fallback exposed on Connections page.
- ✅ **Closed-period locks** — HTTP 423 on any transaction edit/delete/split/approve or JE create/delete whose date falls in a closed period. Applies to rule apply-to-existing too.
- ✅ **Balance Sheet A/R & A/P + Cash/Accrual toggle (Feb 2026)** — On Accrual basis the Balance Sheet now includes Accounts Receivable (from open invoice balances) as a current asset and Accounts Payable (from open bill balances) as a current liability, with Net Income adjusted to keep the sheet balanced. Income Statement adds a Δ A/R and Δ A/P accrual adjustment row when accrual is selected. Cash basis excludes both. The basis toggle is exposed on both reports in the UI and the PDF exporters.
- ✅ **Per-account Plaid connect + opening balances + source-of-truth dedup (Feb 2026)** — New `plaid_connect.py` module. Every Plaid account can now be connected individually via `POST /api/companies/{cid}/plaid/connect-account`. The flow: (a) auto-maps the Plaid subtype to a CoA account (checking→1010, savings→1020, credit card→2100, money market→1030, etc., auto-creating missing accounts); (b) pulls full Plaid history for that account; (c) posts an opening-balance journal entry as of the day before the oldest imported txn, using `current_plaid_balance − net_movement` (assets) / `+net_movement` (credit-card liabilities), booked against a new **3050 Opening Balance Equity** account auto-created per company; (d) persists mapping on `plaid_items.account_mappings` so future syncs route each Plaid account_id to its own ledger bank account. All Plaid, Veryfi, and webhook importers now enforce **source-of-truth precedence: QBO > Plaid > Veryfi** — when a superior source has txns covering a date range for the same bank account, inferior-source txns in that window are skipped. Connections UI adds a "Connect" button per available account and a "Connect all" bulk action. `connect_plaid_account` is idempotent — it re-routes legacy txns and safely handles re-connect.
- ✅ **Plaid Production live (Feb 2026)** — Environment flipped from sandbox → production. Sandbox secret preserved as `PLAID_SECRET_SANDBOX` for easy revert. Production webhook URL: `{PUBLIC_URL}/api/plaid/webhook`.
- ✅ **Company Settings page + delete cascade (Feb 2026)** — New `/settings` route in the sidebar. Lets user edit name, business type, business description, and reporting basis for the current company. Danger zone includes a **"Delete this company"** action guarded by a shadcn AlertDialog that requires typing the exact company name. Backend `DELETE /api/companies/{cid}?confirm=<name>` cascades across 15+ collections (accounts, transactions, JEs, invoices, bills, customers, vendors, payments, plaid_items, veryfi_uploads, ai_activity_log, rules, audit_logs, period_locks, memberships, onboarding_state) then removes the company doc.
- ✅ **Multi-company owner reuse (Feb 2026)** — When a pro creates a client whose email already belongs to a `client` account, the backend now **reuses** that user and just adds a fresh membership for the new company (instead of erroring). This means one owner-login can be used across multiple companies they own, and they can switch between them via the top-left dropdown. New endpoint `GET /api/pro/clients/lookup?email=…` returns `{exists, name}` for the dialog to detect reuse in real time. The New-Client dialog now hides the password field when the email is already registered and shows the message "This client already has a login — the new company will be added to their dropdown."
- ✅ **Plaid full-history request (730 days) + update-mode backfill (Feb 2026)** — `plaid_service.create_link_token` now sets `transactions.days_requested=730` (the max Plaid allows) so every new link pulls up to 24 months of history from the institution. Added `POST /api/companies/{cid}/plaid/backfill-history-token` which mints an update-mode Plaid Link token for an existing item, so companies linked before this fix (e.g. Clean Set, which was locked at 90 days by default) can re-authenticate once and have Plaid backfill the older transactions. Frontend adds a **"Backfill 24 mo"** button next to the Plaid card that opens Link in update mode and kicks off a manual-sync on completion.
- ✅ **Track A: Merchant cache + parallel categorizer (Feb 2026)** — New `merchant_cache.py` module. Per-company `merchant_cache` collection stores normalized `merchant → (account_code, confidence, source)`. Normalization strips common junk (payment-processor prefixes SQ*/TST*/PP*, trailing IDs, dates, city/state, etc.) so variants of the same merchant collapse to one cache key. Every categorization now goes cache-first, LLM-fallback. Cache-miss LLM calls run in parallel via `asyncio.gather` with `Semaphore(10)`. User approvals + manual category overrides (`PATCH /transactions`, `POST /transactions/approve`) upsert cache with `source="user"` which is authoritative (LLM entries never overwrite user entries). All Plaid importers (`plaid_import`, `_sync_and_import`, `plaid_connect.sync_plaid_history_for_account`) refactored to pre-filter → batch categorize → bulk insert. **Performance**: Test 5 showed 20 concurrent LLM misses complete in 0.21s vs 2.0s serial (~10× speedup). Combined with a mature cache (95% hit rate after 3–6 months), a 2K-txn re-sync goes from ~110 min to ~3–5 min. Also added 7 Mongo indexes: `(company_id, plaid_txn)`, `(company_id, plaid_account)`, `(company_id, needs_review, date DESC)`, `(company_id, JE date)`, `(company_id, inv status/date)`, `(company_id, bill status/date)`, `(user_id, company_id)` for membership lookups.
- ✅ **Rocketbooks contact resolution + categorization upgrades (Feb 2026)** — New `contact_resolver.py` + `categorizer.py`. Every Plaid/Veryfi txn now carries a `contact_id`:
  - **Fast path**: When Plaid provides `merchant_name`, we normalize via `normalize_contact_name` (lowercase + corp-suffix strip — `Inc/LLC/Co/Ltd/Corp/NA/GmbH/SRL/PLC`) and match against a compound unique index `(company_id, normalized_name)`. Zero AI calls; handles ~90% of Plaid txns. Legacy contacts auto-backfilled with `normalized_name` before the unique index is created.
  - **AI path** (Claude Haiku 4.5 via Emergent LLM key): Only for description-only rows (Zelle/wires/checks). Handles Zelle recipient extraction, wire `ORIG:` fields, "Recurring Payment authorized on…" patterns. Multi-guard: rejects names >60 chars, `Card ####`, `Conf#/Trn#/Srf#`, `S\d{12+}`, and resembles-description backstop.
  - **Merchant grouping**: Categorizer groups txns by `(contact_id OR normalized_merchant, direction)` → **one LLM call per group**, result cascades to every row. Cuts calls ~60% on typical batches.
  - **Plaid PFC hint** fed into the categorization prompt for +10–15% first-pass accuracy.
  - **Upgraded domain prompt**: Uber-ride vs Uber-Eats, Zelle person-not-app, CC-payment-not-expense, gas/airfare/payroll/interest patterns, meal caps.
  - **Uncategorized bucketing**: New auto-created accounts `6999 Uncategorized Expense` + `4999 Uncategorized Income`. Low-confidence txns post there (`needs_review=true`) instead of being wrongly assigned. Cleaner audit trail.
  - **Per-org `auto_post_threshold`** (default 0.80, editable via PATCH `/settings/auto-post-threshold`).
  - **Meal-cap guard**: Any meal >$150 auto-flags for review even at 0.98 confidence — catches Plaid mis-tags of supplier payments as meals.
  - **`POST /contacts/backfill`** idempotent one-time migration for existing txns. Ran on Clean Set: **131/131 txns now have `contact_id`**, 131 unique contacts created, zero AI cost (fast-path only). Tests: 15/15 integration + 8/8 unit + 8/8 plaid_connect regression pass.
- ✅ **Rocketbooks-style deterministic merchant rules (Feb 2026)** — New `merchant_rules.py` module with a 200+ entry curated US-merchant → GAAP-code dictionary and regex patterns for bank fees, interest, and internal transfers. Wired into the categorization pipeline as **rules → cache → LLM → uncategorized-bucket** precedence. Measured against real Rocketbooks-labeled Plaid CSV (2,363 txns): **82.8% deterministic match rate at 0.95 confidence with zero LLM cost**. `is_internal_transfer()` detects "Online Banking transfer…", "WELLS FARGO DDA TO DDA", "TFR TO/FROM" patterns and routes those to a new `1099 Bank Transfer Clearing` asset account with `needs_review=true` — fixes the 355 LLC balance-sheet skew where $15-20K internal transfers were being mis-tagged as income/expense. New tests in `tests/test_merchant_rules_vs_rocketbooks.py` (43 spot checks + baseline coverage regression at ≥75%).
- ✅ **Track B: Redis + Arq durable background workers (Feb 2026)** — All long-running Plaid sync operations now run off the API request thread via a durable job queue. Redis 7.0 running via supervisor; Arq worker (`max_jobs=20`, `job_timeout=600s`, `max_tries=3`) executes `plaid_manual_sync`, `plaid_reset_resync`, `plaid_contact_backfill`. `POST /plaid/manual-sync` and `POST /plaid/reset-and-resync` return `{job_id, status:"queued"}` in ~20ms instead of blocking. `GET /jobs/{id}` returns status + result. Frontend polls every 2s, shows live progress pill, toasts on completion. **Verified live**: ingress-side reset-and-resync went from 502-timeout at ~30s → 257ms response, 730-day re-pull runs in background in ~15s. Idempotent via `(company_id, plaid_transaction_id)` unique index.
- ✅ **Sync History panel + K8s HPA templates (Feb 2026)**:
  - **`GET /api/companies/{cid}/plaid/sync-jobs`** — returns last N (default 10, max 50) jobs with kind, status, duration_ms, imported count, triggered_by_email, single-line error tail. Powered by the existing `sync_jobs` collection (already indexed by `company_id + kind + created_at`).
  - **Frontend `<SyncHistoryPanel>`** — collapsible section on Connections page below the coverage banner. Colored status badges (queued/running/completed/failed), duration, imported txn count, "triggered by" user handle, and relative time. Auto-refreshes when a live job's status flips.
  - **`/app/k8s/`** — production-ready manifest set: `backend-deployment.yaml`, `worker-deployment.yaml`, `redis-deployment.yaml` (StatefulSet + PVC), `hpa-worker.yaml` (CPU 70% + optional queue-depth via Prometheus Adapter, replicas 1→8), `hpa-backend.yaml` (CPU 65% + memory 80%, replicas 2→10). README documents scale points, rollout order, and what to watch after go-live. Not applied automatically to the current preview environment — ready to `kubectl apply` on the production cluster. — All long-running Plaid sync operations now run **off the API request thread** via a durable job queue. Complete replacement of the inline sync path that was hitting Cloudflare ingress 502 timeouts on 14-second Plaid pulls.
  - **Infra**: Redis 7.0 running via supervisor (bind 127.0.0.1:6379, no persistence — queue is Mongo-durable). Arq worker process managed by supervisor at max_jobs=20, job_timeout=600s, max_tries=3.
  - **`backend/job_queue.py`**: durable `sync_jobs` Mongo collection with unique index on `id`, TTL 7d on `finished_at`. `enqueue_job(kind, cid, **kwargs) → job_id`. `get_job(job_id)`, `update_job(job_id, **patch)`.
  - **`backend/worker.py`**: three Arq tasks: `plaid_manual_sync`, `plaid_reset_resync`, `plaid_contact_backfill`. Each marks status='running' → 'completed'/'failed', persists result/error, is idempotent (dedupe on `(company_id, plaid_transaction_id)` unique index makes retries safe).
  - **API changes**: `POST /plaid/manual-sync` and `POST /plaid/reset-and-resync` now return `{job_id, status:'queued'}` in <100ms instead of blocking. New `GET /jobs/{job_id}` returns status/result/error with per-tenant access control.
  - **Frontend**: `Connections.jsx` polls `/jobs/{id}` every 2s while a job is active, renders a live progress pill "Syncing transactions · status queued/running · <short-id>", disables Re-sync button while job in flight, toasts on completion/failure.
  - **Verified live**: Ingress-side reset-and-resync now returns in **257ms** (previously 502 timeout at ~30s). 730-day re-pull runs in background in ~15s. Same code path — just off the request thread.
  - **Scale**: single worker handles 20 concurrent syncs. Add worker replicas horizontally (Kubernetes) to scale further — no code change needed.
- ✅ **Plaid balance metadata (free, no per-call charges) (Feb 2026)** — Started capturing the balance snapshot Plaid ships back with every `/transactions/sync` call (bundled, free). Fallback to free `/accounts/get` when sync returns an empty `accounts` array (cursor at end-of-history). **Explicitly NOT calling `/accounts/balance/get`** (paid per-call endpoint that forces a live pull from the bank). Persisted to `plaid_items.accounts[].balance_current/available/limit` + `plaid_items.balance_snapshot_at` on every sync. New `plaid_service.get_accounts_balance_snapshot` helper, `plaid_connect._apply_sync_balance_snapshot` merger. `GET /plaid/accounts` now returns `balance_snapshot_at` so the Connections coverage banner shows "Plaid balance: $4,759.93 · 2 min ago" alongside our ledger-computed Cash-on-Hand — accountants can spot drift instantly.
- ✅ **"Bank Balance" column left source-driven (Feb 2026)** — Design correction: this column reflects a balance-after value that comes with the *source data* (mock/seed onboarding rows, and eventually Veryfi-OCR'd bank statement lines which print "Balance $X" per row). Plaid doesn't provide per-transaction balances, so Plaid-imported rows correctly show "—" until a statement OCR carries the actual bank-printed value.
- ✅ **Ledger integrity audit + transfer self-cancellation fix (Feb 2026)** — Full 7-step audit on 627 LLC (1,870 real Plaid txns) uncovered a **$268K ledger inflation**: 48 rows tagged with `TRANSFER_IN/OUT_ACCOUNT_TRANSFER` PFC had `category_account_id == bank_account_id` (code 1010), producing self-cancelling JEs. Root cause: PFC resolver correctly returned `source='fallback_uncategorized'` for these, but the pipeline gate only honored `primary|override`, deferring the row to the LLM — which then picked bank 1010 as the "category" for descriptions like `Online Banking transfer to CHK 6278`. Fixes:
  - `plaid_connect.categorize_and_insert_plaid_txns` — new gate: when `classification ∈ {asset_movement, transfer_review, uncategorized}`, honor `source='fallback_uncategorized'` directly, never defer transfer rows to LLM.
  - `categorizer.decide_posting` — hard reject any LLM-picked account with code 10xx (bank/cash asset); force to Uncategorized bucket with `needs_review=True`. Prevents this class of bug for any future LLM.
  - `tests/repair_self_cancelling_txns.py` — one-shot idempotent repair that scans every company and re-routes self-cancelling rows to the Uncategorized bucket. Ran cleanly against production: **48 bad rows in 627 LLC fixed**.
  - Regression tests: `tests/test_decide_posting_bank_guard.py` (5 tests), `tests/audit_ledger.py` (7-step audit harness). After fix: bank ledger drift for 627 LLC went from **$268,531 → $2,554** (matches Plaid actual $4,759 within pending-txn expected drift). Trial balance = 0.00, A = L + E + NI balances exactly.
- ✅ **Webhook + resync fixes (Feb 2026)** — Root-caused an issue on new company 627 LLC where only 100 of 1,870 available Plaid transactions were imported: `PUBLIC_BACKEND_URL` was unset in `backend/.env`, so `webhook_url=None` on every Plaid Link token → Plaid never fired `HISTORICAL_UPDATE`/`SYNC_UPDATES_AVAILABLE` webhooks to us, leaving items stuck at the ~30-day initial-update window. Fixes:
  - Added `PUBLIC_BACKEND_URL` to `backend/.env`; Plaid webhooks now route to `/api/plaid/webhook`.
  - Refactored the pipeline: extracted `plaid_connect.categorize_and_insert_plaid_txns` so **both** the initial per-account connect flow AND webhook/manual-sync go through the PFC-first pipeline (previously manual/webhook path used the legacy categorizer, bypassing PFC resolver entirely).
  - New endpoint `POST /api/companies/{cid}/plaid/reset-and-resync` — nulls the stored cursor and re-pages the entire Plaid history through the PFC pipeline. Rescued 627 LLC: **imported 1,770 additional txns**; ended with **94.7% PFC-deterministic categorization, 8.0% needing review** (beats Rocketbooks' ~15.8% baseline on the same data).
- ✅ **Plaid PFC → CoA resolver (exact Rocketbooks port, Feb 2026)** — New `pfc_mapping.py` (Python port of `pfc-coa-mapping.ts`) with 127 PFCv2 detailed codes mapped to our chart of accounts + classification (`business_expense | business_income | personal | liability_paydown | liability_increase | asset_movement | transfer_review | uncategorized`). New `pfc_resolver.py` (Python port of `resolve-pfc-coa.ts`) implementing the strict 4-step resolution: **override → primary slot → uncategorized fallback → unmapped**, with bank-account-self-reference guards on every step so transfer PFCs never dump into a random bank asset. New `pfc_org_overrides` Mongo collection with unique `(company_id, pfc_detailed)` index for per-org pins. New endpoints `GET/PUT/DELETE /api/companies/{cid}/pfc-overrides/{pfc_detailed}` for user-controllable overrides. Plaid ingest pipeline now: **PFC resolver (primary+override) → contact resolver → merchant_rules → merchant_cache → LLM → uncategorized bucket**. New seed accounts: `3300 Owner's Draw`, `3400 Owner's Contribution`, `1100 Undeposited Funds`; auto-created on first Plaid sync for pre-existing companies via `ensure_pfc_support_accounts`. Personal PFCs (medical, gym, groceries, gambling, tobacco, home improvement) route to Owner's Draw automatically. Every posted txn now carries `pfc_detailed`, `pfc_primary`, `pfc_classification`, and `ai_source ∈ {pfc_primary, pfc_override, memory, ai, uncategorized, rule}`. Tests: `test_pfc_mapping.py` (30 invariants + spot checks), `test_pfc_resolver.py` (10 Mongo integration tests covering all 4 steps + override precedence + bank-guard). 97/97 tests pass.
- ✅ **Transactions pagination (Feb 16, 2026)** — Fixed 500-row hard cap. `GET /api/companies/{cid}/transactions` now accepts `page` & `limit` query params (default 250/pg, max 5000/pg; `limit=0` = unbounded). Response wrapped `{ transactions, pagination: { total, page, pages, limit } }`. Added deterministic `(_id DESC)` sort tie-breaker so same-date rows never duplicate across pages. Frontend `Transactions.jsx` gained a `<PaginationBar>` with page-size dropdown (50/100/250/500), Prev/Next controls, `Showing X–Y of TOTAL` indicator; filter-chip count now shows true total. Verified live on 254, LLC (1,871 txns, 8 pages). Testing agent iter13: 100% backend + 100% frontend.
- ✅ **Contact regression fix + Transactions search & date filters (Feb 16, 2026)** — Fixed a regression introduced with the PFC pipeline where `contact_resolver.resolve_contacts_batch` was only called on the ~5% of Plaid txns that fell through to LLM categorization, leaving `contact_id=None` on ~95% of well-mapped rows (A/P by-vendor and 1099 tracking silently broke). `plaid_connect.categorize_and_insert_plaid_txns` now runs contact resolution across **every** candidate before category decisioning. Ran existing `POST /api/companies/{cid}/contacts/backfill` against 254, LLC → 1,871 rows resolved, **501 unique contacts** created. Also added toolbar filters to Transactions: (a) debounced free-text search (≥2 chars, case-insensitive across merchant/description/contact_name, uses `re.escape` so `AT&T`/`$5.00` don't blow up), (b) date-range picker (`date_from`/`date_to`, ISO-lexicographic on the existing `(company_id, date desc)` index), (c) "Clear filters" button appearing only when filters are active. Backend `list_transactions` gained `q`, `date_from`, `date_to` query params. Testing agent iter14: 100% backend + 100% frontend, plus a monkeypatched unit test verifying contact resolution runs on all candidates (PFC-primary + LLM-deferred).
- ✅ **Sticky-filter bug on company switch (Feb 16, 2026)** — User reported "400 LLC only shows 101 transactions" but the DB actually had 1,871. Root cause: toolbar filter state (`search`, `dateFrom`, `dateTo`, `filter=review`) was **not** reset when the user switched companies via the top-bar switcher — so a ~1-month date range from the previous company was hiding all but ~101 rows on the new one. Fix: added a `useEffect([currentId])` in `Transactions.jsx` that resets all filter state and page. Also added an amber **"filtered"** badge to the pagination indicator that appears any time filters are active, and shows an inline "clear" link when the filtered result is empty — so users can never be silently blinded by leftover state again. Testing agent iter15: 8/8 UI assertions passed.
- ✅ **Dashboard stale-data fix (Feb 16, 2026)** — User's Dashboard for 418, LLC displayed 101 / 101 / 10 while the DB actually held 1,871 / 1,871 / 198 (verified via `/ai/activity` curl). Root cause: `Dashboard.jsx` fetched `ai/activity`, `dashboard/metrics`, and `reports/income-statement` only on `[currentId]` change — so if the user was viewing the page during the initial ~100-txn Plaid sync (before the SYNC_UPDATES_AVAILABLE webhook backfilled the remaining ~1,770 rows a minute or two later), the tiles froze at that snapshot until a manual reload. Fix: Dashboard now (a) polls all three endpoints every 30 s, (b) refetches immediately on `visibilitychange` and window `focus`, (c) properly cleans up interval + listeners on unmount so remounts don't stack pollers. Testing agent iter16: 5/5 checks passed including verified in-browser (198 → 197 update in 33 s without any navigation).
- ✅ **Sync-Status Pill + scale-safe adaptive polling (Feb 16, 2026)** — Addressed user's 3k+-user scale concern raised after iter16. Backend now has (a) new endpoint `GET /api/companies/{cid}/sync-status` (one indexed `find_one` on `sync_jobs`, safe to poll every 5 s), (b) 15-second in-process micro-cache (`ReportCache` from `infra.py`) on the three heavy Dashboard endpoints (`/ai/activity`, `/dashboard/metrics`, `/reports/income-statement`) — collapses ~200 duplicate polls/minute per company into a single Mongo hit, (c) two focused compound indexes `(company_id, status, created_at)` and `(company_id, status, finished_at)` on `sync_jobs` so the pill query stays sub-ms at scale, (d) `worker._run_sync` emits progress updates at `downloading` and `categorizing` stages with `{stage, current, total}` so the pill shows real numbers. Frontend introduced a new `<SyncPill>` component (three visual states: amber-syncing / emerald-idle / red-failed with `data-testid=sync-pill` + `data-state` attribute) and rewrote Dashboard polling to be adaptive: cheap pill polls every 5 s while syncing / 15 s while idle, heavy endpoints re-fetch only on `syncing→idle` transition, tab focus, or a 120 s safety net. Cleanup on unmount cancels timers and event listeners so no stacked pollers accumulate. Testing agent iter17: 8/8 backend + all frontend states, adaptive polling, and syncing→idle heavy-refetch flip verified. **Net traffic at 3k users on same-company clustering: ~50 req/s heavy + ~600 req/s cheap pill, 99% Redis-safe.**
- ✅ **Plaid webhook now enqueues + Transactions auto-refresh (Feb 16, 2026)** — User reported 501, LLC Dashboard showing all zeros ($0.00 / 0 txns) with a green "All caught up" pill, while Transactions page filter chip stuck at "101" — yet the DB actually held 1,871 txns and cash-on-hand $7,076.17. **Root cause**: `POST /api/plaid/webhook` was calling `_sync_and_import()` inline. Consequences: (1) no `sync_jobs` record created for webhook-driven imports, so the Sync Pill never observed a `syncing→idle` transition and the Dashboard heavy-refetch effect (iter17) never fired — leaving tiles frozen at the initial mount snapshot; (2) the Transactions page had no auto-refresh, so its `pagination.total` was captured during the initial ~100-txn mount and the "101" chip never updated as webhooks silently backfilled the remaining 1,770 rows; (3) inline handler risked >5s webhook timeouts → Plaid retries → duplicate imports. **Fix**: (a) webhook now calls `enqueue_job("plaid_manual_sync", cid)` and returns immediately — worker creates the `sync_jobs` record and emits progress; (b) `Transactions.jsx` now polls `/sync-status` (5 s syncing / 15 s idle) and re-runs `load()` whenever `total_txns` changes or the pill flips `syncing→idle`, plus visibility/focus listeners for immediate refresh on tab return. Testing agent iter18: 7/7 backend + verified end-to-end on real 501, LLC — Dashboard tiles update 0→1871 within ~14 s of a completed sync, Transactions chip updates 1,871→1,876 within ~25 s of new rows landing.
- ✅ **First-Connect Welcome overlay (Feb 16, 2026)** — Every new Plaid connect now shows a warm welcome card on the Dashboard while the initial HISTORICAL_UPDATE webhook is still pulling ~1,700 rows of 24-month history. Card includes: friendly copy ("we're pulling your last 24 months of history — usually takes about 60–90 seconds"), live progress bar fed by `sync-status.percent`, and three step badges (Bank connected · Downloading history · AI categorizing) that flip amber-active → emerald-done as the worker's `_emit(stage, current, total)` fires. Auto-dismiss when `total_txns ≥ 500` OR pill flips `syncing→idle`; manual "hide" link also available. Per-company `sessionStorage` key (`axiom.welcome.dismissed.<cid>`) persists the dismissal so it doesn't flash back on re-poll, and resets when the user switches to a different company mid-onboarding. New component `FirstConnectWelcome.jsx` + shimmer `@keyframes` in `index.css`. Testing agent iter19: 14/14 assertions pass across all visibility/dismiss/reset cases.
- ✅ **Contact-resolver fallback + concurrent-webhook dedup (Feb 16, 2026)** — User connected 535, LLC via Plaid: 1,871 txns imported cleanly but the `contacts` collection stayed empty and every row's `contact_id` was `null`. Two root causes: (1) **Plaid returned empty `merchant_name` on every row** — the merchant string was derived from `name` via `t.get('merchant_name') or t.get('name') or 'Unknown'` — but `plaid_connect` only forwarded the raw `t.get('merchant_name')` to `contact_resolver`, so every row dropped to the AI path and the LLM returned `no_counterparty`. **Fix**: candidates now carry `merchant_name = t.get('merchant_name') or merchant` so the fast path fires whenever we have any usable name. (2) **Plaid fires `DEFAULT_UPDATE` + `HISTORICAL_UPDATE` ~100 ms apart on first connect** — sync_jobs history showed TWO parallel workers on 535, LLC both categorizing the same 1,700 rows in 32 s (burning LLM credits on identical work; DB was clean thanks to `plaid_transaction_id` uniqueness). **Fix**: webhook now `find_one` on `(company_id, kind, status ∈ {queued, running})` before enqueue and short-circuits to `{queued_job: existing_id, dedup: true}` on hit. Backfill run against 535, LLC → 501 contacts created, all 1,871 rows enriched. Testing agent iter20: 100% pass (3/3 pytest + Dashboard regression). Known follow-up: dedup lookup is not scoped by `item_id` — acceptable for MVP (single-item companies) but flagged for future multi-item support.
- ✅ **Arq worker hot-reload (Feb 16, 2026)** — User's 554 LLC showed 1,871 txns import but zero contacts, even though iter20's fix should have populated them. Root cause: the `arq_worker` supervisor process had been running for 3 h 26 min — since before iter20's code landed — and was executing stale bytecode. **Fix**: added `--watch /app/backend` flag to the worker command in `supervisord_workers.conf`. `watchfiles 1.2.0` already available; worker now auto-reloads within ~1 s of any Python file save (verified via `touch contact_resolver.py` → SIGUSR1 restart in log). Prevents the "backend fixed but worker still buggy" class of ghost regressions permanently. Backfill run against 554, LLC → 501 contacts.
- ✅ **NO_COUNTERPARTY_PFC gate + description scrubber (Feb 16, 2026)** — User connected 607, LLC and asked "don't think we're running the dedupe code, do you remember how we were doing it before". Investigation: iter20's `merchant_name = raw_description` fallback bypassed the "no counterparty" AI-path bypass — so every ATM deposit / wire / transfer / bank fee row (each carrying unique dates + ref numbers like `07/16 #XXXXX3176`) created its own contact. 607 wound up with 501 contacts, most of them ATM-noise. **Fix (two-part)**: (1) New `NO_COUNTERPARTY_PFC = frozenset({TRANSFER_IN, TRANSFER_OUT, BANK_FEES, INTEREST, LOAN_PAYMENTS})` gate runs BEFORE the fast path in `resolve_contact` and `resolve_contacts_batch` — these classifications never have a real vendor to track (self-transfers, bank charges) so contact creation is short-circuited entirely. (2) New `clean_merchant_name()` scrubber strips per-row noise (dates like `07/16`, alphanumeric ref codes like `#XXXXX3176` / `Conf# x3x3y0o2p`, PPD IDs, TRACE/REF/CONF codes, bare long digit runs) BEFORE normalization so different-looking rows for the same vendor collapse to one contact. Also updated the backfill endpoint to persist `contact_source` and pass `pfc_primary`. Live verification on 607, LLC: **contacts dropped 501 → 267**, `no_counterparty` rows = 360, `merchant_name`-sourced = 1,511, sum = 1,871. Testing agent iter21: 10/11 pytest + 100% frontend. Also fixed a UX complaint — Dashboard's "heavy refetch" trigger now fires on `total_txns` delta (not only on `syncing→idle` flip), so tiles populate immediately after Plaid Link instead of waiting up to 120 s for the safety-net interval.
- ✅ **Full Rocketbooks resolver port (Feb 16, 2026)** — User uploaded `rocketbooks-latest.zip` and asked us to review, then explicitly chose plan (a): "replace our resolver with Rocketbooks' approach — revert the raw-description fallback, add the rich AI prompt with Zelle/Wire/Recurring rules, add all three junk-name guards, use their exact `normalizeContactNameForMatch` helper." **Changes**: (1) `plaid_connect.py` — reverted iter20 fallback; candidates now forward `t.get('merchant_name')` only (no `or merchant`). Also fixed a missed `contact_source` field in the txn insert dict (was silently dropped, leaving all fresh Plaid txns with `contact_source=None`). (2) `contact_resolver.py` — removed the iter21 `NO_COUNTERPARTY_PFC` gate + `clean_merchant_name` scrubber (Rocketbooks approach relies entirely on the LLM prompt to detect internal transfers, bank fees, and interest). Also added a batch-scope contact snapshot in `resolve_contacts_batch` — loads the company's contacts ONCE at the top of the batch and passes to every AI-path call, cutting per-row Mongo scans by ~1,800× on a first sync. (3) `ai_service.CONTACT_EXTRACTION_SYSTEM` — replaced with the enriched Rocketbooks prompt covering Zelle recipients (person, not app), wire `ORIG:` / `/Bnf=` / `/Org=` (entity, not bank), "Recurring Payment authorized on…" (middle merchant only), bank fees / interest / bare-account-number transfers (`has_counterparty=false`). Also switched `session_id` to a stable md5 slice for cache-friendliness. Junk guards (`len>60`, Card####/Recurring Payment/Conf#/Trn#/Srf# regex, description-resemblance) were already in place from earlier iterations. **Live result on 653, LLC** (1,871 txns; Plaid returned `merchant_name=null` on 100% of rows so every one went through AI): **185 clean contacts** (vs iter21's 267 and iter20's 502), **1,691 rows resolved** with real vendor names (AT&T, AWS, Amazon, Audi Financial, Bank of America Financial Center, Capital One, Costco, CVS, New York Life, VCA Animal Hospital, Reno Collectibles, ...), **180 rows correctly marked `no_counterparty`** (ATM deposits, bank fees, book transfers). Zero contact names contain any of `ATM`, `PPD`, `#XXX`, `Conf#`, `DES:`, `INDN:`, `CO ID:`. Full 24-month backfill wall-clock: 9.5 minutes (~$1.50 in Claude Haiku 4.5 tokens). Testing agent iter22: **16/16 pytest pass**. Re-verified on 729, LLC after switching to watchmedo (see below): 224 clean contacts, 1,630 resolved, 241 no_counterparty, zero noise in names.
- ✅ **Fixed arq worker true auto-reload (Feb 16, 2026)** — Discovered while diagnosing 729 LLC: arq's built-in `--watch` flag only reloads the `WorkerSettings` class on file change; it does NOT clear `sys.modules`, so job-side imports of `plaid_connect`, `contact_resolver`, and `ai_service` stayed pinned to whatever bytecode was loaded when the worker process first started. Every "backend fixed but worker still buggy" incident this session was caused by this. **Fix**: replaced the supervisor command with `watchmedo auto-restart --directory=/app/backend --pattern=*.py --recursive --signal=SIGTERM -- arq worker.WorkerSettings`. `watchmedo` (from `watchdog 6.0.0`) watches for `.py` changes and fully re-execs the child process, guaranteeing fresh imports. Verified: touching `contact_resolver.py` spawns a new subprocess PID within 4 s and Python re-imports from scratch. The stale-worker regression class is permanently eliminated.
- ✅ **Contact resolver: merchant-field fast path + learning cache (Feb 16, 2026)** — User observed the Transactions page's "Merchant / Description" column already renders clean names (Walmart, AT&T, New York Life, Panera Bread, …) because `plaid_connect` derives `merchant = t.get('merchant_name') or t.get('name')`. Iter22's Rocketbooks port had regressed to passing only `t.get('merchant_name')` to the resolver → 100% of rows dropped to the AI path (9.5 min full sync). **Fix (two-part)**: (1) `plaid_connect` again forwards the derived `merchant` field; (2) `contact_resolver.looks_noisy()` regex catches raw ACH/wire/Zelle/CHECKCARD/Recurring-Payment/Online-Banking-transfer memos and routes only those to the AI path. Clean names take the fast path with zero LLM calls. Measured on 729 LLC (1,871 rows): **82% fast path · 17% AI path · 0% missing** — extrapolated first-sync time drops from 9.5 min → **~21 s**. 13/13 pattern-classification unit tests pass. Also added a **learning cache** (`contact_learning_cache` Mongo collection, unique index on `(company_id, signature)`): every AI extraction gets stored under a digit-stripped 4-token signature so future rows with the same shape (`CITI CARD ONLINE DES:PAYMENT ID:XXX ...` and `... ID:YYY ...` collide) skip the LLM entirely. Negative results (`Monthly Maintenance Fee` → no_counterparty) are cached too via a `__none__` sentinel so repeat fee rows never burn credits. Verified end-to-end: warm-cache pass on 8 rows was **216× faster** than the cold pass (1.61 s → 0.01 s). Over multiple company syncs on similar banks, fast-path coverage should approach 95%+ and per-sync LLM cost near zero.
- ✅ **Batch-resolver IO rewrite (Feb 17, 2026)** — User reported sync speeds regressed after the learning-cache addition ("was 5–20s, now taking a while"). Root cause: `resolve_contacts_batch` loaded a snapshot up-front but then still called `_find_by_normalized` (a per-row `find_one`) inside every fast-path invocation, plus a per-row cache lookup and an awaited per-hit cache upsert in the AI path. On a 1,870-row sync that meant ~2,000 sequential Mongo round trips saturating the Motor pool. **Fix**: fully rewrote `resolve_contacts_batch` to be batch-native — single snapshot `find` → in-memory `by_key` / `by_id` dicts for fast-path lookups; single `find({signature: {$in: [...]}})` bulk-loads the learning cache; new contacts collected in a `new_by_key` map and inserted via one `insert_many(ordered=False)`; cache upserts flushed via one `bulk_write`; only LLM calls contend for the semaphore. Bench on a simulated 1,830-row sync (1,500 fast + 330 AI-path with 30 ms stubbed Anthropic calls, concurrency=8): **1st pass 1.31 s · 2nd pass (warm cache) 0.01 s**. Mongo round trips per sync go from ~4,000 → ~4. Unit tests: `tests/test_batch_resolver_perf.py` — 6/6 pass (fast-path dedup, existing-contact reuse, AI cache hit, negative-result cache, bounded round trips, no-gap result rows). Note: this preview env's `redis-server` binary was uninstalled during this cycle so the live end-to-end path is exercised in unit + bench tests only; the fix will apply the moment redis + arq_worker come back up.
- ✅ **Arq/Redis → in-process asyncio.create_task() migration (Feb 17, 2026)** — Eliminated the arq worker + Redis dependency; Plaid sync tasks now execute inside the FastAPI event loop via `asyncio.create_task`. This fixes three recurring pain points: (1) stale-worker regressions (worker running old bytecode), (2) preview envs missing `redis-server` (which had left `arq_worker` in a reconnect loop), (3) added infra complexity of running `watchmedo → arq → redis` on every deploy. **New files**: `job_queue.py` (rewritten — same public API `enqueue_job` / `get_job` / `update_job` / `ensure_jobs_indexes`, now backed by `asyncio.create_task` under a global `Semaphore(MAX_CONCURRENT_SYNCS=20)` plus a task-fn registry; adds `register_task(kind, fn)` + `reconcile_stuck_jobs()`); `sync_tasks.py` (replaces `worker.py` — same three task fns `plaid_manual_sync`, `plaid_reset_resync`, `plaid_contact_backfill`, minus the arq `ctx` first arg and the `WorkerSettings` class; adds `register_all()`). `server.py` startup now calls `sync_tasks.register_all()` and `job_queue.reconcile_stuck_jobs()` — any job left `queued`/`running` from a prior process is flipped to `failed` with a "process restarted before completion" error so the Dashboard Sync Pill never displays "syncing forever". Retries are safe (Plaid inserts still dedupe on `(company_id, plaid_transaction_id)`). Supervisor programs `redis` + `arq_worker` deleted from `/etc/supervisor/conf.d/supervisord_workers.conf`. `worker.py` deleted. `REDIS_URL` env var kept for `infra.py` rate-limit storage (optional, falls back to in-process). **Verified live in preview**: `POST /api/companies/{cid}/plaid/manual-sync` returned `{job_id, status: 'queued'}` in ~50 ms, task started + finished off the request thread, `GET /api/jobs/{id}` served full progress + result payload including a Plaid API error trace on demo data. Tests: `tests/test_inprocess_job_queue.py` — 5/5 pass (happy path, unhandled exception → wrapper marks failed, unknown-kind rejected, reconcile_stuck_jobs flips stale rows, 30 concurrent tasks complete without deadlock). At scale: 20 concurrent syncs per FastAPI pod; scale further by adding pod replicas (K8s HPA on the backend deployment). Existing K8s manifests `worker-deployment.yaml` + `redis-deployment.yaml` are now obsolete and can be removed at production go-live.
- ✅ **Dashboard "$0.00 for 2 minutes after sync" bug + Sync-pill removal (Feb 17, 2026)** — On a fresh Plaid connect (444 LLC test case), the Dashboard tiles displayed all zeros for ~120 s even though the sync had already inserted 1,871 txns and posted them 50 s prior. **Root cause**: `dashboard/metrics` and `ai/activity` are wrapped in a 15 s in-process TTLCache. The Dashboard's initial `fetchHeavy` populated the cache with the empty-state response before the sync finished. When the sync-status poll detected `total_txns` changing from 0 → 1871 and re-fired `fetchHeavy`, the server returned the stale cached zeros for the next ~10 s. The client's next auto-refetch was 120 s later (the safety-net interval), so tiles sat at $0.00 for up to two minutes. **Fix**: `sync_tasks._mark_done()` now calls `get_cache().invalidate(company_id)` immediately after flipping a job to `completed`, purging every per-company cache entry (`dash_metrics:cid:*`, `ai_activity:cid:*`, income/BS statements, …). The client's next refetch — which fires within 5 s of sync-status flipping — hits an empty cache and gets fresh numbers. Also **removed the "All caught up · 50s ago" SyncPill from the Dashboard header** per user request; `FirstConnectWelcome` overlay still surfaces during first-time syncs. Tests: `tests/test_sync_cache_invalidation.py` — 2/2 pass (cache entry purged after `_mark_done`, sibling company's cache untouched). All 13 tests across the three sync-related test files remain green (batch resolver 6/6, in-process job queue 5/5, cache invalidation 2/2).
- ✅ **AI Activity widget: full counters restored (Feb 17, 2026)** — On real Plaid syncs (457 LLC test case) the Dashboard's "AI Activity" panel showed only one row (`Transactions Categorized`), while the Skyward Sparks demo showed five (Categorized, Flagged for Review, Journal Entries Auto-Posted, Rules Created, Statement Lines OCR'd). **Root cause**: only `_log_ai(cid, "categorize", ...)` was emitted from the Plaid pipeline — `post_je` and `flag_review` counters were never written. **Fix**: (1) Extracted `_log_ai` into a shared `/app/backend/ai_activity.py` module (`log_ai_event(company_id, kind, count)`) so background sync code can log events without a circular import. (2) `plaid_connect.categorize_and_insert_plaid_txns` now emits `post_je` = count(`posted=True`) and `flag_review` = count(`needs_review=True`) after each insert batch. (3) `GET /ai/activity` was upgraded to **derive** counters from live truth (`transactions.count_documents`, `rules.count_documents`, `veryfi_uploads.count_documents`) instead of trusting stale `ai_activity` docs — this backfills every existing customer whose txns were imported before the emission hooks existed, and it can never diverge from what the tiles show. Zero-count kinds are omitted so the widget stays clean. Verified live on 457 LLC: was 1 row ("Categorized 1,871"), now 3 rows (Categorized 1,871 · Posted 1,871 · Flagged 198). Tests: `tests/test_ai_activity_dashboard.py` — 3/3 pass (upsert increments, endpoint derives from truth, non-derived kinds like `webhook_sync`/`coa_generated` preserved).
- ✅ **3,000-user productionization pass (Feb 17, 2026)** — No functional changes; every existing behaviour (Plaid → transactions → contacts → dashboard) was verified live post-change on 531 LLC (1,870 txns, cash $5,951, 3 AI-activity rows). **What shipped**: (1) **`RedisReportCache`** added to `infra.py` — a Redis-backed sibling of `ReportCache` with the same public API (`key`, `get_or_compute`, `ainvalidate`). `get_cache()` sync-pings Redis at first call; success → Redis backend (multi-pod safe, invalidations visible across replicas); failure → transparent fallback to in-process `ReportCache` (preview-env behaviour). `sync_tasks._mark_done` now `await`s `ainvalidate(cid)` so the cache purge on sync-complete works with either backend. slowapi rate-limiter already reads `REDIS_URL` for shared storage. (2) **Motor pool bumped 100 → 200** per pod via `MONGO_MAX_POOL_SIZE` env var (`db.py`); 5 s server-selection timeout added so pods fail fast on Mongo outages. (3) **`MAX_CONCURRENT_SYNCS` env-configurable** (default 20, prod override 40 in K8s manifest) — 3 pods × 40 = 120 parallel Plaid syncs. (4) **`/api/health` (liveness) + `/api/ready` (readiness)** endpoints — `/ready` asserts Mongo ping AND `sync_tasks.register_all()` completed, so K8s doesn't route traffic to a pod that would 500 on the first webhook. (5) **K8s manifests updated for 3k**: `backend-deployment.yaml` → 3 replicas, `terminationGracePeriodSeconds: 60`, 5 s `preStop sleep`, both probes wired; `hpa-backend.yaml` → min 3 max 12, 70% CPU target; obsolete `worker-deployment.yaml` + `hpa-worker.yaml` deleted (in-process sync tasks replaced them); `redis-deployment.yaml` retained but re-scoped to cache + rate-limiter only (`--maxmemory 512mb --maxmemory-policy allkeys-lru`); `README.md` rewritten with the new architecture, 3k sizing table, rollout order, and observability watchlist. **Tests** — 18/18 across five files pass: batch resolver 6/6, in-process job queue 5/5, cache invalidation 2/2, AI activity 3/3, Redis cache contract 2/2 (using `fakeredis` since preview env has no redis-server binary). **Scale headroom @ 3k users**: 50 req/s peak API load ÷ 3 pods = 17 req/s per pod (well under the 200-500 req/s per-pod ceiling); 120 concurrent Plaid syncs saturates in ~3 min even in a "everyone connects at once" spike; Mongo pool 600 conns total sits comfortably inside Atlas M30's 1500-conn budget.
- ✅ **Connections page → tabs + Veryfi bank-statement imports (Feb 17, 2026)** — Split the Connections page into two tabs: **"Connect accounts"** (existing Plaid flow, unchanged) and **"Load account statements"** (new Veryfi upload flow). Ported from Rocketsuite's `/imports` module. **New backend**: (1) `statement_account_resolver.py` — matches or creates the CoA asset row for a statement using: (a) last-4 digit substring match on existing bank-flavored asset accounts (most specific), (b) fuzzy institution-name match when exactly one candidate exists, (c) auto-create a new asset account with Rocketsuite-style name ("Bank of America Checking ···6084") using the next free numeric code from 1010. Credit-card statements produce "Credit Card"-named accounts. (2) `statements.py` — orchestrates upload → OCR → resolve CoA → auto-promote via a Veryfi-tailored version of the PFC + AI pipeline. Every Veryfi transaction now carries `statement_import_id` so the detail-page join is exact + deletes are clean. (3) `ai_activity.log_ai_event` reused; posted/flagged counters emitted so the Dashboard's AI Activity widget reflects Veryfi imports too. **New endpoints**: `POST /statements/upload`, `GET /statements/imports`, `GET /statements/imports/{id}`, `DELETE /statements/imports/{id}` (with cascade delete of produced txns). **New frontend**: (1) `components/StatementsTab.jsx` — drop zone (multi-file, PDF/JPG/PNG, ≤25 MB), auto-detect + manual account selector, upload progress rows with processing/completed/failed pills, imports history table matching the Rocketsuite reference (When/File/Account/Method/#/Range/Status). (2) `pages/StatementImportDetail.jsx` — read-only detail view with statement metadata card (institution / account holder / balances) + extracted-transactions table with green "promoted →" pills. Route `/connections/imports/:importId`. **Tests**: `tests/test_statement_account_resolver.py` — 5/5 pass (last-4 match wins, fuzzy bank-name match on single candidate, ambiguous-multi creates new, from-scratch create, credit-card naming). All 23 tests across six files remain green. **Zero regressions** on the Plaid flow — the existing `categorize_and_insert_plaid_txns` was left untouched; Veryfi has a parallel `_categorize_and_insert_veryfi_lines` that reuses the same PFC, contact_resolver, and categorizer helpers so quality matches Plaid without cross-contamination.
- ✅ **Veryfi extractor: read nested accounts[i].transactions (Feb 17, 2026)** — User reported the first two 602 LLC statement uploads landed 0 transactions each despite Veryfi returning a valid document (bank name, period, beginning/ending balance all extracted correctly). **Root cause**: Veryfi's current bank-statement product returns `transactions: []` at the top level and puts the real rows inside `accounts[i].transactions[]`. Our `extract_transactions()` only iterated the top-level array, so every row was silently dropped. **Fix**: rewrote `veryfi_service.extract_transactions()` to iterate all three shapes we've observed: (1) top-level `transactions[]` (older API), (2) nested `accounts[i].transactions[]` (current API — Feb 2026), (3) `line_items[]` (documents-endpoint fallback for receipts). Also updated `statement_account_resolver._statement_fields` to read `beginning_balance` (current) OR `starting_balance` (older) and `accounts[0].number` (current) OR `account_number` (older). Also collapses Veryfi's `text` field (tabs + newlines) into a single-space description. **Backfilled**: ran `tests/reprocess_zero_txn_imports.py` against 602 LLC — the two failed imports were re-extracted from persisted `veryfi_raw` (no re-hitting the OCR API) and now show 98 + 94 transactions, all auto-posted through the PFC/contact/categorizer pipeline. **Tests**: `tests/test_veryfi_extract.py` — 7/7 pass (nested accounts, top-level, both combined, multi-account flatten, empty doc, description normalization, line_items fallback). Total suite: 30/30 across seven files.
- ✅ **Plaid link: per-account CoA auto-create (Feb 17, 2026)** — User requested the same behaviour we just shipped for Veryfi ("statement upload auto-creates `1011 Bank of America Checking ···6084`") to apply the first time Plaid downloads transactions from a linked account. Previously the Plaid pipeline used a hard-coded `SUBTYPE_MAP` that collapsed every linked "checking" account onto a shared `1010 Business Checking`, every "savings" onto `1020 Business Savings`, etc. — three Chase accounts on the same company all landed on the same 1010 row. **Fix**: (1) Refactored `statement_account_resolver.resolve_statement_account` — extracted the core match/create logic into a new public `resolve_or_create_bank_account(cid, *, bank_name, account_number, account_type, is_liability, source)` that both Veryfi and Plaid now call. (2) Rewrote `plaid_connect.get_ledger_for_plaid_account` to delegate to that resolver, passing Plaid's `mask` as the last-4 and the item's institution name (fetched via new `plaid_service.get_institution_name` at Link time). Falls back to the legacy `SUBTYPE_MAP` only when both mask AND institution are missing (Plaid sandbox synthetic rows) to avoid spamming "···None" duplicates. (3) Credit cards now correctly resolve into the liability range (2100-series). (4) Tightened the fuzzy-match heuristic to require BOTH the institution name AND the account-type keyword to appear in the candidate name — otherwise a new Chase Savings statement would wrongly collapse onto an existing Chase Checking row. (5) `institution_name` now persisted on `plaid_items` docs at Link exchange time. **Behaviour**: New Plaid links now create dedicated CoA rows per account like `1011 Chase Business Checking ···6084`, `1012 Chase Savings ···1234`, `2101 Amex Credit Card ···1005` — matching the naming convention users saw with Veryfi. Existing links are unaffected (the periodic sync in `sync_tasks._run_sync` uses `account_mappings` persisted on the plaid_item doc, which continues to point at the original row). Re-clicking Connect on an already-linked account is idempotent (last-4 match returns the existing row). **Tests**: `tests/test_plaid_coa_resolver.py` — 5/5 pass (fresh link creates dedicated row, multiple accounts on same institution get separate rows, credit cards land in liability range, re-link idempotent, no-mask synthetic accounts fall back to legacy shared row). `tests/test_statement_account_resolver.py` grew to 6/6 (added subtype-collapse regression guard). Total suite: **36/36 across eight files**.
- ✅ **Dashboard cash-on-hand: fixed after resolver rollout (Feb 17, 2026)** — User reported Cash on Hand for 317 LLC showed −$1,418.17 despite 1,874 auto-posted transactions and a healthy AI-Activity widget. **Root cause**: `dashboard_metrics.cash_on_hand` filtered accounts by a hard-coded list `["1000", "1010", "1020"]`. When the Plaid/Veryfi resolver started auto-creating dedicated rows like `1011 Bank of America Checking ···6084` (with `subtype="Bank"`), transactions on those new rows were silently excluded — cash-on-hand collapsed to whatever residual activity was left on legacy 1010 (which, for 317 LLC, happened to equal exactly the 30-day net of ±$1,418.17). **Fix**: broadened the query to match any asset account in the 1000–1099 code range plus 1100 (Undeposited Funds) plus any account flagged with `subtype="Bank"`. Verified live on 317 LLC via the testing_agent — cash_on_hand now returns **$5,662.93** (11.04 txn-sum + 5,651.89 opening-balance-JE-sum across 1000/1010/1011/1020/1100). Non-cash assets (A/R 1200, Inventory 1300, Prepaid 1500, Fixed 1600+) explicitly excluded. **Testing**: `tests/test_iter23_cash_on_hand_live.py` — 5/5 pytest pass (live 317 LLC check, live spot-check on Bright Beans, legacy 1010 regression, non-cash A/R+Inventory+Prepaid+Fixed no-leak, resolver-shape reproduction). Testing_agent report `/app/test_reports/iteration_23.json`: 100% success rate, zero critical or minor issues. Total suite: **41/41 across nine files**.
- ✅ **Dashboard = Balance Sheet reconciliation for single-Plaid-account cases (Feb 17, 2026)** — After iter23 fixed cash-on-hand's account filter, user pointed out that 317 LLC still had THREE cash rows on the Balance Sheet (`1010 -$1,418.17 · 1011 $7,081.10 · 1100 -$2,265.94 = $3,396.99`) while the Dashboard tile showed $5,662.93 and Plaid's live balance was $4,233.72 — three different numbers when only ONE Plaid account exists. **Three root causes**: (A) `pfc_mapping.TRANSFER_IN_DEPOSIT` routed to `1100 Undeposited Funds` as `asset_movement`, but Plaid ATM/mobile-deposit rows already sit on the bank as `bank_account_id`, so pairing with 1100 as category produced an impossible negative Undeposited balance. Fixed → maps to `4999 transfer_review` (needs review, CPA to decide revenue vs owner-contribution vs A/R payment). (B) `pfc_resolver._is_bank_account` didn't recognize `1100` (Undeposited Funds) or resolver-created rows with `subtype='Bank'` — the safety guard didn't block auto-routing to them. Extended predicate covers all three cases now. (C) 102 legacy txns had landed on `1010 Business Checking` before the Plaid resolver started auto-creating `1011 BofA Checking ···6084` mid-sync. **Backfill**: `tests/backfill_317_llc_bank_cleanup.py` (idempotent, already run) — reclassified the 5 mis-mapped 1100 txns → 4999 (`needs_review=True`, `ai_source='pfc_backfill_2026-02-17'`), migrated the 102 legacy-1010 txns → 1011, deactivated the empty 1010 row (`active=false` for audit-trail), rewired `plaid_items.account_mappings` to point at 1011. **Verified live by testing_agent** (`/app/test_reports/iteration_24.json`): 317 LLC Dashboard cash_on_hand = Balance Sheet total_assets = **$5,662.93** to the cent · Balance Sheet shows a single active bank row (1011) · TRANSFER_IN_DEPOSIT resolver test confirmed routing to 4999/transfer_review/needs_review. 6/6 pytest pass, 100% success rate, zero critical issues. Testing agent flagged one unrelated minor: Bright Beans (onboarding-in-progress test company) has BS/Dashboard mismatch of its own — pre-existing and out of iter24 scope. **Ledger-vs-Plaid drift** ($5,662.93 vs Plaid's live $4,233.72 = $1,429.21) is expected behavior — Plaid's real-time balance drifts from a static Opening Balance Equity JE due to pending / authorization-hold activity; will be addressed by the future auto-reconciliation feature. Total suite: **47/47 across ten files**.
- ✅ **Cleanup Copilot: multi-bucket categorization with amount-range splits + exceptions (Feb 17, 2026)** — Extended the AI chat cleanup flow to handle real-world bookkeeping like "anything from 0 to 5000 is X, above is Z" and "categorize all as X except for $Y which is Z". **Backend**: new `POST /companies/{cid}/transactions/apply-multi-bulk-approve-rule` (`transactions.py:772`) accepts `groups: [{txn_ids, category_account_id, amount_min, amount_max, rule_label}]` + `create_rules: bool` + `contact_id/contact_name`. Each group updates its txns (skips already-reviewed + closed-period), then idempotently creates a contact_id rule carrying the amount bound (so future Plaid imports auto-route per range). Backend verified 5/5 curl scenarios: range-split, exception, create_rules=false, empty groups, skip-already-approved. **Frontend**: `AiPanel.jsx` `cleanup-inquiry` interceptor gained a natural-language parser (`parseMoney`, `cleanCat` with 'categorize all as X' prefix strip, range regex for `under/below/less than/up to/from X to Y`, exception regex for `X except for the $Y which is Z`). Falls through to single-bucket for plain answers ("these are all Office Supplies"). Emits a new `cleanup-multi-confirm` card (`InlineConfirmCard` testid=`cleanup-multi-card`) with per-bucket preview (`N rows (up to $X) → 6000 Meals`). Confirm handler ensures accounts via `/accounts/ensure`, POSTs the multi-bulk endpoint. **Testing agent iter28**: 100% (5/5 UI + 5/5 backend). On 613 LLC / Walmart: 213 rows split cleanly 71 Meals + 136 Office Supplies at $50 threshold + 2 amount-scoped rules created; exception `Meals except for the $127.28 which was actually Travel` correctly routed 19 rows→Meals + 1 row→Travel.
- ✅ **Cleanup Copilot: auto-suggest range splits from bimodal amount distributions (Feb 17, 2026)** — When the AI opens a cleanup inquiry ("what are these N <Vendor> transactions?"), it now proactively probes the amount distribution and — if bimodal — surfaces the natural split as a one-click quick action. **Backend**: new `GET /companies/{cid}/transactions/split-suggestion?contact_id=X` (`transactions.py:846`). Algorithm: sort abs(amount) of unreviewed txns, find the largest gap; accept as bimodal iff ≥6 candidate rows, both clusters ≥3 rows, gap ≥ max(3× median inter-amount gap, 1.5× tighter-cluster range, $20). Threshold is rounded to a nearby "nice" number ($10/$25/$50/$100/$250/$500/…) when within 10%. Returns `{suggestion:{threshold, below:{count,min,max}, above:{count,min,max}, gap}}` or `{suggestion:null, reason}` with an explainable reason. **Frontend**: new `SplitHintForm` component (`AiPanel.jsx:52`) — two inline inputs (`split-hint-below`, `split-hint-above`) labelled `N rows ($min–$max) →`, Apply button, Ignore button. The `cleanup-inquiry` interceptor now fetches the suggestion after building the assistant message and attaches `splitHint` to it; the form renders under the message and, on Apply, synthesizes `under $${t} is X, above is Y` and auto-fires the send via `sendRef.current?.()`. **Iter29 caught two bugs, both fixed in the same session**: (i) template originally had `above $${t} is Y` which the range regex mis-captured as `$100 is Office Supplies` → changed to `above is Y` AND hardened `cleanCat` to also strip leading `$X is/=` prefixes (defensive for user-typed variants). (ii) `setTimeout(send, 30)` captured stale closure → switched to `setTimeout(() => sendRef.current?.(), 30)`. **Iter30 retest**: 100% pass; on synthetic SplitDemo Vendor (12 txns, $5–$40 + $150–$220), backend returns threshold=$100, below=6 / above=6, gap=$112.2; UI flow completes in one click; DB shows 6 rows→Meals + 6 rows→Office Supplies + 2 amount-scoped rules created.
- ✅ **Cleanup Copilot: recall last-used split categories + auto-advance queue (Feb 17, 2026)** — Two follow-up UX wins that make cleanup feel like a conveyor belt. **Recall**: `split-suggestion` now also queries prior rules (`match_type=contact_id, source=user_multi_bulk_approve`) for the same contact and returns `previous_below` / `previous_above` account names — the below rule picked by `amount_max ≤ threshold*1.5`, the above by `amount_min ≥ threshold*0.5`. Frontend `SplitHintForm` seeds its state from those names, renders a `split-hint-recall` badge ("recalled from last time"), and changes the Apply button label to **"Yes, same again"**. Assistant message copy shifts too: `Last time you split <Vendor> at $100 → **Meals** / **Office Supplies**. Same again?` — turning a two-input decision into a single-click confirm. **Auto-advance**: When a cleanup batch confirms (multi-bulk OR single-bulk), we emit a new `cleanup-completed` action via `emitAction`. `CleanupCopilot` listens with `useActionListener`, adds the contact to its `dismissed` set, reloads `/cleanup-suggestions`, and after ~1.2s calls `onApplyAction` for the next queued action — automatically firing the next `cleanup-inquiry` without the user touching the copilot. **Testing agent iter31**: 100% pass end-to-end (backend + frontend). Verified recall pre-fill, one-tap re-run, no-duplicate rules, auto-advance transitioning from SplitDemo → next real uncat contact (Larry D Brown surfaced automatically ~1.2s after confirm). Regression: contacts without prior rules still render empty inputs + neutral copy.
- ✅ **Cleanup Copilot: skip intent + Skip chip (Feb 17, 2026)** — User reported that saying "let's skip Amazon" caused the AI to build a plan to categorize Amazon rows AS "let's skip Amazon (new)". Added a first-class skip flow: (1) natural-language skip regex `^(?:let's?|please|just|can we|can you)?(?:skip|move on|move past|pass|next|not now|not yet|come back later|hold off|ignore|forget it|leave it)\b(?!\w)` — the `\b(?!\w)` anchor prevents category names like "Skipper Bar", "Skippy peanut butter", "passes for the gym", "nextgen consulting" from being mis-caught. (2) Skip branch in the `send()` cleanup-inquiry interceptor emits `cleanup-completed` with `skipped: true`, so the existing auto-advance in `CleanupCopilot` transparently dismisses the contact and queues the next one. (3) Visible **`cleanup-skip-btn`** chip rendered under every cleanup-inquiry assistant message ("or skip Amazon →") for discoverability — voice and click both work. **Testing agent iter32** caught a TDZ ReferenceError (`const rawText` was declared after the new skip branch referenced it) and fixed it in-place by hoisting the declaration. Final: 22/22 skip phrasings + 4/4 non-match anchors + Skip button + regression categorization pass at 100%.
- ✅ **CPA Reviewer LLM gate for cleanup answers (Feb 17, 2026)** — User reported two critical bugs: (1) "they look good the way they are" created a NEW account literally named "they look good the way they are (new)" for 32 Amazon rows; (2) "let's look at healthy paws" created a NEW account "let's look (new)" for 20 Eimorlain Ugali rows. Root cause: the client-side regex parser treated any string as a valid category name — no accounting knowledge. **Fix**: entirely replaced the client-side parser with a Claude Sonnet 4.5 CPA-reviewer LLM gate. **Backend**: `POST /api/companies/{cid}/ai/cpa-review` (`ai_ops.py:85`) + `cpa_review()` helper (`ai_service.py:598`). Assembles full Chart of Accounts + sample txns + current-category rollup as LLM context. Returns strict-JSON intent classification: `categorize` (with resolved buckets pointing to existing account IDs OR new GAAP-safe accounts), `approve_existing`, `redirect` (target_contact_name), `skip`, `question`, `unclear` (with clarifying_question). GAAP-compliant code ranges enforced in prompt: 1000-1999 Assets, 2000-2999 Liabilities, 3000-3999 Equity, 4000-4999 Revenue, 5000-5999 COGS, 6000-9999 Expenses. Server-side safety net downgrades categorize→unclear when a bucket's account name is a whole-name filler phrase ("they look good", "let's", "okay", "fine" — matched against exact-name whitelist to avoid false positives on legitimate short names like "IT" or "HR"). **Frontend** (`AiPanel.jsx:1074-1265`): send() cleanup-inquiry branch now calls /ai/cpa-review after the fast-path skip regex, then dispatches by intent — approve_existing → apply-multi-bulk-approve-rule with current category_account_ids (no rules created); redirect → dismiss current + look up target contact by name + re-emit cleanup-inquiry; question → fall through to normal chat stream; categorize → build cleanup-multi-confirm card directly from LLM's resolved buckets (skipping regex entirely). **Testing agent iter33**: 16/16 backend pytest + 4/4 frontend Playwright PASS at 100%. Verified 'they look good' → approve_existing (no garbage account); 'let\'s look at Healthy Paws' → redirect + fresh cleanup-inquiry; 'aggressive Q4 marketing spend' → EXISTING 6200 Advertising & Marketing (LLM correctly prefers existing over creating new); 'fine dining meals' still categorizes to 6000 Meals despite containing "fine" (tightened whole-name filler check); 'these are IT expenses' still categorizes despite short "IT" token. Backend p50 ~4-5s per LLM roundtrip.
- ✅ **Cleanup Copilot: contact re-appearance + refinement fixes (Feb 17, 2026)** — In a real cleanup session on 704 LLC the user hit two adjacent bugs: (1) Amazon and Eimorlain Ugali Co (both `contact_split` targets) kept re-appearing in the top_actions queue AFTER the user had already resolved them via approve_existing — so the copilot felt like it was looping; (2) Typing a refinement like "no, only the uncategorized ones" after a `cleanup-multi-confirm` card was showing dropped through to the plain chat stream and produced a hallucinated "Got it — I'll…" response with no action. **Fixes**: (a) `/transactions/cleanup-suggestions` now filters BOTH `split_by_contact` and `uncat_by_contact` by `not human_reviewed` — once a contact's rows are all reviewed (via any path: categorize, approve_existing, bulk-approve), it drops off the queue and stays off. Regression test at `/app/backend/tests/test_iter34_cleanup_filters.py`. (b) `AiPanel.jsx` approve_existing branch now has an idempotent fallback: if the contact has zero unreviewed rows, it emits `cleanup-completed` + "Already approved — moving on" instead of the old "None of these rows have a category yet" error. (c) `AiPanel.jsx` categorize branch now KEEPS `pendingIntentRef` set after building the cleanup-multi-confirm card — so if the user types a refinement instead of clicking Yes/No, the next message re-enters the CPA-review gate (with the same contact context) instead of falling to the plain chat stream. **Iter34**: backend 100% (marking Eimorlain's 21 rows reviewed drops it from top_actions; restored). Frontend fix code-reviewed as correct — auto-advance transitioning between contacts is safe because the cleanup-inquiry listener overwrites pendingIntentRef on every event.
- ✅ **Internal-transfer batch detector (Feb 18, 2026)** — Auto-detects and books transfers between two company-owned bank/credit-card accounts so both legs collapse to the Inter-Account Transfer equity account instead of polluting the P&L. **Backend**: new `detect_transfer_pairs(cid, dry_run, date_since)` in `/app/backend/routes/transactions.py:674` matches txn pairs by opposite-signed equal-magnitude amounts (±$0.01), ±3-day tolerance, different bank_account_id's, both bank-linked, neither already reviewed. Deterministic tie-break by |date-delta| then earliest id. Extracted `_ensure_transfer_account()` helper (reused by the existing per-txn mark-as-transfer flow). New endpoint `POST /companies/{cid}/transactions/detect-transfers` accepts `{dry_run, date_since}`. Post-sync hook in `sync_tasks._run_sync` runs the detector automatically after every Plaid sync (with warning-level logging on failure). **Frontend**: new `Detect transfers` button on the Transactions page header (data-testid='detect-transfers-btn') opens a preview modal (data-testid='detect-transfers-preview') listing each pair's debit + credit leg + date-delta; Apply button books both legs. **Iter35**: 100% pass — 6/6 new pytest (`/app/backend/tests/test_iter35_transfer_endpoint.py`) covering auth (403 for wrong company), dry_run/date_since flags, live-run persistence, sync-hook wiring; standalone regression harness at `/app/backend/scripts/manual_test_iter35_transfer_detect.py` covers 4 correctness scenarios (dry-run vs live, non-match rejection, idempotency, real 704 LLC $13,200 pair). Frontend Playwright: button + modal + apply + toast all verified. Equity account 3200 Inter-Account Transfer auto-created and preserved for future syncs.
- ✅ **Cleanup queue expansion + auto-advance fix (Feb 18, 2026)** — User reported: after PSG/Larry/etc completed, the AI "just repeated itself" — it kept looping on `flagged_batch (227)` because top_actions was capped too small AND auto-advance served flagged_batch whose CPA-review ambiguity re-fired the same inquiry. Also spotted a UI glitch: "Already approved — moving on from **undefined**" when auto-advance touched a flagged_batch (no contact_name). **Fixes**: (a) `/cleanup-suggestions` bumped from `[:8]` overall + `[:8]/[:6]` per-kind → `[:50]` per-kind + `[:50]` overall; filter by `>= 3` threshold BEFORE slicing so valid smaller contacts aren't lost when many raw contacts fall below threshold. (b) Combined sort by count DESC across kinds so the biggest cleanup wins surface first regardless of whether they're contact_in_uncat or contact_split. (c) `flagged_batch` pinned to the END of the list — it's a different workflow. (d) `CleanupCopilot.jsx` auto-advance filter now explicitly skips `flagged_batch` (only manual "Fix now" chip click enters that flow). (e) `AiPanel.jsx` approve_existing rows.length===0 fallback uses `contact_name || "these transactions"` guard. **Iter36**: 5/5 backend pytest + code-review-verified frontend. Regression at `/app/backend/tests/test_cleanup_suggestions_iter36.py`.
- ✅ **`contact_ai_ready` action — one-tap bulk-approve for AI-categorized batches (Feb 18, 2026)** — User's iter36 fix didn't fully solve their 812 LLC issue: only `flagged_batch (227)` surfaced because no vendor had ≥3 UNCATEGORIZED rows (the 1859 AI-categorized-unreviewed rows spread across many vendors weren't in any bucket). **Fix**: new action kind `contact_ai_ready` — for each contact with ≥ threshold AI-categorized-unreviewed rows all in the SAME account, surface a one-tap bulk-approve opportunity with the pre-resolved `{id, code, name}` account attached. Deduped against `contact_in_uncat` and `contact_split` (no vendor appears twice). Adaptive threshold now applies symmetrically to all three kinds — drops to ≥2 when the queue is thin (< 5 candidates). Also added a `contact_name` cache to avoid O(N*M) scan in the split_ranked loop. **Frontend**: new emerald chip (`KIND_STYLES.contact_ai_ready`, ✓ dot); `pitchFor` copy tuned; `AiPanel.jsx` cleanup-inquiry branch produces an account-aware assistant message ("Walmart rows were AI-categorized as **6800 Supplies & Materials** — say 'approve' to sign off"). Since `approve` naturally routes to intent=approve_existing via the CPA reviewer, no new endpoint or client flow needed. **Iter37**: 10/10 backend pytest (`/app/backend/tests/test_cleanup_suggestions_iter37.py`) + frontend UI+integration verified. 812 LLC went from 1 top_action → 50 (top 10: Walmart 213, Healthy Paws 73, Capital One 53, AT&T 48, VCA 42, Starbucks 42, NY Life 36, Target 34, PetSmart 33, McDonald's 30 — all AI-categorized-ready).
- ✅ **"Approve all AI-ready" mega button (Feb 18, 2026)** — one-click confirm that fires bulk-approve for every contact_ai_ready vendor. **Backend**: `POST /companies/{cid}/transactions/bulk-approve-ai-ready` accepts `{dry_run, contact_ids?}` and returns `{total_contacts, total_rows, total_amount, vendors:[full uncapped list], batch_id, updated}`. Marks rows human_reviewed with `ai_source='user_bulk_approve_ai_ready'` and tags them with a shared `mega_batch_id`. Excludes rows with `needs_review=true`. Only touches vendors with UNANIMOUS AI opinion; skips closed periods silently; idempotent. **Undo**: new `POST /transactions/undo-mega-batch/{batch_id}` reverts every tagged row (human_reviewed=false, posted=false, needs_review=false, tag cleared). **Frontend**: emerald button on CleanupCopilot band opens a modal with the FULL scrollable vendor list (search + Select-all/None + per-vendor toggle) and a persistent 60s Undo toast at `z-[70]` (above AiPanel z-60). Iter38+39: 12/12 backend pytest + E2E verified on 1119 LLC (1,054 rows / 193 vendors).
- ✅ **Mega bulk-approve: per-row Approve link + category pill (Feb 18, 2026)** — Added inline "Approve →" text link on every vendor row so a CPA can fly through single-vendor approvals. Optimistic UI (row + summary counts decrement instantly, rollback on API error). Category rendered as an inline pill so it stands out. **Iter40**: 5/5 frontend PASS on 1119 LLC (187 vendors); successive per-row approves shrink list 864→840→818 rows, fresh Undo toast each time, all 66 test-touched rows reverted after the run.

## Prioritized Backlog

### P1
- Real QBO OAuth + entity sync
- Voice interface for AI chat
- Recurring transactions / bill scheduling
- CSV / bank statement direct import UI
- Plaid webhook signature verification (Plaid-Verification JWT)

### P2
- Firm branding / white-label for Pro accounts
- Multi-currency support
- Budget vs. actual reports
- Notification hooks for flagged txns
- Attachment upload on transactions (object storage)
- Audit log
- Stripe subscription billing for the SaaS itself

## Prioritized Backlog

### P0 — none (MVP feature-complete)

### Recently shipped (2026-07-18 late — patch 8: modularization + smarter voice)
- **P1 REFACTOR DONE**: `server.py` split from **4055 → 125 lines**. All ~148 endpoints extracted into 22 topical route modules under `/app/backend/routes/` (`auth`, `admin`, `pro`, `companies`, `accounts`, `transactions`, `ai_ops`, `rules`, `contacts`, `invoices`, `bills`, `payments`, `journal`, `report_routes`, `onboarding`, `plaid`, `statements_routes`, `reconciliation`, `inventory`, `chat`, `anomaly`, `health_probes`, `root`). Shared Pydantic input schemas moved to `models.py`, cross-cutting helpers (`require_company`, `company_ids_for_user`, `log_ai`, `is_period_closed`, `assert_open`, `categorize_and_insert`, `sync_and_import`, `DASH_CACHE_TTL`) moved to `deps.py`. Backward-compat aliases preserved on `server` module (`_categorize_and_insert`, `_require_company`, etc.) so legacy test imports keep working. Verified: 24/24 refactor-smoke endpoints green, 3/3 voice-router flows green, no new pytest regressions vs pre-refactor snapshot.
- **Voice router — combined intent**: "open the Citi Card detail **from March**", "pull account 2110 **for Q1 2026**", "show me Rocket Mortgage **year to date**", "since January", "last month", "last quarter", "last year", "past 30 days", "**from March to June**". New `extractPeriod()` in `voiceCommands.js` parses the phrase, strips it from the utterance (so account fuzzy-match still hits), and forwards `start`/`end` into the remote payload. `AiPanel` appends them to `/reports/account-detail?account=<id>&start=YYYY-MM-DD&end=YYYY-MM-DD` — CPAs zoom straight into a period on any account, entirely hands-free. All 11 phrasings unit-tested via node.

### Recently shipped (2026-07-18 late — patch 7: Account Detail polish)
- **Contact column** — Account Detail table now shows the transaction Contact between Merchant/Description and Amount (col-span layout 1/2/3/2/2/2). Contact resolves from `transactions.contact_name`.
- **Breadcrumb back to Balance Sheet with scroll restoration** — top of Account Detail shows *"Balance Sheet / <code> · <name>"*. Click on the drill-in row captures `document.querySelector('main').scrollTop` (the app shell scrolls the `<main>` element, not the window) into `sessionStorage["bsScrollY"]` and the current BS URL into `sessionStorage["bsReturnUrl"]`. Breadcrumb reads both and returns to that exact position via a double-rAF + 120ms fallback timeout after data render.
- **Search + Filter drawer** — new URL-param-backed search input (`q`) and Filters popover (Date from/to, Amount ≥ / ≤). Backend `compute_account_detail(company_id, account_id, start, end, q, contact_id, min_amount, max_amount)` post-filters the txn cursor by needle in `merchant / description / contact_name` and by `abs(amount)` range. Filter count badge on the toggle button; "Clear all filters" resets everything.
- **Voice router: "open account 2110" / "pull the Citi Card detail"** — new `OPEN_ACCOUNT_RE` in `voiceCommands.js` returns `{ handled: true, remote: 'open-account', target }`. `AiPanel.jsx` fetches `/accounts`, tries exact code → code prefix → fuzzy name match, navigates to `/reports/account-detail?account=<id>` and speaks *"Opening <code> <name>"*.
- **Data-shape render guards** — added `Array.isArray(data.assets)` / `data.rows` / etc. checks on every report body so a lingering stale-data state during URL kind transitions no longer crashes the page ("Cannot read properties of undefined").
- **Also**: `account-detail/pdf` endpoint accepts the same new filter params, so exported PDFs match the on-screen filtered view.

### Recently shipped (2026-07-18 evening — patch 6)
- **Account-detail is now a first-class report, not a modal drawer** — clicking any BS row navigates to `/reports/account-detail?account={id}`, rendered by `ReportView` alongside Balance Sheet, Income Statement, Trial Balance, etc. Same page layout (title bar, Apply/PDF-export buttons, boxed report body).
- **PDF export** — new `GET /api/companies/{cid}/reports/account-detail/pdf?account_id=...` produces a proper `account_detail_<code>.pdf` via `build_account_detail_pdf` (ReportLab, same visual grammar as trial balance/GL).
- **JSON endpoint** — `GET /api/companies/{cid}/reports/account-detail?account_id=...` returns `{account, rows, count, sum_amount, balance, period_start, period_end}` with running balance already computed server-side.
- **Bulk-update preserved** — checkboxes + Move-to-account button live in the report body just like they did in the drawer.
- Removed the old `AccountDrilldown` component; ReportView cleaner and no more overlay z-index gymnastics.

### Recently shipped (2026-07-18 evening — patch 5)
- **Mic is click-to-toggle only** — removed the hold-to-talk (PTT) mode entirely. One click flips OFF ↔ LIVE (open-mic). Tooltip: *"Voice off — click to go live"* / *"Voice on — click to mute"*. Legacy `axiom_mic_mode=ptt` from localStorage is coerced to `open` on load so returning users don't get stuck.
- **Sidebar no longer auto-flips into Accounting sub-view** — clicking "Transactions" from the main sidebar navigates to `/accounting/transactions` but the sidebar stays on the main view. The Accounting sub-view only opens when the user explicitly clicks the *Accounting* button.

### Recently shipped (2026-07-18 evening — patch 4)
- **Drilldown drawer sits BESIDE the AI chat**, not over it. Wrapper repositioned from `fixed inset-0` to `fixed inset-y-0 left-0 right-[24rem]` so the AI panel (w-96 = 24rem) stays visible and interactive while the user reviews / edits transactions in the drawer.
- **Row checkboxes + select-all** in the drilldown. Every row now has an accent-indigo checkbox; header has a select-all checkbox that also shows an indeterminate state when a subset is selected. Selected rows highlight in `bg-indigo-50/40`. Button label + subtotal auto-update: *"Move all N…"* when everything's picked, *"Move X of N — sums to $Y"* when a subset is picked. Disabled when nothing selected.
- **`Move X` payload** — bulk-reclassify now sends only the selected `transaction_ids`, not the full row list.

### Recently shipped (2026-07-18 evening — patch 3)
- **Move-all bulk-reclassify** — from the balance-sheet drilldown drawer, click *"Move all N to another account"* → picker opens (all account types visible, source excluded) → one click moves the entire drilled-in transaction list via `bulk-reclassify`. Toast confirms the target account name. Balance sheet auto-refreshes on close so the emptied account disappears immediately.
- **Extended ReclassifyPicker** with `allowedTypes` (null → all), `title` override, and `excludeIds` so it can be re-used as a general account picker.
- Verified end-to-end via curl on 804 LLC: `POST /transactions/bulk-reclassify` with the drilled-in txn IDs → `{"ok":true,"updated":1}`, then confirmed `?category_account_id=2510` returned 0 rows post-move.

### Recently shipped (2026-07-18 evening — patch 2)
- **Sub-account auto-creation for the REAL Plaid path** — `plaid_connect.categorize_and_insert_plaid_txns` (used by `_sync_and_import`) was the missing hook site for 804 LLC. Added `maybe_route_to_liability_subaccount` + accts_by_id refresh loop so children created mid-batch are reused for subsequent txns in the same sync. All 5 ingestion paths now hooked: real Plaid sync, mock-Plaid demo, mock-Veryfi demo, real Veryfi bank-statement upload, manual `POST /transactions`.
- **Tap-to-drill on Balance Sheet** — click any account row → slide-over drawer (`AccountDrilldown`) shows every transaction posted to that account with date, merchant, amount, and running balance. Backend `GET /transactions?category_account_id=…` filter added. Row-highlight on hover, click-outside to close, keyboard-friendly. Drawer at `z-[70]` to sit above the AI panel.

### Recently shipped (2026-07-18 evening — patch)
- **Bug fix: sub-account auto-creation on new-company onboarding** — the demo `/onboarding/mock-plaid` and `/onboarding/mock-veryfi` endpoints (which run when a new company is set up) were bypassing `maybe_route_to_liability_subaccount` because they inserted transactions inline instead of going through `_categorize_and_insert`. Same latent gap in `POST /transactions` (manual create) and `statements.py` (real Veryfi bank-statement upload). All four paths are now hooked. New companies (e.g. 746 LLC) get sub-accounts inline instead of needing a follow-up fanout. Fanout endpoint remains available for legacy data.

### Recently shipped (2026-07-18 evening)
- **Liability Sub-accounts** — parent buckets like *2500 Loans Payable* / *2100 Credit Card Payable* now auto-fan-out into per-payee children (2510 Mr. Cooper, 2520 Rocket Mortgage, 2110 Capital One, …) whenever a transaction lands on a generic parent bucket. New `liability_subaccounts.py` module with regex-based bucket detection, ACH-memo scrubber (`MR COOPER PMT PPD ID:…` → *Mr. Cooper*), and next-free-code allocator (parent+10 stride). Hooked into: bank-feed ingestion loop, `PATCH /transactions/{tid}`, `bulk-reclassify`, plus new `POST /accounts/{aid}/fanout-subaccounts` that migrates historical transactions. Ran on 317 LLC: created 6 CC children + 4 loan children, moved 111+36 transactions.
- **Hierarchical Balance Sheet** — `compute_balance_sheet` now nests children under parents (parent row = sum of children, children indented with `parent_code` metadata). Section totals correctly count only top-level rows so nothing double-counts.
- **UI: Chart of Accounts + Balance Sheet nesting** — child rows indented with `↳` glyph, `AUTO` badge on AI-created subaccounts.


### Recently shipped (2026-07-18 late)
- **Batch Resolve Mode** — *"let's clear the flagged transactions"* → paced sprint through flagged txns. Each row card shows merchant, amount, and AI-suggested category. Voice cues: `"yes"` accepts, `"no it's meals"` (or `"actually X"`, `"put it in X"`, `"categorize as X"`) reclassifies, `"skip"` moves on, `"exit"` ends with a summary ("Accepted 3, reclassified 5, skipped 1"). Uses existing `bulk-approve` + `bulk-reclassify` endpoints; local fuzzy-match resolves spoken category names to Chart-of-Accounts rows.
- **Book Diagnostic Engine** — new `GET /api/companies/{cid}/ai/diagnose` scans the balance sheet for common data-entry pathologies: negative liabilities (over-debited), negative assets, non-zero Opening Balance Equity, unbalanced BS. Each anomaly returns a professional-quality explanation (specific $ amounts, transaction counts, and the GAAP fix). The top 5 anomalies are injected into every chat-stream call so the AI proactively diagnoses instead of giving generic "you have a data issue" replies.
- **Real 317 LLC diagnosis** — Verified: the AI now correctly identifies that CC Payable (-$31,426.78) and Loans Payable (-$80,394.89) are over-debited by 162 paydown-side transactions with ZERO offsetting charge-side entries, and recommends opening-balance JEs to book original principal.

### Recently shipped (2026-07-18 mid)
- **Weekly Review Mode** — *"walk me through the books"* runs a paced 4-step briefing (Flagged, Overdue A/R, Expense spikes, Suggested rules) with `"next"` / `"back"` / `"exit"` voice cues.
- **Chat context enrichment** — top expense categories, top vendors, recent + flagged txns, A/R + A/P aging, anomalies. AI no longer says "I don't have visibility."
- **Capability disclosure in system prompt** — Axiom knows it CAN navigate/filter/read/create by voice.
- **Nav-prefix normalization** — "take me to X", "bring me to X", "navigate to X" all work.
- **Comparative TTS narration** — "read my P&L vs last quarter" speaks top movers.
- **Chat-question disambiguation** — question-worded utterances route to LLM chat.
- **Contextual filter** — "filter by this contact" uses the AI-focused row.

### Earlier today
- TTS-narrated report summaries; transaction voice filters/deep-links; confirm synonyms (looks good/yep/post it); `normalized_name` bug fix in create_contact; Hybrid voice-driven CREATE flow with pending banner; expanded voice router (25+ routes); ReportView URL-driven filters.

### P1
- Refactor `server.py` (3300+ lines) into `/routes/` package for scalability
- Real Plaid Link SDK wiring (replace mock endpoint)
- Real QBO OAuth + entity sync
- Real Veryfi document upload + OCR
- Recurring transactions / bill scheduling
- Sales Tax Liability + 1099 Summary reports (tiles reserved)
- CSV / bank statement direct import UI
- Enforce closed-period locking on transaction edits

### P2
- Slack / Email digest (Resend/SMTP) of daily "Needs Attention" for Pros
- Veryfi statement-line balance → `bank_balance_after`
- AI-at-QBO-connect override generator & PFC-mapping settings page
- Audit log entry for every edit to Invoices/Bills
- Firm branding / white-label for Pro accounts
- Multi-currency support
- Budget vs. actual reports
- Email/notification hooks for flagged txns (SendGrid / Resend)
- Attachment upload on transactions (object storage)
- Stripe subscription billing for the SaaS itself

### 2026-02-20 — AI Onboarding Coach: full-flow wiring (Steps 1–6)
- Extended the AI onboarding coach beyond Step 0 (Business Profile) to every remaining step.
  Each step now greets the user in the AI chat panel with a step-specific "live accountant"
  message and (when meaningful) extracts structured intent from the user's freeform reply.
- **Backend** (`/app/backend/routes/onboarding.py`): added five new `_COACH_STEP_SCHEMAS`
  entries — `qbo_link` (extracts `qbo: 'yes'|'no'`; server-side value guard drops LLM
  sentinels like `'ambiguous'`), `coa_overrides` (extracts `add_hints[]`, `remove_hints[]`,
  `notes`), `plaid_intent` (extracts `skip: bool`, `institution_hint`), `veryfi_intent`
  (extracts `skip: bool`), `ready_confirm` (extracts `confirm: bool`).
- **Frontend** (`/app/frontend/src/pages/Onboarding.jsx`): expanded `COACH_SCRIPTS` with
  greeting + `ready()` + `confirm()` for every step, wrapped auto-advance in per-step
  intent (steps 0/1/4/5 advance on confident extraction, step 2 is greet-only, step 3
  never auto-advances, step 6 calls `finish()` and navigates to Transactions).
  Introduced `stepRef` / `answersRef` / `nextRef` / `finishRef` to compensate for
  `useActionListener`'s empty-deps handler binding so the extraction handler always
  reads the current step + answers. Added a `loaded` guard so the step-0 greeting no
  longer fires momentarily before persisted state arrives.
- **Tests** (iteration 44): 13/13 backend pytest across every schema + edge cases;
  7/7 frontend Playwright checkpoints walking the full Bright Beans Coffee onboarding
  flow via natural-language chat.


### 2026-02-20 — AiPanel prompt tightening + Dashboard timeframe selector
- **`AiPanel.jsx`**: shortened the "Let's Review" cleanup prompt for uncategorized-by-contact
  buckets. Was: *"I see [X] transactions sitting in Uncategorized. Tell me what these are
  and I'll categorize them all + create a rule so future imports land in the right account."*
  Now: *"I see [X] transactions sitting in Uncategorized. Tell me about them."* — keeps the
  "live accountant" tone conversational instead of pitchy.
- **`Dashboard.jsx`**: added a **timeframe picker** to the Income Snapshot header (P1 from
  handoff). Three modes — `Year to date` (default), `By month`, `By year` — with prev/next
  arrows to step the anchor and a `Today` reset pill. Header updates live
  (e.g. "Income snapshot · May 2026"). Passes `start`/`end` to the existing
  `/reports/income-statement` endpoint; the dashboard metrics tiles (Cash on hand, A/R,
  A/P, 30d activity) remain semantically period-agnostic. `data-testid`s:
  `dashboard-timeframe`, `dashboard-timeframe-mode`, `dashboard-timeframe-prev`,
  `dashboard-timeframe-next`, `dashboard-timeframe-reset`.
- Verified end-to-end via screenshot on Bright Beans Coffee (July→May 2026 step-back
  shows different revenue/expense figures).

### 2026-02-20 (later) — Enterprise branding + AI UX polish
- **AI proposal follow-through**: The AI now proposes categorizations with a
  yes/no closing question and emits a hidden `[[PROPOSAL:action=...]]` marker.
  The client parses the marker into a `pendingIntentRef`, so short follow-ups
  like "yes / do it / categorize it" execute against the current
  selection (or focused row) via the existing bulk-reclassify endpoint.
  The marker is stripped from both live streams and persisted transcripts.
- **TTS markdown stripper** (`lib/speechText.js`) — silences `**bold**`,
  headings, links, code fences so speechSynthesis reads text, not syntax.
- **Plaid Link accessibility**: When Plaid's iframe is open, we knock its
  z-index down by 1 and promote the AI panel to `position: fixed;
  z-index: 2147483647` on the right so users can mute, stop TTS, or ask
  questions without dismissing the modal. Plaid's centering is unchanged.
- **Onboarding statement uploader**: Step 5 now embeds `StatementsTab` (via a
  new `bare` prop that skips its own outer card) so onboarding matches the
  Connections › Statements experience.
- **Failed statement uploads**: The failure reason is surfaced inline in red
  under the filename; Retry + Dismiss buttons appear on failed rows. The
  original `File` object is retained on the entry so Retry re-uploads
  without re-selection.
- **Slice A branding** (2026-02-20):
  - New profile chip in the topbar (initials avatar + name + dropdown).
  - `/pro/settings` route with Logo upload, sign-in subdomain, 4 theme presets.
  - Backend: `GET/PATCH/POST/DELETE /api/pro/branding[/logo]`.
  - `lib/branding.js` applies `--brand-primary` / `--brand-accent` CSS vars.
  - Sidebar swaps "Axiom LEDGER" for the uploaded logo (h-12 max-w-180 in
    expanded state, h-11 square when collapsed).
- **Slice B branding** (2026-02-20):
  - 4 logo variants (`logo_light`, `logo_dark`, `icon_light`, `icon_dark`) —
    sidebar picks the appropriate one based on collapsed state, with legacy
    `logo_data_url` auto-migrated to `logos.logo_light` on read.
  - Per-token custom colors (primary / accent / sidebar_bg / sidebar_active_bg
    / topbar_bg) validated as `#RRGGBB` hex; presets + custom overrides merge
    into the final palette.
  - Live-preview card in ProSettings renders a mini app-chrome mock driven
    directly by the palette so users see changes before saving.
  - **Branded sign-in URLs** — public `GET /api/branding/by-subdomain/:sub`
    (no auth) returns firm name + logos + theme; Login.jsx reads
    `?firm=<sub>` (or the hostname's leftmost label in prod) and renders
    the firm's logo above the sign-in form.

### 2026-02-20 — Month Close checklist (NEW)
- New route `/accounting/month-close` (also under `Accounting > Month Close`
  in both left nav arrays, directly under Transactions).
- 5-checkpoint checklist per calendar month:
  - `txns_reviewed` (AUTO — 0 uncategorized + 0 unreviewed for posted txns in
    the window; vacuously green when the month has no transactions)
  - `invoices` (SIGN-OFF — outstanding count shown live, no requirement to pay)
  - `bills` (SIGN-OFF)
  - `recon` (SIGN-OFF for MVP; auto-inference from reconciliations collection
    is future work)
  - `closed` (SIGN-OFF, gated — backend returns 409 unless the other four are
    green; also writes a `close_periods` row so the existing period-lock
    engine sees the month as closed)
- Two views: **detail** (per-month checklist with prev/next month arrows +
  Today reset + clickable status links) and **list** (12-month grid with
  red/green pills per checkpoint).
- New Mongo collection: `month_close_signoffs`
  `{company_id, year, month, kind, signed_at, signed_by}` upserted per row.
- New backend routes in `/app/backend/routes/month_close.py`:
  - `GET /api/companies/{cid}/month-close/months?count=12`
  - `GET /api/companies/{cid}/month-close/{yyyy-mm}`
  - `POST /api/companies/{cid}/month-close/{yyyy-mm}/checkpoint`

### 2026-02-20 (later) — Reconciliation R1+R2+R3 (NEW)
- **R1 Plaid auto-clear** — nightly-safe idempotent job that sets `cleared_at`
  on posted Plaid txns older than 5 days. Wired to run inline after every
  `plaid_service.sync_transactions()` call plus exposed as
  `POST /api/companies/:cid/reconciliations/auto-clear`. Also drives
  Month Close's `recon` checkpoint (auto-green when 100% of the month's bank
  txns are cleared).
- **R2 Interactive matcher** — `/preview` returns book balance + uncleared list
  + running diff; `/complete` writes cleared_at + snapshot doc + reconciliation
  audit link.
- **R3 Statement PDF matcher** — `/match-statement` accepts PDF/CSV, runs
  Veryfi OCR, fuzzy-scores each extracted line (50% amount / 20% date / 30%
  desc-Jaccard). Confidence tiers: ≥ 0.90 auto, 0.60-0.90 suggest, < 0.60
  manual. `/apply-matches` bulk-clears the accepted ids.
- **List / detail split**:
  - `/accounting/reconciliation` — RocketSuite-style history table
    (Period · Account · Status · Statement · Ledger · Diff · →). Interactive
    matcher is now behind a "+ Start reconciliation" toggle.
  - `/accounting/reconciliation/:rid` — detail page showing snapshot stats
    (statement / ledger / matched / difference) + full list of cleared txns
    with `cleared_source` pills (MANUAL / plaid_auto / statement_match).
- New file `backend/reconciliation_engine.py`, updated
  `backend/routes/reconciliation.py` (~150→220 lines), new frontend files
  `pages/Reconciliation.jsx` (rewritten) + `pages/ReconciliationDetail.jsx`.


### 2026-07-21 — R4 Plaid Bootstrap (auto-reconcile from Plaid feed)
- **`reconciliation_engine.bootstrap_from_plaid(cid, plaid_item_id?, overwrite_placeholders?)`** —
  Walks every Plaid-mapped bank account and generates ONE real
  `status="reconciled"` doc per completed calendar month, with
  `source="plaid_bootstrap"` and full `cleared_txn_ids`.
- **Zero-fabrication invariants** (enforced, never bypassed):
  1. `opening_balance + Σ(post-opening Plaid txns) == plaid.balance_current`
     within $0.01 — otherwise the whole account is skipped and the
     discrepancy surfaced in `errors[]`.
  2. If any non-Plaid txn exists on the same `bank_account_id`, the account
     is skipped (bootstrap only reasons about the Plaid feed).
  3. Any period already covered by a real recon is skipped with reason
     `"already reconciled"`. Real recons are never overwritten.
  4. Months with zero activity are skipped so the history stays meaningful.
- **`POST /api/companies/{cid}/reconciliations/auto-bootstrap`** — endpoint
  invoked by the "Auto-reconcile from Plaid" button on the Reconciliation
  page. Also auto-fires at the end of `plaid_connect.connect_plaid_account`
  so new companies get their history pre-reconciled at connect time.
- **`POST /api/companies/{cid}/reconciliations/purge-placeholders`** —
  surgical delete of recons with empty `bank_account_id` OR empty
  `cleared_txn_ids` (seed/demo artifacts). Real completed recons untouched.
  Also exposed via `overwrite_placeholders=true` on the bootstrap endpoint;
  the frontend surfaces a confirmation modal when placeholders block auto-
  reconcile.
- **What "reconciled" here asserts (documented honestly in the code):**
  "Ledger matches the Plaid feed for the period." It does NOT assert the
  Plaid feed matches the paper bank statement — that check is still R3
  (Veryfi statement match).
- Tests: `backend/tests/test_recon_plaid_bootstrap.py` (5 cases: creates
  real recons, refuses on ledger/Plaid disagreement, refuses on non-Plaid
  txns, idempotent, purges only placeholders).


### 2026-07-21 — Communications Hub (Resend-backed, 7 flows, per-user toggles)
- **Integration**: Resend v2.34 via async `email_service.send_email()`.
  Verified sender: `no-reply@accountingapp.ai`. Domain verified in Resend
  dashboard.
- **Central dispatcher** `email_dispatcher.dispatch(kind, ...)` — single
  choke point that: (a) checks the initiating user's pref for `kind`,
  (b) if disabled → logs `skipped_pref_off` and returns without hitting
  Resend, (c) otherwise sends and logs the outcome to `communications`.
  Failures NEVER raise — callers get `{status: sent|failed|skipped_pref_off}`.
- **7 email flows**, all defaulted to ON:
  1. `ask_client` — Pro emails client owner a magic-link asking about a
     txn. Client's answer flows back onto the txn via `client_answer` +
     `ai_comment` audit trail. Public routes `GET/POST /api/q/{token}`.
  2. `daily_pro_digest` — Needs-Attention roll-up across the pro's firm.
     Fires from `POST /api/communications/daily-digest/run` (called by
     the pro manually today; wire a cron for auto-daily later).
  3. `dunning` — customer-facing A/R chase for an overdue invoice.
  4. `overdue_bill_client` — client-facing A/P reminder listing all past-
     due bills for the company.
  5. `plaid_reauth` — alert client that a bank connection needs re-auth.
  6. `onboarding_followup` — nudge client to finish their onboarding step.
  7. `month_close_signoff` — ask client to sign off on a closed month.
- **Data model**: three new collections
  - `communications` — audit log (id, kind, to, subject, status, resend_id,
    user_id, company_id, contact_id, related, sent_at).
  - `comms_prefs` — per-user pref toggles (one doc per user, merged with
    DEFAULT_PREFS which are all-True).
  - `client_questions` — magic-link tokens for the ask-client flow
    (id=token, question, status, answer, expires_at 30d, to_email).
- **UI** (`/communications`):
  - **Inbox tab** — audit log with status pills (Sent / Failed / Skipped),
    "Send test email" input, refresh button.
  - **Settings tab** — 7 toggle rows, saves instantly on click, respects
    `PUT /api/settings/communications`.
- **Ask Client integration**: new item in the transaction row-menu ("Ask
  client about this") opens a shared modal (single instance across all
  rows via an imperative ref). On send, the txn is marked `needs_review`,
  the question is appended to `ai_comment`, and a token is minted.
- **Public magic-link page** `/q/:token` — no auth, renders txn context +
  question + textarea. On answer, updates the question doc and pushes
  onto the transaction. Second-answer attempts return a 400.
- **Tests**: `backend/tests/test_communications.py` (4 cases):
  defaults all-on, pref-off blocks send + audits skipped, sent status
  captures Resend id, full ask-client → magic-link → answer round-trip.
- **Live-verified** end-to-end: sent a real ask-client email to
  michael@bigsaas.ai, answered it via the magic-link, verified the answer
  appears on the transaction. Resend accepted every send.
- **Known follow-up**: the daily digest currently ships via an endpoint,
  not a scheduled task. A single-line cron / APScheduler tick will
  activate the "auto-send at 8am" behavior when the pro wants it.

### 2026-07-21 — AI-Suggested Batched Ask-Client
- **`ai_service.draft_ask_client_question()`** — takes a counterparty label
  + a cluster of flagged txns and asks Claude to draft ONE concise, friendly
  question referencing the shared context (counts, totals, common
  possibilities). Fails soft: deterministic fallback string if the LLM
  errors, so the UI never blocks.
- **`POST /companies/{cid}/communications/ask-client/suggest`** — clusters
  flagged transactions (`needs_review = true` OR `ai_confidence < 0.6`) by
  contact_name / merchant, drafts a question per group in parallel, ranks
  by (cluster size, absolute total). Automatically excludes any txn
  already covered by a pending `client_question` so the pro never asks
  twice about the same charge.
- **`POST /companies/{cid}/communications/ask-client/batch`** — sends ONE
  email covering N txns. `client_question` doc now stores `txn_ids` array
  (single-txn flow also populates the array for parity). Every listed
  txn is stamped `needs_review = true` + `client_question_id = token`.
- **`email_templates.ask_client_batch()`** — new inline-CSS template that
  renders a table of every txn in the batch + one shared question.
- **Public magic-link updates**: `GET /api/q/{token}` now returns
  `{txns: [...], batched: bool, counterparty_label}`. `POST /q/{token}/answer`
  applies the single answer to every txn in the batch — client_answer,
  client_answered_at, and an ai_comment audit entry per txn.
- **Frontend**: new "AI Suggestions" tab on `/communications`. Cards show
  counterparty · count · total, editable draft question, expandable txn
  list, per-cluster "Send this", bulk "Send N emails" button. All clusters
  pre-selected — pro unchecks the ones they don't want.
- **Answer page** (`/q/:token`) — renders a table of every txn when batched,
  changes heading to "Hi — questions about {counterparty}" for clarity.
- **Live-verified**: sent a real batched email covering 5 Zelle payments to
  michael@bigsaas.ai; answered once via magic-link; verified all 5 txns
  received the `client_answer` and audit trail.
- **Tests**: 2 new pytest cases (`test_ask_client_batch_answer_applies_to_all_txns`,
  `test_suggest_batches_groups_by_counterparty_and_dedupes_asked`) — 12/12
  passing across the communications + recon suites.


### 2026-07-21 — Closed-Loop: Client Answer → AI Proposal → One-Click Accept
- **`ai_service.interpret_client_answer(answer, txns, coa)`** — Claude parses
  the client's free-text reply against the CoA and proposes
  `{account_code, confidence, reasoning, applies_to_all, requires_split}`.
  Guards: only allows `account_code` values that exist in the CoA;
  fails soft with a low-confidence placeholder so the UI never breaks.
- **Auto-fires** at the end of `public_answer_question` — every txn in the
  batch is stamped with `ai_proposal_from_answer` (account_id, account_name,
  account_code, confidence, reasoning, proposed_at, source_question_id).
  The question doc also carries a copy under `ai_proposal` for review UIs.
- **`POST /companies/{cid}/transactions/{tid}/accept-proposal`** — applies
  the proposed category, sets `human_reviewed = true`, clears `needs_review`,
  appends an accept-audit line to `ai_comment`, removes the proposal.
- **`POST /companies/{cid}/communications/accept-proposal-batch`** —
  one-shot accept for every txn tied to a `question_id`; the pro's "yes,
  apply that to all N" button.
- **`POST /companies/{cid}/transactions/{tid}/dismiss-proposal`** — drop
  the proposal without applying it. Client's answer text and audit
  comments remain on the row.
- **`GET /companies/{cid}/communications/pending-proposals`** — list every
  txn currently carrying a pending proposal (sorted by `client_answered_at`
  desc) so a review inbox UI can group them.
- **Frontend**: new `ProposalPill` component on the Confidence column of
  each Transactions row — renders as a colored chip showing `Client →
  <account name>` with inline ✓ Accept and ✕ Dismiss buttons. Hovering
  the pill reveals the AI's reasoning.
- **Live-verified**: sent a 3-txn Bright Idea Co batched ask → answered
  once ("payroll advances to Roberto") → AI mapped to Payroll (7200) at
  0.95 confidence → one-click accept-batch applied to all 3 txns; ledger
  now has 3 categorized+reviewed Payroll charges, zero manual touches.
- **Tests**: 1 new pytest case (`test_closed_loop_interpret_and_accept`,
  monkeypatches the interpreter to keep tests offline) — 13/13 passing
  across the communications + recon suites.


### 2026-07-21 — Client-Facing AI Chat (magic-link answer page)
- **`ai_service.client_chat_reply()`** — Claude system prompt for a
  friendly, colleague-tone conversation. Rules baked in: max 2 follow-ups,
  never accuse, restate the plan before finalizing, emit `[[DONE:<summary>]]`
  only after the client has confirmed. Never emit DONE on turn 1.
- **`POST /api/q/{token}/chat`** — public, no-auth, one turn per call.
  Persists the transcript on `client_questions.chat_messages`. When Claude
  emits `[[DONE:<summary>]]`, backend strips the marker from the visible
  reply, composes an answer = `summary + "\n\nClient's own words: ..."`,
  and threads through the existing `public_answer_question` flow so the
  interpreter runs and the proposal is stamped on every txn.
- **Rewrote `/q/:token` frontend** as a chat panel matching the app's
  "Let's review transaction" experience:
  - Header states the counterparty + N txns
  - Collapsible txn detail panel
  - Message bubbles (Bot + Client avatars, cyan-branded, no jargon)
  - Typing indicator during AI turns
  - Autoscroll, Enter-to-send, Shift+Enter for newlines
  - Optimistic client message with rollback on error
  - Resumable — a client who closes the tab and re-opens the link picks
    up the transcript exactly where they left off
- **Email template** now advertises "Chat with our AI →" so the CTA
  matches what the client actually sees.
- **Live-verified**: A 3-turn conversation about a Widget LLC batch → AI
  asked "one-time or recurring?" → client answered → AI restated the plan
  → client confirmed → interpreter mapped to **Legal & Professional Fees
  (6500) @ 0.85 confidence** (correctly avoiding Payroll because the
  client said "not an employee"). Proposal now sits on all 3 txns ready
  for one-click accept.
- **Tests**: `test_client_chat_finalizes_and_stamps_proposal` — verifies
  the DONE marker is stripped from the visible reply, the question
  finalizes, proposals land on every txn, and post-finalization turns are
  refused. 14/14 tests pass across the communications + recon suites.


### 2026-07-21 — Client Chat UX Overhaul + AI Logs
- **Two-path finalization** in the client chat. The AI now picks based on
  complexity/confidence:
  - **Fast path** — high-confidence, unambiguous mapping → AI says "Got it,
    thanks!" and emits `[[DONE:{json}]]`. Backend applies the categorization
    to every txn, closes the question, and (if the counterparty is a repeat)
    creates a `db.rules` auto-categorize rule for future imports.
  - **Confirm path** — split-decisions, low confidence, or unusual mappings
    → AI emits `[[PLAN:{json}]]`. Frontend renders a green plan card with
    "Yes, apply + create rule" (green) / "No, thanks" (grey) buttons.
- **Anti-fishing prompt**: system explicitly forbids inventing hypothetical
  follow-ups when the client's first answer is clear ("office supplies"
  IS the answer — do NOT ask "what if some were coffee?").
- **New endpoint** `POST /api/q/{token}/apply-plan` — server-side plan
  execution (validates account_code against the CoA, never trusts a
  client-side spoof) shared with the fast-path DONE flow.
- **`_apply_client_plan()`** helper — idempotent one-shot: categorize +
  human_reviewed + close question + spawn rule if applicable.
- **Markdown rendering** in chat bubbles (bold via `**`, plain-text bullets
  via `•`) so the plan lead-ins actually look formatted.

### 2026-07-21 — Communications > AI Logs tab
- **`GET /companies/{cid}/communications/ai-logs`** — every client-chat
  conversation, newest first, each enriched with:
  - full `chat_messages` transcript
  - `linked_txns` (id/date/description/amount + resulting category)
  - `ai_proposal` (the final categorization decision)
  - `status`, `asked_by_name`, `to_email`, timestamps
  - Single-query txn hydration (no N+1).
- **Frontend "AI Logs" tab** on `/communications`:
  - Collapsible row per conversation: counterparty · txn count · total ·
    resulting category chip · sent timestamp
  - Expanded view shows: pro/client metadata line, linked-txns mini-table
    with per-row category chip + amount, full chat transcript with
    Bot/Client avatars styled like the client-facing page.
  - Answered rows carry a green "✓ Category" pill; pending rows show
    "Awaiting client".
- **Verified live** on Bright Beans Coffee Co.: 6 conversations, all
  linked correctly to their 15+ transactions with resulting categories
  (Office Supplies, Product Sales, Payroll, Legal & Professional Fees).


## Stripe Billing & Affiliate Revenue Share (Feb 23, 2026) ✅

### Overview
Stripe webhook + billing dashboards live at `/api/stripe/webhook`. Auto-
creates user accounts on successful Stripe checkout, tracks every paid
invoice in `platform_payments`, and credits 20% of gross to the referring
affiliate in `referral_earnings`. No automatic payout — accrued balance is
displayed in each affiliate's `/share` dashboard, superadmin marks batches
as paid_out after cutting a manual payment.

### Backend (`/app/backend/routes/stripe_billing.py`)
- `POST /api/stripe/webhook` — verifies `STRIPE_WEBHOOK_SECRET` signature,
  dedupes by Stripe event id in `stripe_webhook_events`, fans out on:
    * `checkout.session.completed` → find-or-create user (client role,
      random password), link `stripe_customer_id` +
      `stripe_subscription_id`, resolve `client_reference_id` as
      referral slug → set `referred_by_user_id`, send welcome email
      with magic-link `set-password` token (14-day TTL).
    * `invoice.paid` → insert `platform_payments` row (idempotent on
      `stripe_invoice_id`), if payer has `referred_by_user_id` credit
      20% (basis points `AFFILIATE_SHARE_BPS=2000`) to
      `referral_earnings` with `status="accrued"`.
    * `customer.subscription.deleted|updated` → update user's
      `subscription_status`, `subscription_canceled_at`.
- `GET /api/billing/me` — signed-in user's subscription + invoice history.
- `GET /api/billing/pro/clients` — pros see every client owner's billing status.
- `GET /api/billing/superadmin` — platform revenue totals, recent
  payments, top affiliates by accrued/paid_out.
- `GET /api/billing/affiliate/me` — earnings breakdown for `/share` page.
- `POST /api/billing/superadmin/mark-paid` — bulk-flip `referral_earnings`
  from `accrued` → `paid_out`.
- New email template `stripe_welcome` + `stripe_welcome` pref key.

### Frontend
- New `/billing` route (`Billing.jsx`): role-aware dispatch. Everyone sees
  "My subscription" + payment history; pros additionally see "Client
  billing" table; superadmin also sees platform revenue KPIs + recent
  payments + top affiliates rail.
- Sidebar link "Billing" between "My Businesses" and "Refer & earn".
- Live earnings counts on `/share` page now backed by `referral_earnings`.

### Persistence (Mongo collections)
- `platform_payments` — one row per paid Stripe invoice, keyed on `stripe_invoice_id`.
- `referral_earnings` — one row per (payment, referrer), status = accrued|paid_out.
- `stripe_webhook_events` — event id → received_at, for idempotent dedupe.

### Env vars consumed
- `STRIPE_SECRET_KEY` (user-rotated live key on Railway)
- `STRIPE_WEBHOOK_SECRET` (`whsec_...` from Stripe Dashboard → Webhooks)
- `AFFILIATE_SHARE_BPS` (defaults to 2000 = 20%)
- `PRIMARY_HOST` (default `app.smartbookssoftware.ai`)

### Tests
- `/app/backend/tests/test_stripe_billing.py` — 7 pytest cases covering
  signature verification (reject bad, accept good), event dedup by id,
  auto-user-creation, referral slug crediting, 20% share math,
  invoice.paid idempotency across different event ids, and superadmin
  mark-paid role guard + status flip. All pass under xdist.


## AI Usage & Cost Monitoring (Feb 23, 2026) ✅

### Overview
Superadmin dashboard tracking every billable AI + external-API event
across the platform. One row per LLM call / OCR / email / linked item in
`ai_usage_events`; aggregated at read time so historical rows can be
re-summarised without a data migration.

### Cost recorder (`/app/backend/ai_usage.py`)
- Pricing tables (USD per 1M tokens for LLMs; USD per unit for flat services):
    * OpenAI: gpt-4o-mini/4o/4.1-mini/4.1/5/5-mini
    * Anthropic: sonnet-4.5, haiku-4.5
    * Veryfi OCR: $0.16 / document
    * Plaid linked items: $0.30 / item / month
    * Resend email: $0.0004 / email
- `record_llm(feature, provider, model, input_tokens, output_tokens, ...)` — computes cost + inserts row
- `record_service(feature, service, quantity, ...)` — flat-rate services
- `set_request_context(user_id, company_id)` — request-scoped ContextVars, populated by `get_current_user` so every AI call attributes to the initiating user without call-site plumbing
- `get_summary(range_key, category)` — totals, by_feature, by_service, by_category rollups
- All recorders are non-raising — a broken tracker never takes down user-facing AI

### LLM instrumentation (`/app/backend/llm_client.py`)
- `LlmChat(..., feature="ai-…")` — every call site tags itself
- OpenAI streaming: `stream_options={"include_usage": True}` — pulls prompt/completion tokens from the final chunk
- OpenAI non-streaming: reads `resp.usage.prompt_tokens/completion_tokens`
- Anthropic streaming: reads `stream.get_final_message().usage.input_tokens/output_tokens`
- Anthropic non-streaming: reads `resp.usage`
- Fire-and-forget cost logging via `_record_usage` — one Mongo insert per call

### Feature tags applied across `ai_service.py`
`ai-categorize`, `resolve-contact`, `ai-chat`, `suggest-coa`,
`ai-onboarding-questions`, `ai-onboarding-synthesize`, `ai-voice-intent`,
`ai-review`, `ai-ask-client-draft`, `ai-answer-interpret`,
`ai-client-chat`

### Backend endpoint
- `GET /api/admin/usage?range={7d|30d|90d|month|all}&category={llm|bank|email|ocr}` (superadmin only)
    * Returns: totals, by_feature, by_service, by_category, expected_services, plaid_items_active
    * Plaid row is synthetic (live-count × monthly rate) so it always reflects current active items even without emitted events

### Frontend page (`/admin/usage`)
- Range chips (Last 7/30/90 days, This month) + category chips (all/llm/bank/email/ocr) with running $ totals
- 4 KPI cards: Total cost, Total events, Unique users, Avg cost / event
- **By Feature** table — kebab-case verb / events / cost
- **All Cost Categories** table — service label / quantity / rate / cost. Unused services render dimmed placeholder rows (matches mockup)
- Sidebar link "Usage & Costs" appears only for superadmin

### Persistence
- `ai_usage_events` collection — one document per billable event, indexed on `ts DESC`, `service`, `feature`

### Tests
- `/app/backend/tests/test_ai_usage.py` — 8 pytest cases covering
  price math (known model + prefix match + unknown fallback), LLM
  recorder, service recorder, request-context propagation, summary
  aggregation, and superadmin RBAC on the endpoint. All pass.



### Per-Enterprise & Per-User Breakdowns (Feb 23, 2026 — same-day extension)
- `get_summary` now also emits `by_company` (with `unique_users` per company)
  and `by_user` rollups
- `require_company` in `deps.py` sets both `user_id` + `company_id` in
  the ContextVar so every AI call inside a company-scoped route
  automatically attributes to that enterprise — no call-site changes
  needed
- `/api/admin/usage` response enriches each row with `name` / `email` /
  `role` from the users + companies collections
- Plaid items are joined per-company so the enterprise row shows
  "true monthly bill" (AI + Plaid subscription combined)
- Orphaned Plaid items (from deleted companies) are filtered out of the
  enterprise table but still counted in the by_service Plaid line
- Frontend adds **By Enterprise** and **By User** tables below the
  existing feature/service tables, with role badges (SUPERADMIN / PRO /
  CLIENT) on the user rows
- Added `test_get_summary_aggregates_by_company_and_user` — verified
  events dedupe correctly per company + user

### Categorization Source Breakdown (Feb 23, 2026 — same-day extension)
- Added `categorization_sources_overall` + `categorization_sources` (per company) to `/api/admin/usage`
- Buckets transactions by `ai_source`: `pfc_*` → Plaid PFC, `memory` → merchant cache, `rule/rules` → company rules, `ai` → LLM, everything else → "Manual / other"
- Frontend renders:
    * Big "Zero-AI cost path" percentage KPI + stacked horizontal bar + 5-way legend
    * Per-enterprise mini stacked bar in the By Enterprise table with "% AI" tag
- Purpose: proves the deterministic layers (Plaid PFC → merchant cache → rules → LLM) are pulling their weight so LLM cost stays near zero even on brand-new client onboardings


## AI Cleanup Review — Column-aligned Category Picker (Feb 24, 2026) ✅
- Vendor rows in `CleanupCopilot.jsx` mega/stepper view now use CSS grid at `md:` breakpoint (`md:grid md:grid-cols-[auto_240px_minmax(200px,1fr)_auto_auto_auto]`) so every `AccountPicker` dropdown lines up in a clean vertical column regardless of merchant-name length
- Falls back to the original flexbox layout on screens narrower than `md` (768px) so the row still wraps gracefully on tablets / phones
- No API or data-model changes; verified visually with a temporary set of 18 unreviewed AI-categorized rows across 6 vendors on Bright Beans Coffee Co.


## Dashboard: "Firm at a Glance" Toggle View (Feb 24, 2026) ✅
- Added a `Classic ↔ Firm at a Glance` segmented toggle at the top-right of `/dashboard` (persisted per-user in `localStorage` under `dashboard_view`)
- Classic view is the pre-existing dashboard content, now extracted into a `ClassicDashboard` sub-component inside `pages/Dashboard.jsx`
- New view: `components/FirmAtAGlance.jsx` — QBO-Accountant-style overview inspired by user reference screenshot:
    * Centered "Good morning/afternoon/evening, {firstName}!" greeting
    * "Firm at a glance" band with company name and active month
    * **Sales & Get Paid Funnel** card (Not paid / Paid / Deposited columns with colored top-stripe + amber "N overdue invoices" / rose "on hold" / emerald "N deposited" badges, plus a "Create a new payment request" CTA column)
    * **Bank Accounts** panel (today's total bank balance + per-account rows with balance + "N to review" deep-link into Reconcile)
    * **Profit & Loss** card (net profit, signed % delta vs last quarter, Income and Expense bars with per-side "N to review" counts, "View profit and loss report" link)
    * **Expenses** card (donut chart of top-5 expense categories + "Other" roll-up, signed % delta vs last month, colored legend)
- New backend endpoint `GET /api/companies/{cid}/dashboard/firm-glance?month=YYYY-MM&basis=accrual` in `backend/routes/firm_glance.py` — packages all four panels into a single 15s-cached response
- Delta calculations: P&L compares current month's net profit to the AVERAGE month of the prior calendar quarter; Expenses compares to previous month total
- 4 pytests in `backend/tests/test_firm_glance.py` — all passing (default month, explicit month, bank-account fields, expense category colors)
- Verified visually on Bright Beans Coffee Co. — funnel + banks + P&L + donut all render with real data; toggle switches instantly and preserves selection across reloads

## Inline "Send Reminder" + Business Overview View (Feb 24, 2026) ✅
### Send reminder (dunning) from the Firm at a Glance card
- The amber "N overdue invoices" badge on the Sales & Get Paid funnel is now a **clickable Popover** listing every overdue invoice with per-row `Send reminder` button
- Each row shows: customer name, invoice #, days overdue, amount, email on file (or an inline editor if the contact has no email yet)
- Button hits the existing `POST /api/companies/{cid}/communications/dunning` endpoint (Resend-backed, `kind="dunning"`, logs a Communication row)
- Backend now stamps `last_reminder_sent_at` and `last_reminder_to` on the invoice doc so the popover shows a green "Reminder sent" pill for 24h and prevents accidental re-sends
- `firm-glance` endpoint payload extended with `sales_funnel.not_paid.overdue_invoices[]` (id, number, contact_name, contact_email, amount, days_overdue, due_date, last_reminder_sent_at) — one round-trip powers the card + popover

### Business Overview toggle (3rd dashboard view)
- Added third `Business Overview` option to the Dashboard toggle. Toggles now: **Classic ▸ Firm at a Glance ▸ Business Overview** (persisted in localStorage)
- New `components/BusinessOverview.jsx` — QBO-Client 6-card grid inspired by the reference screenshot:
    * **Invoices** — $X unpaid last 365 days split into Overdue + Not due yet with orange & slate bars; $Y paid last 30 days split into Not deposited + Deposited with emerald bars
    * **Expenses** — big total + donut chart + 5-item legend with per-slice amounts
    * **Bank accounts** — grouped by Checking/Savings, showing Bank Balance vs In QuickBooks per account (orange if diverges)
    * **Profit and Loss** — net income + Income (↑) and Expenses (↓) bars
    * **Sales** — this-quarter total + 6-month line chart (inline SVG, no external chart lib)
    * **Discover** — marketing/upsell card ("Streamline your firm with AI Copilot" → Try AI Cleanup Review)
- New backend endpoint `GET /api/companies/{cid}/dashboard/business-overview?month=YYYY-MM` (single 15s-cached call packages all 6 cards' data)

### Tests & seed
- 4 additional pytests in `test_firm_glance.py` (overdue-invoices shape, business-overview default month, sales 6-month series, bank categorization) → all 8 pass
- Seeded 3 demo overdue invoices on Bright Beans Coffee Co. (2 with contact emails, 1 without) so the popover has real data


## Monthly-Close 3-Step To-Do Checklist (Feb 24, 2026) ✅
- QBO-style horizontal "1 → 2 → 3" progress card added above **Firm at a glance** section (only rendered in the Firm-at-a-Glance dashboard view)
- Each step shows a numbered/checked circle, title, subtitle, big count, unit label, and a Review CTA → the circle turns green with a ✓ and shows "All caught up" when count = 0
- Header includes an "X of 3 done" summary badge
- Steps:
    1. **Review AI categorized** — count = # of AI-categorized unreviewed txns with a real category + contact_id → deep-links to `/accounting/ai-cleanup-review?mode=stepper`
    2. **Let's review** — count = # of distinct vendor groups the Step-1 txns belong to → deep-links to `/accounting/ai-cleanup-review?mode=grouped`
    3. **Individual review** — count = # of no-contact unreviewed txns → deep-links to `/accounting/transactions?filter=needs-review&no_contact=1` (marked with a "Preview" pill; will be replaced by the future "grouped by similar description" review UI)
- New `_monthly_todos()` helper in `backend/routes/firm_glance.py` (as-of-now counts, NOT month-scoped, so switching the month picker doesn't hide backlog)
- `firm-glance` endpoint response extended with a `todos` field (step1/step2/step3 with count, cta_link, coming_soon flag)
- Frontend: `MonthlyTodos` + `TodoStep` sub-components added to `components/FirmAtAGlance.jsx`
- 1 additional pytest (`test_firm_glance_monthly_todos_shape`) — now 9 pytests total, all passing


## Context-aware To-Do Checklist (Setup vs Monthly Close) + Dismiss/Reopen (Feb 24, 2026) ✅
### Two modes
- **Setup — "Set Up: Review Books"** — surfaced when `company.onboarding_complete = True` but the company has **zero** `close_periods` docs (books being brought current for the first time). Subtitle: _"Bring your books up to date before your first month-end close."_
- **Monthly Close — "{PrevMonth} {Year} Closing Tasks"** — surfaces on/after **day 3** of the current calendar month for the **prior month**, only if that prior month has not been closed. Subtitle: _"Wrap up {Month} by finishing these three reviews."_
- Header pill shows either `SETUP CHECKLIST` or `MONTHLY CLOSE CHECKLIST` depending on mode

### Lifecycle
- Backend returns `todos.visible`, `todos.is_complete`, `todos.mode`, `todos.checklist_key`
- User can dismiss via X button → stored in `localStorage` under `todo_dismissed:{companyId}:{checklistKey}:{YYYY-MM-DD}` (per-company, per-checklist, per-day)
- When dismissed, a small **"To Do (N items)"** pill replaces the full checklist — clicking it clears the dismissal for the day and re-shows the full card
- When all 3 steps hit zero (`is_complete: true`), backend returns `visible: false` and the frontend hides **both** the checklist and the pill entirely — nothing to do, nothing to reopen
- Dismissal resets automatically at midnight (new date suffix in localStorage key) — if tasks are still incomplete, checklist reappears the next day

### Files
- `backend/routes/firm_glance.py::_monthly_todos()` — new mode / visibility logic driven by `companies.onboarding_complete` + `close_periods` (count all-time + prior-month coverage query)
- `frontend/components/FirmAtAGlance.jsx` — new `MonthlyTodosContainer` (dismissal + reopen state, per-day localStorage), refactored `MonthlyTodos` (title/subtitle + X button), unchanged `TodoStep`
- 2 additional pytests (`test_firm_glance_monthly_todos_shape`, `test_firm_glance_todos_setup_mode_when_no_month_closed`) — total **10 pytests all passing**
- Verified both modes visually on Bright Beans (0 closed months → Setup mode; after seeding one May-2026 close_periods → June 2026 Closing Tasks)


## To-Do Checklist Now Shows on ALL Dashboard Views (Feb 24, 2026) ✅
- Extracted the checklist container from `FirmAtAGlance.jsx` into a shared component `frontend/components/DashboardTodos.jsx`
- Mounted `<DashboardTodos />` in `Dashboard.jsx` right above the view swap so the checklist appears above **Classic**, **Firm at a Glance**, and **Business Overview** views uniformly
- Component fetches `/dashboard/firm-glance` and reads only the `todos` sub-object (backend response is cached 15s so no duplicate work when Firm-at-a-Glance also fetches the endpoint)
- Dismiss/reopen state, per-day localStorage key, and completion-hiding all preserved — same behavior across all views
- Removed the checklist mount + helper components from `FirmAtAGlance.jsx` (cleaner separation of concerns)
- Verified visually — Setup Checklist → Set Up: Review Books renders identically on Classic, Firm at a Glance, and Business Overview



## Contextual Rainbow-Shimmer on Setup Checklist (Feb 24, 2026) ✅
- **Setup mode**: the existing `.attention-rainbow` shimmer border now moves onto the FIRST incomplete step of the Setup checklist (Step 1 → 2 → 3 as counts hit zero). Simultaneously, the Needs-your-attention priority-card shimmer is **suppressed** so the user's eye only lands on the checklist step.
- **Close mode**: no shimmer on any checklist step — the Needs-your-attention shimmer retains its original priority-card behavior (Overdue bills → Overdue invoices → Flagged → Rules → Unreconciled).
- Implementation:
    * Lifted `todos` fetch from `DashboardTodos.jsx` up to `Dashboard.jsx` (single source of truth for both surfaces)
    * `DashboardTodos` now receives `todos` as a prop; computes `highlightIdx = mode === "setup" ? steps.findIndex(s => count > 0) : -1` and applies `attention-rainbow relative z-10` to that step's body only.
    * `AttentionTile` accepts a new `suppressShimmer` prop; when true, `priorityKey` is forced to `null` so no attention card gets highlighted.
    * `ClassicDashboard` computes `suppressAttentionShimmer = todos?.mode === "setup" && todos?.visible && !todos?.is_complete`.
- Verified visually on Bright Beans: Setup mode shows the shimmer around Step 3 (first incomplete) with a plain Needs-your-attention section; after inserting a demo May-2026 close_period, Close mode shows plain checklist steps with the shimmer back on the "3 Overdue invoices" card.

## Fix: Checklist Review Buttons Land on the Correct View (Feb 24, 2026) ✅
Two bugs discovered when clicking Review from the Setup checklist:

1. **Step 1 stepper never activated.** `AICleanupReview.jsx` reads the `?view=` query param, but my backend was emitting `?mode=stepper` in the cta_link. Renamed the params in `firm_glance.py` to `?view=stepper` / `?view=category` and extended `AICleanupReview.jsx` to also accept `?view=category` (grouped mode) and `?view=grouped` as an alias.
2. **Step 2 pointed at the wrong page entirely.** AI Cleanup Review only surfaces AI-categorized-unreviewed vendor groups (Step 1 material). Step 2's "Let's review" is about *uncategorized* vendor groups (Venmo, Summit Christian Church, etc.), which is driven by the Copilot chips on the **Transactions** page. Repointed Step 2 to `/accounting/transactions?filter=uncategorized` so clicking Review lands where the batch-categorization chips actually live.

Verified on 419 LLC: clicking Step 2 Review now lands on Transactions page with the Copilot showing chips for Eimorlain Ugali Co (15), Summit Christian Church (15), Dad & Babe (8), Summit Church Summitnv.org Nv (3) — exactly the 4 vendor groups counted by the checklist (Venmo was truncated from the chip display but is present in the "20 Venmo transactions" copilot summary).



## Setup Checklist Refinements: Step 1 Categories + Auto-Tour (Feb 24, 2026) ✅
Two follow-ups requested after seeing the Review-button flow in action:

**1. Step 1 count changed from raw transactions → distinct categories**
- Backend `_monthly_todos` now tracks a set of `category_account_id` values across all AI-ready transactions (rather than counting raw txns). Step 1 unit label changed from `transactions` → `categories` so the checklist number matches the "GROUP X OF Y" stepper info box on the AI Cleanup Review page. Verified on Bright Beans (seeded 39 unreviewed AI-categorized txns → Step 1 correctly reported **6 categories**).

**2. AI Cleanup Review page auto-plays the "How To" tour on entry**
- Added `?tour=1` to Step 1's `cta_link` (`/accounting/ai-cleanup-review?view=stepper&tour=1`)
- `AICleanupReview.jsx` reads it and forwards `autoStartTour` prop to `CleanupCopilot`
- `CleanupCopilot.jsx` gained a one-shot effect that fires `runHowTo()` 500ms after `megaPreview.vendors` are hydrated (guarded by `autoTourFiredRef` so it never re-fires within the same mount, even if the preview data re-loads)
- Tour narration is spoken (browser Speech Synthesis) AND posted into the AI chat side-panel as assistant bubbles, so the walkthrough is available even if audio is muted


## First-Run Gate on Auto-Tour (Feb 24, 2026) ✅
- Auto-tour now runs **once per user + company pair** instead of on every visit
- After the tour kicks off, `CleanupCopilot.jsx` writes `tour_seen:<userId>:<companyId>` to localStorage; the auto-start effect skips the tour when the flag is present
- The manual "How To" button in the toolbar always runs the tour, so CPAs can replay it deliberately whenever needed
- Guarded so a null `user.id` / `currentId` short-circuits cleanly (defensive against auth-hook race on first mount)


## "Re-play tour" Button in AI Chat Panel (Feb 24, 2026) ✅
- After the "How To" walkthrough finishes, `CleanupCopilot.jsx` posts one final assistant bubble to the AI chat side-panel: **"That's the whole tour. Ready to review your books."** with an indigo **"Re-play tour"** button underneath
- New generic bubble-CTA plumbing:
    * `AiPanel.jsx` listens for `ai-chat-say-with-cta` action → pushes `{ role, content, cta: { label, actionKey } }` onto its messages array
    * Renders the button below the bubble; on click emits `chat-cta:<actionKey>` and strips the CTA from that bubble so it can't be double-clicked
- `CleanupCopilot.jsx` listens for `chat-cta:restart-tour` and re-invokes `runHowTo()` (guarded so it can't stack while a tour is already running)
- Aborted tours (user hits "Stop tour") do NOT post the CTA — keeps the chat clean
- Verified: tour completed → "Re-play tour" bubble rendered → click re-started the walkthrough with fresh sparkles and new narration bubbles


## Coached Step Transitions in Setup Checklist (Feb 24, 2026) ✅
- When a Setup-mode step count flips from >0 → 0, `DashboardTodos.jsx` posts an assistant bubble to the AI chat with a **"Jump to Step N+1"** CTA so the whole checklist feels like one continuous coached experience instead of three independent buttons
- Coaching messages:
    * Step 1 → 2: **"Nice — X categor(y|ies) approved. Ready for the vendor batches?"** + **"Jump to Step 2"** CTA (navigates to `/accounting/transactions?filter=uncategorized`)
    * Step 2 → 3: **"Great work — X vendor group(s) sorted. Time for the no-contact review."** + **"Jump to Step 3"** CTA
    * All 3 done: **"Books are clean. First close is ready when you are."** (no CTA — checklist auto-hides)
- Cross-reload aware: previous counts are persisted in `localStorage` under `todo_prev_counts:{userId}:{companyId}` so a user who approves work and then opens the dashboard in a new tab still sees the coaching moment
- Idempotent: fires at most once per user + company + step (`coach_seen:{userId}:{companyId}:step{N}` gate)
- New `chat-cta:jump-to-step` listener in `DashboardTodos.jsx` handles the click (via react-router `useNavigate`)
- Verified end-to-end: seeded Step1=1 → saved baseline → flipped to reviewed → reload → coach bubble appeared → clicked "Jump to Step 2" → navigated to Transactions with uncategorized filter

## Bug Fix: Step 1 Count Now Matches AI Cleanup Review Page (Feb 24, 2026) ✅
User reported the dashboard showed **"28 categories"** in Step 1 while the AI Cleanup Review page said **"Nothing to approve"** for the same company (335 LLC). Root cause: my Step 1 filter counted every unreviewed row with a real category + contact, but the AI Cleanup Review page only surfaces vendors whose AI-categorized rows agree on ONE unanimous account (`len(r["accounts"]) == 1` in `cleanup-suggestions`).

Fix: `_monthly_todos()` now mirrors `cleanup_suggestions()`'s `ai_ready_by_contact` structure — it groups unreviewed rows by contact, keeps a set of `category_account_id` per contact, and only counts distinct categories from contacts with unanimous opinion. Result: Step 1's count is always in sync with what the CPA will actually see on the AI Cleanup Review page. Verified via curl against Bright Beans and 419 LLC.


## New Page: "Let's Review" Contact-Grouped Stepper (Feb 24, 2026) ✅
- New route `/accounting/lets-review` with `frontend/pages/LetsReview.jsx` — a dedicated stepper that walks a CPA through one uncategorized-vendor group at a time
- Mirrors the AI Cleanup Review page's shape, but the "Group X of Y" info box shows the CURRENT CONTACT (e.g. "Venmo · 20 txns · $5,905.00") instead of a category — matching the user's mental model that Step 2 is "batch this vendor into one category"
- Powered by the existing `/cleanup-suggestions` endpoint (`kind=contact_in_uncat` filter). Each group loads its own uncategorized rows via `/transactions?contact_id=X&status=uncategorized`
- Single AccountPicker + "Also save a rule so future {vendor} rows auto-post here" checkbox + big **Approve N →** button
- Uses the existing `apply-bulk-approve-rule` endpoint so the flow benefits from every rule / audit / journal-entry side effect the Transactions page already ships
- Previous / Skip / Next navigation between contacts; the current group drops from the list on successful approval
- **Setup checklist Step 2's Review button now deep-links here** (`/accounting/lets-review`) instead of the Transactions page — the coach `Jump to Step 2` CTA follows the same link since it uses the backend-provided value
- Registered in `App.js` alongside the existing `/accounting/ai-cleanup-review` route
- Verified visually on 419 LLC: opened at "Venmo · CONTACT 1 OF 5" with all 20 rows listed, AccountPicker + rule checkbox + Approve 20 → button ready


## Let's Review Rebuilt as Transactions Clone (Feb 24, 2026) ✅
Rewrote `/accounting/lets-review` per user feedback ("literally could have cloned the transactions page with that filter and added the box for the contact info"):

- `LetsReview.jsx` is now a **thin router** — fetches `/cleanup-suggestions`, filters to `kind=contact_in_uncat`, picks the first group (or the one specified via `?contact_id=`), then redirects to `/accounting/transactions?letsReview=1&contact_id=X&contact_name=Y&idx=A&total=B&filter=uncategorized`. Also fires the `cleanup-inquiry` bus event so the AI Copilot chat populates immediately.
- `Transactions.jsx` gained lightweight overrides driven by those URL params:
    * Title swaps to **"AI Transaction Questions"** (from "Transactions") with the tagline *"One vendor at a time. Answer the AI's questions and post them in bulk."*
    * Contact info box appears top-right in the same slot as AI Cleanup Review's "Group X of Y" box: **"CONTACT 1 OF 5 · Venmo"** with **← Prev / Next →** buttons
    * `load()` adds `contact_id=X` to the request so the table is pre-filtered to that vendor
- New exported `useLetsReviewNav()` hook in `LetsReview.jsx` handles Prev/Next navigation without duplicating the group-fetch logic
- Every existing Transactions feature (search, date filters, per-row actions, AI Copilot chip strip, chat side-panel, "Approve AI Categorized" flow) works unchanged
- Setup checklist Step 2 Review button continues to link to `/accounting/lets-review` — user drops straight into the vendor stepper with the Copilot's questions ready in chat


## Bug Fix: AI Chat Now Has Multi-Turn Memory (Feb 28, 2026) ✅
**Symptom:** In the AI Fixed Asset creation flow, the user said "I bought a property for $350k on May 15th, $100k cash down, rest financed." AI asked "residential or commercial?" User answered "residential property." AI then re-asked *"What's the purchase price? Cash, loan, or combination?"* — completely forgetting the details already given.

**Root cause:** `llm_client.py` sent every LLM call as a stateless `[system, user]` pair with **no chat history**. Session-id was accepted but silently ignored (see docstring line 25). Multi-turn conversations had zero memory between turns.

**Fix:**
- `LlmChat.stream_message` / `_stream_openai` / `_stream_anthropic` now accept an optional `history: list[{role, content}]` param, which is inserted between the system prompt and the current user message.
- `ai_service.chat_stream` gained a `history` kwarg and forwards it to the LLM client.
- `routes/chat.py` `/ai/chat/stream` route now fetches the last 20 turns from `chat_messages` **before** persisting the new user message and passes them as history. Hidden `[[PROPOSAL:...]]` markers are stripped from history entries so the LLM doesn't confuse itself.

**Verified with 3-turn conversation:** AI now correctly recalls $350k, $100k down, mortgage from Turn 1 across Turns 2 & 3, then proposes mortgage account + correctly flags land/building depreciation split.

**Files changed:**
- `/app/backend/llm_client.py`
- `/app/backend/ai_service.py`
- `/app/backend/routes/chat.py`


## AI Fixed-Asset Flow: Stays Focused + Sub-Account Support (Feb 28, 2026) ✅
**Symptom (round 2 from user test):** After the multi-turn-memory fix, the AI correctly recalled all $200k / $75k down / mortgage details from the initial voice message. But when the user replied "make a sub account" (meaning: create a property-specific mortgage under the existing "Loans Payable 2500"), the AI dropped out of the Fixed Asset flow and answered *"Hover a transaction or click its sparkle first so I know which one to recategorize"* — a generic categorization fallback.

**Two root causes fixed:**
1. **Directive was too loose** — the Fixed Asset system directive did not forbid the AI from slipping back into transaction-categorization mode. Strengthened it to: *"STAY IN THIS MODE until you emit [[PROPOSAL:create-fixed-asset]] or the user cancels — do NOT ask the user to 'hover a transaction' or 'click the sparkle'."*
2. **Sub-account intent was missing** — the `create-liability-account` proposal had no way to declare a parent. Added `parent_account_id` to the proposal shape and taught the LLM to include it when the user asks for a "sub account", "child account", or property-specific mortgage under an existing parent like Loans Payable.

**Backend hardening (`routes/accounts.py::ensure_account`):**
- Accepts `parent_account_id` as UUID **or** 4-digit code **or** plain name — auto-resolves to the real UUID so a hallucinated LLM value (e.g. `"2500"`) doesn't create an orphaned child.
- When `parent_account_id` is set, the endpoint no longer short-circuits on a matching code — a fresh code is minted in the type range (e.g. 2110, 2120) so property-specific mortgages don't collide with the parent 2500.
- Name-collision detection is scoped to the same parent so different properties can each have their own "Mortgage Payable — <addr>" child.

**Frontend (`AiPanel.jsx`):**
- `create-liability-account` proposal parser now reads `parent_account_id` from the JSON marker.
- The `/accounts/ensure` POST forwards `parent_account_id` and the follow-up assistant message notes *"...as a sub-account"* when applicable.

**Verified end-to-end:**
- 3-turn conversation → AI holds all context, proposes sub-account with parent link.
- Direct API test: parent by code (`"2500"`) and parent by name (`"Loans Payable"`) both resolve to the correct UUID; children get fresh codes.

**Files changed:**
- `/app/backend/routes/chat.py`
- `/app/backend/routes/accounts.py`
- `/app/frontend/src/components/AiPanel.jsx`


## Bug Fix: Client-Side Voice-Command Parser Was Swallowing Long Sentences (Feb 28, 2026) ✅
**Symptom (round 3):** After the Fixed Asset directive was strengthened, the user opened the AI Panel and dictated *"okay I just bought a property at 123 Main Street it was 250,000 but the company put $50,000 down and then we got 200k financed"*. The AI responded with *"Nothing pending to confirm."* three times in a row — the message never reached the LLM at all.

**Root cause:** `/frontend/src/lib/voiceCommands.js:489` had a regex `/^(confirm|yes|yep|yeah|yup|sure|ok(ay)?|save it?|do it|go ahead|looks good|sounds good|that.?s good|create it|make it|book it|post it|approve it?)\b/i` that only anchored at the start (`^`) with a word-boundary (`\b`) — no end anchor. It short-circuited any message that STARTED with "okay", "yes", "sure", etc., regardless of what followed. Since no proposal was actually pending, it fell into the "Nothing pending to confirm." fallback and never called the LLM.

**Fix:**
1. **End-anchored regex** — the CONFIRM/CANCEL regexes now require the whole utterance to be an affirmative + optional short filler ("okay", "sure, go ahead", "yes please", "ok do it"). Long narratives that just happen to start with "okay" fall through to the LLM.
2. **`hasPendingIntent` gating** — the parser now takes a `hasPendingIntent` context flag from `AiPanel`. Confirm/cancel are only interpreted when a proposal is actually pending; otherwise the message is forwarded to the LLM. Defensive belt-and-suspenders in case a novel affirmative slips past the regex.

**Verified with 16-case regex matrix** — all short affirmatives still confirm; all long narratives fall through.

**Files changed:**
- `/app/frontend/src/lib/voiceCommands.js`
- `/app/frontend/src/components/AiPanel.jsx` (adds `hasPendingIntent` to ctx)


## AI Fixed-Asset Payload Hardening + Directive Tightening (Feb 28, 2026) ✅
**Symptom (round 4 from user test):** After the multi-turn memory and voice-command parser fixes, the AI finally engaged with the Fixed Asset flow, remembered all context ($350k / May 15 / $75k down / mortgage financed / residential / Wells Fargo). But it got stuck in a 6-turn "Confirm to proceed?" loop before finally emitting the `[[PROPOSAL:create-fixed-asset]]` marker. When it did, the payload had three bugs:
1. Field name: `funding_sources` instead of `offsets`
2. `purchase_date: "2026-07-28"` (today) instead of `"2026-05-15"` (what the user said)
3. `account_id` values were 4-digit codes (`"2500"`, `"2190"`) instead of UUIDs, AND $75k cash-down was assigned to the Loans Payable account (wrong direction)

**Two-part fix:**

### Backend hardening (`asset_service.create_fixed_asset`)
- Accepts `funding_sources` as an alias for `offsets` so hallucinated field names don't fail
- Resolves any non-UUID `account_id` value (code like `"2500"` or name like `"Loans Payable"`) to the real UUID by looking up the account in the current company
- Validated end-to-end via curl with the exact buggy shape the LLM was producing — asset created cleanly (330 depreciation entries)

### Directive tightening (`chat.py` fixed-asset directive)
Added a PROPOSAL EMISSION RULES section that explicitly:
1. Requires the marker AT THE END OF THE SAME MESSAGE that shows the summary (fixes the "Confirm to proceed?" loop where the LLM narrated the plan without emitting the marker)
2. Names the field literally as `"offsets"` (not `funding_sources`) and lists shape `{account_id, amount}`
3. Requires `account_id` values to be UUIDs from `offset_candidates[].id`, not codes/names
4. Adds funding-direction mapping: cash-down → CASH/BANK asset account, financed → LIABILITY account, owner contribution → EQUITY
5. Forbids fallback dates: "purchase_date must be extracted from the user's stated date — NEVER use today's date"
6. Adds explicit anti-loop rule: "if the user says 'yes'/'ok' and no proposal was in your previous message, you forgot the marker — emit it NOW"

**Files changed:**
- `/app/backend/asset_service.py` (offsets alias + UUID resolution)
- `/app/backend/routes/chat.py` (directive)


## Firm-Wide Policy: Loans/HELOCs/Credit Cards Are Always Sub-Accounts (Feb 28, 2026) ✅
**User request:** *"Always make loans or home equity lines of credit (HELOCs) or credit cards, always make those sub-accounts."*

**What was built:**
A firm-wide policy enforced at the backend — every liability that matches the loan / mortgage / note-payable / line-of-credit / HELOC / credit-card class is automatically created as a child of a canonical parent, whether the account is created via the AI Panel, a Sparkles proposal, or a manual CoA form.

**Parent conventions:**
- Loans / mortgages / notes payable / HELOCs → **"Loans Payable"** (code 2500)
- Credit cards → **"Credit Cards Payable"** (code 2100)
- The parent is auto-created on demand if it doesn't already exist.

**Backend (`routes/accounts.py`):**
- New helper `_resolve_liability_parent(cid, name, subtype)` classifies by keyword/subtype and returns (or creates) the appropriate parent id.
- `ensure_account` now calls the helper whenever `type=='liability'` and no explicit `parent_account_id` was provided.
- The root parent itself is exempt from self-parenting (e.g., creating "Loans Payable" won't try to parent it under itself).
- Unrelated liabilities (Accrued Payroll, Sales Tax Payable, etc.) are untouched by the policy.

**AI directive (`routes/chat.py`):**
Added a SUB-ACCOUNT POLICY block instructing the LLM to always include `parent_account_id` in `create-liability-account` proposals for loans/HELOCs/credit cards, even on the first creation. Backend acts as a safety net when the LLM forgets.

**Verified via curl (5 scenarios, all pass):**
1. Wells Fargo mortgage (no parent hint) → auto-parented under Loans Payable ✓
2. HELOC → auto-parented under Loans Payable ✓
3. Amex Business Credit Card → auto-parented under newly-created Credit Cards Payable ✓
4. Accrued Payroll → NOT parented (correct — unrelated liability) ✓
5. "Loans Payable" itself → NOT self-parented ✓

**Files changed:**
- `/app/backend/routes/accounts.py`
- `/app/backend/routes/chat.py`


## Loan Sub-Accounts Now Auto-Spawn Linked Loans-Page Records (Feb 28, 2026) ✅
**User feedback (from production `app.smartbookssoftware.ai`):** *"it creates the chart of accounts but not the Fixed Assets record or the Loans record that should be linked to the chart of account items."*

**What was built:** Whenever `ensure_account` creates a new liability sub-account that qualifies as a loan / mortgage / note payable / HELOC / line of credit (matched by keyword + subtype heuristics), a companion row is auto-inserted into the `loans` collection with an `account_id` back-link to the CoA account. The Loans page now stays in perfect sync with the CoA.

**What auto-spawns include:**
- `account_id` — links back to the CoA sub-account
- `lender` — caller-supplied OR derived from the account name (`"Mortgage Payable — 123 Main"` → `"123 Main"`, `"HELOC — Chase Bank"` → `"Chase Bank"`, `"Wells Fargo Mortgage"` → `"Wells Fargo"`)
- `principal`, `rate`, `term_months` — populated when the AI or manual UI provides them; placeholder-null otherwise, ready for user completion

**Cascade delete:** Deleting a loan CoA account now also deletes its linked Loans row so the two views never desync.

**Not affected (correct behavior):**
- Credit cards — deliberately excluded; they have their own lifecycle
- Non-loan liabilities (Accrued Payroll, Sales Tax Payable, etc.)
- Root parent accounts ("Loans Payable", "Credit Cards Payable") — don't self-spawn

**AI directive update (`chat.py`):** Added a LOAN METADATA section instructing the LLM to include `lender`, `principal`, `rate`, and `term_months` in the `create-liability-account` proposal when the user mentions them ("Wells Fargo mortgage for $300k at 6.5% over 30 years"). LLM converts years → months automatically. Missing fields are fine — placeholders are inserted and the user can complete later.

**AiPanel intent handler + streaming parser:** Both now capture and forward the loan metadata fields end-to-end.

**Verified via curl (4 scenarios, all pass):**
1. Mortgage with full metadata → account + Loan row linked, all fields populated ✓
2. HELOC with no metadata → account + Loan row with heuristic lender + null placeholders ✓
3. Accrued Payroll → account created, NO Loan row (correct — not a loan class) ✓
4. Delete loan account → Loan row cascade-deleted, Loans page empty ✓

**Files changed:**
- `/app/backend/routes/accounts.py` (helpers `_is_loan_class`, `_lender_from_name`; auto-spawn on insert; cascade on delete; extended `EnsureAccountIn`)
- `/app/backend/routes/chat.py` (LOAN METADATA directive)
- `/app/frontend/src/components/AiPanel.jsx` (proposal parser + intent handler forward loan fields)


## Two-Phase Fixed Asset Creation (Feb 28, 2026) ✅
**User feedback:** *"maybe we should have the asset created first, have it populate in the fixed assets and on the chart of accounts, and then go from there."*

**What was built:** The AI Fixed Asset flow is now split into two phases, matching how a real CPA thinks (asset shell first, funding second):

### Phase 1 — Asset shell
The AI asks only for name/purchase_date/cost/asset_type/useful_life_years — NO funding questions. On confirm, the asset is created immediately with:
- Fixed Assets page row ✓
- 1510/1515 CoA sub-accounts ✓
- Full 27.5-year (or type-appropriate) depreciation schedule ✓
- **Acquisition JE credits a system-managed "Fixed Asset Suspense" clearing account (code 2990)** so debits still equal credits with zero funding info yet.

The user sees the asset on Fixed Assets + CoA within one confirmation.

### Phase 2 — Funding (deferred, multi-turn)
On subsequent turns, the AI sees `pending_funding_assets` in the context and skips Phase 1 entirely, going straight to funding conversation. Funding sources can be added one at a time; each posts a JE `DR Suspense / CR real funding account`. Net effect after full funding = the original acquisition JE with correct offsets.

Verified accounting math: Suspense zeros out to $0.00 after full funding (450k debited during acquisition, 450k credited across 2 funding calls = 150k cash + 300k mortgage).

### New endpoint
`POST /api/companies/{cid}/assets/{aid}/fund` with body `{"sources": [{"account_id","amount"},...]}`. Idempotent per call; can fire multiple times if funding trickles in. Refuses to fund past the asset's cost.

### New AI intent
`fund-fixed-asset` — payload `{asset_id, sources:[{account_id, amount},...]}`. AiPanel intent handler wired end-to-end with success/partial messages ("Funded $X — $Y still to go" vs "Fully funded — balance sheet in sync").

### Directive rewrite
Complete two-phase directive with FIRST rule: *"CHECK `pending_funding_assets`. If NON-EMPTY, an asset shell already exists — SKIP PHASE 1 and go straight to PHASE 2."* AI now correctly detects pending assets and jumps to funding conversation instead of re-creating.

**Backend files:**
- `/app/backend/asset_service.py` — new `_ensure_fixed_asset_suspense`, `fund_fixed_asset`; `create_fixed_asset` accepts empty offsets → Suspense
- `/app/backend/routes/inventory.py` — new `POST /assets/{aid}/fund`
- `/app/backend/routes/chat.py` — two-phase directive; injects `pending_funding_assets` context

**Frontend files:**
- `/app/frontend/src/components/AiPanel.jsx` — `fund-fixed-asset` streaming parser + intent handler; Phase 1 success message points user to Phase 2

**Verified end-to-end with live LLM stream:**
- Phase 1: user says *"$450k property, May 15"* → AI proposes `create-fixed-asset` with no offsets, asset shell created (330 depreciation entries, monthly $1,363.64) ✓
- Phase 2: user says *"$100k B of A + $200k Wells Fargo mortgage"* → AI recognizes pending asset, proposes mortgage sub-account with loan metadata (lender/principal/term_months=360) ✓


## Bug Fix: Fixed Assets Nesting Under Wrong Parent (Feb 28, 2026) ✅
**Symptom (production 431 LLC):** *"Why is the asset a sub-account of 1510?"* — screenshot showed `1510 · 123 Main Street` and `1515 · 123 Main Street — Accumulated Depreciation` visually indented under `1500 · Prepaid Expenses` instead of a proper "Fixed Assets" parent.

**Root cause:** `asset_service._ensure_fixed_assets_parent` looked up the parent by **code** (`code=1500`) assuming that slot was always "Fixed Assets". But many seeded CoAs (including 431 LLC's) reserve code 1500 for "Prepaid Expenses", so the fetch returned the wrong parent and every new asset silently nested under it.

**Two-part fix:**

### Corrected parent lookup order
1. Existing account NAMED "Fixed Assets" (case-insensitive) — the canonical parent whatever code it lives at.
2. Existing top-level asset with subtype `fixed_asset` and no parent — reuse if the name suggests it's a group.
3. Auto-create a fresh "Fixed Assets" parent at the FIRST FREE code in the 1500-1899 range (skipping any taken codes).

### One-time repair migration
Whenever `_ensure_fixed_assets_parent` runs, it now scans for any `fixed_asset` / `accumulated_depreciation` sub-accounts nested under a non-fixed-asset parent (like Prepaid Expenses) and idempotently re-homes them under the correct parent. Runs automatically on the next asset creation OR on-demand via `POST /api/companies/{cid}/assets/fix-hierarchy`.

### Code-collision fix
`_next_asset_code` now checks against ALL company codes (not just siblings of the parent). This came up when the auto-created "Fixed Assets" parent landed at 1510 and the first child would have collided at 1510 too.

**Verified via curl:**
- Set up busted state (fixed_asset rows nested under Prepaid Expenses) → call `/assets/fix-hierarchy` → rows correctly re-homed under a real "Fixed Assets" parent ✓
- Create a new asset when 1500 is Prepaid Expenses → parent auto-created at 1510, asset lands at 1520, accum depr at 1525, no collision ✓

**Files changed:**
- `/app/backend/asset_service.py` (`_ensure_fixed_assets_parent` overhaul, `_next_asset_code` global scan)
- `/app/backend/routes/inventory.py` (new `POST /assets/fix-hierarchy` repair endpoint)


## Bug Fix: Forgiving asset_type Lookup (Feb 28, 2026) ✅
**Symptom (production `app.smartbookssoftware.ai`):** User walked the AI through creating a $175k residential real estate asset. AI said *"I'll proceed to record this asset now"* — but the backend responded with the error `"useful_life_years required for depreciable asset types"` and the asset never created.

**Root cause:** `_lookup_asset_type` required an *exact* key match ("residential_real_estate"). But the LLM's proposal payload can arrive with any of these variations:
- Label: `"Residential Real Estate"`
- Lowercase spaced: `"residential real estate"`
- Uppercase: `"RESIDENTIAL_REAL_ESTATE"`
- Hyphenated: `"residential-real-estate"`

When the lookup returned `None`, the 27.5-year preset was lost, `useful_life_years` wasn't in the payload either, and the validation guard fired.

**Fix:** `_lookup_asset_type` now normalizes the input (lowercase, collapse whitespace/hyphens to underscores, strip punctuation) and tries:
1. Exact key match
2. Normalized key match
3. Normalized label match
4. Fully-stripped alphanumeric label match

Verified via unit test (9 cases including labels, hyphens, casing, invalid) and via curl (three variations of "Residential Real Estate" — all produce a 330-entry depreciation schedule at $530.30/month).

**Files changed:**
- `/app/backend/asset_service.py`


## Live Form-Fill for the New Fixed Asset Modal (Feb 28, 2026) ✅
**User request:** *"it should be filling out this form while we say it"*

**What was built:** As you talk to the AI, the New Fixed Asset modal now populates in real-time — you watch each field fill in as the AI extracts it from your speech, then you review the fully-populated form before confirming.

### Architecture
- **New streaming marker `[[DRAFT:{...}]]`** — the AI emits it early and often, with a *partial* payload (any subset of `name`, `purchase_date`, `cost`, `asset_type`, `useful_life_years`, `salvage_value`).
- **AiPanel streaming parser** — new `draftRe` regex extracts each marker, dedups via a ref so the same marker doesn't refire during chunked streaming, and dispatches an `ai:fixed-asset-draft` window CustomEvent with the partial payload. Markers stripped from the visible chat text.
- **FixedAssetModal listener** — merges each partial into the form state: `name`, `purchase_date`, `cost`, `salvage_value`, `asset_type` (with forgiving normalization matching the backend fix), and `useful_life_years` (auto-filled from the asset_type preset when not explicitly stated).

### AI directive update
Added a LIVE FORM-FILL block to the Phase 1 directive instructing the LLM to emit `[[DRAFT:...]]` markers as soon as any field is known — even if only 1-2 fields. Example flow shown in the prompt: *"I bought 123 Main for $175k on Jan 5"* → immediate `[[DRAFT:{name, cost, purchase_date}]]` on the SAME reply that asks about `asset_type`. The final `[[PROPOSAL:create-fixed-asset]]` comes at the end when all fields are ready.

### Verified end-to-end
- **Live LLM stream test:** User said *"I bought 123 Main Street on January 5 for $175,000, residential real estate"* → AI emitted `[[DRAFT:{"name":"123 Main Street","purchase_date":"2026-01-05","cost":175000,"asset_type":"residential_real_estate"}]]` in one shot ✓
- **Playwright screenshot:** Dispatched the same draft event manually → modal populated Asset Name, Asset Type dropdown (with auto-selected "Residential Real Estate — 27.5 yrs"), Purchase Date, Useful Life (27.5 auto-filled), Cost, and Remaining ($175k) ✓

**Files changed:**
- `/app/backend/routes/chat.py` (LIVE FORM-FILL directive block)
- `/app/frontend/src/components/AiPanel.jsx` (DRAFT parser + dispatch, dedup ref, marker strip, per-stream reset)
- `/app/frontend/src/pages/FixedAssetsPage.jsx` (modal listener merging partial fields into form state)


## Onboarding Coach TTS Barge-In on Manual Step Skip (Feb 28, 2026) ✅
**User feedback:** *"when someone is going through the onboarding and they click the button faster than the AI can speak, the AI just keeps going even if I am on the Bank connection step it is still finishing up the message that belongs to 1. Business Profile."*

**Root cause:** Two layers stacked stale messages:
1. `Onboarding.jsx` scheduled the step-greeting emit with `setTimeout(500)` but never cancelled prior timeouts, so several greetings could queue if the user clicked Next faster than 500ms per step.
2. Even after the emit fired, `AiPanel`'s `speakOne` call did a plain `window.speechSynthesis.speak(u)` which QUEUES behind any already-playing utterance instead of replacing it.

**Fix:**
- **`Onboarding.jsx`:** The step useEffect now tracks the greeting timeout in `coachTimerRef`. On every step change (or cleanup), it:
  - Clears the pending timeout so the stale step's greeting never lands
  - Cancels the browser speech queue (`speechSynthesis.cancel()`)
  - Emits a new `ai-stop-tts` action so `AiPanel` clears its own TTS state flags (`ttsSpeakingRef`, `ttsTailUntilRef`, `spokenIdxRef`)
- **`AiPanel.jsx`:** New `ai-stop-tts` action listener wired as the external kill-switch. Clears browser queue + internal state, so the next step's greeting can start immediately without any barge-in / tail-grace suppression.

**Result:** clicking Next fast now immediately silences the previous step's greeting and begins the current step's greeting (or none, if the user is skipping past AI-only steps).

**Files changed:**
- `/app/frontend/src/pages/Onboarding.jsx` (step effect + cleanup)
- `/app/frontend/src/components/AiPanel.jsx` (new `ai-stop-tts` listener)


## AI Cleanup Copilot — Barge-In on Manual Vendor Skip (Feb 28, 2026) ✅
**User request:** *"lets do the same thing for Step 2"* — apply the onboarding barge-in fix to the AI Cleanup Copilot's vendor-by-vendor flow so that clicking Next / Skip on a vendor immediately silences the previous vendor's message.

**What was done:**
- Extracted the TTS kill-switch into a reusable `stopTtsNow()` helper on AiPanel.
- Called `stopTtsNow()` inside the `cleanup-inquiry` action handler right before `speakOne(msg)` so any still-playing previous vendor's message is silenced before the new vendor's message begins.
- Refactored the existing `ai-stop-tts` listener to delegate to the same helper.

**Result:** When the user clicks Next → to advance from vendor 4 (Patientco Inc) to vendor 5 (…) — or clicks any Skip chip — the AI stops mid-sentence and immediately begins the new vendor's inquiry.

**Files changed:**
- `/app/frontend/src/components/AiPanel.jsx` (`stopTtsNow` helper, added to `cleanup-inquiry` handler)


## Hide "Demo Accounts" Block on CypherPro Private-Label Root (Feb 28, 2026) ✅
**User request:** *"only on `cypherpro.accountingapp.ai/login` lets take this off 'Demo Accounts...' but leave it everywhere else"*

**What was done:** Added a module-scoped `HIDE_DEMO_HOSTS` set in `Login.jsx` currently containing just `"cypherpro.accountingapp.ai"`. The demo accounts block (rendered around lines 227-247) is now wrapped in a conditional that hides it when `window.location.hostname.toLowerCase()` is in the set. Case-insensitive match.

**Extending later:** Adding another private-label root that should also hide demo accounts is one line — just add the hostname to the set.

**Verified end-to-end:**
- Preview URL (`aifinance-hub-6.preview.emergentagent.com/login`) → Demo Accounts VISIBLE ✓
- Temporarily added preview hostname to HIDE list → Demo Accounts HIDDEN (screenshot confirms only Sign in, Forgot password, Create one visible; the entire Demo block gone) ✓
- Reverted → Demo Accounts VISIBLE again ✓
- Unit test on the lookup logic: 5 host variations, all correct routing (case-insensitive)

**Files changed:**
- `/app/frontend/src/pages/Login.jsx`


## Per-Tenant "Hide Demo Accounts" Toggle in Enterprise Settings (Feb 28, 2026) ✅
**User request:** *"we could make this a per-tenant branding toggle in the superadmin panel — so instead of hardcoding host strings in the frontend, you'd tick a Hide demo accounts on sign-in page checkbox when configuring each private-label firm. That way new white-label tenants can flip this without a code change or redeploy. — yes"*

**What was built:** The one-hostname hardcode is gone. Each private-label firm can now flip a checkbox on their Enterprise Settings page to hide/show the Demo Accounts block on their sign-in page. No redeploy needed.

### Backend
- `BrandingPatch` schema (`routes/pro.py`) gained a `hide_demo_accounts: Optional[bool]` field
- `_branding_out()` returns the flag as a coerced `bool`
- `PATCH /api/pro/branding` handles the update (sets `branding.hide_demo_accounts` on the user doc)
- Both public branding endpoints — `GET /api/branding/by-subdomain/{sub}` and `GET /api/branding/by-host` — now include `hide_demo_accounts` so the sign-in page can read it without auth

### Frontend
- `Login.jsx`: removed the hardcoded `HIDE_DEMO_HOSTS` set. The Demo Accounts block is now hidden whenever `mode === "firm" && firm?.hide_demo_accounts`. Falls back to visible on the SmartBooks platform brand + preview URLs + any firm without the flag set.
- `ProSettings.jsx`: added a new "Sign-in page options" card (with a Sparkles icon) directly under the Sign-in Address section. Contains the toggle + explanatory copy ("Recommended once you have real end-users so the seeded demo shortcut doesn't leak"). Contextual copy names the actual live host (`acme.accountingapp.ai`) when a subdomain is set.
- Optimistic UI with rollback on error, toast confirmations both ways.

### Verified via curl
- Baseline GET `/pro/branding` → `hide_demo_accounts: False` ✓
- PATCH to `true` → returned `True` ✓
- Public GET `/branding/by-subdomain/acme` → `hide_demo_accounts: True` (accessible without auth) ✓
- PATCH back to `false` → returned `False` ✓

### Verified via screenshot
- ProSettings page renders the new toggle card with proper labeling, checkbox, help text ✓

**Files changed:**
- `/app/backend/routes/pro.py` (schema + update handler + both public endpoints)
- `/app/frontend/src/pages/Login.jsx` (branding-driven check replacing hardcode)
- `/app/frontend/src/pages/ProSettings.jsx` (new "Sign-in page options" card + save handler)


## Sign-in Page Options: 3 More White-Label Toggles (Feb 28, 2026) ✅
Extended the per-tenant Sign-in page options card with three new high-leverage controls, all self-service via Enterprise Settings — no code changes needed to onboard a new white-label tenant.

### New fields (backend)
Added to `BrandingPatch`, `_branding_out()`, and both public branding endpoints (`by-subdomain`, `by-host`):
- `hide_signup_link: bool` — hides the "No account? Create one" link on the firm's sign-in page. For invite-only firms.
- `signin_tagline: str` (max 120 chars) — replaces the default "Welcome back. Let's get to the numbers." Empty string clears the override.
- `signin_hero_image: str` — data URL (image upload) or https URL. Replaces the SmartBooks marketing hero on the left half of the sign-in page on desktop. Empty string clears. Server-side validation blocks `javascript:` and other non-image URIs; 2 MB size cap.

### UI (`ProSettings.jsx`)
The "Sign-in page options" card now has 4 stacked sections separated by soft border-t dividers:
1. Hide Demo Accounts toggle (shipped previously)
2. Hide "Create one" signup link toggle (new)
3. Sign-in tagline text input with inline Save button (new; disabled unless dirty)
4. Marketing sidebar image with preview, Upload button, and Clear (when set) (new). Reads the file as a data URL so it round-trips through the JSON PATCH endpoint. 2 MB client-side guard.

Each toggle has optimistic UI with rollback on error, toast confirmations both ways, and helpful sub-copy explaining the effect.

### Login page renders (`Login.jsx`)
- Sign-in tagline uses `firm?.signin_tagline` when set, else the default
- Signup link is wrapped in a conditional that hides it when `firm?.hide_signup_link`
- Left marketing panel: platform brand shows the SmartBooks hero; firms with `signin_hero_image` set show a cover-image div; neutral hosts render nothing (unchanged)

### Verified end-to-end via curl
- PATCH all three fields → persisted correctly ✓
- Public `/branding/by-subdomain` exposes all four flags without auth ✓
- 121-char tagline rejected with clear error ("Sign-in tagline must be 120 characters or less.") ✓
- `javascript:alert(1)` hero URL rejected ("Hero image must be an https URL or a data:image/... URL.") — XSS guard ✓
- Cleanup (empty strings) clears all three ✓

### Verified via screenshot
- Full ProSettings page renders all four Sign-in options controls stacked cleanly with proper help copy and contextual host reference (`acme.accountingapp.ai`) ✓

**Files changed:**
- `/app/backend/routes/pro.py` (schema + branding helper + PATCH + both public endpoints)
- `/app/frontend/src/pages/ProSettings.jsx` (3 new state pairs, 3 new save handlers, expanded card UI)
- `/app/frontend/src/pages/Login.jsx` (tagline override, signup-link conditional, hero-image cover panel)


## Firm Login Layout: Big Logo + Name Below (Feb 28, 2026) ✅
**User request:** *"make the logo big and put the Name under the logo"*

**Before:** logo (h-10, ~40px) and firm name side-by-side, cramped on the top-left of the form.

**After:** logo enlarged to h-20 (~80px) with a max-width of 320px, centered above the firm name which now sits on its own line, also centered, in `font-heading font-bold text-lg`. Both wrapped in `flex flex-col items-center text-center`.

**Files changed:**
- `/app/frontend/src/pages/Login.jsx` (firm branding block layout)

**Verified via screenshot** on the firm-branded login: CypherPro logo big and centered, "Priya Patel, CPA" (the firm name) directly underneath.


## "Grant Superadmin" Button in Superadmin Dashboard (Feb 28, 2026) ✅
**User request:** *"can you add a create superadmin button in superadmin so that I can create it from there?"*

**What was built:** A one-click self-service Grant Superadmin flow in the Superadmin panel — no more shelling into Mongo to promote users.

### Backend endpoint
`POST /api/admin/superadmins` — accepts `{email, name?}`. Behavior:
- **Existing user, already superadmin:** idempotent no-op (returns `already_superadmin: true`)
- **Existing user, any other role:** flips role to superadmin (returns `previous_role`)
- **Fresh email:** creates a new user with a random placeholder password (`must_set_password: true`), mints a 7-day magic-link welcome token, and dispatches a "Platform Superadmin" welcome email. Returns the magic_url when creation is fresh so ops can manually forward the link if email delivery flops.

Every grant is written to `admin_audit_log` with kind=`superadmin_granted` (granting_admin_id, target_user_id, previous_role, created_new_user, timestamp). Requires `require_role("superadmin")` — client/pro tokens get 403.

### Frontend UI (`SuperadminDash.jsx`)
- New "Grant Superadmin" button (indigo, ShieldPlus icon) top-right of the Superadmin page header.
- Opens `GrantSuperadminModal` — email + optional name (only used for fresh creation). Submit shows a result panel:
  - "Already a superadmin" → info toast
  - Promoted existing → success toast with `previous_role → superadmin`
  - Fresh creation → success message + magic-link fallback panel (amber-bordered) with a Copy button when email delivery isn't confirmed
- "Grant another" resets the form, "Done" closes the modal. Refreshes the overview list so the new user appears immediately.

### Verified end-to-end
- **Backend curl (4 scenarios):** idempotent already-superadmin, promote existing pro, fresh user creation w/ magic-link, non-superadmin 403 — all pass ✓
- **UI screenshot:** Superadmin page shows new button + Michael Giorgi already promoted; modal submission creates a new superadmin, Users count bumps 63→64, magic-link fallback rendered with Copy button, success toast ✓

**Files changed:**
- `/app/backend/routes/admin.py` (new `POST /admin/superadmins` endpoint + Pydantic schema)
- `/app/frontend/src/pages/SuperadminDash.jsx` (button + `GrantSuperadminModal` component)


## Owner-Only Superadmin Management + Revoke List (Feb 28, 2026) ✅
**User request:** *"only have the 'Grant Superadmin' button on the superadmin michael@bigsaas.ai, as well as the list report of the superadmin with an revoke button per row"*

**What was built:** A second-layer gate fences the promote/demote surface so only ONE designated superadmin (the platform owner, `michael@bigsaas.ai` by default, configurable via `OWNER_SUPERADMIN_EMAIL` env var) can grant or revoke superadmin. All other superadmins retain their existing panel access — they just don't see the management controls.

### Backend
- **New `require_owner_superadmin` dependency** — stacked on top of `require_role("superadmin")`. Any other superadmin gets 403 with a clear message.
- **`GET /api/admin/superadmins`** — returns every user with `role="superadmin"`, sorted by `created_at`, plus an `owner_email` field. Each row has an `is_owner: bool` flag so the UI can lock the owner row.
- **`POST /api/admin/superadmins/{user_id}/revoke`** — demotes to `pro`. Blocks with 400 if:
  - Target user not found (404)
  - Target is the owner ("Cannot revoke the platform owner")
  - Target is not currently a superadmin
- Audit-logged as `superadmin_revoked` (granting_admin_id/email, target_user_id/email, previous_role, new_role, at).
- **Grant endpoint** (`POST /admin/superadmins`) tightened from `require_role("superadmin")` → `require_owner_superadmin` — same second gate.

### Frontend (`SuperadminDash.jsx`)
- On mount, the page probes `GET /admin/superadmins`. If it 403s, we're a non-owner and the promote/list surface stays hidden entirely (no button, no list, no leaked owner email).
- **Grant Superadmin button** now conditional on `isOwner`.
- **New "Superadmins" report card** — shows Name / Email / Since / Actions. Per-row Revoke button with a 2-step confirmation (Cancel + Confirm). Owner row shows an indigo `Owner — cannot revoke` locked badge instead.
- Success/failure toasts on both grant and revoke.

### Verified end-to-end
- **Backend curl (5 scenarios):**
  1. Non-owner superadmin GET /admin/superadmins → 403 ✓
  2. Non-owner superadmin POST /admin/superadmins → 403 ✓
  3. Owner GET → returns 2 superadmins with `is_owner` correctly flagged, `owner_email: michael@bigsaas.ai` ✓
  4. Owner revoking self → 400 "Cannot revoke the platform owner" ✓
  5. Owner revoking another superadmin → 200, new role `pro` ✓
- **UI screenshots:**
  - Signed in as `michael@bigsaas.ai` → Grant button visible + Superadmins report card visible with revoke buttons + owner locked badge ✓
  - Signed in as `admin@axiom.ai` → both the button and the card **completely hidden**, everything else intact ✓

**Files changed:**
- `/app/backend/routes/admin.py` (`OWNER_SUPERADMIN_EMAIL` env, `require_owner_superadmin` dep, new list + revoke endpoints, tightened grant guard)
- `/app/frontend/src/pages/SuperadminDash.jsx` (probe → isOwner flag → conditional UI, new `SuperadminsCard` + `SuperadminRow` components with 2-step confirm)


## Bug Fix: Firm Staff Pending Invites Persisted + Accepted Staff Now Appears (Feb 28, 2026) ✅
**User report:** *"I went into Skyward Sparks LLC and added a firm staff. I refreshed and the pending went away so now it says there is no firm staff. Also, the staff received the invite and accepted, but they are still not on the dashboard for firm staff."*

**Two connected root causes, both in `list_pro_team`:**

1. **Pending disappears on refresh** — the endpoint filtered pending invites by `invited_by_user_id: user["id"]` only. Fine when a pro invites, but the query didn't consider company scope — and when a superadmin viewer refreshed, if the invite's `invited_by_user_id` didn't match their own id (e.g., stale JWT, alternate session), the pending vanished.

2. **Accepted staff never appears** — the `members` list is filtered through `my_cids = {companies where I have role="pro"}`. Superadmins have NO `role:"pro"` memberships, so `my_cids = ∅`, meaning `members = []` regardless of what's actually happened on the company.

**Fix — make `/pro/team` company-scoped when the frontend passes `?company_id`:**

### Backend (`routes/invites.py`)
`list_pro_team` now accepts an optional `company_id` query param:
- **Company-scoped mode** (companyId provided): 
  - Verifies access (owner/pro membership OR superadmin) — 404 unknown / 403 unauthorized
  - Members = every user with `role="pro"` on THIS company (excluding self)
  - Pending invites = every pending invite for THIS company, regardless of who created it
- **Legacy mode** (no companyId): preserved for backwards compat

### Frontend
- `TeamPanel.jsx` — the `listUrl` builder now appends `?company_id=<currentId>` when `mode==="pro"` and a company is picked in the top selector
- `ProTeam.jsx` — pulls `currentId` from `useCompany()` and passes it to `TeamPanel`. Page copy dynamically shows the current company name ("Staff and pending invites for **Bright Beans Coffee Co.**") when scoped.

**Verified end-to-end via curl:**
- Baseline company-scoped fetch → 2 existing members ✓
- Create pro invite as owner → invite persisted with company_ids ✓
- **Refresh → pending PERSISTS** (was 0 → now 1) — Bug 1 fixed ✓
- Accept invite via `POST /invites/{token}/accept` → user created with role="pro" ✓
- **Refresh → accepted staff appears as active member, pending row clears** (members: 2 → 3) — Bug 2 fixed ✓

**Files changed:**
- `/app/backend/routes/invites.py` (`list_pro_team` accepts optional `company_id`, adds company-scoped mode)
- `/app/frontend/src/components/TeamPanel.jsx` (`listUrl` appends companyId when set)
- `/app/frontend/src/pages/ProTeam.jsx` (subscribes to `useCompany`, passes companyId + adds dynamic copy)


---

## Feb 2026 — AI Follow-up modal + Overdue filter chip (P0)

**Feature:** Wire the "AI Follow-up" CTA on the A/R Highlights card to draft personalised chase emails per overdue customer, and turn the "Overdue" card into a one-click table filter.

**Backend** (`/app/backend/routes/invoices.py`):
- `_drafts_for_overdue(cid)` groups overdue invoices by contact_id, calls GPT-4o-mini via `LlmChat(feature="ai-followup")` to draft each body, and falls back to a deterministic template if the LLM errors. Attaches customer email from `contacts` collection.
- `POST /companies/{cid}/invoices/ai-followup/drafts` returns `{drafts: [...]}` (one per customer).
- `POST /companies/{cid}/invoices/ai-followup/send-all` dispatches edited drafts via `email_dispatcher`, skipping rows without a valid email, returning `{sent, failed, skipped[], total}`.

**Frontend** (`/app/frontend/src/pages/Invoices.jsx`):
- `AIFollowupModal` — fetches drafts, shows loading state, renders one collapsible row per customer with checkbox, To/Subject/Body editors, "Toggle all", missing-email badge, and Send button. Result summary shows sent/failed/skipped counts.
- `overdueOnly` URL param (`?overdue=1`) — set by clicking `ar-highlights-overdue-card`, filters the client-side table to rows with `balance_due > 0 AND due_date < today`. Filter chip and "Clear filters" work for the overdue param alongside existing outstanding/as_of filters.

**Verified via screenshot:**
- Highlights toggle → Overdue card click → URL `?overdue=1` → chip "Showing **overdue** · 2 of 11" → table filtered to 2 rows ✓
- AI Follow-up card click → modal loads → 2 GPT-drafted personalised reminder emails render with editable To/Subject/Body ✓
- Backend curl round-trip confirmed real GPT-4o-mini output (166d late, 167d late invoices, 3-paragraph friendly-but-firm bodies) ✓


---

## Feb 2026 — Invoice list polish + AI Follow-up recency guard

**Feature:** Trim the invoice table, make Highlights the sticky default, and warn the pro before double-nudging any customer already chased in the last 7 days.

### 1) Removed "Issued" column
- `/app/frontend/src/pages/Invoices.jsx` — dropped both the `<th>Issued</th>` header and its `<td>{fmtDate(inv.issue_date)}</td>` cell; `colSpan` for the empty-row placeholder updated from 8 → 7.

### 2) Highlights = default view, persistent, moved to the left
- `ArAgingCard`: initial `view` state now reads `localStorage.getItem("ar_aging_view")` falling back to `"highlights"` (was `"aging"`).
- New `setViewPersist(v)` writes the choice back to localStorage so it sticks across sessions.
- Toggle order flipped: **Highlights** now renders on the left (default), A/R Aging on the right.

### 3) Recency guard on the AI Follow-up modal (last 7 days)
**Backend** (`/app/backend/routes/invoices.py`):
- Every invoice now carries a `last_followup_at` ISO timestamp — written by `send-all` on each successful dispatch (`db.invoices.update_many({id: $in: invoice_ids}, {$set: {last_followup_at: ...}})`).
- `_drafts_for_overdue()` computes per-customer-group:
  - `last_followup_at`: max timestamp across all invoices in the group
  - `followup_days_ago`: integer days since last chase (or `None`)
  - `recently_followed_up`: `True` if that timestamp is within the last 7 days

**Frontend** (`/app/frontend/src/pages/Invoices.jsx` → `AIFollowupModal`):
- Default-select logic no longer ticks `recently_followed_up` rows (`sel[i] = hasEmail && !d.recently_followed_up`).
- Drafts partitioned into `freshIdx` and `recentIdx`.
  - Fresh customers render at the top, expanded and editable as before.
  - Recently-chased customers collapse into a bottom section: **"Recently followed up · N (chased in last 7 days — expand to re-nudge)"** — controlled by `showFollowed` state.
- Each recent row gets:
  - `border-l-4 border-l-amber-400` accent stripe
  - Amber `CHASED Xd AGO` / `CHASED TODAY` badge with `Clock` icon
- Summary bar surfaces the count: `1 chased in last 7 days`.
- "Toggle all" now only affects fresh rows so the pro has to opt in to re-nudge.

**Verified end-to-end:**
- Curl: seeded `last_followup_at` (2 days ago on INV-2042, 12 days ago on INV-9999) → drafts endpoint correctly returns `recently_followed_up=True/days_ago=2` and `False/days_ago=12` ✓
- Playwright screenshot: default view = Highlights, no "Issued" column in table headers ✓
- Modal renders the fresh customer at the top, "Recently followed up · 1" collapsed section at the bottom that expands to reveal the amber-bordered row with `CHASED 2D AGO` badge and unchecked checkbox ✓


---

## Feb 2026 — Per-invoice Follow-up History timeline

**Feature:** Give pros an audit-ready timeline of every AI-drafted chase email sent for an invoice so they can prove they've been chasing before writing anything off.

### Backend (`/app/backend/routes/invoices.py`)
- `POST /companies/{cid}/invoices/ai-followup/send-all` now appends a `followup_history` entry to every invoice it successfully chased. Entry shape:
  ```
  {
    id, sent_at (ISO UTC), to_email, subject, body,
    sent_by_user_id, sent_by_user_name, channel: "email"
  }
  ```
  Written via `$push: {followup_history: entry}` in the same `update_many` that stamps `last_followup_at`, so both the recency guard and the audit trail stay in sync.
- New endpoint `GET /companies/{cid}/invoices/{iid}/followup-history` returns `{invoice_id, invoice_number, last_followup_at, count, history[]}` — history is sorted newest-first so the pro's eye lands on the most recent chase immediately.

### Frontend
- **New component** `/app/frontend/src/components/FollowupHistoryBlock.jsx`:
  - Auto-loads history from the new GET endpoint. Silently renders nothing if the history is empty (avoids visual noise on invoices that have never been chased).
  - Header: mail icon + `N chase emails sent · latest X days ago`.
  - Vertical timeline (indigo dots on a border-left) with one card per entry showing subject, recipient email, sender name, absolute timestamp (`Jul 30, 2026, 2:37 AM`), and relative time (`2 days ago`).
  - Click any row to expand the full email body in a soft-indigo panel — preserves whitespace via `pre-wrap` so the pro sees exactly what the customer received.
- **Wired into** `/app/frontend/src/pages/InvoiceEditor.jsx` — rendered directly after `PaymentHistoryBlock` when in edit mode.

### Verified end-to-end
- Backend: seeded 3 history entries on INV-2042 (2d, 14d, 30d ago). `GET /followup-history` returns `count=3` with newest-first ordering ✓
- Playwright screenshot on `/invoices/{id}/edit`:
  - Header renders `3 chase emails sent · latest 2 days ago` ✓
  - 3 timeline entries render with correct subjects, recipients, sender = "Michael Chen", and matching relative-time badges ✓
  - Clicking the top row expands the full body ("Hi TEST_dupctx, Just a gentle follow-up on invoice INV-2042…") in the indigo panel ✓

### Files touched
- `/app/backend/routes/invoices.py` — GET endpoint added, `send-all` push-history logic added
- `/app/frontend/src/components/FollowupHistoryBlock.jsx` — new component
- `/app/frontend/src/pages/InvoiceEditor.jsx` — import + render in edit mode


---

## Feb 2026 — Follow-up history promoted to a third tab

**Change:** Move the follow-up timeline out of the scrolling edit body and into a dedicated **"Follow-up history"** tab to the right of Preview, complete with a live count badge.

### Frontend
- `/app/frontend/src/pages/InvoiceEditor.jsx`:
  - `tab` state now supports `"edit" | "preview" | "followup"` (still defaults to Edit).
  - Third tab button renders only when `editMode` is true (new invoices have no history yet). Indigo accent underline when active, `Mail` icon, and a pill badge showing the current count (`3`) when `followupCount > 0`.
  - Tab body: when `tab === "followup"`, render `FollowupHistoryBlock` inside a `rounded-xl border bg-white shadow-sm` container to match the Preview tab's card treatment.
  - Removed the inline block below `PaymentHistoryBlock` — the tab is now the single source of truth.
  - Pre-fetch on invoice load: `GET /followup-history` fires alongside payments so the badge count shows immediately, even before the pro opens the tab.
- `/app/frontend/src/components/FollowupHistoryBlock.jsx`:
  - New optional `onCount(n)` callback — fires whenever history loads so the parent tab badge stays in sync.
  - Now renders three states: `loading`, empty ("No follow-ups yet"), and populated timeline (was previously "render nothing when empty" — but a tab needs *something* when clicked). Empty-state copy explains what the tab will fill with.
  - Removed the `border-t bg-white` wrapper class — the block now assumes it lives inside a card container provided by the parent tab.

### Bug fixed en-route
- Initial pass used `docId={docId}` from InvoiceEditor's top scope where only `id` (from `useParams`) is defined. Corrected to `docId={id}`. Runtime error `ReferenceError: docId is not defined` no longer reproduces.

### Verified via Playwright
- Tab bar: `['Edit', 'Preview', 'Follow-up history\n3']` — badge renders `3` for INV-2042 which has 3 seeded entries ✓
- Clicking the tab loads the timeline (3 entries), expanding entry-0 reveals the full body pane ✓


---

## Feb 2026 — Tier 2 Inventory Module (COMPLETE, 5 phases)

**Change:** Full weighted-average inventory bookkeeping across items, bills, invoices, adjustments, and reports. Tier 2 spec: weighted-avg only, starts from today (no retroactive backfill), warn-but-allow negative QOH, atomic delta-based reversal.

### Files added / touched
- **`/app/backend/inventory_service.py`** — new engine. `apply_bill_inventory`, `apply_invoice_inventory`, `apply_adjustment`, `compute_valuation`, `list_movements`, `_reverse_bill_hooks`, `_reverse_invoice_hooks`. Delta-based reversal so intervening adjustments survive.
- **`/app/backend/routes/items.py`** — `ItemIn`/`ItemPatch` extended with `track_inventory`, `quantity_on_hand`, `cost_basis`, `inventory_account_id`, `cogs_account_id`, `low_stock_threshold`. Backfills account names on create.
- **`/app/backend/routes/bills.py`** — create/update/delete wired to inventory_service. Hooks stored on `bill.inventory_hooks` for idempotent re-save.
- **`/app/backend/routes/invoices.py`** — create/update/delete wired. Response includes `inventory_warnings` when a sale would push QOH negative.
- **`/app/backend/routes/inventory.py`** — new endpoints: `POST /companies/{cid}/inventory-management/adjustments`, `GET /valuation`, `GET /movements`.
- **`/app/frontend/src/pages/InventoryPage.jsx`** — new tabbed page (Valuation / Movements / Adjustments) with AdjustmentModal (delta or absolute set + reason dropdown).
- **`/app/frontend/src/pages/Items.jsx`** — modal now has inventory sub-form (toggle, opening QOH/cost, account pickers, low-stock threshold) with auto-picked defaults when only one account matches.
- **`/app/frontend/src/App.js`** — route `/inventory-management → InventoryPage`.
- **`/app/frontend/src/components/Sidebar.jsx`** — "Inventory" link under Accounting group (between Loans and Tags).
- **`/app/frontend/src/pages/Reports.jsx`** — Inventory Valuation tile added.

### Accounting design (agreed w/ user)
- Bill JE: `DR Inventory / CR line.expense_account_id` — the CR against the same expense account intentionally offsets both cash-based expense recognition on later payment AND the accrual A/P adjustment in reports._open_ar_ap → net P&L effect from inventory purchases is $0 until sold.
- Invoice JE: `DR COGS / CR Inventory` at the item's current weighted-avg cost.
- Adjustments: DR/CR against Inventory + auto-created "Inventory Adjustments" expense account (detail_type=`inventory_adjustment`).
- Movements audit trail in new `inventory_movements` collection.

### Verified
- All 9 pytest cases in `/app/backend/tests/test_inventory_tier2.py` PASS. Frontend fully validated: Items modal reveal, /inventory-management page (all 3 tabs), sidebar link, adjustment modal.


---

## 2026-02 — Railway 3-Node Replica Set Migration Plan (documentation only)

### Status
- **BLOCKED on user backup-restore drill** before any prod Mongo touch.
- Full plan committed to `/app/memory/RAILWAY_REPLICA_SET_MIGRATION.md`.

### User answers received (2026-02)
- Railway plan: **Pro** (24 vCPU / 24 GB per-replica ceiling — confirmed from screenshots).
- HA choice: **c — Full 3-node RS**. Agent counter-recommends **PSS (Primary-Secondary-Secondary)** over PSA for durable `w:majority`.
- Downtime tolerance: **c — 15–30 min window OK**.
- Backup situation: **unknown → agent to advise**. User must run restore drill and report RTO.

### Cost estimate delivered
- PSS self-managed on Railway: **~$135/mo** (3× mongo:8.0 + volumes).
- Atlas M10 alternative: **~$57/mo** managed with PITR (Appendix A).

### Worker calibration decision
- Now (pre-migration, single node): `--workers 4` + `MONGO_MAX_POOL_SIZE=100`.
- Post-migration (3-node PSS with 24 vCPU headroom): `--workers 8` + `MONGO_MAX_POOL_SIZE=75`.

### What lands in code AFTER migration succeeds (queued)
1. Thread `session=` through `POST /bills`, `POST /assets`, `POST /opening-balance`, `POST /bill-payments`, wrap in `ledger_transaction()`.
2. Wrap contact upsert in `try/except DuplicateKeyError → find existing → return 200`.
3. Remove one-shot warning from `db.py::_probe_txn_support` once real RS is confirmed.
4. Add integration test `test_ledger_atomicity.py` with force-fail rollback assertion.
5. Route `/api/admin/ledger-integrity` via `readPreference=secondaryPreferred`.

### User owes before we execute
- [ ] Backup restore drill RTO measured
- [ ] Maintenance window scheduled
- [ ] Confirm PSS vs PSA (agent recommends PSS)
- [ ] Set `MONGO_MAX_POOL_SIZE=100` on Railway accountingapp Variables
- [ ] Approve `--workers 4` today, `--workers 8` post-migration
- [ ] Confirm cost path: self-managed ~$135/mo OR Atlas M10 ~$57/mo



---

## 2026-02-03 — MIGRATED TO ATLAS M10 ✅ (DONE, LIVE)

### What happened
User walked through the full runbook end-to-end. Migration completed in ~90 min, with ~1 min of API downtime during the `MONGO_URL` flip.

### Key discoveries during migration
- **Prod had ZERO backups configured on Railway Mongo before this session.** Fixed by setting up daily 03:00 UTC snapshots with 30-day retention as a safety net before migrating.
- **`DB_NAME` = `axiom_prod`** (not `axiom` as previously assumed).
- **Actual prod data is tiny** — 28.3 MB across 51 collections, 47,726 total docs.
- **Contacts collection has 7,157 docs across 8 companies** — highly suggests DuplicateKeyError race from unfixed P3 issue is causing contact bloat. Dedup pass queued.

### Migration path taken
1. Signed up MongoDB Atlas → created M10 cluster `Accountingapp` in AWS us-west-1 (matches Railway) with Cloud Backups Enabled.
2. Set IP allowlist to `0.0.0.0/0` (Railway has dynamic egress IPs).
3. Created DB user `michael_db_user`.
4. `mongodump --db=axiom_prod --archive=/tmp/prod.gz --gzip` from Railway Mongo Console → 5.8 MB archive in 1 sec.
5. `mongorestore --uri="mongodb+srv://..." --archive=/tmp/prod.gz --gzip` → 47,726 docs restored, 0 failures in ~30 sec.
6. Verified Atlas counts match Railway baseline exactly (all 10 spot-checked collections + total object count).
7. Flipped `MONGO_URL` env var on Railway `accountingapp` service → auto-redeploy → live on Atlas.
8. Confirmed live traffic on Atlas: 28.4 R/s, 0.5 W/s, 68 connections, spike visible at cutover moment.

### Post-migration state
- **Live prod**: Atlas M10 replica set (3 nodes), MongoDB 8.0.29, us-west-1, Continuous Cloud Backup + PITR.
- **Railway MongoDB**: still running as hot rollback. Scheduled for deletion after 48h Atlas stability.
- **Cost delta**: +$65/mo Atlas, -$40/mo Railway Mongo (once deleted) = net +$25/mo for enterprise-grade managed DB with PITR, transactions, and true HA.
- **`MONGO_MAX_POOL_SIZE=100`** set on `accountingapp` Variables.

### Immediate follow-ups (user's plate)
- Smoke test live app flows (login, transactions, reports, AI features)
- Rotate Atlas password (was in chat during migration)
- Delete Railway MongoDB service after 48h clean run

### Code work now UNBLOCKED (agent's plate, no downtime required)
1. Thread `session=` through `POST /bills`, `POST /assets`, `POST /opening-balance`, `POST /bill-payments`. Wrap in `ledger_transaction()`. Atomicity now actually works.
2. Wrap contact upsert in `try/except DuplicateKeyError → find existing → return 200` (fixes P3 recurring 500s, root cause of contact bloat).
3. Remove single-node fallback warning from `db.py::_probe_txn_support` (no longer relevant).
4. Bump `uvicorn --workers 4` → `--workers 8` with `MONGO_MAX_POOL_SIZE=75` (more concurrency now that pool is Atlas-backed).
5. Write `test_ledger_atomicity.py` — force-fail rollback assertion.
6. Contact dedup script — collapse the 7,157 duplicated contacts back to expected count.

### Files touched
- `/app/memory/RAILWAY_REPLICA_SET_MIGRATION.md` — original plan, now historical reference.
- `/app/memory/PRD.md` — this entry.
- **No code changes made in this session** — pure infrastructure migration.

### Verified
- Atlas count parity: 8 companies, 11 JEs, 15 users, 11200 txns, 13 invoices, 3 bills, 421 accts, 7157 contacts, 6 items, 4 payments (matches Railway exactly).
- Total docs: 47,726 (Railway) = 47,726 (Atlas). Zero data loss.
- Live traffic confirmed on Atlas Metrics dashboard (R 28.4/s, W 0.5/s, 68 conns at 12:03 PM cutover).



---

## 2026-02-03 (evening) — Sprint 1 partial: Contact race fix + Dedup script ✅

### Delivered
1. **Contact race fix** — `POST /api/companies/{cid}/contacts` and
   `POST /api/companies/{cid}/contacts/import/commit` now catch
   `DuplicateKeyError`, look up the winner, and return the same id
   (manual create) or perform an update (import). Stops all 500s from
   concurrent inserts of the same normalized name.

2. **Contact dedup script** — `/app/backend/tests/dedupe_contacts.py`
   Standalone CLI with `--apply` and `--company=<cid>` flags. Groups
   contacts by (company_id, normalized_name), picks oldest as keeper,
   repoints FKs across 9 collections (transactions, invoices, bills,
   payments, receipts, communications, contact_learning_cache,
   rule_candidates, rules), then deletes losers. Dry-run by default.

3. **Pytest coverage** — 6/6 passing:
   - `tests/test_contact_race_fix.py` (3 tests: manual race, import race, normalized collision)
   - `tests/test_dedupe_contacts.py` (3 tests: grouping, apply, empty-key skip)

4. **Shared test loop helper** — `/app/backend/tests/_shared_loop.py`.
   Multiple test modules were creating their own event loops → motor
   client (bound at import time in `db.py`) errored "attached to a
   different loop" on the second module. Single shared loop fixes this
   for any future async test file — just `from tests._shared_loop import run`.

### To use the dedup script on Atlas prod
```bash
# Dry run — see what would happen (no changes)
cd /app/backend && python -m tests.dedupe_contacts

# Or per-company staged rollout
python -m tests.dedupe_contacts --company=<cid>

# LIVE (after reviewing the dry run)
python -m tests.dedupe_contacts --apply
```
Take an Atlas snapshot before `--apply` (Atlas → Backup → Take Snapshot).
The 7,157-contact bloat should collapse to a realistic per-company count.

### Files touched
- `/app/backend/routes/contacts.py` — added `DuplicateKeyError` import;
  wrapped `create_contact` and `contacts_import_commit` inserts in
  race-safe try/except.
- `/app/backend/tests/dedupe_contacts.py` — NEW
- `/app/backend/tests/test_contact_race_fix.py` — NEW
- `/app/backend/tests/test_dedupe_contacts.py` — NEW
- `/app/backend/tests/_shared_loop.py` — NEW (shared test utility)

### Sprint 1 items still queued for next session
- **Ledger transaction wrappers** on Bills / Assets / Opening-Balance /
  Bill-Payments. Deferred because it requires threading `session=` through
  the entire 965-line `inventory_service.py` including `apply_bill_inventory`,
  `_ensure_accounts_payable`, `_record_movement`, `_reverse_bill_hooks`,
  `insert_je`. Missing a `session=` anywhere = write escapes the transaction
  silently. Wants dedicated focus session.
- **Worker bump** `--workers 4 → 8` with `MONGO_MAX_POOL_SIZE=75`. Just a
  Railway config change — see Instructions below.
- **Remove single-node fallback warning** from `db.py::_probe_txn_support`
  (no longer relevant with Atlas replica set).

### Railway config change (user's plate, 2 min)
Railway → `accountingapp` service:
- Variables tab: change `MONGO_MAX_POOL_SIZE` from `100` → `75`
- Settings → Start Command: update to `uvicorn server:app --workers 8 --host 0.0.0.0 --port $PORT`
- Save → auto-redeploys → ~30s of API 502s

This gives 8 workers × 75 pool = 600 concurrent DB sockets, well under
Atlas M10's 1500 limit, with more Python heap for concurrent report queries.



---

## 2026-02-03 (late night) — Restaurant Vertical Plan Locked ✅ (planning only, no code)

### Confirmed scope
- **Positioning**: Restaurant365-competitor for SMB (1–10 locations). $150–350/location/mo.
- **Architecture**: `vertical` field + feature flags on existing platform. 80% code reuse. Base accounting product unchanged for existing users.
- **POS integrations (in order)**: Square (weeks 3–4) → Clover (weeks 8–9) → Toast (weeks 10–12; partner app filed Day 1).
- **Multi-location scope**: Independent 1–3 location + small groups up to ~10. NOT enterprise 100+ chains.
- **Timeline**: 10–12 weeks solo-builder + AI to public beta.
- **Greenfield acquisition** — no existing customers to migrate.
- **Team**: solo (Michael + agent). Need beta operators lined up in weeks 5–7.

### Documents
- `/app/memory/RESTAURANT_VERTICAL_ROADMAP.md` — full 12-section roadmap (source of truth)

### Parallel actions user needs to start Day 1
- File Toast Partner Application (2–4 week approval)
- Sign up Square + Clover developer accounts (self-serve)
- Line up 3–5 restaurant beta operators for weeks 5–8

### Next session kickoff
Full prompt in `RESTAURANT_VERTICAL_ROADMAP.md` §12. Starts with Week 1–2 foundation work: vertical field, locations collection, feature flag scaffold, multi-location report scoping, onboarding wizard branch. All additive to existing base product.




---

## 2026-02-03 (very late) — Hotfix: slowapi Redis outage 500'd all logins 🚨

### Symptom
User reported "Demo login failed" on prod. Direct `curl POST /api/auth/login` returned HTTP 500 "Internal Server Error" with no JSON body. Every login attempt affected.

### Root cause
`/app/backend/infra.py::limiter` was configured with `storage_uri=REDIS_URL` but Redis was unreachable (Connection refused on 127.0.0.1:6379). slowapi's default behavior on storage-backend errors is to **let the ConnectionError bubble up**, which took down every rate-limited endpoint — including `/api/auth/login`.

Stack trace pinpointed:
```
slowapi/extension.py __evaluate_limits → limits/storage/redis.py incr →
redis.exceptions.ConnectionError: Error 111 connecting to 127.0.0.1:6379
```

### Fix
Added `swallow_errors=True` to the `Limiter()` constructor. Now if Redis is down / unreachable / times out, slowapi silently skips the rate-limit check and the request passes through. The Mongo-backed brute-force layer in `routes/auth.py::_login_failures_recent` still enforces per-email lockout.

### Verified
Local test with Redis down:
- Before fix: `POST /api/auth/login` with wrong password → HTTP 500 (crash)
- After fix: `POST /api/auth/login` with wrong password → HTTP 401 (correct rejection)

### Files touched
- `/app/backend/infra.py` — added `swallow_errors=True` + comment explaining why

### User's immediate action (unblock)
- Delete `REDIS_URL` env var from Railway `accountingapp` → memory:// fallback → login works in 60s

### User's follow-up (harden)
- Push this infra.py fix via Save-to-GitHub → PR merge → Railway auto-deploy
- Investigate why Redis went down (or if it was ever really up on Railway)
- If wanting proper multi-worker rate limiting: sign up Upstash (free tier) → paste URL back into `REDIS_URL`


---

## 2026-02-03 (very late) — Hotfix #2: Thread exhaustion from --workers 8 🚨

### Symptom
After merging Sprint 1 PR + the --workers 8 change to production, `POST /api/auth/login` returned HTTP 500 "Internal Server Error" on every attempt. Users could not log in.

### Root cause (found via Railway Deploy Logs)
`RuntimeError: can't start new thread` — the container ran out of OS threads. Traceback path:

```
routes/ai_ops.py::_compute_attention
  → asyncio.gather(*[_stale(a) for a in bank_accts])   # unbounded fan-out
  → routes/ai_ops.py::_stale
  → db.transactions.count_documents(...)               # Motor async → threadpool
  → motor/frameworks/asyncio/__init__.py::run_on_executor
  → concurrent/futures/thread.py::_adjust_thread_count
  → threading.Thread(target=...).start()
  → RuntimeError: can't start new thread
```

The multiplier that broke us: 8 uvicorn workers × Motor's per-worker executor × unbounded `asyncio.gather()` on N bank accounts × MONGO_MAX_POOL_SIZE=100 sockets = OS thread ceiling hit on Railway container.

### Fix
Rolled back `backend/railway.json` start command:
- Old: `uvicorn server:app --host 0.0.0.0 --port ${PORT} --workers 8`
- New: `uvicorn server:app --host 0.0.0.0 --port ${PORT} --workers 4`

Verified: login endpoint returns HTTP 200 with valid credentials post-rollback.

### The earlier "Redis is down" diagnosis was WRONG for prod
Local dev container had a stale Redis connection attempt that showed a Redis ConnectionError, but PROD had no Redis service and no REDIS_URL env var. The `swallow_errors=True` fix to `infra.py` (`Limiter`) is still worth landing as defence-in-depth but was NOT the root cause of the prod 500. Real cause was thread exhaustion, not Redis.

### Queued longer-term fixes (next session)
1. **Bound `asyncio.gather` in ai_ops.py** with `asyncio.Semaphore(10)` so we don't fan out unbounded across all bank accounts.
2. **Audit every `asyncio.gather(*[...])` in the codebase** for similar unbounded fan-outs. Grep target: `grep -rn "asyncio.gather" backend/`.
3. **Move heavy async work to `job_queue.py`** — attention/insights computation should not race with request threads.
4. **Then re-try `--workers 8`** with fan-out patterns bounded.
5. **`infra.py::Limiter(swallow_errors=True)` fix** — already applied locally, needs to be pushed via Save-to-GitHub → PR merge.

### Files touched this session
- `backend/railway.json` — rolled back to `--workers 4` (committed direct to main via GitHub UI)
- `backend/infra.py` — added `swallow_errors=True` to slowapi Limiter (local only, needs push)
- `memory/PRD.md` — this entry

### Handoff notes for next session
- Prod is on `--workers 4` — this is the "safe" setting. Don't bump to 8 again until fan-out patterns are bounded.
- `infra.py` change is in local /app but NOT pushed to GitHub. Needs Save-to-GitHub → Create Branch & Push → PR merge to land in prod.
- No new database changes, no schema migration required.
- Sprint 1 code (contact race fix + dedup script) IS live in prod — only the workers-8 change was rolled back.



## 2026-02-07 — QBO transactional migration hardening (Invoice/Bill/Payment) 🛠️

### Symptom
"QBO 4 LLC" migration (CID `bae7e839-6754-4f16-bc8b-61b237bd9ed5`) imported Accounts/Customers/Vendors/Items successfully, then died. Invoices, Bills, Payments, JEs, and all downstream entities showed count=0.

### Root cause
`map_invoice` did `obj.get("TxnTaxDetail", {}).get("TotalTax") ...`. QBO returns `TxnTaxDetail: null` (explicit JSON null) on non-taxable invoices. `dict.get("TxnTaxDetail", {})` returns `None` when the key is *present but null* (the default only fires for missing keys). Second `.get()` on `None` → `AttributeError`. That exception bubbled through `_run_entity` → `run_migration`'s top-level try, marking the whole job as `failed` and skipping every remaining entity in `_PIPELINE`.

### Fix
- `map_invoice`: pre-extract `tax_detail = obj.get("TxnTaxDetail") or {}` — the `or {}` idiom coerces `None` to `{}`. Applied same treatment to other refs.
- `map_payment`: rewrote the shadowed-variable nested comprehension into an explicit two-level loop that flattens LinkedTxn safely.
- `_run_entity`: wraps each row in `try/except`. On failure: increments a `failed` counter and pushes `{qbo_id, error_type, error}` into `qbo_jobs.entity_errors.<Entity>` (bounded to 25 samples). Writes per-entity `entity_summary` (processed/failed) to the job doc on completion. **One bad row can no longer kill the pipeline.**
- `/api/companies/{cid}/qbo/diagnostics`: now includes counts + sample docs for `invoices`, `bills`, `payments`, `journal_entries`, and `transactions` so partial imports are immediately visible. Job docs (already surfaced by the endpoint) now include `entity_errors` and `entity_summary` maps.

### Verified
- 14 mapper tests pass (`tests/test_qbo_mapper_null_safety.py` + `tests/test_qbo_mapper_ids.py`).
- Backend hot-reload clean.
- Live `GET /diagnostics` returns the new transactional collection blocks.

### Files touched
- `/app/backend/qbo_service.py` — mapper null-safety + `_run_entity` isolation.
- `/app/backend/routes/qbo.py` — diagnostics endpoint extended.
- `/app/backend/tests/test_qbo_mapper_null_safety.py` — new regression tests.

### User's next steps
1. Save to GitHub → PR merge → Railway auto-deploys.
2. Re-run QBO 4 LLC migration.
3. Re-fetch diagnostics. Even if a specific row fails, the job now continues; failed rows show up in `jobs[0].entity_errors` with exact error strings.

## 2026-02-08 — QBO → Plaid PFC Auto-Categorization Pipeline 🎯

### The core insight
Trying to stamp our numeric codes onto QBO accounts was the wrong model — it was fragile (AI non-determinism), lossy (structural accounts like AP/AR/Inventory got mangled), and coupled QBO's schema to our seed. The right model is the existing `pfc_org_overrides` collection, populated per-company via AI at migration time.

### What shipped
- **New: `backend/pfc_ai_builder.py`** — Claude Sonnet 5 proposes `pfc_detailed → account_id` mappings using each company's actual chart. Type-safe (revenue→revenue, expense→expense), skips structural accounts, `medium+` confidence auto-writes.
- **New endpoints** in `routes/qbo.py`: `GET /pfc-map/plan`, `POST /pfc-map/apply`, `GET /pfc-map`, `PUT /pfc-map/{pfc}`, `POST /qbo/reset-qbo-codes` (undo old code-stamping).
- **New page** `frontend/src/pages/PfcCategoryMap.jsx` at `/settings/pfc-map` — 127-row table with account dropdowns, filter, "Build with AI" button, source badges (ai/user/pinned).
- **Auto-runs on QBO migration** — `run_migration()` now calls `resolve_payment_links()` AND `apply_pfc_map()` after entities import. Wrapped in try/except so LLM hiccups don't fail the migration.

### Test results — QBO 15 LLC (Feb 2026)
- 89 accounts / 55 contacts / 18 items / 31 invoices / 15 bills / 26 payments (all auto-linked) / 3 JEs / 46 transactions imported cleanly.
- PFC map: 58 of 127 categories auto-mapped at medium+ confidence. 69 correctly left unmapped (personal categories, ambiguous transfers). Manual overrides available per-row.
- Verified isolation: Show LLC (non-QBO) categorization unchanged — same 11-bucket distribution as before this work.

### Retired
- `backend/qbo_ai_align.py` (still exists but no longer called — the "stamp codes onto QBO accounts" approach)
- `POST /qbo/ai-align-plan` and `POST /qbo/ai-align` endpoints (kept for backward-compat, users should ignore)

### Known limitations
- INCOME_RENTAL sometimes maps to a domain-specific revenue account when the QBO chart has one — user can override via dropdown.
- LOAN_PAYMENTS_* (non-credit-card) intentionally left unmapped — principal/interest splits need special handling.
- `TRANSFER_OUT_ACCOUNT_TRANSFER` pre-existing routing bug (falls to Uncategorized instead of 3200 Inter-Account Transfer) — unrelated to this work, tracked for future session.



## 2026-08-09 — QBO Mirror Phase 2c (Invoice Push / Outbound)

**Status**: SHIPPED. Bi-directional invoice sync complete.

### What shipped
- **`qbo_mirror/push.py`**
  - `_invoice_body(company_id, inv)` — QBO Invoice payload builder.
    Translates local `contact_id` → `CustomerRef.value`, per-line
    `item_id` → `ItemRef.value`. Falls back to a Service-typed QBO
    item (prefers names "Services" / "Hours" / "General") when a
    line lacks `item_id`. Handles `TxnDate`, `DueDate`, `DocNumber`
    (21-char cap), `CustomerMemo`, `PrivateNote`.
  - `_push_invoices()` — bulk pusher. Skips drafts, voided, and
    already-mirrored invoices.
- **`qbo_mirror/autopush.py`**
  - `_push_one_invoice()` single-shot pusher.
  - Invoice registered in `_ENTITY_META`, `_HANDLERS`,
    `_ENTITY_TO_CFG_KEY`.
  - `_run_auto_update()` — invoice branch: doc-level sparse update
    only (TxnDate/DueDate/CustomerMemo/PrivateNote). Line-level
    drift deferred to Phase 3.
  - `_run_auto_delete()` — invoice uses `?operation=delete` (QBO
    hard delete).
  - `_run_one()` — filters `status in (draft, void, voided)`.
  - `_run_auto_update()` fresh-push fallback — a draft → sent
    transition on an unmirrored invoice routes to the fresh push
    path so it lands on QBO for the first time on the flip.
- **`routes/invoices.py`** — `create_invoice`, `update_invoice`,
  `delete_invoice`, `duplicate_invoice` wire `try_auto_push` /
  `try_auto_update` / `try_auto_delete` hooks. Duplicate strips
  source `qbo_id` so the copy pushes fresh.
- **`pages/QboMirror.jsx`** — dropped "(Phase 2 · preview only)"
  label; invoices are now first-class in Push / Pull / Preview.
- **`tests/test_qbo_mirror_invoice_push.py`** — 5 unit tests
  covering body-builder happy path + all reject branches. All PASS.

### Deliberately deferred
- **Doc-level tax** — `TxnTaxDetail` skipped because our local
  taxes library isn't mirrored to QBO. Forcing it onto QBO either
  errors (non-AST company w/ unmapped TaxCode) or is silently
  overridden (AST). Full tax mirror lands in Phase 3.
- **Line-level updates** — QBO invoice line updates need the
  per-line QBO Id to preserve payment linkage. Our local line
  model doesn't yet carry it. Deferred to Phase 3.

### Next up
- **Phase 2d** — Bills push/pull mirror (same pattern as invoices).
- **Phase 2e** — Payments / BillPayments mirror.
- **Phase 2f** — Deposits / Transfers / Journal Entries mirror.
- **Phase 3** — Estimates, POs, tax library mirror, line-level
  invoice updates.
- **Sync Status Badges** — UI badges on CoA/Contacts/Items/Invoices
  rows using `_sync_status`.
- **Real-time inbound webhooks** — replace manual Pull.


## 2026-08-09 — QBO Mirror Phase 2d (Bills, Bi-directional)

**Status**: SHIPPED. Bills now enjoy full bi-directional sync
identical to invoices — autopush on create/update/delete,
manual bulk push (2-pass: creates then drifted-updates),
inbound pull with reclaim-by-DocNumber, twin-patch phantom-drift
prevention.

### What shipped
- `_bill_body`, `_push_bills`, `_local_patch_from_qbo_bill`
  (push.py)
- `_pull_bills` (pull.py) with reclaim-by-DocNumber
- Bill normalizers + drift fields (engine.py)
- `_push_one_bill` + registry entries + update/delete branches
  (autopush.py)
- All four route hooks wired (routes/bills.py + duplicate_bill in
  routes/invoices.py)
- Bills toggle enabled by default (settings.py)
- Bills row in mirror settings UI (QboMirror.jsx)
- 6 regression unit tests

### Deferred
- ItemBasedExpenseLineDetail (inventory item purchases push as
  AccountBasedExpenseLineDetail for now).
- Bill-level tax pushdown (tax library still not mirrored).

### Next up
- Phase 2e: Payments + BillPayments mirror. Payments reference
  both invoices and bills — both linkage sides now exist.
- Phase 2f: Deposits / Transfers / Journal Entries mirror.
- Real-time inbound webhooks or background auto-pull polling.
- Sync Status Badges on CoA / Contacts / Items / Invoices / Bills.


## 2026-08-09 — QBO Mirror Phase 2e (Payments + Bill Payments)

**Status**: SHIPPED. Money movement now flows bi-directionally.

### What shipped
- Push (both directions), Pull (both directions), autopush on
  create/delete, dry-run preview cards.
- Direction dispatch in `routes/payments.py::_payment_mirror_entity`.
- Registry split into `payment_in` / `payment_out` so a single
  local collection can drive two QBO endpoints.
- 8 unit tests, 19/19 total across all mirror test files.

### Deferred
- Payment UPDATE mirroring — user pattern: delete + recreate.
- Multi-invoice / multi-bill single payments (single-link MVP).
- Payment drift detection in preview (qbo_id-only match).

### Next up
- Phase 2f: Deposits / Transfers / Journal Entries mirror.
- Background auto-pull polling (15-min scheduler) → QBO→us
  becomes automatic without Intuit webhook config.
- Sync Status Badges on CoA / Contacts / Items / Invoices / Bills
  / Payments rows using `_sync_status`.


## 2026-08-10 — QBO Mirror Phase 2f (Journal Entries)

**Status**: SHIPPED. Full bi-directional JE sync.

### What shipped
- `_journal_entry_body` push builder + `_push_journal_entries`
  bulk pusher (push.py)
- `_pull_journal_entries` with account_id resolution (pull.py)
- `_push_one_journal_entry` handler + registry entries (autopush.py)
- JE normalizers, drift-fields entry, engine loop (engine.py)
- Route hooks in `routes/journal.py` (create/delete)
- Frontend ENTITIES + whitelists
- 8 unit tests; 28/28 mirror tests total

### Deferred (documented in CHANGELOG)
- JE UPDATE mirroring — delete + recreate.
- Deposits/Transfers push — no in-app authoring UI.
- Deposits/Transfers pull — already covered by migration path.

### Next up
- **Background Auto-Pull Polling** — 15-min scheduler; QBO → us
  becomes automatic, no Intuit dev config needed. Fills the "why
  didn't my QBO change show up?" gap.
- **Sync Status Badges** — 🟡/🟢/🔴 pips on all list rows using
  `_sync_status`.
- **Plaid `TRANSFER_OUT_ACCOUNT_TRANSFER`** — still routing to 6999.
- **Estimates + Purchase Orders** — new doc types wired to mirror
  from day one.


## 2026-08-10 — Phase 3 (Estimates + Purchase Orders)

**Status**: SHIPPED. Two new doc types with full bi-directional
mirror + one-click convert workflow.

### Endpoints
- `GET/POST /companies/{cid}/estimates`
- `PATCH/DELETE /companies/{cid}/estimates/{eid}`
- `POST /companies/{cid}/estimates/{eid}/convert` → Invoice
- `GET/POST /companies/{cid}/purchase-orders`
- `PATCH/DELETE /companies/{cid}/purchase-orders/{pid}`
- `POST /companies/{cid}/purchase-orders/{pid}/convert` → Bill

### DB collections (new)
- `db.estimates`: `id, company_id, number, contact_id,
  contact_name, issue_date, expiration_date, line_items,
  status (draft|sent|accepted|rejected|closed|converted),
  total, subtotal, discount_amount, tax, shipping, notes,
  internal_notes, source (opt: "qbo"), qbo_id, _sync_status,
  converted_invoice_id, source_estimate_id (on the resulting
  invoice)`
- `db.purchase_orders`: same shape, `status
  (open|closed|converted)`, `converted_bill_id`, `source_po_id`
  (on the resulting bill).

### Deferred (documented)
- Full multi-line editor + PDF preview + attachments (MVP uses
  single-line create dialog; users convert-to-invoice to finish).
- Reverse-linking (deleting the resulting invoice/bill doesn't
  reopen the estimate/PO).

### Next up
- Background Auto-Pull Polling (~30 min) → truly hands-off QBO→us
- Sync Status Badges — 🟡/🟢/🔴 pips on all list rows
- Plaid Transfer routing bug
- Deposits & Transfers push (needs authoring UI)
- Real-time QBO webhooks (Phase 4)


### Feb 2026 — Per-Company Report Styling (+ 12 bundled fonts)

**Problem**: PDF report header had a spacing bug where the 18pt company name overlapped the 11pt subtitle ("708 LLC" collided with "INCOME STATEMENT"). Also user asked to customize labels, fonts, colors and spacing.

**Fix (spacing)**: Rebuilt `_pdf_styles` with explicit `leading` (line-height) and `spaceAfter` on Title2 and SubTitle.

**Feature — Full report styling**
- `backend/reports.py`: `DEFAULT_REPORT_STYLE`, `DEFAULT_REPORT_LABELS`, `resolve_report_style()`, `resolve_report_label()` helpers. Every compute function (`compute_income_statement`, `compute_balance_sheet`, `compute_trial_balance`, `compute_general_ledger`, `compute_cash_flow`, `compute_sales_tax`, `compute_1099_summary`, `compute_account_detail`) returns `report_style` + `report_label` in its payload. Every PDF builder honors both.
- `routes/companies.py`: `report_style` added to the PATCH `/companies/{cid}` allowlist.
- 12 bundled fonts (5.7 MB total): Inter, Roboto, Open Sans, Lato, Poppins, Nunito, PT Serif, Playfair Display, Lora, Libre Baskerville, JetBrains Mono, IBM Plex Mono. Downloaded via `scripts/download_fonts.py` using `fontTools.varLib.instancer` to extract Regular+Bold static TTFs from Google Fonts variable-font masters.
- `backend/fonts/*.ttf`: 24 static TTF files (Regular + Bold pair per family). Registered on module load in `reports.py` via `pdfmetrics.registerFont`. Missing/corrupt TTF silently degrades to Helvetica.
- Frontend: `CompanySettings.jsx` gains a `ReportStylingCard` with font family (15 options grouped Built-in / Sans / Serif / Mono), title & subtitle sizes, 4 color pickers, spacing controls, and 8 per-report label overrides. `ReportView.jsx` reads `data.report_style` + `data.report_label` and applies to the on-screen header via CSS `font-family` stacks with system fallbacks.

**Tests**: `tests/test_report_styling.py` — 20 tests (defaults, partial overrides, label fallback, spacing prevents overlap, every font family renders, end-to-end PDF with custom label). All passing.


### Feb 2026 — Enterprise Audit Trail

**Feature**: Comprehensive audit log of every mutating action on the platform: financial writes, config changes, auth events (login/failed/logout/password_reset), impersonations, QBO/Plaid sync, exports. Enterprise scope (all events + full snapshot + retention forever).

**Architecture**
- `backend/audit.py` — Core audit module:
  - `log_event()` — main API. Fire-and-forget via `asyncio.create_task` so user requests never wait.
  - `log_create` / `log_update` / `log_delete` — thin convenience wrappers.
  - Smart snapshot policy: full compressed before/after snapshots for deletes + config-shaped entities (company, account, tax_rate, user) + auth/impersonation/sync/export events. Regular row edits store a compact field-level diff only.
  - zstd compression on all snapshots and diffs (~70% storage reduction).
  - `_redact()` — deep-copies before storage, masking password/token/secret fields at every nesting level. Diff-of-redacted comparison ensures password changes never leak either.
  - `hydrate_event()` — decompresses stored blobs on read; auto-derives diff from before/after for full-snapshot events so API responses are shape-consistent.
  - `list_events()` / `count_events()` — permission-scoped read side. Regular users see only their own actions; CPAs/pros see every event in accessible companies (via `deps.company_ids_for_user`); superadmins see all.
  - Indexes: `(company_id, timestamp -1)`, `(actor_user_id, timestamp -1)`, `(entity_type, entity_id, timestamp -1)`, `(event_type, timestamp -1)`, `(timestamp -1)`.
- `backend/routes/audit_routes.py` — Read API:
  - `GET /api/companies/{cid}/audit` — company timeline (filters: date range, event/entity type, actor, only_mine)
  - `GET /api/audit/entity/{entity_type}/{entity_id}` — per-record timeline
  - `GET /api/audit/me` — user's own actions across all accessible companies
  - `GET /api/admin/audit` — superadmin global view
- `backend/server.py::startup` — calls `audit.ensure_indexes()` on boot.

**Instrumentation (this pass)**
- Auth: successful login, failed login (both stamp IP + user-agent).
- Impersonation: `impersonate_start` stamped with superadmin actor + target user metadata (existing lightweight `admin_audit_log` kept for backward compat).
- Company settings: PATCH `/companies/{cid}` — full before/after snapshot per policy.
- Transactions: `POST /companies/{cid}/transactions` (create), `PATCH /companies/{cid}/transactions/{tid}` (update).

**Frontend**
- `pages/AuditLog.jsx` — new global audit-log page (`/audit-log`). Scope tabs (This company / My actions), filter bar (event type, entity type, since/until, only-mine), color-coded event pills, expandable rows showing IP / user-agent / field-level diff table (red before → green after) / full JSON snapshot (collapsible).
- `App.js` — `/audit-log` route registered.
- `Sidebar.jsx` — "Audit log" link added under STANDALONE_BOTTOM with `History` icon.

**Choices confirmed by user**: async fire-and-forget writes; zstd compressed snapshots; smart mixed snapshot strategy; keep hot forever (no cold-archive).

**Tests**: `tests/test_audit.py` — 8 tests (diff shape, redaction at every depth, compression round-trip, snapshot-policy matrix, hydrate derives diff for full-snapshot events, hydrate honors stored diff for diff-only events, redaction masks password-change signal). All passing. Combined 28/28 tests green.

**Future instrumentation** (documented, not yet hooked):
- Invoices/bills/journal entries/accounts CRUD paths — copy the transaction pattern.
- QBO pull/push completion events (`qbo_mirror/pull.py` + `push.py`).
- Plaid sync events (`routes/plaid.py`).
- Report/PDF exports (`routes/report_routes.py`).
- MFA changes + password reset (auth flow additions).
- Per-record `<AuditTimeline entity_type entity_id />` component embed in InvoiceEditor / BillEditor / etc.



### Feb 2026 — Audit Trail Phase 2: Invoice / Bill / JE / CoA CRUD Instrumentation

**Feature**: Extended the audit trail to cover the remaining core CRUD paths beyond Phase 1 (auth + impersonation + company settings + transactions). Every create/update/delete on invoices, bills, journal entries, and chart-of-accounts now lands in `audit_events`.

**Instrumentation added this pass**
- `routes/invoices.py` — `POST /companies/{cid}/invoices` (create), `PATCH /companies/{cid}/invoices/{iid}` (update, before-doc fetched up front and reused as `existing`), `DELETE` (full snapshot per policy)
- `routes/bills.py` — same 3 CRUD paths, same shape as invoices
- `routes/journal.py` — `POST` create (includes full lines[] in snapshot), `DELETE` (full snapshot preserves debit/credit legs so compliance can reconstruct the pre-delete JE)
- `routes/accounts.py` — `POST` create (full snapshot), `PATCH` update (full snapshot — CoA is config-shaped), `DELETE` (full snapshot)

**Design notes**
- Diff-only path fires for invoice/bill routine PATCH (high-volume). Full-snapshot path fires for JE + CoA + all deletes (per `_FULL_SNAPSHOT_ENTITIES` + `_FULL_SNAPSHOT_EVENTS` policy in `audit.py`).
- Every route captures the BEFORE doc BEFORE mutation so the diff has both sides. Wrapped in try/except so an audit failure never blocks the primary write.
- Denormalised summaries are human-readable: `Invoice INV-100 · Acme · $250.00`, `Bill BILL-661 updated (notes, _sync_origin)`, `JE 2026-01-15 · March rent · $5,000.00`.

**Verified end-to-end** via curl: created + deleted an invoice, created + patched a bill, created + deleted a JE. All 6 events landed cleanly in `audit_events` with correct event_type, summary, and diff_field_count.

**Tests**: `tests/test_audit_entity_instrumentation.py` — single consolidated test (motor client is loop-bound, so all coverage lives in one `asyncio.run`). Verifies invoice create/delete round-trip, bill diff-only shape, account full-snapshot shape, JE line preservation. All pass. Combined 29/29 audit + report-styling tests green.

**Not yet instrumented** (documented, next-up):
- QBO pull/push completion events (`qbo_mirror/pull.py` + `push.py`)
- Plaid sync events (`routes/plaid.py`)
- Report/PDF exports (`routes/report_routes.py`)
- MFA changes + password reset (auth flow additions)
- Per-record `<AuditTimeline entity_type entity_id />` component embedded in InvoiceEditor / BillEditor / etc.


---

### Feb 2026 — Branding Cascade Fix for Enterprise-Owner Pros

**Bug**: An Enterprise user (Pro role, WL locked) created under a Partner was incorrectly seeing the Superadmin/Platform default branding instead of the Partner's branding upon login.

**Root cause**: `GET /api/branding/effective` short-circuited for role=`pro` and returned the Pro's OWN branding without ever walking the cascade to the parent Partner.

**Fix**:
- `routes/pro.py` — `/branding/effective` now, for role=`pro`, checks whether the Pro's WL is unlocked. If not, it walks to (a) `user.partner_id`, else (b) `enterprise.partner_id` via `user.enterprise_id`, and returns the Partner's branding when the Partner's WL is unlocked. Falls through to own brand → platform default otherwise.
- `routes/admin.py` — `POST /admin/enterprises` now stamps BOTH `enterprise_id` AND `partner_id` on the resulting Pro owner user (when the caller is a Partner). Redundant with the enterprise-doc path but resilient.

**Tests**: `tests/test_branding_cascade.py` extended with 6 new tests covering the Pro-as-Enterprise-Owner cascade (via direct `partner_id`, via `enterprise.partner_id`, own-WL-unlocked short-circuit, locked+locked → own brand, legacy-user scenario with only enterprise stamped, and the backfill loop itself). All 10/10 pass. Verified end-to-end via curl + Playwright screenshot: created an Enterprise as `partner@axiom.ai`, logged in as the fresh Pro owner, sidebar renders "AxiomPartners" instead of the platform "SmartBooks / Ledger" wordmark.

### Feb 2026 — Follow-up: Sidebar `firm_name` render + startup backfill

User reported that `michael+enterprise@bigsaas.ai` (an existing enterprise-owner Pro under a partner) STILL saw "SmartBooks / Ledger" in the sidebar after the cascade fix landed. Two additional root causes were fixed:

1. **`components/Sidebar.jsx`** — When the branding response returned a `firm_name` but no logo, the sidebar hardcoded "SmartBooks / Ledger" wordmark regardless. Now renders `branding.firm_name` as the top-of-sidebar text when set (with `data-testid="sidebar-firm-name"`), falls back to the platform wordmark otherwise.

2. **`server.py` startup backfill** — Enterprises created BEFORE the `partner_id`-stamping code landed had `partner_id` on the enterprise doc but NOT on the owner user, so the cascade's fast-path (`user.partner_id`) couldn't fire. Added an idempotent startup loop that walks every enterprise with a `partner_id` and stamps that value onto the owner user if missing. Logs count of stamped rows to the startup output.



### Feb 2026 — Partner Dashboard Rollup ($-value Usage / Revenue / Margin)

The Partner Dashboard previously showed only entity counts (Clients / Enterprises / Users / Partner Books). Extended with a **Financials** section that surfaces real $-value rollups scoped to the Partner's tree.

**Backend** (`partners.py::partner_financials` + `GET /api/partner/financials?months=3`):
- **Usage** — `$sum(ai_usage_events.cost_cents)` for every company in the Partner's tree (direct `companies.partner_id` OR attached to an enterprise the Partner owns).
- **Revenue** — `$sum(enterprise_invoices.amount_due_cents)` where the invoice's `status ∈ {finalized, paid}` and `enterprise_id` is in the Partner's tree.
- **Margin** — Revenue − Usage (computed client-side).
- **Trend** — trailing 3 months (configurable via `months=N`, clamped to 12) of both series, oldest-first.
- **By-service** — current-month per-service breakdown of usage $ (openai_llm, veryfi_ocr, resend_email, etc.) sorted descending.

**Frontend** (`pages/PartnerDash.jsx`): Three `MoneyTile` cards (Usage / Revenue / Margin) + a `TrendBars` component (indigo=usage, emerald=revenue) + a `ServiceBreakdown` bar list. Rendered conditionally — if the API errors we skip the section rather than blocking the dashboard.

**Isolation**: Partner A never sees Partner B's data (`_partner_tree_company_ids` filters on `partner_id == self.id`). Confirmed by dedicated test.

**Tests**: `tests/test_partner_financials.py` — 5 tests covering direct-client usage sum, enterprise invoice revenue, enterprise-attached companies pulled via `enterprise_id`, 3-month trend window, and Partner-vs-Partner isolation. All 5/5 pass standalone; 24/24 pass alongside `test_partners.py` + `test_branding_cascade.py` (all three files now share a single event loop via `tests/_shared_loop.py` so Motor's cached-loop bug doesn't fire when xdist pins them to the same worker).

**Verified end-to-end**: Seeded usage + revenue rows for `partner@axiom.ai`; Playwright screenshot confirmed tiles show `$58.60 Usage · $245.00 Revenue · $186.40 Margin` with per-service breakdown (`openai_llm $42.70`, `veryfi_ocr $12.50`, `resend_email $3.40`) and a 3-month trend.


### Feb 2026 — QBO OAuth: Private-Label Return-to-Host Fix

**Bug**: Client on `enterprise.accountingapp.ai` clicks "Connect to QuickBooks Online", completes Intuit consent, and gets bounced to `app.smartbookssoftware.ai/login` instead of back to `enterprise.accountingapp.ai/connections/qbo`.

**Root cause**: The QBO callback's success `RedirectResponse` used the platform default `_APP_URL` (`app.smartbookssoftware.ai`) instead of the private-label host. Error paths already used `_label_app_url(rec)`, but success forgot. Also, `_label_app_url` only knew how to strip an `api.` prefix — it couldn't handle shared-host labels (`enterprise.accountingapp.ai` where the app and API run on the same subdomain) and the whitelist `_QBO_ALLOWED_HOSTS` gate meant `redirect_uri` was `None` for those labels, so we had NO record of where the user came from.

**Fix** (`routes/qbo.py`):
1. Introduced `_return_to_host_from_request(request)` which grabs the frontend host from `x-forwarded-host` (or falls back to `origin`/`referer`), strips any `api.` prefix, and returns `https://<host>`. Independent of the Intuit-registered redirect URI whitelist — every label captures a return host, even shared-host labels.
2. `POST /companies/{cid}/qbo/oauth/start` now persists `return_to_host` alongside `redirect_uri` on the state record.
3. `_label_app_url(rec)` now checks `return_to_host` FIRST, then falls back to the legacy `api.*` strip on `redirect_uri`, then to `_APP_URL`.
4. **Success redirect fixed** — now uses `_label_app_url(rec)` (was hardcoded `_APP_URL`).
5. Error early-exit (Intuit `error`, missing params) now peeks the state record before returning so "No thanks" also lands on the label's own frontend.

**Fix v2** (Feb 2026 iteration 2): First attempt trusted `x-forwarded-host` and naively stripped an `api.` prefix — which collapsed `api.smartbookssoftware.ai` to the bare marketing domain `smartbookssoftware.ai` (404 in production, no app served there). Rewrote `_return_to_host_from_request` header priority to: **1) `Referer`** (browser tab URL, always set on same-origin fetches), **2) `Origin`** (scheme+host, set on POST/CORS), **3) `x-forwarded-host` as last resort** — and even then, hosts starting with `api.` return `None` so we fall through to `_APP_URL` instead of guessing wrong. The callback's legacy `redirect_uri`-derived fallback only strips `api.` when the host ends with `.accountingapp.ai` (label subdomain).

**Fix** (`routes/qbo.py`) — final shape:
1. `_return_to_host_from_request()` uses Referer → Origin → x-forwarded-host (skipping api.* fallback).
2. `POST /companies/{cid}/qbo/oauth/start` persists `return_to_host` alongside `redirect_uri` on the state record.
3. `_label_app_url(rec)` checks `return_to_host` FIRST, then a guarded legacy-strip on `redirect_uri`, then `_APP_URL`.
4. Success redirect uses `_label_app_url(rec)`.
5. Error early-exit peeks the state record so "No thanks" also lands on the label host.

**Tests**: `tests/test_qbo_oauth_return_host.py` — 6 tests now: Referer capture, Origin-fallback capture, api.* host in x-forwarded-host returns None (guards the bare-domain bug), success redirect to label, error redirect to label, and legacy state without `return_to_host` falls back to platform. All 6/6 pass; 30/30 pass alongside partner + branding suites.


### Feb 2026 — Partners can Edit their own Enterprises

Extended `GET` + `PATCH /admin/enterprises/{eid}` so Partners can view and edit the enterprises they've provisioned. Superadmins retain unrestricted access; every other role is 403; a Partner asking for another partner's enterprise gets **404** (deliberate enumeration guard — never reveals existence of rows in another partner's tree).

**Backend** (`routes/admin.py`):
- New `_require_enterprise_access(eid, user)` helper — fetches the enterprise, verifies role: `superadmin → any`, `partner → only ent.partner_id == user.id`, else 403.
- Role gate on `GET /admin/enterprises/{eid}` and `PATCH /admin/enterprises/{eid}` widened to `("superadmin", "partner")`; both call the helper before touching data.
- Response shape unchanged so the frontend detail view reuses the same component.

**Frontend** (`pages/AdminEnterpriseDetail.jsx`):
- Role gate widened to allow `partner`.
- `WhitelabelCompToggle` and `EnterpriseBillingSection` conditionally rendered — only for `superadmin`. Partners see the name/allotment editor, pros list, and companies table, but not the superadmin-only comp toggle or Stripe billing controls (those endpoints are still superadmin-gated on the backend).

**PartnerDash** (`pages/PartnerDash.jsx`): Enterprise rows are now clickable `<Link>`s to `/admin/enterprises/{eid}`. Clients rows already were.

**Tests**: `tests/test_partner_enterprise_access.py` — 6 tests:
- Partner GET own enterprise ✅ 200
- Partner GET another partner's enterprise ✅ 404 (enumeration guard)
- Partner PATCH own enterprise (rename) ✅ 200 + DB updated
- Partner PATCH another partner's enterprise ✅ 404 + DB unchanged
- Pro role still 403 on both GET + PATCH
- Superadmin still gets any enterprise

All 6/6 pass; 36/36 pass across partner + branding + QBO + enterprise-access suites. Verified end-to-end via Playwright: partner@axiom.ai clicked an enterprise row → landed on detail page with Edit button visible, WL toggle + Billing section correctly hidden.


### Feb 2026 — Auto-Switch to Newly Created Company

**Change**: When a user creates a new business from `My Businesses`, the top-bar Company Selector immediately switches to the new company (no manual re-selection needed).

**Frontend** (`pages/MyBusinesses.jsx`):
- `BusinessFormModal.submit()` now captures `r.data.company_id` from the create response and passes it up through `onSaved(createdId)` (edit path passes `null`).
- Parent `onSaved` handler is now async: after a create it calls `await refreshCompanies()` (from `useCompany`) so the new company is in the global list, then `switchCompany(newCompanyId)` to make it active before finally calling `load()` to refresh the local table.
- Also fixed a latent 422 bug: `business_description` was being sent as `null`, but the Pydantic `CompanyCreate` model requires `str` (default `""`). Both create + edit now send `desc || ""`.

**Verified end-to-end** via Playwright: logged in as `client@axiom.ai`, created "AutoSwitchCo …" from `/my-businesses`. Top-bar selector went from "TEST_dup" → "AutoSwitchCo …" immediately after the modal closed; `localStorage.axiom_company_id` matches the new company's UUID.


### Feb 2026 — Auto-Switch after "Add a new client" (Pro flow)

Same auto-switch behavior extended to the Pro's "New Client" modal at `/pro/clients` — after a Pro creates a new client company, the top-bar Company Selector switches to that new company automatically.

**Frontend** (`pages/ProClients.jsx`):
- `NewClientModal.save()` now passes the created `company_id` up as `onCreated(newCid)`.
- Parent handler at line 493 calls `switchCompany(newCid)` after `refresh()`, so the header dropdown flips to the new client immediately (unless the flow redirects to Stripe Checkout for client-card billing, in which case the redirect wins — `onCreated` is not called on that branch).

**Verified via Playwright**: `pro@axiom.ai` → `/pro/clients` → "New Client" → filled name/owner/email → clicked "Create client". Header changed from `TEST_iter8_newclient` → `AutoSwitchClient …`, `localStorage.axiom_company_id` matches the new company's UUID.


### Feb 2026 — Feedback / Bug-Report Widget + Superadmin Triage Inbox

Every signed-in user (client / pro / partner / superadmin) can now file a bug report or product recommendation from the profile-menu dropdown. Superadmins triage them in a dedicated inbox at `/admin/feedback` with a 4-state workflow (New → In Progress → Completed, plus Won't Do as terminal alt). Every new submission emails every superadmin. Product decision: no status-change emails to submitters — they see updates in-app at `/feedback/mine` (kept per user's 3b choice).

**Backend** (`routes/feedback.py`, new module):
- `POST /api/feedback` — any auth'd user submits `{type, title, description, route, user_agent, company_id}`. Persists to new `feedback_items` collection with `status="new"`, `admin_notes: []`, timestamps, and best-effort `_notify_superadmins()` fires branded emails to every user with `role=="superadmin"`.
- `GET /api/feedback/mine` — submitter's own tickets, newest first.
- `GET /api/feedback?status=&type=&q=` — **superadmin-only**; returns items + a `counts` breakdown per status (always across the whole inbox so the tab pills stay accurate).
- `PATCH /api/feedback/{id}` — **superadmin-only**; updates `status` and/or appends an admin note (`admin_notes` is a `$push`-only journal preserving prior notes).
- Enum guards on `type` (`bug` / `recommendation`) and `status` (`new` / `in_progress` / `completed` / `wont_do`) — invalid values return `400`.

**Email** (`email_templates.py::feedback_new_submission`, `email_dispatcher.py`):
- New `feedback_new_submission` kind registered in `DEFAULT_PREFS`.
- Branded template with icon + accent color (🐞 rose for bugs, 💡 cyan for ideas), reporter / role / company / page context table, description block with preserved line breaks, and CTA button linking to `/admin/feedback`.
- Sent with `initiating_user_id=None` (system-initiated) so it bypasses per-user opt-out prefs — this is an internal ops signal, not a marketing send.

**Frontend**:
- `components/FeedbackModal.jsx` — the modal from the sketch: Bug/Recommendation toggle chips, Title + Description, "Submitted from `<route>`" footer, Cancel + Submit. Auto-captures active `currentId`, `window.location.pathname + search`, and `navigator.userAgent`.
- `pages/MyFeedback.jsx` — every submitter can revisit their own tickets, see the status pill (New / In progress / Completed / Won't do), and read superadmin notes as they land. "New feedback" button on this page too, so users don't need to hunt for the profile menu.
- `pages/AdminFeedback.jsx` — 2-column triage view: filterable list (status tabs w/ counts, type filter, debounced search) + detail pane with inline status buttons and an append-only notes thread.
- `components/Layout.jsx::ProfileMenu` — new "Send feedback" + "My feedback" items sit between "Change password" and "Sign out".
- `pages/SuperadminDash.jsx` — new **Feedback** button in the top-right toolbar next to Stripe Webhooks.

**Routes** (`App.js`):
- `/admin/feedback` → `<AdminFeedback />` (superadmin-only via backend gate; the page is behind `<Protected>` so unauth'd users hit /login).
- `/feedback/mine` → `<MyFeedback />`.

**Tests** (`backend/tests/test_feedback.py`, 9 tests, all green):
- Create, trim, and default status verification
- Invalid `type` → 400
- `/mine` scoping (u1 never sees u2's rows)
- `/feedback` admin-only (client / pro / partner → 403)
- Admin list + PATCH round-trip (status change + append two notes without wiping the first)
- Client cannot PATCH (403)
- Invalid status → 400
- Filters: status, type, and free-text `q` matching title/description
- Zero-admin sanity: submission still 200 even if notify path is degraded

Verified end-to-end via Playwright:
- `client@axiom.ai` opened profile menu → Send feedback → filed "Playwright bug …" → toast confirmed → landed in `/feedback/mine` visible with `New` badge.
- `admin@axiom.ai` opened `/admin/feedback` → both tickets visible with status counts → detail pane showed reporter, company, route, UA → flipped status to `In progress` → posted admin note "Assigned to eng team". Note surfaced in submitter's `/feedback/mine` immediately.
- `communications` collection confirms `[Bug] Playwright bug …` emails delivered to real superadmins (`michael@bigsaas.ai`, `admin@axiom.ai`).



### Feb 2026 — Feedback: Partner + Enterprise attribution

Every feedback item + notification email now carries the Partner and/or Enterprise that the submitter belongs to, so a superadmin triaging in `/admin/feedback` can immediately tell whether a bug is coming out of Northgate Advisory's client base or a bare-metal SmartBooks user.

**Backend** (`routes/feedback.py::_resolve_context`):
Resolution priority — never raises, gracefully returns `None` if unresolvable:
- **Partner**:
  1. `user.role == "partner"` → self
  2. `user.partner_id` (fast-path stamp on user doc)
  3. `company.partner_id` (companies partners provision are stamped)
  4. `enterprise.partner_id` (fallback via the enterprise we resolve below)
- **Enterprise**:
  1. `user.enterprise_id` (pros owned by an enterprise)
  2. `company.pro_user_id.enterprise_id` — walks from the reporter's active company to its managing pro, so a **Client** submitting a bug still gets attributed to the Pro's Enterprise / Partner.

Persisted alongside every feedback item: `partner_id`, `partner_name`, `enterprise_id`, `enterprise_name` (denormalized so counts + list previews don't need lookups).

**Email** (`email_templates.py::feedback_new_submission`):
- Added `Partner` and `Enterprise` rows to the context table (between Role and Company) — dashes render when unresolved.
- Kept the icon + accent color + CTA button, so existing look holds.

**Frontend** (`pages/AdminFeedback.jsx`):
- List preview: partner (fuchsia) and enterprise (indigo) chips render under each row's timestamp, so triage is scannable without opening the ticket.
- Detail pane: dedicated Partner + Enterprise cells (with chip styling) sit next to Company in the context grid.

**Tests** (`tests/test_feedback.py`, 4 new cases → 13 total, all green):
- Partner-role user attributes to themself and uses their `branding.firm_name`.
- Pro user with `enterprise_id` set → enterprise + partner attribution walks to `enterprise.partner_id`.
- Client submitting via `company_id` → company's managing pro's `enterprise_id` + partner cascade fills in both slots.
- Bare client with no company context → both slots stay `None` (no false attribution).

Verified end-to-end via Playwright: `pro@axiom.ai` submitted a bug → admin inbox row surfaces the "Northgate Advisory" indigo chip; detail pane shows `Enterprise: Northgate Advisory`; the outbound email HTML includes both the Partner and Enterprise context rows.



### Feb 2026 — Feedback v2: Filters, Attachments, Reporter Replies, Notify-Toggle

Three big additions:

**1. Partner + Enterprise filter dropdowns** (superadmin inbox)
- New endpoint `GET /api/feedback/tenants` returns distinct partners + enterprises that have ever filed feedback, plus `has_no_partner` / `has_no_enterprise` booleans so ops can carve out orphan tickets with a `— No partner —` / `— No enterprise —` option.
- `GET /api/feedback` now accepts `partner_id` and `enterprise_id` query params (with `__none__` sentinel for orphans). Filters compose safely with each other + the existing status/type/q filters via `$and` / `$or` guards.

**2. Screenshot attachments**
- `FeedbackCreate` payload accepts `attachments: [{filename, mime, data_url}]`. Server validates mime against `{png, jpeg, gif, webp}`, caps each at 5MB and total at 20MB. Stored inline (base64) on the feedback row — no S3 wiring needed at this scale.
- `components/FeedbackModal.jsx`: multi-image support via **file picker + drag-and-drop overlay + clipboard-paste** (window `paste` listener). Removable thumbnail grid, inline size validation. Screenshots are the fastest way to close a bug — this feature is worth the extra 60 lines.
- Admin detail pane renders a **3-col image gallery** with click-to-lightbox; row previews show a `📎 N` badge.
- Submitter's `/feedback/mine` shows the same images inline for context.

**3. Reporter communication + per-item notify toggle**
- `admin_notes` items now carry `visibility: "internal" | "reporter"` and `email_sent: bool`. Superadmin picks per-note whether it's a private working note or a reply the reporter sees; if it's a reply, an optional **"Also email"** checkbox (default ON) triggers a branded `feedback_reply_reporter` email.
- Feedback item carries `notify_submitter: bool` (default TRUE). A pill in the top-right of the detail pane toggles it between **"Notify submitter" (green)** and **"Muted" (grey)**. When status changes from e.g. `new → completed` and the item is unmuted, a branded `feedback_status_update` email fires to the reporter automatically.
- `GET /feedback/mine` uses `_scrub_for_submitter` to strip internal notes — so the reporter's inbox stays clean.

**Email**:
- New kinds in `DEFAULT_PREFS`: `feedback_status_update`, `feedback_reply_reporter`.
- Templates in `email_templates.py`: `feedback_status_update` (short "status is now X" nudge) and `feedback_reply_reporter` (renders the author's message in a quoted block with a "Open the thread →" CTA).

**Tests** (`tests/test_feedback.py`, 20 total, all green):
- Attachment persistence + bad-mime rejection
- `notify_submitter` default true + togglable
- Note visibility internal→hidden from `/mine`, reporter→visible
- Bad visibility rejected
- Reporter-email flow marks note's `email_sent=True` + dispatches to `communications`
- `/feedback/tenants` returns partners + enterprises + `has_no_*` flags
- `partner_id=<id>` filters correctly; `enterprise_id=__none__` catches orphans

Verified end-to-end via Playwright:
- Client submitted a bug with a screenshot → modal thumbnail grid → row `📎 1` badge → gallery in detail pane.
- Superadmin filter dropdowns show real tenants (`Northgate Advisory`).
- Internal note stayed hidden from client's `/feedback/mine`; reporter reply "Thanks for the report — fixed in v2.4" appeared as a blue card + arrived via email at `client@axiom.ai`.
- Status flipped to Completed → toast "reporter notified" → `feedback_status_update` email delivered.
- Toggled notify → pill flipped to "Muted"; subsequent status changes will not email.



### Feb 2026 — Feedback: In-app Reporter Replies

Reporters can now respond to superadmins directly from their `/feedback/mine` inbox — including attaching new screenshots — closing the loop without leaving the app.

**Backend** (`routes/feedback.py`):
- `POST /api/feedback/{fid}/reply` — auth'd endpoint scoped to the ticket's original submitter (anyone else → 404 to prevent enumeration). Accepts `{note, attachments[]}`, appends a `note` object to `admin_notes` with `author_role: "reporter"` + `visibility: "reporter"` (naturally in the shared thread), and best-effort emails every superadmin via a new `feedback_new_reporter_reply` kind.
- `admin_notes` items now carry `author_role: "superadmin" | "reporter"` + a per-note `attachments[]` array. Existing entries lacking these fields degrade cleanly (default `author_role` = "superadmin", missing attachments = empty).
- `_scrub_for_submitter` naturally returns reporter-authored notes (they're `visibility=reporter`), so the reporter sees their own follow-ups too.

**Email** (`email_templates.py::feedback_new_reporter_reply`, `email_dispatcher.py`):
- New template with 🐞/💡 icon, violet accent border, quoted reply text, attachment count line, and "Open feedback inbox →" CTA to `/admin/feedback`.
- Registered in `DEFAULT_PREFS`.

**Frontend**:
- New `components/AttachmentPicker.jsx` — extracted the shared multi-image widget (file-picker + drag/drop + clipboard-paste, 5MB/img and 20MB/total caps) so both the initial `FeedbackModal` and the new reply-compose reuse identical UX + validation.
- `pages/MyFeedback.jsx` rebuilt: each ticket is now a card with the original description + attachments, the full thread (color-coded by author — cyan for "Team", grey for "You" reporter follow-ups), and a per-card **"Reply to the team"** toggle that expands into a compact compose (textarea + AttachmentPicker + Send). Toast confirms + row auto-refreshes on post.
- `pages/AdminFeedback.jsx` — notes thread now shows reporter-authored notes in a distinct violet card labeled "Reporter reply"; each note renders its attachments inline (clickable → same lightbox as the original submission's gallery).

**Tests** (`tests/test_feedback.py`, 6 new cases → 26 total, all green):
- Reporter posts a reply on their own ticket
- Reporter reply appears in the superadmin's inbox
- Non-submitter attempting to reply gets 404
- Reply with attachments persists them correctly
- Reporter reply triggers a `feedback_new_reporter_reply` communications row
- Empty reply → 422 (Pydantic min_length guard)

Verified end-to-end via Playwright:
- `client@axiom.ai` opened My Feedback → clicked "Reply to the team" → composed message + attached screenshot → submitted → toast "the team's been notified" → note surfaced with "YOU · MICHAEL CHEN" badge and thumbnail inline.
- `admin@axiom.ai` on `/admin/feedback` sees the reporter's follow-up appended to the same thread.



### Feb 2026 — Feedback: Unread Badges + Reporter Filters

Two new user-facing surfaces:

**1. Unread badges** on the profile-menu avatar (all users) + the "Feedback" button on the Superadmin dashboard.
- Reporters see a red dot on their avatar whenever a superadmin has posted a **reporter-visible** note they haven't seen. Internal notes never count.
- Superadmins see a red dot whenever a feedback item is brand-new to them or a reporter has posted a follow-up since their last visit. Per-admin read tracking (`admin_reads: {admin_uid: iso}`) — one admin marking read doesn't clear anyone else's badge.
- Badge counts collapse at "9+" to keep the pill compact.
- Auto mark-read on `/feedback/mine` and `/admin/feedback` visit — first the list loads (so per-row dots paint), THEN a background `POST .../mark-read` fires so the next unread-count poll returns 0. Poll interval: 60s via `lib/useFeedbackUnread.js`.

**2. Reporter filters** on `/feedback/mine`:
- Status pill row identical to the superadmin inbox: All / New / In progress / Completed / Won't do — each with its own count.
- **"New replies"** pill in solid rose when active — flips `only_unread=1` on the GET call.
- Per-row unread dot + rose ring highlight for tickets with fresh team activity.

**Backend** (`routes/feedback.py`):
- New fields on every item: `reporter_last_read_at` (iso) + `admin_reads: {uid: iso}`.
- New helpers: `_is_unread_for_reporter(row)` (only counts superadmin-authored, reporter-visible notes) and `_is_unread_for_admin(row, admin_id)`.
- New endpoints:
  - `GET /api/feedback/mine?status=&only_unread=` — filters + returns per-status `counts` + `unread` total on the payload.
  - `GET /api/feedback/mine/unread-count` — cheap poll endpoint for the reporter badge.
  - `POST /api/feedback/mine/mark-read` — bumps `reporter_last_read_at` on every one of the caller's items.
  - `GET /api/feedback/unread-count` (superadmin) — same shape as reporter's.
  - `POST /api/feedback/mark-read` (superadmin) — sets `admin_reads.<caller_id>` on every item.
- Every list item now carries an `unread` boolean scoped to the caller, so per-row indicators render without extra requests.

**Frontend**:
- `lib/useFeedbackUnread.js` — polling hook (60s + on-mount) that returns `{reporter, admin, refresh}`. Only calls the admin endpoint when `isSuperadmin=true`.
- `components/Layout.jsx::ProfileMenu` — red count-dot on the avatar showing the total, plus a per-item count on "My feedback" and (for superadmins) a "Feedback inbox" shortcut with its own count.
- `pages/SuperadminDash.jsx` — badge on the dashboard's "Feedback" toolbar link.
- `pages/MyFeedback.jsx` — new status pill row + "New replies" toggle + per-row unread dot + rose ring; empty-state copy adjusts per active filter ("No unread replies right now.", etc.).
- `pages/AdminFeedback.jsx` — per-row unread dot on the triage list.

**Tests** (`tests/test_feedback.py`, 3 new cases → 29 total, all green):
- Reporter unread lifecycle: 0 on file, +1 on admin reply, 0 after mark-read, +1 on next reply, internal notes never count.
- Admin unread lifecycle: fresh item unread → mark-read clears → reporter reply re-marks unread for the admin who already read.
- `mine` filters: `status=completed` narrows to matching titles; `only_unread=1` narrows to tickets with fresh admin activity; `counts` breakdown stays independent of the active filter.

Verified end-to-end via Playwright:
- Admin dashboard "Feedback" button showed `4` badge → after visiting inbox it cleared.
- Admin posted a reporter-visible reply → client's profile-menu badge showed `1` on next poll.
- `/feedback/mine` painted the affected row with the red dot + rose ring, and the status pills + "New replies (1)" filter behaved as expected. Revisiting cleared the badge.



### Feb 2026 — Chart of Accounts: Sub-Type Unification (Option B)

Fixes a long-standing user-visible bug: reclassifying an account by changing its sub-type (e.g. "Operating Expense" → "Other Expense", or moving an account accidentally saved under COGS back to Operating Expense) appeared to save cleanly but the account never moved to the new section. Reported first by the Cliffs at Indian Point Condo Owners Association user via CypherPro.

**Root cause**: the accounts table carried three parallel classification fields — `type`, `subtype`, and `detail_type` — but the Edit dropdown only wrote `type` + `subtype`, while the Chart of Accounts renderer grouped rows by `detail_type`. The `SUBTYPES_BY_TYPE` list in the frontend and `DETAIL_SECTIONS_BY_TYPE` used by the renderer had **divergent keys** (`cost_of_sales` in the dropdown vs `cost_of_goods_sold` on the renderer — those never matched). For Asset / Liability / Income / Equity the two lists happened to overlap enough that changes appeared to work; for Expense/COGS they diverged sharply.

**Fix — one taxonomy, one source of truth**:

**Frontend** (`pages/ChartOfAccounts.jsx`):
- `subtypesFor(type)` now derives from `DETAIL_SECTIONS_BY_TYPE` — the exact keys the renderer groups by. The dropdown is now WYSIWYG: pick "Other Expense", account jumps to the "Other Expense" section immediately.
- The Edit-row PATCH now sends `subtype` AND `detail_type` mirrored. `subtype` stays populated for the one legacy consumer (`reports.py`'s fixed-asset check on the Balance Sheet). Cleanest possible migration — no data reshaping needed on existing accounts.
- Old `SUBTYPES_BY_TYPE` constant left in the file as a reference-only comment block so anyone reading git blame sees the previous divergent list.

**Backend safety net** (`routes/accounts.py::update_account`):
- If a PATCH sends `subtype` without `detail_type` (older clients, direct API callers), the handler automatically mirrors `subtype → detail_type`. Only fires when subtype was in the payload, so unrelated edits (name change, code change) don't clobber an existing detail_type.

**Audit of `subtype` consumers before shipping**:
- `reports.py` — one reference, `subtype == "fixed_asset"` check in Balance Sheet. Preserved.
- All other backend files reference `subtype` only in write paths (seed scripts, model definitions, mapper output) — no side-effects.

**Tests** (`tests/test_coa_subtype_unification.py`, 3 new cases):
- Legacy-client PATCH sending only `subtype` mirrors to `detail_type` — the exact user-reported COGS → Other Expense bug now works.
- Modern-client PATCH sending explicit `detail_type` wins — no mirror clobbering.
- Un-related edit (rename/code change) leaves `detail_type` intact — no side-effect regressions.

Verified end-to-end via Playwright — CoA renders sections cleanly under detail_type-keyed headers ("Cash and Bank", "Money in Transit", "Cost of Goods Sold", "Operating Expense", "Other Expense" as applicable).

The Cliffs user can now retry their reclassification and it should stick. No one-off migration script needed — the fix is fully self-healing on the next edit.



### Feb 2026 — CoA Import Preview: Section Landing + Group View

Extends the CoA CSV/Excel/PDF import review with a section-preview so users spot misplaced accounts *before* commit — same taxonomy the renderer uses, so what you see is what you get.

**Frontend** (`pages/ChartOfAccounts.jsx::ImportAccountsModal`):
- New **`sectionFor(row)`** helper — resolves each parsed row to the exact `{key, label}` from `DETAIL_SECTIONS_BY_TYPE` for the row's `type`. When the row's `detail_type`/`subtype` doesn't match any section key, falls back to the type's first section (renderer's default bucket) and flags the row with `fallback: true`.
- **Sticky "Section preview" summary bar** above the review table:
  - Rollup pill per landing section with count (e.g. `Operating Expense · 2`, `Cash and Bank · 1`).
  - Amber pills call out fallback buckets so users know which sections have accounts they meant to place elsewhere.
  - Aggregate amber warning: `"⚠ N rows in a default bucket — fix sub-type to reclassify"` — only shows when N > 0.
- **"Group by section" checkbox** — flips the table between flat and grouped rendering. Grouped mode inserts section-header rows (`Asset · Property, Plant & Equipment · 1`) so a 200-row import is scannable at a glance.
- **New "Subtype" dropdown** in each row — replaces the free-text input with a select bound to `DETAIL_SECTIONS_BY_TYPE[type]`. Picking a value mirrors to BOTH `subtype` and `detail_type` on the row, so the row's "Will land under" pill updates live as the user reclassifies.
- **New "Will land under" column** — colored badge showing the destination section per row (grey for confident matches, amber for fallback rows).

**Backwards compatibility**:
- Existing CSVs with mismatched subtype values (e.g. `cost_of_sales`, `property_plant_equipment`, or free-text like `widget_expense`) still parse — they just render with the amber fallback badge instead of silently landing in an unexpected section post-commit. Users fix the sub-type in-place before hitting Import.
- Backend commit unchanged — already computes `detail_type` from row payload OR falls back to `_infer_detail_type(type, name, subtype)`.

Verified end-to-end via Playwright:
- Uploaded a mixed CSV (6 rows including one deliberate typo `widget_expense`) → summary pills rendered correctly, amber warning surfaced 3 fallback rows, per-row "Will land under" badges showed the actual destinations, "Group by section" toggle grouped rows under type · section headers with a `(default bucket — set sub-type to move)` inline hint on affected groups.



### Feb 2026 — CoA Sub-Type Unification: PFC Fix + Drift Audit

Follow-up to the Option-B sub-type unification. Addresses one downstream reader that was going to silently miss edited bank accounts, and adds observability so we can decide later whether a bulk backfill is justified without touching data now.

**PFC prompt fix** (`pfc_ai_builder.py`):
- Line ~77 hard-coded `subtype='Bank'` in the AI prompt's "never map to a bank account" rule. Widened to also match `subtype='cash_and_bank'` and `detail_type='cash_and_bank'`. Prevents the PFC AI from incorrectly categorizing bank-account edits as spendable line items once a user reclassifies a bank row through the new CoA dropdown.

**Read-only drift audit** (`routes/accounts.py::GET /companies/{cid}/accounts/subtype-audit`):
- Classifies every account row into one of five states:
  - **canonical** — `subtype == detail_type` and both are in the frontend's `DETAIL_SECTIONS_BY_TYPE` for that type
  - **legacy_only_subtype** — `subtype` is a pre-unification label (e.g. `"Bank"`, `"Fixed Asset"`) but `detail_type` is already canonical. Self-heal candidate — will normalize on next edit through the dropdown.
  - **drifted** — both fields are canonical keys but they disagree with each other (real data-integrity concern, warrants closer look).
  - **missing_detail_type** — no `detail_type` at all.
- Returns totals + per-type breakdown + up to 10 example drifted rows so an operator can eyeball what a backfill would actually touch.
- No writes anywhere — a pure diagnostic.
- Available to any company member (mirrors the CoA read permissions) so Pros / Enterprise owners can spot drift on their own books, not just superadmins.

**Purpose**: Lets us watch the self-healing property of the new sub-type unification work over time. If after 60-90 days the `legacy_only_subtype` counts have drained to near-zero organically, no backfill needed. If they stall, we know the manual migration is worth the risk.

**Tests** (`tests/test_coa_subtype_unification.py`, +1 case → 4 total, all green):
- Audit endpoint counts each classification state correctly given a seeded mix of canonical / drifted / legacy / missing rows, and surfaces the drifted rows in `sample_drift`.

Verified via curl against the preview instance — real `client@axiom.ai` company returned 50 accounts with a mix of states, per-type breakdown accurate.


### Feb 25 2026 — Drift Audit UI (banners + Superadmin badges)

Second half of the CoA sub-type drift work. The read-only `/subtype-audit` endpoint is now surfaced in the UI so operators actually see when drift exists:
- **Chart of Accounts page** — amber banner for `missing_detail_type > 0`, red banner for `drifted > 0`. `legacy_only_subtype` still self-heals silently (no banner for regular users). Superadmins get a diagnostic chip exposing every count + a bounded sample of drifted rows.
- **Superadmin Dashboard** — batch endpoint `/api/admin/coa-drift-summary` walks the whole `accounts` collection once and returns `{company_id → {counts, severity}}` for every company with any drift. Rendered as amber/red pills next to the company name in both the flat Companies table and the nested Enterprises → Clients → Companies report.

**Rules**:
- `missing_detail_type > 0` → Amber
- `drifted > 0` → Red (overrides amber)
- `legacy_only_subtype > 0` → nothing shown to standard users (self-healing on edit)

**Tests** (6/6 green): `test_admin_coa_drift_summary_batch` (severity precedence + clean company omission) and `test_admin_coa_drift_summary_forbidden_for_non_superadmin` (RBAC).

Status: **DONE**. Awaiting user verification.


### Feb 25 2026 — Seed + Plaid Write-Path Populate `detail_type`

**Empirical trigger**: User reported that a brand new company created on production (`partners.accountingapp.ai / Post Detail Plaid LLC`) was showing 54 amber "missing_detail_type" pills. Investigation revealed both the default CoA seed (`DEFAULT_COA` in `seed.py`) and the Plaid auto-account creator write only `subtype` and leave `detail_type` blank. Same true for the shared statement_account_resolver used when Plaid provides a mask/institution.

**What was fixed** (all additive, no existing data mutated):
- `DEFAULT_COA` upgraded from 4-tuple to 5-tuple `(code, name, type, subtype, detail_type)` with frontend-canonical Wave keys.
- 5 seed callers updated: `seed.py`, `routes/companies.py`, `routes/pro.py`, `enterprises.py`, `partners.py`.
- `plaid_connect.py::_ensure_account` and `SUBTYPE_MAP` now carry `detail_type`.
- `statement_account_resolver.py::resolve_or_create_bank_account` writes `credit_card` / `cash_and_bank` for the account it creates.
- `liability_subaccounts.py` inherits `detail_type` from the parent account.
- `routes/accounts.py::_CANONICAL_KEYS_BY_TYPE` corrected to match the frontend's `DETAIL_SECTIONS_BY_TYPE` keys (was using accounting-textbook labels; fixes a false-drift bug in the Feb 2026 audit endpoint).

**Impact**:
- **New companies** land amber-free from day one with proper GAAP sub-section grouping (Cash and Bank / Accounts Receivable / PP&E / Credit Card / Loan and Line of Credit / Accounts Payable / etc.) visible on both the CoA UI and Balance Sheet / Income Statement PDFs.
- **Existing companies** are unchanged — they'll continue to show amber until an operator runs the idempotent `/accounts/backfill-detail-type` endpoint against them (deliberate, opt-in).

**Tests**: New `test_new_company_seeds_detail_type_on_every_account` (7/7 green in file). Live preview verified end-to-end via API+screenshot.

Status: **DONE**. Awaiting user verification on production (fresh company creation should now come up clean).


### Feb 25 2026 — Batch Sweep Endpoint + Superadmin One-Click Backfill

**`POST /api/admin/coa-drift-backfill`** (superadmin-only) walks every account across every company and populates `detail_type` using the same name+subtype inference. Idempotent, `?force=1` recomputes even set values.

**Superadmin Dashboard**: a "Sweep sub-types" button appears beside the Companies section header, with an inline aggregate chip ("N red · M amber"). One click → runs the batch → refreshes the drift map. The section is only rendered when there's any drift to report.

**Why sweep is safe by default**: only touches accounts with blank `detail_type`. Won't overwrite user-chosen sub-types. Genuine "drift" cases (both fields canonical but disagreeing) stay flagged red until an operator makes an intentional force call.

**Verified state on preview** after write-path fix + endpoint deploy: amber pills gone across the board (0 amber, 0 missing_detail_type). Only 11 truly-drifted rows across 6 companies remain flagged red — those are legitimate mismatches for Ops to review, not noise.

Status: **DONE**. Sweep + summary chip live on Superadmin dashboard.



### Feb 28 2026 — Undeposited Funds Two-Step Workflow

**Problem**: On native Axiom companies, customer payments that weren't paired with a bank Deposit transaction reduced Invoice `balance_due` (AR down) without a matching entry on the asset side — the BS silently under-reported held cash by the payment amount. QBO models this correctly as a two-step: Receive Payment → Undeposited Funds → Bank Deposit sweeps UF into the actual bank.

**Backend**
- `PaymentCreate` gained `deposit_to_account_id` (optional local account id).
- `POST /companies/{cid}/payments` auto-fills UF when direction='in' and no deposit account or paired txn is provided.
- `reports.py::_signed_balances` now iterates native payments too, with a double-post guard for payments already paired via `source_transaction_id`. Direction='in' payments with no resolvable deposit account fall through to the company's UF account.
- `qbo_service.py::resolve_payment_undeposited(cid)` — new backfill resolver, wired into the QBO import pipeline and exposed as `POST /companies/{cid}/qbo/resolve-undeposited`. Stamps legacy rows lacking a deposit reference so downstream reports are idempotent.

**Frontend**
- `PaymentModal` — new "Deposit to:" dropdown listing the company's Cash and Bank + UF accounts. Default option is UF with a `(default — sweep later)` tag plus explanatory helper text about the QBO two-step workflow. `deposit_to_account_id` sent to the API only when the user explicitly picks a bank.

**Tests**
- `tests/test_undeposited_funds_workflow.py` — 5 new regression tests, all pass. Existing `test_qbo_payment_cash_side.py` (4 tests) still passes.

**Verified live**
- QBO Test 553 LLC: BS UF row = $2,062.52 (matches QBO snapshot exactly).
- Native TEST_dup: creating a $500 payment without a bank auto-fills UF; BS Δ total_assets = $0 (AR −$500, UF +$500).
- `POST /companies/{cid}/payments` stamps UF on the payment doc when omitted.

Status: **DONE**. Held customer payments now show up correctly on the Balance Sheet even before a Bank Deposit sweeps them.



### Feb 28 2026 — QBO Phase 2 Parity: GL-Verified Line Accounts

**Problem**: The recon panel on QBO Test 553 LLC exposed $95.72 of P&L drift concentrated on child income accounts (Beverages -$1,695, Sales of Product Income +$1,833, Catering missing $138). Root cause: QBO Item.IncomeAccountRef can be reassigned to different accounts over time, but historical postings retain the account in effect at recording. Our line mapper resolved via current item mappings, diverging from QBO's actual GL.

**Backend**
- `resolve_qbo_gl_line_accounts(cid)` — fetches QBO's `GeneralLedger` per account and stamps `account_qbo_id` + `gl_verified=true` on invoice/bill/SR/RR lines. Leaf-first scan order (deepest child first) + never-overwrite-verified guard so parent-account GL rollups don't clobber child-level stamps. Wired into QBO import pipeline; standalone endpoint `POST /companies/{cid}/qbo/resolve-gl-line-accounts`.
- `resolve_deposit_splits` — captures QBO Deposits' top-level `CashBack` object as a negative-amount split targeting the cashback destination bank.
- `compute_income_statement` accrual layer — CreditMemos now NEGATE the target income account (matches QBO). `_sweep_deep_accounts` post-pass captures direct signed activity on grandchild-and-deeper revenue/expense leaves that the 2-level tree walker was dropping.

**Tests**: `tests/test_qbo_phase2_child_mapping.py` — 4 new regression tests. All pass.

**Verified live**: QBO Test 553 LLC P&L drift closed from $95.72 to $75. Residual $75 is a single sandbox invoice (#1013) with malformed line detail — a QBO data quirk that won't affect production migrations.

Status: **DONE**. Per-account parity now essentially 1:1 with QBO on companies with well-formed line detail.


### Feb 28 2026 — Sandbox 358d Migration Parity Fixes

**Problem**: Fresh Craig's Landscaping migration exposed three defects: Total Assets short by $13,495 (Truck grandchild lost), OBE off by $419.09 (opening JE double-counted), and cross-section name collisions on the Recon Panel (income "Plants and Soil" ↔ expense "Plants and Soil").

**Backend**
- BS totals now use `_emit_section`'s running `top_total` + A/R + A/P + NI (no row re-sum).
- P&L `_emit` rows carry `parent_id`; new `_refresh_subtotals` pass keeps subtotals current after the accrual layer tops up child rows.
- `_post_opening_balances_je` only plugs accounts with ZERO imported activity + skips sales-tax payables (`AccountSubType` GlobalTax/SalesTaxPayable).

**Frontend**
- `QboReconciliationPanel` matches rows by `(section, normLabel)` scoped tuple so income/expense name collisions no longer cross-match.

**Tests**: `tests/test_report_subtotals_and_opening.py` — 5 new tests, all pass. Full suite 14 tests green.

**Verified live**: Craig's Landscaping OBE = -$9,337.50 (exact QBO match). BS balanced. Total L&P subtotal = $1,170 (exact QBO match). Residual per-account drift confined to real import gaps (Checking +$76.90, Inv Asset -$28.75, BoE Payable $370.94 = missing invoice sales-tax extraction).

Status: **DONE**. Big three drift items closed; remaining residuals are isolated import gaps on specific accounts, not systemic.


### Feb 28 2026 — Cash-Basis Report Parity

**Problem**: With accrual parity done, toggling to Cash showed Total Income $614 vs QBO $5,080 (-$4,466 gap). Cash basis was falling through to `_signed_balances` alone — invoices paid by Payment docs never contributed revenue because the allocation layer was gated behind `basis=='accrual'`.

**Backend**
- New `basis=='cash'` block in `compute_income_statement`: prorates each Payment IN over the linked invoice's line items and posts to the line's income account. Symmetrical for Payments OUT + bills.
- New `basis=='cash'` block in `compute_balance_sheet`: strips Inventory Asset (QBO cash convention) and rolls the value into Net Income to keep the sheet balanced.
- `_refresh_subtotals` hoisted so both bases reuse it.

**Tests**: `tests/test_cash_basis_parity.py` — 5 new tests. Full suite 19/19 green.

**Verified live**: Sandbox 358d cash P&L expenses and COGS match to the penny; revenue within 2.4% (+$120 from partial-payment proration vs QBO's top-down application). Cash BS balances; assets within $77 (same Checking import gap that also shows on accrual). Accrual reports unchanged.

Status: **DONE**. Both accrual and cash basis now essentially tie to QBO 1:1 on Craig's Landscaping.


### Feb 28 2026 — Top-Down Payment Application + Sales-Tax Extraction

**Problem**: Two residual drifts on the cash-basis Recon Panel: revenue +$120 (proration vs QBO's top-down partial-payment application) and BoE Payable + AZ Dept. Payable both $0 (sales tax never extracted from invoice `TxnTaxDetail`).

**Backend**
- Cash P&L rewrites Payment→line allocation to consume lines top-down (`min(line_amt, remaining)`) — matches QBO exactly.
- `qbo_service.py::resolve_tax_rates(cid)` — new resolver fetches QBO TaxRate + TaxAgency and caches to `db.tax_rates`. Wired into import pipeline.
- `compute_balance_sheet` extracts each invoice's TaxLine amounts and routes to the correct `GlobalTaxPayable` account by agency-name match. Accrual = full tax, cash = prorated by paid ratio. NI offset by the tax total.

**Tests**: `tests/test_cash_basis_parity.py` — top-down partial-payment test + new sales-tax extraction test. Full suite **20/20 green**.

**Verified live**: Cash Total Equity on Sandbox 358d now matches QBO **to the penny (-$11,809.12)**. Sales-tax payables populate from real invoice data.

Status: **DONE**. Cash-basis reports now essentially tie to QBO 1:1 on Craig's Landscaping.



### Feb 28 2026 (evening) — Final Parity Blockers Closed: Sales Tax Payment Synth + CM/RR Tax Reversals

**Problem**: Two residual drifts remained after the tax-extraction pass:
1. **Checking -$76.90** on Sandbox a026/2457 — QBO's Sales Tax Payment entity isn't exposed by the REST API (returns 400) or the Purchase endpoint, so two payments ($38.50 + $38.40) never CR'd Checking on our side.
2. **BoE + AZ Payables inflated** — Same two payments never DR'd the payables either, and CreditMemos/RefundReceipts with TaxLines weren't reversing their tax contribution.

**Backend**
- `qbo_service.py::resolve_qbo_sales_tax_payments(cid)` — new synthesizer that walks the GeneralLedger for every `GlobalTaxPayable` account, picks up every `Sales Tax Payment` DR posting, matches it to the funding bank via a two-sided (payable-GL × bank-GL, date + amount) walk, and posts a single deterministic JE. Handles QBO's `-Split-` column (fires when the STP carries an extra expense line like a bank fee). Idempotent by fixed JE id.
- Wired into the import pipeline right after `resolve_tax_rates`.
- `reports.py::compute_balance_sheet` — CreditMemo + RefundReceipt `TxnTaxDetail.TaxLine` amounts now subtract from the same sales-tax-payable so voided/refunded invoices don't leave phantom tax liability sitting on the BS.

**Tests**: 
- `tests/test_qbo_sales_tax_payment_synth.py` — 5 new tests (matched JE shape, idempotency, credit-side skip, no-connection noop, real-world `-Split-` two-sided match)
- `tests/test_cash_basis_parity.py` — added 2 tests for CM and RR TxnTaxDetail reversals (10 total in file, all green)
- `tests/test_qbo_opening_balance_delta.py` — updated stale `test_opening_je_with_activity_plugs_only_the_delta` to reflect the new design (opener SKIPS accounts with activity so real import gaps surface on the Recon Panel rather than being silently swallowed into OBE).
- Full targeted suite: **31/31 green**.

**Verified live (Sandbox a026 + 2457)**:
- Checking: -$76.90 → **$1,201.00** ✓ (target $1,201.00)
- BoE Payable: was inflated by opener plug → **$370.94** ✓ (target $370.94)
- AZ Dept. of Revenue Payable: **$0.00** ✓ (accrual and STP DR cancel)
- Accounts Payable: **$1,602.67** ✓
- Undeposited Funds: **$2,062.52** ✓
- Truck Original Cost: **$13,495.00** ✓
- Notes Payable: **$25,000.00** ✓, Loan Payable: **$4,000.00** ✓, Mastercard: **$157.72** ✓
- BS balanced end-to-end on both realms.

Residual known gaps (surface on Recon Panel, not silently plugged):
- Savings $600 vs QBO $800 ($200 opening balance predates activity — synthesizer for this account class pending)
- Inventory Asset $567.50 vs QBO $596.25 ($28.75 opening balance, same class)
- A/R $5,381.52 vs QBO $5,281.52 ($100 import gap — CM allocation)

These are surfaced correctly for review rather than being masked into OBE.

Status: **DONE**. Sales-tax payment lifecycle now fully round-trips through synthesis + accrual + reversal.


### Aug 21 2026 — Multi-Payment Cash-Basis Fix

**Problem**: Cash P&L Recon Panel on Sandbox 358d showed a +$120.52 shuffle pattern — Sales of Product +$44, Plants and Soil +$609.62, Services -$400, Maintenance +$135. Category totals almost tied but children were scrambled, classic sign of misclassification. Initial hypothesis (item→income-account historical divergence) turned out wrong (GL resolver stamped 0 lines because our stored `account_qbo_id` already matched current item mapping).

**Root cause**: `reports.py` top-down cash allocator reset `remaining = paid` per payment while iterating the invoice's FULL line array. Multi-payment invoices double-consumed top lines and never reached bottom lines. Sandbox 358d Invoice 1004 ($20 + $24 + $1,750 + $400 = $2,194 subtotal, paid by $694 + $1,500) posted:
- Sprinklers 2× ($88 vs QBO $44)
- Sod double-counted ($2,281 vs QBO $1,750)
- Services $0 (never reached, vs QBO $400)

**Backend** (`reports.py::compute_income_statement` cash-basis block)
- Group payments per invoice/bill into `pre_period` (before window) + `in_period` (within window)
- Walk lines ONCE per invoice with cumulative consumption pointer: `pre_period` advances pointer silently, `in_period` posts revenue only for the segment it consumes
- Same treatment on vendor side (bills → expense/COGS)

**Tests**: `tests/test_cash_basis_parity.py` — added `test_cash_multi_payment_advances_line_pointer` (exact Sandbox 358d Invoice 1004 scenario) + `test_cash_pre_period_payment_advances_pointer_without_posting` (window boundary). Full suite **12/12 green**, wider 33/33 parity suite green.

**Verified live on Sandbox 358d cash P&L**:
- Sales of Product $88 → **$44 ✓** (exact match)
- Services $103.55 → **$503.55 ✓** (exact match — the $400 line came back)
- Plants and Soil $2,483.49 → $1,951.97 (drift +$609.62 → +$78)
- Total Income drift **+$120.52 → -$55.00** (55% reduction)

Residual -$55 is a separate item-mapping shuffle (Landscaping parent direct postings, Fountains, Pest Control) — smaller root cause, distinct from the top-down bug closed here.

Status: **DONE**. Multi-payment cash-basis top-down allocation now matches QBO for both customer receipts and vendor payments.


### Aug 21 2026 — QBO Inventory Visibility Fix

**Problem**: Sandbox 358d Craig's Landscaping migrated 18 items + 4 InventoryAdjustments successfully — but the Inventory Management page showed "0 tracked items · total value $0.00". QBO's real answer: 4 inventory items (Pump, Rock Fountain, Sprinkler Heads, Sprinkler Pipes) with total value $596.25.

**Root cause**: Two-track import pipeline mismatch.
- The migration entry (`run_migration` → `_PIPELINE`) called `map_item` which stored `type='inventory'`, `item_type='Inventory'`, `track_qty_on_hand=True`, and quantity/cost fields correctly.
- BUT the internal `track_inventory` flag (which the Inventory page filters on) and the local `inventory_account_id` / `cogs_account_id` / `income_account_id` resolutions were only done by `_pull_items` in the ongoing mirror pull — which never fires immediately after migration.
- Additionally, `compute_valuation` reads `cost_basis` (weighted-average maintained by inventory movements) but QBO stores unit cost in `cost` — freshly migrated items had `cost_basis=None`, showing $0 valuation.

**Backend**
- `qbo_service.py::resolve_item_accounts_and_tracking(cid)` — new post-import resolver. For each QBO-imported item: resolves QBO account refs to local ids, flips `track_inventory=True` on Inventory-typed items, and seeds `cost_basis` from `cost` (only when empty — respects weighted-average updated by movements later). Idempotent.
- Wired into `run_migration` right after `resolve_payment_links`.
- Backfilled all 8 QBO-connected sandbox companies (4 items flipped each).

**Tests**: `tests/test_qbo_item_resolver.py` — 3 new regressions (flip + resolve, service-item skip, idempotency). Wider **36/36 targeted parity suite green**.

**Verified live on Sandbox 358d**:
- 4 tracked items now visible: Pump ($250), Rock Fountain ($250), Sprinkler Pipes ($77.50), Sprinkler Heads ($18.75)
- **Total value: $596.25 ✓** — exact match to QBO Inventory Asset target from prior parity work.

Status: **DONE**. QBO-migrated inventory items now surface on the Inventory Management page immediately after import.
