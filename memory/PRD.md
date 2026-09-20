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
