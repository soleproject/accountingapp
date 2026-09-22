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

## Quick Check-in Task Cards (Feb 2026)
Four new cards were added to both the To Do page and the Client Cockpit,
matching the "Reviewing Transactions" / "Paying Sales tax" pattern:
- **Liability Payments** — items where the client needs to split a
  payroll/liability payment across tax/benefit accounts.
- **Checks (missing payee)** — checks the CPA can't category without a
  payee from the client.
- **Receipt Follow-up** — transactions still missing their receipt.
- **IRS Compliance** — combined Meals + Travel §274 compliance items.

Implementation:
- Catalog entries live in `routes/responsibilities.py:CATALOG` with
  `cadence: perpetual`, tracked live from the open/scheduled
  `client_review_batches` doc grouped by `item_type`.
- Defaults to `assignment: "both"` when unset so both surfaces render
  the cards pre-onboarding; firms can opt each out via the
  Responsibilities modal (N/A support enabled).
- Expand-in-place with `CheckinItemsTile` — every row deep-links to the
  same `/api/client-review/pending/{cid}/open` redirect that
  `PendingReviewCard` uses (opens the client's magic-link Quick Check-in).
- "All caught up" state shown when a bucket is empty (green tone,
  dashed border).

## To Do 2 — Sidebar Card Mode (Feb 2026)
New "To Do 2" entry in the accounting sidebar (right below the
existing "To Do" link). Clicking it replaces the entire sidebar nav
with a filtered card list mirroring the `/accounting/todo` page 1:1
— only open items, sorted by tier (Professional → Assistant → AI).

Design:
- Each card wears the 3-tier color model (🟡 pro / 🟣 assistant /
  🟢 AI Junior) with a matching left border, chip, and icon.
- Card shows: tier chip · count badge · task label · one-line detail
  · chevron. Click routes to the item's `area_link` with
  `return_to=/accounting/todo` so the target page renders a back
  breadcrumb.
- "← Back to menu" breadcrumb at the top restores the normal nav.
- Empty state: "🎉 You're clear. Enjoy the quiet."
- Only shows items with `status !== "done"` AND `status !== "n/a"`,
  and hides tracked-zero-count items that aren't in-progress.

Implementation:
- New `Todo2CardList.jsx` component; consumes the same
  `/companies/{cid}/responsibilities/status?scope=both` endpoint the
  ToDo page uses.
- Local sidebar state `todo2Mode`; passed into `ProductAccordion` as
  `onOpenTodo2` prop. Old "To Do" link kept alongside (both surfaces
  coexist per user's request).

## Checks Card — Per-Check Row Explosion (Feb 2026)
The Checks (missing payee) card no longer shows the aggregate item
as one summary row. It now explodes into **one row per unresolved
check**, each with date · check number · amount · dedicated Answer
button. Clicking Answer expands only that check's allocator (Payee
+ Categories & amounts) inline. Card count reflects the number of
UNRESOLVED checks (was 1 aggregate → is now 4 checks).

Implementation:
- Backend `responsibilities.py`: for `checks_no_payee` the count sums
  unresolved checks across all aggregates (was `len(bucket)`).
- Frontend `CheckinItemsTile`: `_explode(it)` maps a type-13
  aggregate into N virtual rows with `_rowKey = aggregateId::checkId`
  and `_aggregateId` preserved so the save endpoint still targets the
  parent batch item.
- Frontend `ChecksAllocatorInline`: new `filterCheckId` prop scopes
  the allocator to one check when the tile mounts it per-row; header
  hidden in single-check mode. New `onCheckSaved(checkId, allDone)`
  fires immediately on each row save so the tile drops the row
  optimistically.

## Checks (Missing Payee) — Full Inline Allocator (Feb 2026)
The Checks card no longer opens a payee-name-only mini-form; it now
expands into the same multi-line allocator UI that lives on the Quick
Check-in page — inline on the To Do / Client Cockpit.

Per check card:
- Header: `#Number · Date · $Amount · Save`
- **PAYEE** dropdown (existing contacts, sorted) with an inline
  "type a new payee" text field when nothing selected. New payees
  are auto-created via the shared check-assign flow.
- **CATEGORIES & AMOUNTS**: N-line allocator, each line is either an
  open Bill or a GL Account. "+ Add another line" appends; per-line
  ✕ removes. Live total-vs-check validation, green ✓ or red delta chip.
- Per-check Save button — each row saves independently. When every
  check in the aggregate is saved the backend marks the whole item
  answered and the tile drops it.

Backend plumbing:
- Refactored `apply_check_assign(batch, item, body)` and
  `load_pickable_options(cid)` into shared helpers in
  `routes/client_review.py`.
- New firm-auth endpoints in `routes/responsibilities.py`:
  - `GET  /api/companies/{cid}/checkin/pickable`
  - `POST /api/companies/{cid}/checkin/items/{item_id}/check-assign`
- `_open_checkin_items_by_bucket` now plumbs `context.checks` +
  `resolved_txn_ids` through for type 13 so the frontend renders
  one card per check without a second round trip.

## Voice-Fill for Check-in Answer Forms (Feb 2026)
Each inline Answer form now has a single "🎤 Speak to fill" button at
the top. User records one utterance ("Lunch with John from Acme to
discuss Q4 pricing"), backend runs Whisper transcription + a
lightweight GPT-4o-mini structured extraction call, and the fields
auto-fill with a 1.8s emerald sparkle-glow animation.

Design guarantees:
- One mic per form instance (not per field, not per card). Users
  describe once, the AI splits the sentence across relevant fields.
- **Never overwrites typed content** — form tracks a `touched` set so
  any field the user has touched is protected from voice-fill.
- **No hallucinated fields** — server whitelists the extraction by
  `item_type` (meals → attendees/purpose only; travel → +destination
  +dates; check → payee only; receipt → notes only) so the LLM can't
  bleed the merchant name into the destination slot.
- **Transparent transcript** — the raw transcription stays visible as
  an italicized quote below the mic so the user sees exactly what
  the AI heard.
- **Graceful fallback** — if extraction can't split anything, the raw
  transcript lands in the Notes field with a toast.

Endpoint: `POST /api/companies/{cid}/checkin/voice-extract`
(multipart audio + `item_type` + `txn_context_json`) — uses Whisper-1
+ gpt-4o-mini via the Emergent LLM key.

## Compliance Library — Substantiation Rendering (Feb 2026)
The `/compliance` page now surfaces the structured substantiation
fields collected via the inline Answer form:

- Backend `GET /api/companies/{cid}/compliance/entries` merges the
  substantiation payload from three sources (finding `meta.client_payload`,
  batch item `answered_payload`, transaction `irs_substantiation`) so
  it renders regardless of which write path stamped the data first.
- New `substantiation` sub-doc on each entry: `{business_purpose,
  attendees, destination, trip_start, trip_end}` — populated fields
  only.
- New `answered_by_pro` + `answered_by_email` fields for audit trail.
- Frontend `CompliancePage.jsx` renders a dedicated **Substantiation**
  block (indigo-tinted) above the Client Answer, with per-field rows
  and a "Recorded by …" footer when a pro filled it in on behalf of
  the client.

## Quick Check-in Inline Answer Forms (Feb 2026)
Clicking "Answer" on any row inside a `CheckinItemsTile` now expands
the row in-place with an IRS-aware substantiation form — no bounce
to the magic-link Check-in page for common cases.

Per item-type field set:
- **Meals (§274, type 10)** — attendees (required) · business purpose
  (required) · optional receipt (required when amount ≥ $75).
- **Travel (§274, type 14)** — destination (required) · business purpose
  (required) · trip start/end dates · optional attendees · optional receipt.
- **Missing Receipt (type 3)** — receipt upload (required) · optional memo.
- **Liability Payment (type 9)** — statement upload (AI split) OR
  manual Principal / Interest / Escrow / Fees fields. Client-side
  total-must-match validation.
- **Checks (type 13)** — payee-name only (MVP). Full multi-line ledger
  allocation still lives on the Quick Check-in page.

Backend plumbing:
- New firm-authenticated shim `POST /api/companies/{cid}/checkin/items/{item_id}/submit`
  (multipart with `answer`, `payload_json`, optional `file`) delegates
  to the existing typed handlers.
- New `_handle_irs_substantiation` in `client_review_handlers.py`
  writes `db.transactions.$.irs_substantiation` (attendees, purpose,
  destination, dates, actor + timestamp) so the Compliance record
  lives with the transaction forever, independent of the batch.
- `_mirror_upload_to_receipts_page` extended to Q10 & Q14 with the
  substantiation fields baked into `receipts.notes` + a structured
  `receipts.irs_substantiation` sub-doc.
- Batch item stamped `answered_by_pro: true` + `answered_by_email`
  for audit trail.

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
