# SmartBooks — Changelog

## 2026-02-25 — AI Ask Client: Cross-Company Recipient-Signature Cooldown

### 🚨 Incident
User received **7 emails** for the same $340 "Online Banking transfer to CHK 6278" transaction:
- **Burst 1 (3:50 AM UTC)** — 4 emails from separate test companies (Plaid Date 1 LLC, others). Nightly scheduler tick fired one email per company because the underlying Plaid sandbox had the same $340 charge duplicated into each company as a separate row.
- **Burst 2 (1:26 PM UTC)** — 3 more emails from additional companies (Post Detail Plaid LLC). Same root cause on a later scheduler run.

The Feb 2026 dedup fix only prevented duplicates **within a single company**. It did not catch the case where the same real person owns multiple companies (common in bookkeeper sandbox testing, and also a real production edge case).

### 🔎 Root cause
1. `_candidate_txns` dedup is company-scoped (correct — different companies own different money).
2. `DAILY_CAP_PER_CLIENT=3` counts by `to` email address. Gmail plus-tag aliases (`michael+companyA@`, `michael+companyB@`, …) are treated as distinct addresses by the counter, so the same real inbox never triggers the cap.
3. No cross-company recipient guard existed.

### ✅ Fix — normalized-email + cross-company payment-signature cooldown
- **`_normalize_email(addr)`** — new helper that strips Gmail plus-tag suffixes AND dots-in-localpart (Gmail-specific); other domains only get case+trim. `michael+companyA@gmail.com` and `mi.chael+testco@gmail.com` both normalize to `michael@gmail.com`.
- **`_payment_signature(txn)`** — extracted the existing `(date, cents, counterparty)` signature into a shared helper.
- **`_recently_asked_same_payment(client_email, signature)`** — queries `client_questions` for any prior ask to the same normalized recipient about the same payment signature within `RECIPIENT_SIGNATURE_COOLDOWN_HOURS` (default 72h). Cross-company by design.
- **`process_company`** — after the daily-cap check and candidate selection, calls the cooldown lookup. If a prior ask is found, returns `status: "recipient_signature_dedup"` with the prior question id + prior company id (great for ops debugging without firing an email).
- **`client_questions` documents** now stamp `normalized_to_email` and `payment_signature` at insert time so the cooldown query is a single-index hit.

### 🧪 Tests (13/13 in ai_ask_client suites)
- **`test_ai_ask_client_cross_company_dedup.py`** (4 new tests):
  - `test_normalize_email_gmail_plus_tag_and_dots` — Gmail plus-tag, dots collapse, non-Gmail behavior, case/whitespace, empty safety
  - `test_recently_asked_same_payment_finds_cross_company_ask` — normalization actually matches across plus-tag aliases
  - `test_recently_asked_ignores_asks_outside_cooldown_window` — 30-day-old ask does NOT block fresh ask (cooldown is forward-looking)
  - `test_process_company_skips_when_recipient_signature_already_asked` — end-to-end: seed prior ask from Co A, run process_company on Co B → returns `recipient_signature_dedup`, no email fires

### 📬 What this means for the user
- **Going forward**: fresh scheduler runs will populate `normalized_to_email` + `payment_signature` on new asks. Any repeat charges (Gmail plus-tag or otherwise) to the same normalized recipient within 72h are silently skipped.
- **Existing 7 email burst**: those old asks pre-date this fix so they don't have `payment_signature` populated. They won't block future asks. Backfilling is optional — the cooldown catches new asks going forward.
- **Real production case (multi-company real client managed by one pro)**: still works correctly. The cooldown protects real inboxes from spam AND legitimately different money on different companies from the same vendor on the same day gets a single ask (batching effect). If Ops wants both emails to fire, set `AI_ASK_CLIENT_RECIPIENT_COOLDOWN_HOURS=0`.

---

## 2026-02-25 — Feedback Email Leak Guard (Feb 25 incident — pytest firing real Resend to ops inbox)

### 🚨 Incident
Overnight after yesterday's session, the ops Gmail inbox received a **15+ email burst** of `[Bug] admin-unread`, `[Bug] unread-flow`, `[Bug] notify-admins`, `[Bug] att-reply`, `[Bug] priv`, `[Bug] cross-visibility`, `[Bug] reply test`, etc. — all timestamped within the same minute. Every email was a real Resend delivery of a real `feedback_new_submission` template. Root: the pytest suite fired during a CI/deploy run and flooded the real ops inbox.

### 🔎 Root cause (two-layer)
1. **`test_feedback.py` doesn't mock the email dispatcher.** Tests seed `fb_XXXXXX@example.com` users and call `POST /api/feedback`, which triggers `_notify_superadmins`.
2. **`_notify_superadmins` iterates ALL superadmins** in the shared MongoDB — including production superadmins seeded there — and calls `dispatch()` per admin.
3. **`email_dispatcher.dispatch()` had no test-domain safety guard** — it unconditionally called Resend even when the recipient's address was a reserved test domain (RFC 2606: example.com/org/net, RFC 6761: .test/.invalid/.localhost).

### ✅ Fix — defense in depth
1. **`email_dispatcher.dispatch()` reserved-domain guard** — any call where all recipients end in `@example.com`, `@example.org`, `@example.net`, `.test`, `.invalid`, or `.localhost` is short-circuited with a `skipped_test_recipient` audit-log row. `send_email` (Resend) is never called.
2. **`_notify_superadmins` and `_notify_superadmins_of_reporter_reply`** now (a) short-circuit at the top when the submitter/reporter has a test-shaped email, and (b) filter out test-shaped admin rows from the fanout loop. Belt-and-suspenders — prevents even the audit log row from spawning.
3. **Refactored to shared helper** `_is_test_email(addr)` so every future fanout can use the same check.

### 🧪 Tests (34/34 in feedback suites)
- **New `test_feedback_email_leak_guard.py`** (5 tests):
  - `test_feedback_submission_from_example_com_does_not_email_real_superadmins` — the exact incident scenario: real superadmin seeded, test client submits bug, asserts `send_email.call_count == 0`.
  - `test_dispatcher_skips_all_test_recipient_addresses` — direct unit test on the dispatcher.
  - `test_dispatcher_skips_reserved_domains_variety` — covers all 6 RFC-reserved domain shapes.
  - `test_dispatcher_still_sends_to_real_addresses` — sanity: guard doesn't break real deliveries.
  - `test_reporter_reply_from_test_user_does_not_email_real_superadmins` — same guarantee for the reporter-reply fanout.
- **Updated `test_reporter_reply_notifies_superadmins_via_comms`** — now uses non-reserved `@fbtest-real.io` emails + mocks `send_email` so it can still verify the fanout writes comms rows without firing real Resend.

### 📬 Immediate cleanup
No cleanup needed on production — the delivered emails are just noise, no data damage. Once the deploy of this fix lands, future pytest runs will not repeat the incident. If it happens again before the deploy, ops can filter/delete the `[Bug]` subject-line burst in Gmail.

---

## 2026-02-25 — Income Statement COGS + Gross Profit (Option B — proper GAAP P&L)

### 🎯 Why
Pre-fix, `reports.py::compute_income_statement` only emitted `revenue` and `expense` rows. Any account with `type=cogs` was silently DROPPED from the P&L — its dollars were invisible on reports and didn't reduce Net Income. This was a genuine data-integrity bug that was hidden because:
- The seed doesn't create any COGS accounts by default
- Most SMB customers (SaaS, service, condo association) don't post to COGS
- Only surfaces when QBO import brings in `AccountType: "Cost of Goods Sold"` rows (mapped to `type: "cogs"` in `qbo_service.py`)

User caught this while adding a new CoA entry — the "COGS" type option in the type dropdown produced an empty sub-type list AND an auto-populated "COGS · 0" section on the CoA render. User (a CPA) opted for the proper GAAP fix rather than collapsing COGS into Expenses as a subtype.

