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

### P1
- Real Plaid Link SDK wiring (replace mock endpoint)
- Real QBO OAuth + entity sync
- Real Veryfi document upload + OCR
- Voice interface for AI chat ("regarding the Walmart purchase on…")
- Recurring transactions / bill scheduling
- Sales Tax Liability + 1099 Summary reports (tiles reserved)
- CSV / bank statement direct import UI
- Enforce closed-period locking on transaction edits

### P2
- Firm branding / white-label for Pro accounts
- Multi-currency support
- Budget vs. actual reports
- Email/notification hooks for flagged txns (SendGrid / Resend)
- Attachment upload on transactions (object storage)
- Audit log
- Stripe subscription billing for the SaaS itself
