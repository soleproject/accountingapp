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