### ✅ Changes
- **`reports.py::compute_income_statement`** — now emits `cogs = _emit("cogs")` alongside revenue/expense. New response fields: `cogs`, `total_cogs`, `gross_profit`. Formula: `gross_profit = total_revenue − total_cogs`; `net_income = gross_profit − total_expense`. **Backwards compatible**: for companies without COGS activity, `total_cogs=0`, `gross_profit=total_revenue`, and `net_income` computes identically to pre-fix (Revenue − Expense).
- **`reports.py::build_income_statement_pdf`** — emits "COST OF GOODS SOLD" section header + "Total Cost of Goods Sold" subtotal + a distinct "GROSS PROFIT" subtotal line above Operating Expenses, but only when there's COGS activity. Service/SaaS books get the classic two-section P&L; inventory/restaurant/retail books get proper GAAP presentation.
- **`ReportView.jsx::IncomeStatementBody`** — conditionally renders the COGS section + Gross Profit row when `total_cogs != 0`. Uses the same 0.5¢ threshold as `fmtMoney` to decide.
- **`ChartOfAccounts.jsx`** — hides the auto-populated "COGS · 0" section when a company has zero COGS accounts. Section reappears the moment a COGS account exists (from QBO import or manual create). Removes the "what's this doing here?" UX friction while preserving the type option for businesses that need it.

### 🧪 Tests (14/14 green across CoA + IS-COGS suites)
- **`test_income_statement_cogs.py`** (new file, 3 tests):
  - `test_income_statement_emits_cogs_and_gross_profit` — seeds a balanced JE with $10k revenue / $3k COGS / $2k operating expense → asserts `total_revenue=10k`, `total_cogs=3k`, `gross_profit=7k`, `total_expense=2k`, `net_income=5k`
  - `test_income_statement_backwards_compatible_no_cogs` — seeds a service company (no COGS) → asserts `total_cogs=0`, `gross_profit=total_revenue`, `net_income=8k` (matches pre-fix arithmetic)
  - `test_income_statement_pdf_builds_with_cogs_activity` — PDF renderer doesn't KeyError on the new fields

### ✋ What did NOT change
- Downstream consumers (`routes/chat.py`, `routes/firm_glance.py`) continue to read `total_revenue`, `total_expense`, `net_income` — those still refer to Operating Expenses only (not COGS), so cash-burn KPIs and per-expense breakdowns are unaffected. `total_cogs`/`gross_profit` are opt-in additions that downstream can adopt when ready.
- The `cogs` top-level type remains valid on `POST /accounts`, in the AI type enum, and in the QBO import mapper — the fix restores its P&L visibility rather than removing it.

---

## 2026-02-25 — Drift Audit Refinement (false-positive fix + inline drift list)

### 🎯 Why
User (as Superadmin) opened the drift diagnostic chip on Veryfi 351 LLC and saw "Opening Balance Equity" flagged as drift with `subtype: equity → detail_type: opening_balance_equity`. On investigation, this was a **false positive** — not real drift. The row was correctly labeled by Plaid's `ensure_opening_balance_equity` helper for reconciliation purposes. The audit was flagging it only because the frontend's `DETAIL_SECTIONS_BY_TYPE` for equity didn't include `opening_balance_equity`, so the audit's tightened canonical set (mirrored from the frontend) treated both `equity` and `opening_balance_equity` as non-canonical → fell through to the drift bucket.

### ✅ Fixes
- **Frontend `DETAIL_SECTIONS_BY_TYPE.equity`** — added `opening_balance_equity` → "Opening Balance Equity" (also added to the create/edit sub-type dropdown). Now proper GAAP grouping on PDFs and the CoA renders a dedicated "OPENING BALANCE EQUITY" section header.
- **Backend `_CANONICAL_KEYS_BY_TYPE.equity`** — added `opening_balance_equity` to match.
- **Tightened drift condition**. Was: `st != dt` (any two disagreeing values). Now: `st in canon AND dt in canon AND st != dt`. If either side is a legacy or specialty value, the row goes into the silent `legacy_only_subtype` bucket instead of firing the red banner. This eliminates a broad class of false positives on any account where the classifier can't confidently call drift.
- **Applied the same tightening in `routes/admin.py::admin_coa_drift_summary`** so the Superadmin dashboard company badges stay in sync with the CoA page.
- **Inline drift list in the CoA banner (visible to ALL users, not just Superadmin)**. When drift is present, the banner now lists up to 3 offending accounts inline with name + type + `subtype → detail_type`. Answers "which account is drifted?" without requiring Superadmin access or opening the diagnostics chip. Full list still lives in the Superadmin diagnostics.

### 🧪 Tests
- **`test_drift_requires_both_canonical_no_false_positive_on_opening_balance_equity`** — seeds an OBE row (`subtype=equity, detail_type=opening_balance_equity`) and asserts `drifted == 0`.
- 11/11 tests green in `test_coa_subtype_unification.py`.

---

## 2026-02-25 — QBO Sync Write-Path Fix (populate detail_type on QBO account import)

### 🎯 Why
User linked a fresh company (Test 316 LLC) to a QBO sandbox → sync completed → CoA landed showing "89 accounts missing a sub-type" amber banner. Root cause: `qbo_service.map_account()` copies `AccountSubType` → `subtype` but never sets `detail_type`. Every QBO-imported account was landing without the Wave-style detail_type key, so PDFs would render flat and the drift audit lit up.

Same gap already fixed for the CoA seed and Plaid earlier today — this closes the last remaining write-path.

### ✅ Fix
- **`qbo_service.py::map_account`** now populates `detail_type` using the same `_infer_detail_type` heuristic the CoA CSV import uses. QBO's `AccountSubType` vocabulary ("Checking", "CashOnHand", "AccountsReceivable", "CreditCard", "FixedAsset", etc.) doesn't line up 1:1 with our frontend's Wave keys, so name-based inference produces cleaner results than a verbatim copy.
- **`qbo_mirror/pull.py`** picks up the fix for free — it calls `map_account` on both insert (line 78) and update (line 82 via `_UPDATE_FIELDS`). `_UPDATE_FIELDS["accounts"]` deliberately does NOT include `detail_type` so re-syncs won't clobber a user's manual reclassification.

### 🧪 Test
- **`test_qbo_map_account_populates_detail_type`** — asserts:
  - `Checking / Bank / Checking` → `cash_and_bank`
  - `Accounts Receivable (A/R) / Accounts Receivable / AccountsReceivable` → `expected_payments_from_customers`
  - `Visa Credit Card / Credit Card / CreditCard` → `credit_card`
  - `Truck / Fixed Asset / Vehicles` → `property_plant_equipment`
- 10/10 tests green in `test_coa_subtype_unification.py`

### 🔧 Cleaning up the 89 accounts on Test 316 LLC (post-deploy action)
Existing rows imported before this fix still have blank `detail_type`. Two options:
1. **Sweep sub-types button** on the Superadmin dashboard (batch — clears every legacy row across every company)
2. **Backfill sub-types button** in the CoA page header for that specific company (per-company)

Either one runs the same idempotent name+subtype heuristic. Once run, the amber banner disappears and the CoA renders with proper GAAP grouping.

---

## 2026-02-25 — Sweep Existing Books (batch backfill + Superadmin sweep button)

### 🎯 New
- **`POST /api/admin/coa-drift-backfill`** — superadmin-only batch endpoint that walks every account across every company in one pass and populates `detail_type` using the same name+subtype inference the per-company endpoint uses. Idempotent — accounts that already carry `detail_type` are skipped. Accepts `?force=1` to recompute even set values (opt-in only, useful for fixing mislabeled sub-types).
- **Superadmin Dashboard "Sweep sub-types" button** — inline chip beside the Companies section header showing aggregate "N red / M amber" counts + a one-click sweep. Renders only when the platform has any drift to report. After running, the dashboard's drift map auto-refreshes so the pills disappear immediately for cleaned companies. Uses `window.confirm` guard + toast feedback showing accounts touched and companies affected.

### ✅ Behavior
- Sweep is **safe by default** (no `force`): touches only accounts with a blank `detail_type`. Won't overwrite user-chosen sub-types.
- Genuine **drift** rows (both `subtype` and `detail_type` set to canonical values that disagree) stay flagged red — requires manual review or an explicit `?force=1` call. Signal-to-noise on the Companies list is now excellent: only truly problematic tenants highlight.
- Idempotent: re-running the sweep after a completed pass returns `updated=0, skipped_already_set=N`.

