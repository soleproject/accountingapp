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
- ✅ Rules engine + AI rule candidates + apply-to-existing on rule creation
- ✅ Onboarding wizard (6 steps) — business profile, QBO toggle, AI CoA generation, mock Plaid, mock Veryfi, complete
- ✅ Invoices / Bills / Payments (auto-updates balance_due) / Receipts / Contacts full CRUD
- ✅ Journal Entries with debit=credit validation
- ✅ Reconciliation, Book Review, Close-the-Books (month) and Year-End Close
- ✅ Inventory / Assets / Loans / Tags / Communications / Connections generic CRUD
- ✅ Reports (5 statements) with Accrual/Cash toggle + real PDF export (ReportLab)
- ✅ AI Chat SSE streaming panel with focused-transaction context + injected books snapshot (revenue, expenses, net income, assets)
- ✅ Collapsible sidebar + collapsible AI panel
- ✅ Superadmin overview dashboard, Pro clients dashboard

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
