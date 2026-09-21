# Rocketsuite / Axiom — Product Requirements

## Original Problem Statement
Turn the "Lab Pipeline v3" into a production categorization mode and build
a secondary modified "Chat Review" process. Extended over multiple sessions
to include: bulk update capabilities, AI cleanup grouping, directional loan
sub-account fixes, split-into-subgroups in Chat Review, embedded Chat Review
in Dashboard, cross-device preferences, and Plaid-PFC guardrails to prevent
non-fee transactions from landing in Bank Fees.

## Users
CPAs (primary) and their small-business clients (secondary).

## Core Requirements
- Categorization pipeline: Plaid → Directory → PFC → LLM → CoA
- Two modes: Standard (production) and Lab v3 (deterministic re-run)
- Chat Review: single-transaction disambiguation flow with split support
- CPA Cockpit: bulk approvals, AI cleanup suggestions grouped by contact pair
- Client Quick Check-in: bulk requests, scrollable lists
- Cross-device user preferences via `db.user_prefs`

## Bank Fees Guardrail (Feb 2026)
Two-layer defense:
- **Data**: 48 bank-institution entries in `global_contact_directory.json`
  now carry `identity_only: true` — directory recognizes them for
  contact/logo but does NOT stamp a category. Only `Bank Overdraft Fee`
  (fee-specific aliases) remains as a stampable `bank_fees` semantic.
- **Code**: `contact_resolver.py` guards the `bank_fees` semantic with a
  keyword regex (`fee|charge|overdraft|nsf|insufficient|service charge|
  monthly maintenance|atm fee|wire fee|late fee|foreign transaction|
  cash advance|returned item|stop payment`). Non-fee memos get
  `linked_semantic=None`, letting PFC/LLM decide the category.
- **Result**: Wells Fargo/Chase/Citi/BofA transfers, deposits, and CC
  payments no longer force-route to Bank Fees at Plaid ingest.

## Retroactive Cleanup
`GET /api/companies/{cid}/reviewv2/bank-fees-scan` surfaces historical
pollution for bulk reassignment. Should be run once per company after
this fix rolls out.

## Conversational Chat Review (Feb 2026)
Standalone Chat Review is now a multi-turn conversation:
- `db.chat_review_threads` persists user/AI turns keyed by `(company_id, card_key)`.
- LLM system prompt always emits `ai_message` (1–2 sentence bookkeeper reply).
- Frontend renders a scrollable thread below the reply input; no container chrome.
- Yellow contact-override collapsed to a one-line inline strip.
- Green new-account box shows a summary + Create & book; type / subtype / code + parent picker live behind an "Edit details" toggle.
- On successful book, the thread is auto-deleted so re-open starts clean.
- New endpoints: `GET/DELETE /api/companies/{cid}/reviewv2/chat-review-thread?card_key=…`.
- Scope: **standalone Chat Review only** — split-mode untouched.

## Onboarding Wizard (Feb 2026)
12-step wizard drives client setup end-to-end:
1. Starting · 2. Contact · 3. Business type · 4. Business profile ·
5. QuickBooks link · 6. AI Interview · 7. AI Chart of Accounts ·
8. Bank connection (Plaid) · **9. Credit card connection (Plaid)** ·
10. Statement upload (Veryfi) · 11. Responsibilities · 12. Ready to review.
Plaid accounts split cleanly: depository subtypes stay on step 8, `credit`
type / `credit card` subtype accounts appear on step 9. Both steps share
the same Plaid item state — one link session can populate both pages.

## Accountant Cockpit — Today v7 (Feb 2026)
Managerial dashboard at `/cockpit/today-v7`, powered by `GET /api/cockpit/today-v4`.
Three-tier ownership: AI Junior → Human Assistant → Professional.
- **Closings** live in a dedicated hero tile (6th slot, rose-tinted) that
  toggles a rose-accented **Closings panel** on click. When the panel
  is open, every other row of the dashboard is hidden (focus mode).
- Closings panel renders one row per client with unclosed prior months.
  Each row shows a **horizontal 12-month strip** built from
  `judgment.close_grid` (per-client × 12 months). Cells: green =
  reconciled/signed-off, rose = unreconciled, gray = no activity.
  Clicking a rose cell expands an inline checklist below the strip
  (fetched from `GET /api/companies/{cid}/month-close/{ym}`) showing
  the 5 real checkpoints (`txns_reviewed`, `invoices`, `bills`,
  `recon`, `closed`) with per-checkpoint deep-link CTAs and a top
  "Review & sign off →" button plus `⋮` Quick sign-off menu (server
  enforces the 4-precondition gate; failures show as toasts).
- Source of truth for "closed": `db.month_close_signoffs` with
  `kind: "closed"`. Lookback: 12 months.
- **Professional Judgment panel** is single-purpose (blocking +
  judgment-needed only). Collapses to the emerald "quiet strip" when
  empty.

## Backlog
- **P1** Retroactive Bank Fees Cleanup UI (surface `/bank-fees-scan` in Cockpit)
- **P1** IRS Compliance sub-flows: Vehicle/mileage, Business gifts, Charitable contributions
- **P1** Bank statement upload conditional trigger flow
- **P1** Owner Digest Draft (plain-English monthly digest)
- **P1** Contact Identity Spec Phase 2 (cross-source AR/AP matching)
- **P2** Sidebar Settings "Navigation Style" broken navigation
- **P2** Multi-pod stale cache / Redis disconnect handling
- **P2** Multi-company mirror booking
- **P2** Directory approval workflow
- **P2** Merge suggestions & cross-company learning
- **P2** Mobile UX Phase 2
- **P2** `/healthz` route
- **P2** Retire Standard (Legacy) categorization

## Known Issues
- Wells Fargo Plaid syncing 0 transactions (upstream, P3)