### 🧪 Verified E2E (9/9 tests green)
- `test_admin_coa_drift_backfill_sweeps_missing_detail_type` — seeds 3 legacy rows across 2 companies, asserts sweep populates canonical Wave keys (`cash_and_bank`, `credit_card`), and confirms re-run is no-op (idempotent).
- `test_admin_coa_drift_backfill_forbidden_for_non_superadmin` — RBAC guard.
- Live preview verification — sweep hit the admin API, returned `updated=0, skipped=2625, scanned=85` (write-path fix already handled everything), UI screenshot showed sweep button + summary chip rendering correctly with only genuine red-drift companies highlighted (no amber noise).

---

## 2026-02-25 — Seed + Plaid Write-Path Fix (fresh companies land canonically clean)

### 🎯 Why
Every fresh company was landing with 37+ amber "missing_detail_type" pills on the Superadmin dashboard because the default CoA seed and the Plaid auto-account creator only populated `subtype` and left `detail_type` blank. Result: PDFs rendered as flat lists without GAAP-appropriate sub-section headers (Cash and Bank, Accounts Receivable, PP&E, etc.). Accounting math was always correct, but professional presentation was degraded on every new tenant.

### ✅ Fixes (all additive — no existing data touched)
- **`seed.py`** — `DEFAULT_COA` is now a 5-tuple `(code, name, type, subtype, detail_type)`. Every seeded account carries a frontend-canonical Wave key in `detail_type` (`cash_and_bank`, `expected_payments_from_customers`, `property_plant_equipment`, `depreciation_and_amortization`, `credit_card`, `loan_and_line_of_credit`, `sales_tax_payable`, `owner_contribution_drawing`, `retained_earnings`, `income`, `operating_expense`, `payment_processing_fee`, `payroll_expense`, etc.). `subtype` stays as its legacy value (`current_asset`, `fixed_asset`, `current_liability`, etc.) so downstream readers that pin on specific subtype strings (e.g. `reports.py::_cash_flow_statement` checks `subtype == "fixed_asset"` to classify PP&E as investing activity) keep working.
- **5 seed callers updated to unpack the 5-tuple**: `seed.py::seed()`, `routes/companies.py::create_company`, `routes/pro.py::provision_client_company`, `enterprises.py::provision_client_company_for_pro`, `partners.py::ensure_partner_books_company_for_partner`.
- **`plaid_connect.py`** — `SUBTYPE_MAP` extended with `detail_type`. `_ensure_account` signature takes an optional `detail_type` (falls back to subtype). `resolve_ledger_for_plaid` returns 5-tuple. `ensure_opening_balance_equity` sets `opening_balance_equity`; the CC Payment Clearing helper uses `money_in_transit`.
- **`statement_account_resolver.py::resolve_or_create_bank_account`** — the OTHER Plaid write-path (invoked from `get_ledger_for_plaid_account` when a mask/institution is present) now writes `detail_type = "credit_card"` for CC liabilities and `"cash_and_bank"` for bank assets on account creation.
- **`liability_subaccounts.py::spawn_liability_subaccount`** — Plaid-imported credit card children (Best Buy, Capital One, Citi Card, etc.) and loan sub-accounts (Audi under Loans Payable, etc.) now inherit `detail_type` from their parent so they render in the same CoA section as the parent.
- **`routes/accounts.py::_CANONICAL_KEYS_BY_TYPE`** — corrected to mirror the frontend's `DETAIL_SECTIONS_BY_TYPE` keys exactly (was using accounting-textbook labels like `accounts_receivable` while frontend + inference use Wave-style `expected_payments_from_customers`). Bug in the Feb 2026 audit patch that would have caused false-drift on new companies.

### 🧪 Verified E2E (7/7 CoA tests + 39/39 across CoA/QBO/Feedback)
- `test_new_company_seeds_detail_type_on_every_account` (new) — creates a fresh company via `POST /api/companies` and asserts every seeded account has `detail_type` populated + audit reports `missing_detail_type=0` and `drifted=0`.
- Live preview verification — created `DetailType Verify Co` via the admin API; audit returned `missing=0, drifted=0`. CoA screenshot showed proper GAAP grouping: Cash and Bank → Money in Transit → Accounts Receivable → Inventory → PP&E → Depreciation → Vendor Prepayments; Credit Card → Loan and Line of Credit → Accounts Payable → Sales Tax Payable.

### 🎨 What this looks like for the user
A brand new company now lands with:
- **Zero amber banner** on the Chart of Accounts page
- **Zero "missing" pill** on the Superadmin Companies list
- **GAAP-formatted Balance Sheet** with proper line-item classification instead of a flat list

Existing companies (created before this fix) still show amber until the read-only `/accounts/backfill-detail-type` endpoint is run against them — that remains a separate, opt-in operator action.

---

## 2026-02-25 — Drift Audit UI (Chart of Accounts sub-type drift banners + Superadmin badges)

### 🎯 New
Surface the read-only `/subtype-audit` endpoint output as actionable UI:
- **Chart of Accounts page**: amber banner when accounts are missing a Wave-style `detail_type`; red banner when `subtype` and `detail_type` disagree (true drift). Both banners are hidden when there's nothing to report so clean books look clean.
- **Superadmin-only diagnostics chip** on the CoA banner exposing every count (Total, Canonical, Legacy-only, Missing detail, Drifted) plus a bounded sample of drifted rows so ops can eyeball fixes before running Backfill.
- **Superadmin companies lists**: warning badges on both the flat Companies table and the nested Enterprises → Clients → Companies report — amber "Missing N" or red "Drift N" pills so ops can spot problem tenants at a glance.

### ✅ Changes
- **`routes/admin.py`** — new `GET /api/admin/coa-drift-summary` superadmin batch endpoint. One scan across `accounts` collection returns per-company `{missing_detail_type, drifted, legacy_only_subtype, severity}`. Companies with no drift are omitted to keep the payload small. Reuses `_CANONICAL_KEYS_BY_TYPE` from `routes/accounts.py` so classification stays in sync with the per-company audit endpoint.
- **`pages/ChartOfAccounts.jsx`** — `useAuth()` role check for the Superadmin diagnostic chip. New `driftAudit` state fetched inside `load()`. Amber/red banner rendered above the existing duplicate-detector banner (severity computed client-side: red beats amber).
- **`pages/SuperadminDash.jsx`** — new `driftMap` state fetched once from `/admin/coa-drift-summary`. Threaded into `EnterprisesReport` via prop so both the flat Companies table and the nested per-client company list render the same warning pill.
- **`tests/test_coa_subtype_unification.py`** — two new tests: `test_admin_coa_drift_summary_batch` (asserts red beats amber, clean companies omitted, per-company counts correct) and `test_admin_coa_drift_summary_forbidden_for_non_superadmin` (RBAC guard).

### 🧪 Verified E2E
- `pytest tests/test_coa_subtype_unification.py` → 6/6 passed
- Screenshot as Superadmin on the dashboard: amber "Missing 42" pills on Bright Beans and other companies with legacy sub-types; red "Drift 25" pill on TEST_dup.
- Screenshot on the Chart of Accounts page for Bright Beans (missing_detail_type=42): amber banner renders correctly; Superadmin diagnostics chip expands with all 5 counts.

### 🔒 Design rules honored
- `missing_detail_type > 0`: Amber banner (user actionable)
- `drifted > 0`: Red banner (real integrity risk — overrides amber)
- `legacy_only_subtype > 0`: NO banner for standard users (self-healing on edit)
- Superadmins get the diagnostic chip revealing every count including `legacy_only_subtype`

---

## 2026-02-24 — Partner demo button on Login page

### 🎯 New
Fourth "Partner" one-click demo button on the login page (next to Client / Accounting Pro / Superadmin), signing in as `partner@axiom.ai` / `partner123` and auto-redirecting to `/partner`.

### ✅ Changes
- **`scripts/seed_demo_users.py`** — added Partner demo spec (Jordan Reseller, AxiomPartners, subdomain `axiompartners`, brand color `#c026d3`). Seed script now:
  - Handles branding block (firm_name + subdomain + primary_color) as a merged nested dict
  - Auto-creates the `partners` sidecar row for role=partner
  - Calls `ensure_partner_books_company_for_partner()` on every seed run (idempotent — safe to re-run)
  - Uses per-spec `user_id` capture so partner-side-effects don't recompute the id
- **`pages/Login.jsx`** — fourth demo button `Partner — AxiomPartners` under the existing three
- **`constants/testIds.js`** — added `demoPartner: "demo-partner-btn"` for testing
- **`memory/test_credentials.md`** — added Partner demo credentials
- Seed ran on preview → `+ created partner@axiom.ai (partner)` + Partner Books auto-provisioned

### 🧪 Verified E2E
- Login page renders all 4 demo buttons
- Click Partner → auto sign-in → redirects to `/partner`
- Dashboard shows `AxiomPartners` brand header, fuchsia avatar, `axiompartners.accountingapp.ai` chip, 4 stat cards (Clients 0 / Enterprises 0 / Users 0 / **Partner Books 1**), YOUR FIRM tile, action buttons, PARTNER role badge on sidebar

### 📖 To activate on prod
1. **Save to GitHub** → prod redeploys (frontend + backend)
2. Run seed script on prod (if not part of your deploy pipeline): `python scripts/seed_demo_users.py`
3. Verify the Partner button appears on `app.smartbookssoftware.ai/login`



## 2026-02-24 — Partners moved into the Clients/Enterprises toggle

### 🎯 UX change
Partners no longer live in a separate section on the Superadmin dashboard — they're now the third pill in the same toggle group as Clients + Enterprises on `/pro/clients`, matching the existing spatial model users already know.

### ✅ Frontend changes
- `pages/ProClients.jsx` — added third `Partners` toggle (fuchsia + Handshake icon, distinct from indigo Enterprises), matching `New Partner` button (fuchsia), a `PartnersGrid` renderer with pink/rose gradient border (visually parallel to EnterprisesGrid but distinct), lazy-loaded on tab click. `CreatePartnerModal` reused from `components/PartnersCard.jsx` (now exported).
- Header dynamically swaps to `Partners` when the toggle is selected + subtitle explains the tier.
- Grid cards show brand-color avatar, contact email, subdomain chip, 3-column stat grid (Clients / Enterprises / Users), Partner Books deep-link, and "Awaiting password set" chip when the invite hasn't been claimed.
- `SuperadminDash.jsx` — removed the separate `PartnersCard` inject.

### 🧪 Regression
34/34 pass across partner + QBO + stripe suites. Verified E2E on preview:
- Toggle shows 3 buttons: Clients | Enterprises | Partners
- Clicking Partners → header becomes "Partners", subtitle updates, New Partner button appears (fuchsia)
- Empty state renders correctly with the CypherPro hint
- Create Partner modal opens from this toggle exactly as before



## 2026-02-24 — Partner role (Phase 1 MVP)

### 🎯 New user tier
A **Partner** is a reseller that sits between Superadmin and the existing Pro/Enterprise/Client trees. Partners inherit every Pro capability (manage client books, get their own "Partner Books" with the same delete protections as Firm Books) AND gain Enterprise-management privileges — but scoped to only the enterprises and clients they created. Partners cannot create Superadmins and cannot see any other Partner's data.

Hierarchy:
```
Superadmin
├── Partners
│   ├── Enterprises  (linked via partner_id)
│   └── End Users    (linked via partner_id)
└── Enterprises  (linked directly, no partner)
    └── End Users
```

### ✅ Backend (`backend/partners.py`, `backend/routes/partners_routes.py`)

**Data model additions:**
- `users.role == "partner"` — new role in the RBAC layer
- `users.branding` on partner docs — same shape as pro/firm branding (`firm_name`, `subdomain`, `logo_url`, `primary_color`)
- `users.partner_id` — set on Pros/Enterprise-owners provisioned by a Partner
- `companies.partner_id` — set on Enterprises + Clients created by a Partner (superadmin-created entities leave this unset)
- `companies.is_partner_books == True` — marks the Partner's own accounting entity; delete-guarded via new `force_partner_books=true` query flag (mirrors `force_firm_books`)
- New `partners` sidecar collection — light index doc for slug lookup + rollup

**Endpoints (all prefixed `/api`):**
- `POST /superadmin/partners` — create partner (auto-provisions Partner Books + fires magic-link welcome email; 409 on duplicate email; 409 on email belonging to a non-partner account so role changes stay explicit)
- `GET /superadmin/partners` — list all partners with rollup stats
- `GET /superadmin/partners/{id}` — detail
- `PATCH /superadmin/partners/{id}` — update branding + subdomain (unique slug reprocess on change)
- `GET /partner/me` — partner's own profile + stats (self-heals Partner Books if missing)
- `GET /partner/summary` — one-shot dashboard payload
- `GET /partner/clients` — clients scoped by `partner_id`
- `GET /partner/enterprises` — enterprises scoped by `partner_id`

**Idempotency:** `ensure_partner_books_company_for_partner()` uses the same defensive dedupe pattern as Firm Books (flag lookup → legacy name-suffix retro-stamp → mint new) so the 3-copies bug that hit Firm Books in production can't recur here.

### ✅ Frontend

- `frontend/src/components/PartnersCard.jsx` — Superadmin dashboard section with Partners list + New Partner button + Create modal (contact name/email + display name + subdomain + brand color picker). Auto-refreshes after create.
- Injected into `SuperadminDash.jsx` right above the stat cards, exactly parallel to the existing Enterprises card layout.
- `frontend/src/pages/PartnerDash.jsx` — new `/partner` landing page: brand-colored header, 4 stat cards (Clients / Enterprises / Users / Partner Books), Partner Books tile, action buttons (New Client / New Enterprise / Branding & Settings), and scoped client + enterprise lists. Every field flows from `GET /partner/summary` + `/partner/clients` + `/partner/enterprises`.
- `Login.jsx` — post-login redirect now includes `partner` → `/partner`.

### 🧪 Tests

`backend/tests/test_partners.py` — **9 tests, all green**:
- Create partner: provisions Partner Books, returns stats, marks `must_set_password=True`, writes sidecar row
- Duplicate email → 409
- Email belonging to a non-partner (client/pro) → 409 (role changes stay explicit)
- List partners returns created partner with rollup
- PATCH updates branding (display_name + primary_color)
- Partner Books delete requires `force_partner_books=true` (403 without, 200 with)
- Scoping: Partner A cannot see Partner B's clients (`/partner/summary` stats respect `partner_id`)
- Partner role cannot access `/superadmin/partners` (403)
- `ensure_partner_books_company_for_partner` is idempotent (protects against Firm Books 3-copies bug recurrence)

Full regression on adjacent suites: **9 partner + 8 QBO + 17 stripe private-label + 16 partner-vs-stripe combined = 50/50 pass**.

### 📸 Verified E2E on preview
- Superadmin dashboard renders the Partners section with a real CypherPro partner card (brand chip, stat chips, Partner Books button, "Awaiting password set" notice)
- New Partner modal opens, form has all fields (name/email/display_name/subdomain/color picker)
- `/partner` dashboard: brand-colored header shows "CypherPro", subtitle "Partner dashboard · cypherpro-test.accountingapp.ai", Partner Books tile is clickable, stat cards populated, action buttons present, role badge on left sidebar reads **PARTNER**

### 🔮 Deferred to Phase 2
- Migration script: convert existing CypherPro Enterprise → Partner + re-link its 3 clients
- Partner Settings page (mirrors Enterprise settings — subdomain edits, sign-in options, private-label brand key so `metadata.brand=cypherpro` routes to Partner's branding automatically)
- Enterprises-under-Partner inheriting Partner branding cascade
- Detailed Usage / Cost / Revenue breakdowns (Phase 1 shows only counts; Phase 2 will add $ + AI-spend rollups scoped to `partner_id`)
- Stripe self-signup for Partners (right now the only creation path is Superadmin → New Partner)



## 2026-02-24 — Brand fallback to Stripe Product metadata

### 🎯 Problem
Operator set `brand=cypherpro` metadata on the **Product** in Stripe Dashboard (the natural place — that's where the "CypherPro" branding conceptually lives). But our webhook was only reading `session.metadata`, which reflects **Payment Link** metadata, not Product metadata. Result: after the fix in the previous entry, the webhook still routed to `smartbooks` because it never saw the Product's metadata.

### ✅ Fix (`backend/routes/stripe_billing.py`)
`_handle_checkout_completed` now falls back to a Stripe API expansion when session metadata is empty:
```python
if brand.key == "smartbooks" and _STRIPE_KEY and session.id:
    expanded = stripe.checkout.Session.retrieve(
        session.id, expand=["line_items.data.price.product"]
    )
    for ln in expanded.line_items.data:
        candidate = resolve_brand(ln.price.product.metadata)
        if candidate.key != "smartbooks":
            brand = candidate
            break
```
- Runs at most **one** Stripe API call per event (only when session metadata is empty).
- Session metadata still wins if both are set (specific-over-general — allows a promo Payment Link to override its product's brand).
- Any Stripe API failure is caught and swallowed — user creation never breaks because of a metadata lookup hiccup.

### 🧪 Tests
Added 3 tests to `test_stripe_private_label_welcome.py` (all monkeypatched — no real Stripe calls):
- `test_brand_falls_back_to_product_metadata` — product metadata alone routes to CypherPro
- `test_session_metadata_wins_over_product_metadata` — expansion isn't even called when session already has brand
- `test_stripe_expansion_error_is_swallowed` — user still gets created + falls back to smartbooks

Full private-label suite: **17/17 pass** across 5 consecutive runs. Combined `test_stripe_billing.py` + `test_stripe_private_label_welcome.py`: **24/24 pass** across 3 consecutive runs.

### 📖 Operator playbook update
For CypherPro (or any private label): add `metadata.brand=cypherpro` in EITHER place:
- **Product** (Product catalog → Products → open → Metadata) — recommended, configures branding once per brand
- **Payment Link** (Product catalog → Payment Links → open → Metadata) — overrides Product metadata; use for one-off promos
Both work. Product metadata is the durable choice.



## 2026-02-24 — Private-Label Welcome Emails (CypherPro-branded)

### 🎯 Problem
CypherPro (and any future private label) shares the SmartBooks backend + database, but customers paying on `cypherpro.ai` were getting a **SmartBooks-branded** welcome email with a magic link pointing at `app.smartbookssoftware.ai/set-password/…`. Customers thought it was spam ("I paid CypherPro — why is SmartBooks emailing me?") and abandoned the signup.

### ✅ Fixes

**New brand registry (`backend/private_labels.py`)**
- Single source of truth for every private-label brand: `{key, display_name, product_name, app_url, tagline}` per entry.
- Ships with `smartbooks` (flagship) + `cypherpro` (first white-label) — extensible by editing the `_BRANDS` dict.
- `resolve_brand(metadata)` reads `brand` / `label` / `private_label` keys off a Stripe session's `metadata` (operators use different vocabularies — we accept all three). Case-insensitive, unknown values fall back to `smartbooks` so a typo never breaks a signup.
- Per-brand `app_url` respects env override (`BRAND_CYPHERPRO_APP_URL` etc.) so ops can retarget without a code push.

**Brand-aware webhook (`routes/stripe_billing.py`)**
- `_handle_checkout_completed` resolves brand from session metadata BEFORE anything else — so even a `bailed_no_email` outcome now reports which private-label link was misconfigured.
- User doc gets stamped with `private_label_brand` on creation so future re-sends of the welcome email route to the right host without re-parsing Stripe metadata.
- Outcome dict includes `brand` + `magic_link_host` fields; both surface on the diagnostic UI and the API response body.
- `_send_welcome_magic_link(user, brand=…)` uses the brand's `app_url` for the magic-link base and passes the brand into the email template.

**Brand-aware email template (`email_templates.py::stripe_welcome`)**
- Accepts an optional `brand` dict. Subject swaps to `"Welcome to <product_name> — set your password"`, heading uses the product name, body includes the brand tagline ("your business, decoded" for CypherPro).
- Footer: for private labels we PASS `brand_name` into `_wrap`, which drops the `smartbookssoftware.ai` reference so the email reads as purely CypherPro branded. Flagship SmartBooks signups keep their historical footer.
- User-supplied name is HTML-escaped on render so a malicious payer can't inject markup.

**Brand-aware From header (`email_dispatcher.py`)**
- New `firm_name_override` kwarg on `dispatch()`. When set, wins over the initiating user's firm branding — used by the private-label welcome flow to force `"CypherPro <no-reply@accountingapp.ai>"` as the From line even though the fresh customer has no firm affiliation yet.
- Reuses the existing `RESEND_FROM_FIRM` template plumbing — no new Resend domain verification required. (Note for later: switching to `no-reply@cypherpro.ai` requires the operator to add DNS records + verify a new Resend domain.)

**Diagnostic UI updated (`frontend/src/pages/SuperadminStripeWebhooks.jsx`)**
- New **Brand** column between Outcome and Payer Email — chip-highlighted for private labels so failed signups are easy to attribute at a glance.

### 🧪 Tests
`backend/tests/test_stripe_private_label_welcome.py` — **14 tests, all green**:
- Brand resolution: `brand` / `label` / `private_label` aliases, case-insensitive, unknown → fallback, missing metadata → fallback, typo-safe
- Template branding: subject swaps to product name, footer drops smartbookssoftware.ai for private labels, flagship keeps it, HTML injection escaped
- Webhook integration: CypherPro session → outcome carries `brand: cypherpro` + `magic_link_host: app.cypherpro.accountingapp.ai`, user doc stamped with `private_label_brand`
- Regression: sessions without brand metadata still route to `smartbooks` (preserves flagship behaviour)
- Even `bailed_no_email` reports which brand's link was misconfigured

**Combined stripe suite** (test_stripe_billing + test_stripe_webhook_diagnostics + test_stripe_private_label_welcome): **26/26 pass** across 4 consecutive parallel runs. Broader combined: **178 stripe + qbo tests pass**, zero regressions.

### 📖 Operator playbook — attributing a Payment Link to CypherPro
1. Stripe Dashboard → Product catalog → Payment Links → open each CypherPro link
2. **Metadata** section → add key `brand`, value `cypherpro`. Save.
3. That's it. From the next payment on:
   - Welcome email subject: **"Welcome to CypherPro — set your password"**
   - From line: **"CypherPro <no-reply@accountingapp.ai>"**
   - Magic link: **`https://app.cypherpro.accountingapp.ai/set-password/<token>`**
   - Diagnostic UI shows brand: `cypherpro` chip on the row

### 🔮 Adding a new private label
1. Add entry to `_BRANDS` dict in `backend/private_labels.py` (key + display_name + product_name + app_url + tagline)
2. Stamp `metadata.brand=<key>` on every Payment Link in Stripe Dashboard
3. Optionally set `BRAND_<KEY>_APP_URL` env override for staging/prod parity
No template code, no separate email dispatcher, no per-brand webhook needed.



## 2026-02-24 — Stripe webhook outcome tracking + diagnostic endpoint

### 🐛 Problem
CypherPro's private-label pricing page (`cypherpro.ai/pricing`) uses Stripe Payment Links. After the operator archived the old products and created new ones, paid signups stopped creating users and welcome emails stopped firing. Stripe Dashboard showed the webhook attempt as "Succeeded" (green checkmark) → looked like everything worked. In reality our handler was bailing silently on some path and 200-ing to Stripe so it wouldn't retry.

### 🔍 Root-cause hunt
Without outcome tracking, "Stripe says 200" told us nothing. The handler has several silent-bail paths:
- **No email on the session** (Stripe Payment Link with "Collect customer information → Email" toggle OFF) — the most likely culprit when new Payment Links are hand-created in the Dashboard
- Handler exception (caught + logged, but ignored)
- User already exists (correct behaviour, but indistinguishable from "no user created" without instrumentation)

### ✅ Fixes (`backend/routes/stripe_billing.py`)
1. **Every handler now returns an outcome dict** — `_handle_checkout_completed` returns `{status: "user_created"|"user_existing"|"bailed_no_email", email, welcome_sent, stripe_customer_id, stripe_subscription_id, linked_company_id, whitelabel_flipped}`. The `bailed_no_email` path includes a plain-English hint pointing at the Stripe Dashboard toggle to flip.
2. **`stripe_webhook_events` collection now stores** `payload_snapshot` (trimmed to ~2kb — id, customer, email, metadata, mode, line_price_ids, etc.) and `outcome` (status + processed_at).
3. **Response body now includes the outcome** so operators (and tests) can see what happened per event without a DB round-trip.
4. **New diagnostic endpoint**: `GET /api/admin/stripe/webhook-events?limit=50&event_type=&outcome_status=` (superadmin only). Returns recent events with their outcome + snapshot, plus a `recent_outcome_breakdown` histogram across the last 200 events for at-a-glance ops triage.

### 🧪 Tests
`backend/tests/test_stripe_webhook_diagnostics.py` — 5 tests, all green:
- Payment Link with no email → `bailed_no_email` outcome + Dashboard-toggle hint
- Happy path → `user_created` + `welcome_sent=True` + persisted stripe IDs
- Invoice event → `line_price_ids` on snapshot for at-a-glance product ID
- Metadata capped at 20 keys, values coerced to str
- Snapshot helper never crashes on missing/None fields

Combined suite (test_stripe_billing.py + test_stripe_webhook_diagnostics.py): **12/12 pass** across 3 parallel runs.

### 📖 Operator playbook
When a signup doesn't create a user, hit:
```
GET /api/admin/stripe/webhook-events?event_type=checkout.session.completed&limit=20
```
- If `outcome.status == "bailed_no_email"` → Stripe Payment Link has email collection off. Edit the Payment Link → **Collect customer information → Email** → ON.
- If `outcome.status == "user_existing"` → the payer already had an account; welcome email deliberately not sent.
- If `outcome.status == "handler_exception"` → error message in `outcome.error`, full traceback in backend logs.



## 2026-02-24 — QBO Private-Label OAuth Redirect (Option A) — VERIFIED

### 🎯 Goal
Private-label domains (Cypher Pro, Proactive Books, etc.) that host their own `api.<label>.accountingapp.ai` API subdomain must bounce Intuit's OAuth consent flow back to THEIR domain, not to the SmartBooks flagship. Users lost trust when the consent flow landed on `smartbookssoftware.ai` mid-connection.

### ✅ Implementation (`backend/routes/qbo.py` + `qbo_service.py`)
- **`_redirect_uri_from_request(request)`** — pulls `x-forwarded-host` (Kubernetes ingress) or `Host` header, strips port suffix, lowercase-normalises, and only accepts hosts on `_QBO_ALLOWED_HOSTS` whitelist. Returns `None` for non-whitelisted hosts so the caller falls back to the env-configured flagship `QBO_REDIRECT_URI`.
- **`qbo_oauth_start`** — takes `request: Request`, derives the per-request URI, persists it on the `qbo_oauth_states` row, and threads it through `Q.authorization_url(state, redirect_uri=)` so Intuit sees the label domain on the outbound consent URL.
- **`qbo_oauth_callback`** — reads the persisted `redirect_uri` off the state doc and passes it into `Q.exchange_code(code, realm, redirect_uri=)` (Intuit does a strict-equality check on the exchange, otherwise it 400s with `invalid_grant`).
- **`_label_app_url(rec)`** — helper that derives the front-end app URL from the persisted API URI (`api.cypherpro.accountingapp.ai` → `cypherpro.accountingapp.ai`) so success/error redirects also return the user to THEIR frontend, not SmartBooks.

### 🔒 Allow-list gate
`_QBO_ALLOWED_HOSTS = {"api.smartbookssoftware.ai", "api.cypherpro.accountingapp.ai"}`. Adding a new label requires (1) appending the host here, (2) adding the callback to the Intuit Developer Portal's Redirect URIs list — either alone would 400 the flow.

### 🧪 Tests
- **`tests/test_qbo_private_label_redirect.py`** — 8 unit tests: whitelist match via `x-forwarded-host`, `Host` fallback, forwarded-host wins over host, non-whitelist → None, missing headers → None, port-suffix stripping, case-insensitive match, whitelist sanity.
- **Live curl verification** (direct backend, bypassing Emergent's ingress rewrite):
  - No forwarding header → falls back to env `QBO_REDIRECT_URI` ✓
  - `x-forwarded-host: api.cypherpro.accountingapp.ai` → `https://api.cypherpro.accountingapp.ai/api/qbo/oauth/callback` ✓
  - `Host: api.smartbookssoftware.ai` → `https://api.smartbookssoftware.ai/api/qbo/oauth/callback` ✓
- **Regression**: 152 QBO tests pass, zero new failures.

### ⚠️ Operator action required
Add `https://api.cypherpro.accountingapp.ai/api/qbo/oauth/callback` (and the callback for any other private label going live) to the Intuit Developer app's Redirect URIs list at developer.intuit.com — otherwise Intuit rejects the auth request with `invalid_redirect_uri`.



## 2026-02-21 (bugfix 3) — InventoryAdjustment Pull Diagnostics + Fallback

### 🐛 Problem
Migration preview showed **`InventoryAdjustment: 4`** but the completion tile showed **`Inv adjustments: 0`**. The pull was silently skipping adjustments with no way to see why.

### ✅ Fixes to `_pull_inventory_adjustments`
1. **Return diagnostics** — `{inserted, updated, skipped, seen, skip_reasons}`. The `skip_reasons` dict counts each rejection cause (`no_priced_lines`, `zero_net_dollars`, `exception`). CPAs can now hit the pull endpoint directly and see exactly which adjustments were dropped and why.
2. **Per-adjustment log line** — when a row is skipped, we now write an INFO log with the QBO id, raw line count, priced line count, net dollar value, and contra account name. Production log-scraping now surfaces the exact cause per adjustment.
3. **Line-level `Amount` fallback** — QBO Desktop-migrated adjustments occasionally lack a matching local item but populate `Line.Amount`. We now use `Amount / QtyDiff` to infer a cost basis instead of silently dropping the line.

### 📊 Migration finisher logging
`qbo_service.run_migration` now logs the full stats dict when `inv_adj_stats.skipped > 0`, so a scan of the migration log immediately shows why the tile is 0.

### 🔁 User remediation
Re-run the pull to get real diagnostics:
```
POST /api/companies/{cid}/qbo/mirror/pull  Body: {"entities": ["inventory_adjustments"]}
```
Response now looks like:
```json
{"inventory_adjustments": {"inserted": 0, "updated": 0, "skipped": 4,
  "seen": 4, "skip_reasons": {"no_priced_lines": 4}}}
```
`no_priced_lines` means the items referenced by the adjustments haven't been mirrored yet with cost > 0. Fix: re-pull items first (Feb 21 bugfix Round 2 patches), then re-pull inventory_adjustments.

### ✅ Test coverage
- Extended `test_pull_skips_zero_cost_items` to assert the new diagnostic fields (`skipped`, `seen`, `skip_reasons`).
- New `test_pull_amount_fallback_when_item_cost_missing` — locks in the Desktop-migration line-Amount fallback.
- 119 backend tests all green.

### Files touched
- `backend/qbo_mirror/pull.py::_pull_inventory_adjustments` — diagnostic counters, log line per skip, line.Amount fallback, extended return shape.
- `backend/qbo_service.py::run_migration` — logs inv_adj_stats when skipped > 0.
- `backend/tests/test_qbo_inventory_adjustments.py` — 1 extended + 1 new test.

## 2026-02-21 (bugfix 2) — Inventory Field Alignment (Bugfix Round 2)

### 🐛 Root cause
User deployed the Feb 21 fix, ran a fresh migration on a QBO sandbox with real inventory items, saw the migration banner correctly report "**Opening inventory: $346.25**" — but the Items page still showed every item as `SERVICE` and Inventory Management still said "0 tracked items."

Two more field-name mismatches between the mapper and the frontend:

**Bug A** — `map_item` stamped **`item_type`** (with QBO's raw enum values like "Service" / "Inventory"), but Items.jsx reads **`it.type`** (with app-native lowercase values like "service" / "inventory"). Every item's TYPE column defaulted to "service".

**Bug B** — `map_item` stamped **`qty_on_hand`**, but Items.jsx + `inventory_service.py` both read **`quantity_on_hand`**. Even for real Inventory items, the on-hand column showed "—".

The opening-inventory JE worked because it used the QBO-native `qty_on_hand`, but the display layer needed the app-native names.

### ✅ Fix
`map_item` now stamps **all three fields** so every consumer finds what it expects:
- `type` — app-native lowercase enum: `"inventory"` / `"product"` / `"service"` (mapped from QBO's Type: Inventory→inventory, NonInventory→product, Service/Group/Bundle→service). Powers the Items page display, inventory filters, and item CRUD APIs.
- `item_type` — QBO's raw enum preserved so a future outbound `Item` push can round-trip the correct Type value.
- `quantity_on_hand` — app-native alias of `qty_on_hand`, populated identically. Both read by different code paths; both stamped so no rename sweep is needed.
- `qty_on_hand` — retained (used by `_post_opening_inventory_je`).

`_UPDATE_FIELDS["items"]` expanded to include `type` and `quantity_on_hand` so re-pulls heal legacy rows.

### 🔁 User remediation
Same as the previous bugfix — a single re-pull heals everything:
```
POST /api/companies/{cid}/qbo/mirror/pull  Body: {"entities": ["items"]}
```

### ✅ Test coverage
- `test_map_item_captures_inventory_fields` extended — asserts `type=="inventory"`, `item_type=="Inventory"`, `quantity_on_hand==50.0`.
- `test_map_item_defaults_for_service_item` extended — asserts `type=="service"`.
- New `test_map_item_noninventory_becomes_product` — locks in the QBO NonInventory → app-native "product" mapping.
- 13 inventory-related backend tests all green.

### Files touched
- `backend/qbo_service.py::map_item` — added `type`, `quantity_on_hand` fields; kept `item_type`, `qty_on_hand`.
- `backend/qbo_mirror/pull.py::_UPDATE_FIELDS["items"]` — added `type`, `quantity_on_hand`.
- `backend/tests/test_qbo_inventory_migration.py` — extended + 1 new NonInventory test.

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

---

## Feb 2026 — Partner Books Deduplication (verified)

Mirrors the Firm Books dedupe. Prevents Partners from ever ending up
with duplicate "Partner Books" rows under concurrent-boot races.

**Backend**
- `partners.py::ensure_partner_books_company_for_partner` — swallows
  DuplicateKeyError from the new partial-unique index and returns the
  winning row (idempotent under races).
- `partners.py::dedupe_partner_books_companies()` — startup pass that
  keeps the oldest row per `partner_id`, deletes the rest plus child
  memberships/accounts/transactions/journal_entries/invoices/bills.
- `server.py` startup:
  - Partial-unique index `partner_books_uniq_per_partner`
    on `companies.(partner_id, is_partner_books)`.
  - Calls `dedupe_partner_books_companies()` after Firm Books dedupe.

**Regression coverage**
- `tests/test_partner_books_dedupe.py` — 3 new tests (dedupe collapses
  duplicates, ensure() swallows DuplicateKeyError, dedupe is noop).
- Full suite: `test_partner_books_dedupe.py` (3), `test_firm_books_dedupe.py`
  (3), `test_partners.py`, `test_partner_lifecycle.py` → **19/19 pass**.
- Backend supervisor: clean boot, "Application startup complete".

---

## Feb 2026 — QBO Sandbox / Production Toggle

Per-company QBO environment picker on Company Settings (immediately
above the Danger Zone). New companies default to **production**;
existing sandbox-connected companies were backfilled to `sandbox` at
startup so their tokens keep working.

**Backend**
- `.env`: added `QBO_CLIENT_ID_PROD`, `QBO_CLIENT_SECRET_PROD`,
  `QBO_ENV_DEFAULT=production` alongside legacy sandbox creds.
- `qbo_service.py`:
  - `_norm_env`, `api_base_for(env)`, `_creds_for(env)` helpers.
  - `_auth_client(redirect_uri, env)`, `authorization_url(state,
    redirect_uri, env)`, `exchange_code(code, realm_id,
    redirect_uri, env)`, `_refresh(company_id, refresh_token, env)`,
    `revoke(refresh_token, env)` now all env-aware.
  - `save_connection(company_id, realm_id, tokens, env)` stamps
    `env` on every new row.
  - `env_from_connection(conn)` — legacy rows without `env` fall back
    to sandbox (matches the backfill).
  - `_api_base_for_company(company_id)` async helper for API calls.
  - `_get` reads per-company env before every request.
- `qbo_mirror/push.py::_post` — uses `_api_base_for_company` so
  autopush POSTs hit the correct Intuit base URL for each connection.
- `routes/qbo.py`:
  - `qbo_oauth_start` persists target env on the state row and passes
    to `authorization_url`.
  - `qbo_oauth_callback` reads env off state and passes to
    `exchange_code` + `save_connection` (Intuit rejects cross-env
    exchange with `invalid_grant`).
  - `qbo_disconnect` revokes against the connection's original env.
  - `qbo_status` returns `env` (selected) + `connection_env` (active).
  - New endpoints: `GET /companies/{cid}/qbo/env`, `PATCH
    /companies/{cid}/qbo/env`. The PATCH is rejected with 409 while a
    connection is active (prevents orphaned tokens).
- `server.py` startup: one-time backfill stamps existing
  `qbo_connections` and their parent `companies` with `env: "sandbox"`
  when the field is missing.

**Frontend**
- `components/QboEnvToggle.jsx` — 2-card radio (Production /
  Sandbox), disabled + Lock pill when the company already has an
  active connection.
- `pages/CompanySettings.jsx` — slotted above the Danger Zone.

**Regression coverage**
- `tests/test_qbo_env_toggle.py` — 8 new tests (helpers, GET defaults,
  PATCH flips, PATCH rejected while connected, invalid-value coercion,
  disconnect-then-flip).
- Full QBO suite: 31/31 pass. Backend boots cleanly with backfill
  no-op'ing when no legacy rows exist.

**Intuit Developer app — TODO for user**
- Register these Redirect URIs on the PRODUCTION Intuit app
  (in addition to whatever is already on the Sandbox app):
  - `https://api.smartbookssoftware.ai/api/qbo/oauth/callback`
  - `https://api.cypherpro.accountingapp.ai/api/qbo/oauth/callback`
  - Any additional private-label callbacks the user adds later —
    they must also be appended to `_QBO_ALLOWED_HOSTS` in
    `routes/qbo.py`.

---

## Feb 2026 — QBO Migration "You'll get an email" Flow

Two-step UX + branded completion notification for the QBO bulk import.

**Frontend (`pages/QboConnect.jsx`)**
- Replaced browser-native `confirm()` with a shadcn AlertDialog
  ("Start QuickBooks migration?") whose body promises an email on
  completion — "safely close this tab, we'll email you as soon as
  it's done".
- Added a follow-up shadcn Dialog that fires immediately after the
  migration is queued: "We're migrating your QuickBooks data" +
  "you'll get an email as soon as it wraps up". Dismissible with
  "Got it".
- Added `data-testid`s: `qbo-migrate-confirm-dialog`,
  `qbo-migrate-confirm-start`, `qbo-migrate-confirm-cancel`,
  `qbo-migrate-started-dialog`, `qbo-migrate-started-ack`.

**Backend**
- `email_templates.py`: new `qbo_migration_complete()` +
  `qbo_migration_failed()`. Both use `_wrap(brand_name=…)` so
  Partner/Enterprise white-label branding cascades into the footer.
  Complete-template renders a table of non-zero stats (transactions
  posted / categorized, payments linked, estimates + POs + inventory
  adjustments pulled, opening inventory value in USD).
- `email_dispatcher.py`: registered `qbo_migration_complete` and
  `qbo_migration_failed` in `DEFAULT_PREFS` (both opt-in by default).
- `qbo_service.py`:
  - New `_notify_migration_result(job_id, company_id, ok, error)`
    helper — looks up the initiating user, picks the right template,
    dispatches via `email_dispatcher.dispatch`. Best-effort — any
    exception is swallowed so the background task can still finalise
    the job doc.
  - Called from `run_migration` after both the "done" and "failed"
    branches (including the early "QBO not connected" bail-out).
- `routes/qbo.py::qbo_start_migration` — stamps
  `initiating_user_id: user["id"]` on every new job doc so the
  background task can find who to email.

**Regression coverage**
- `tests/test_qbo_migration_email.py` — 8 new tests: template
  rendering (stats + brand), zero-stat row drop, error truncation,
  no-op when `initiating_user_id` missing (legacy jobs), dispatch
  wiring (complete + failed paths), route stamps
  `initiating_user_id`. **8/8 pass.**

**Branding cascade**
- Dispatcher already reads `initiating_user_id`'s
  `branding.firm_name` and swaps the From/footer to the white-label
  firm. Nothing extra needed — partners' clients see an email that
  looks like it came from their accountant, not SmartBooks.

---

## Feb 2026 — QBO Migration Email: Diagnostics + Manual Resend

Clarification: **email is env-agnostic**. Sandbox vs Production only
controls which Intuit API base the migration talks to — Resend is a
single service that sends the same regardless. If a completion email
doesn't arrive, the failure is upstream of Resend, not env-specific.

**Backend**
- `qbo_service.py::_notify_migration_result`:
  - Swapped silent `logger.warning` for `logger.exception` so the
    full traceback lands in Railway logs when a dispatch fails.
  - Added `logger.info` on every skip path (missing
    `initiating_user_id`, missing user email) so support can
    distinguish "no email because we never captured a user" from
    "no email because dispatch failed" at a glance.
  - Logs the Resend ID + dispatch status on success — Resend
    dashboard cross-reference becomes one grep away.
- New endpoint `POST /api/companies/{cid}/qbo/migrations/{job_id}/resend-email`
  — manually re-fires the same branded template that would have
  fired at job completion. Rejects with 400 for jobs still in
  `queued` / `running`. Accepts optional `to` body param to redirect
  to any address without permanently editing the job doc
  (synthetic user is created + torn down within the request).

**Frontend**
- `pages/QboConnect.jsx`: New "Resend email" button on the
  post-migration action row (cyan pill, `data-testid=qbo-resend-email-btn`).
  Fires the new endpoint and toasts success/failure.

**Regression coverage**
- `tests/test_qbo_migration_email.py`: 3 new tests — resend
  dispatches again, rejects non-terminal jobs, `to` override
  redirects without dirtying the job doc. **11/11 pass.**
- End-to-end verified via curl against preview:
  - Default recipient → 200, Resend ID captured.
  - Override `to` → 200, email delivered to overridden address,
    job doc `initiating_user_id` restored to original.

**How to diagnose a missing production email**
1. `journalctl | grep "QBO migration email"` on Railway — reveals
   whether the notify helper fired, skipped, or errored.
2. Query the `communications` collection for
   `related.job_id == <the job id>` — shows the dispatch attempt +
   Resend response.
3. If neither exists, the code path never ran: the deployed backend
   likely predates the `initiating_user_id` stamp on
   `POST /qbo/migrations`. Re-deploy.
4. As a last-resort recovery, the user can click "Resend email" on
   the completed migration and the email will fire immediately.

---

## Feb 2026 — Onboarding Step 2 (QBO) — Inline Connect + Copy Cleanup

**Frontend**
- `pages/Onboarding.jsx`:
  - Removed all "mock" copy from step 2:
    - Button: "Yes — link QuickBooks (mock)" → "Yes — link QuickBooks"
    - Card body: dropped "(Mocked in this MVP.)"
    - Coach script confirm text: replaced mock-link line with an
      instruction to click the Connect button now visible on-screen.
  - Added `?qbo=connected` / `?qbo_error=` query-param handler that
    snaps the wizard to step 1, toasts success/failure, then strips
    the params so a refresh doesn't repeat.
- New `components/InlineQboConnect.jsx` — compact connect + preview
  + migrate flow. Reuses the same
  `/api/companies/{cid}/qbo/{status,oauth/start,preview,migrations,disconnect}`
  endpoints as the standalone /connections/qbo page (nothing
  diverges). Passes `return_path` to `/oauth/start` so the callback
  lands the user back inside the wizard.

**Backend**
- `routes/qbo.py::qbo_oauth_start` now accepts optional
  `{return_path: str}` body. Persisted on the oauth_states row.
  Backward-compatible with the legacy bare-POST caller.
- `qbo_oauth_callback` honors the stored `return_path` for both
  success (`?qbo=connected&realm=…`) and error
  (`?qbo_error=…`) redirects — falls back to `/connections/qbo`.
- New `_safe_return_path()` helper rejects absolute URLs and
  protocol-relative paths (open-redirect guard). Silently downgrades
  bad inputs to None; only same-origin rooted paths pass through.

**Regression coverage**
- `tests/test_qbo_oauth_return_path.py`: 6 new tests — helper
  accepts valid paths, rejects open-redirects, truncates absurd
  lengths, route persists path on state row, backward-compat with
  no body, malicious input downgraded to None. **6/6 pass.**
- Full QBO test surface: 28/28 pass.

**Visual verified**
- Onboarding step 1 now renders: "Do you already use QuickBooks
  Online?" card with clean copy, "Yes — link QuickBooks" +
  "No — set up fresh" pill buttons, and the "Connect QuickBooks
  Online" panel appears immediately below when Yes is selected.
  Post-consent OAuth bounce lands the user back on `/onboarding`
  with a success toast rather than redirecting to the standalone
  QBO connect page.

---

## Feb 2026 — QBO Connect Page: Persist Migration History

**User request**: keep the "Migration complete" summary + preview
counts visible on return visits to `/connections/qbo` — currently
resets to a bare "Start migration" button on refresh.

**Backend**
- `routes/qbo.py::qbo_preview` — writes `preview_counts`,
  `preview_total`, `preview_at` to the qbo_connection row on every
  preview click so the cache stays fresh.
- `routes/qbo.py::qbo_status` — enriched response with:
  * `preview`: the cached preview counts + total from the connection
    row. Lets the "Preview scope" card render with numbers on
    revisit instead of just a button.
  * `last_job`: the most recent terminal (`done` | `failed`) job
    for this company, with its full stats payload. Lets the
    "Migration complete" card render with everything intact —
    progress bar at 100%, seeded/estimates/POs/opening-inventory
    pills, action buttons. Excludes in-flight (queued / running)
    and `stale`-marked jobs.

**Frontend**
- `pages/QboConnect.jsx::refreshStatus` — on mount, if backend
  returns `preview` or `last_job`, seed local `preview` / `job`
  state from them. Guards against clobbering in-flight polls.
- `components/InlineQboConnect.jsx::refreshStatus` — same
  rehydration inside the onboarding wizard's inline panel, so
  navigating away and back keeps the state consistent.

**Regression coverage**
- `tests/test_qbo_status_persistence.py`: 4 new tests — preview
  caches counts, status returns cached preview + latest terminal
  job, in-flight jobs excluded from last_job, stale jobs excluded.
  **All 4 pass. Full QBO suite: 32/32 pass.**

**Verified end-to-end** by seeding a done job + preview cache and
loading `/connections/qbo` — the page now renders exactly like the
reference screenshot: Connected pill, 372 records across 14 types
with per-object counts, "Migration complete" summary with stat
pills, and the full action-button row (View CoA, View Contacts,
Review Plaid Categories, Open Live Mirror, Re-run, Resend email,
Rebuild account hierarchy, Categorize imported transactions).
