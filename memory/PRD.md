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

## NMI Payments Gateway — Underwriter Portal + Hosted Pay (Feb 2026)
Full end-to-end merchant-payments stack layered on NMI's v5 REST API. Five phases shipped together, all wired through `nmi_service.py` which reads per-merchant credentials from `db.merchant_payments_credentials` (encrypted with `crypto_service`). No card data ever hits our origin — the browser tokenizes via NMI's `@nmipayments/nmi-pay-react` Payment Component and we only see the one-time payment token (PCI SAQ-A stance).

**Phase A — Underwriter Review Portal** ✅ ship-ready today
- New `underwriter` role with a dedicated stripped-down sidebar (only Merchant Review) and post-login redirect to `/admin/merchant-review`.
- Portal at `/admin/merchant-review` (page: `MerchantReview.jsx`): two-pane list-detail. Left rail buckets submitted / approved / declined apps. Right pane shows the fully decrypted application (EIN, SSN, DOB, owner list) plus every uploaded document (voided check, IDs, statements) previewable/downloadable inline.
- **Approve action** — captures NMI Security Key, Tokenization Key, Processor ID, Webhook secret, environment (sandbox/production), per-merchant surcharge %. All encrypted at rest. Flips `company.payments_enabled = true` and fires an approval email via Resend.
- **Decline action** — free-text reason + internal note, emails the client via Resend, keeps `payments_enabled = false`.
- **Rotate keys / Reconsider** — approved/declined apps can be re-approved to rotate keys or overturn a decline in place.

**Phase B — Hosted Invoice Payment** (Payment Component, PCI SAQ-A)
- Public route `/pay/:token` (`HostedPay.jsx`) — customer-facing, no auth. Loads NMI's `<NmiPayments>` Payment Component with the merchant's **public** tokenization key only. Card / ACH / Apple Pay / Google Pay in one component.
- Backend: `POST /api/companies/{cid}/invoices/{iid}/pay-link` mints an invoice's `public_token`. `GET /api/pay/{token}/config` returns invoice + business name + tokenization key + **dual-pricing** breakdown (card_total = balance × (1 + surcharge_pct/100), ach_total = balance). `POST /api/pay/{token}/sale` recomputes the amount server-side and hits `nmi.run_sale` — the browser never dictates what to charge.

**Phase C — Customer Vault (saved payment methods)**
- Opt-in "Save this card" toggle on the hosted page → `add_to_customer_vault: true` flag on the sale → NMI returns `customer_vault_id` we persist to `nmi_transactions.customer_vault_id`. No PAN. Future recurring sales pass `customer_vault_id` in `payment_details`.
- `DELETE /api/companies/{cid}/nmi/vault/{vault_id}` — customer-requested removal, cascades the `payment_methods` list on any contact.

**Phase D — Webhooks (real-time status)**
- `POST /api/nmi/webhook/{company_id}` — public but HMAC-SHA256 verified against the merchant's `webhook_secret`. Handles `transaction.sale.success/.failure`, `transaction.refund.success`, `transaction.void.success`, `ach.return.*`, `chargeback.*`. Idempotent by `event_id`; every event lands in `db.nmi_events`. Chargebacks / ACH returns automatically reopen the invoice.

**Phase E — Refunds & Voids**
- `POST /api/companies/{cid}/nmi/transactions/{txn_id}/refund` — partial (`amount`) or full (`amount: null`); status flips to `refunded`.
- `POST /api/companies/{cid}/nmi/transactions/{txn_id}/void` — pre-settle voids; status flips to `voided`.
- Both call `nmi.refund_payment` / `nmi.void_payment` under the hood; both restricted to the merchant's own users via `require_company`.

**PCI stance**: Payment Component → PAN never touches our origin. Customer Vault → tokens only. Merchant Security Key + Webhook Secret encrypted at rest via `crypto_service` (`enc_v1:` sentinel). Confirmed with sandbox test approve flow.

**Awaiting from Paul** (NMI merchant contact): webhook signing secret (Transaction Options → Webhooks → Generate). Backend endpoint `POST /api/nmi/webhook/{company_id}` is built and HMAC-verified; just needs the secret dropped into `merchant_payments_credentials.webhook_secret` on any approved merchant.

**Sandbox credentials in use** (approved merchant `Test 9-21 LLC` / cid `c2bf80c9-cc3d-4cd2-9fe3-6a536073cf93`):
- Gateway ID: `1346499`
- Private Security Key: `23y4BWDe62jvTPxNH88y3Zxcf4T8fE92` (encrypted at rest with `enc_v1:` sentinel)
- Public Tokenization Key: `K33a2K-RQ845q-Y3g4F4-3FxG87` (plain; browser-facing)
- Verified end-to-end: real $2 sandbox sale succeeded (transactionid `12587827430`), void succeeded (`Transaction Void Successful`).


## Payments Application (Get Paid Faster) — 3-Step Wizard (Feb 2026)
`/welcome/payments` intake is now split into a 3-step wizard with a
numbered progress bar pinned at the top:
1. **Business** — legal/EIN/DBA/address/contact/volume fields (required list mirrors backend `_BIZ_REQUIRED`).
2. **Signers** — beneficial owners; forward-gate requires ≥ 80% combined ownership and all owner fields.
3. **Uploads** — voided check + signer ID (required) plus optional processing/bank statements.
Rules:
- Each step's Next button is disabled until that step is valid; forward jumps via the stepper pips honour the same gating.
- Back never validates.
- The **Submit application** button only renders on step 3, and stays disabled/dimmed until every step is valid (`allValid`) — no more submitting from a half-empty step 1.
- Returning users auto-jump to the first incomplete step on load.
- Autosave (1s debounce) and "Save & continue later" remain available on every step.
- **Legal name auto-populated** — GET `/companies/{cid}/payments-app` seeds `business.legal_name` from `companies.name` for empty drafts and back-fills it on returning drafts that never filled the field.
- **Firm-wide roll-up** — `GET /api/pro/payments-apps` returns every payments application across the caller's memberships, bucketed by status (drafts first, then submitted, each sorted by most-recent update). Rendered as the "Payments applications" card in Pro Cockpit (`CockpitTodayV7 → PaymentsAppsPanel`) with per-client progress bars and a one-click "Open" that switches company and jumps to `/welcome/payments`.


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

## Quick Check-in — Receipts-First + One-Txn-at-a-Time (Feb 2026)
Structural rewrite of the client's Quick Check-in queue to match the
Review Chat dialogue feel — every card is a single transaction, not
a group, and the queue is reordered so **Receipts Required goes first**
so any receipt parsing can cascade forward into sibling Uncategorized
items.

Backend (`/app/backend/client_review.py`):
- `_TYPE_ORDER[ITEM_MISSING_RECEIPT] = 0.5` — Receipts sort before
  Uncategorized (was 6, sat after Uncategorized).
- `_build_uncategorized_items` no longer groups by `(contact_id,
  direction)`. Emits ONE item per transaction with `source_collection
  = "transactions"`, `source_id = txn_id`, `context.grouped = False`,
  and single-txn context (`amount`, `date`, `description`, `merchant`,
  `contact_id`, `direction`, `account`, `txn_id`). Cap 30 items so a
  week's queue stays under thumb.

Seed (`scripts/seed_9_24_llc_all_types.py`):
- Force-append block rewritten to emit per-txn Uncategorized items
  identical in shape to production.
- Whole `items` list resorts by `_type_priority` at the end so
  Receipts → Uncategorized → Owner/Deposit/Liability/etc. ordering
  matches production regardless of insertion order.

Frontend (`/app/frontend/src/pages/ClientReviewPage.jsx`):
- No code changes required — the existing `item_type === 1 &&
  !currentItem?.context?.grouped` render path (line 1095) drives the
  single-txn card via `UncategorizedShortcuts` (per-row Edit /
  Receipt / Link actions). `GroupedTxnListCard` remains in the tree
  for backward compat on any legacy batches with `grouped=True`
  items already persisted.

Behavior:
- Queue order: Missing Receipts (type 3) → Uncategorized single-txn
  (type 1) → Owner's Draw → Deposit → Liability → Check no payee →
  Ambiguous Transfer → IRS Meals → IRS Travel → W-9 → dormant.
- Every Uncategorized txn gets its own dialogue turn (chat bar routes
  through `/turn` → `/answer` on that specific txn only), matching
  Review Chat's UX at the single-row granularity.
- Cap 30 individual Uncategorized items per batch (was 20 groups
  covering up to 200 txns).
- Backward compat: existing minted batches with `context.grouped ==
  True` items still render via `GroupedTxnListCard`.

Verified: seed produces 19 items, Missing Receipt renders at
position 1 in the client-review UI, "0 of 19 done" counter correct,
5 individual per-txn Home Depot / Priya Patel Uncategorized items
sit adjacent right after.

## Backlog
- **P1** NMI Webhook signing secret (blocked on user providing key)
- **P1** Retroactive Bank Fees Cleanup UI (surface `/bank-fees-scan` in Cockpit)
- **P1** IRS Compliance sub-flows: Vehicle/mileage, Business gifts, Charitable contributions
- **P1** Bank statement upload conditional trigger flow
- **P1** Owner Digest Draft (plain-English monthly digest)
- **P1** Contact Identity Spec Phase 2 (cross-source AR/AP matching)
- **P1** Marketing site migration (`www.smartbookssoftware.ai` vs `app.smartbookssoftware.ai`)
- **P2** Sidebar Settings "Navigation Style" broken navigation
- **P2** Multi-pod stale cache / Redis disconnect handling
- **P2** Multi-company mirror booking
- **P2** Directory approval workflow
- **P2** Merge suggestions & cross-company learning
- **P2** Mobile UX Phase 2
- **P2** `/healthz` route
- **P2** Retire Standard (Legacy) categorization

## NMI Production Hardening (Sep 2026)
Bundle shipped to make merchants safe to flip live:

- **Fail-closed webhook verification** (`payments_gateway.py:462-471`) — refuses to process events unless a signing secret is on file, closing the previous silent bypass.
- **Credential preflight on save** (`nmi_service.validate_credentials`, hits `https://secure.nmi.com/api/query.php`) — wired into both `PUT /underwriter/apps/{cid}/gateway-keys` and the inline path of `POST /apps/{cid}/approve`. Bogus/wrong-key credentials can never reach `db.merchant_payments_credentials`.
- **Production toggle two-step confirmation** — `GatewayKeysIn.confirm_live` required when `environment="production"`; frontend `GatewayKeysModal` shows a rose-bordered callout with the merchant name and a mandatory checkbox. Approve modal path forces underwriters into the dedicated Gateway Keys tab for production writes.
- **Environment history audit** — every sandbox↔production flip appends to `env_history[]` on the credentials doc; surfaced as a collapsible in the Gateway Keys panel.
- **LIVE / TEST environment pill** — bold rose LIVE badge on production, amber TEST badge on sandbox. Data-testid `gk-env-pill`.
- **Webhook URL helper UI** — copy-to-clipboard box in the Gateway Keys panel with the merchant-specific `POST /api/nmi/webhook/{cid}` URL. Shows "Last webhook received {date}" once events start landing; nudges "Paste inside NMI's Merchant Portal → Options → Settings → Webhooks" until then.
- **Customer receipt emails** — after a successful `POST /pay/{token}/sale`, sends a plain HTML receipt to `customer_email` (from body or invoice) with amount, invoice#, method (card/ACH), card last-4 if present, and NMI confirmation ID. Best-effort — email failure never rolls back the payment.

## Info Request Channels (Sep 2026)
Underwriter info requests now support TWO response paths in parallel:

**Portal path** (Milestone 1)
- Client-side `InfoRequestResponseCard` component replaces the old wizard-only "Update & resubmit" banner on `/welcome/payments` when status is `waiting_on_client`.
- Multi-file drag-drop upload (per-file `POST /companies/{cid}/payments-app/upload`, refresh-safe via new `GET /companies/{cid}/payments-app/files`).
- Optional written-reply textarea.
- On Send → `POST /companies/{cid}/payments-app/submit` with `{response_note}`; server-side gate validates against the request's `response_type` and closes the info request with `response_channel="portal"`.
- Wizard "Update full application" remains as an escape hatch.

**Magic-link path** (Milestone 2)
- Signed HMAC token in `link_tokens.py` — derived via HKDF from `FIELD_ENCRYPTION_KEY`, 7-day TTL, single-use.
- Email includes "Respond directly →" CTA linking to `/respond/:token`.
- Public endpoints (`routes/public_info_request.py`):
  - `GET  /api/public/info-request/{token}` — resolves + returns note/type/biz-name.
  - `POST /api/public/info-request/{token}/upload` — multi-file, tagged `via_link_rid`.
  - `GET  /api/public/info-request/{token}/files` — refresh-safe list.
  - `DELETE /api/public/info-request/{token}/files/{fid}` — soft-remove staged file.
  - `POST /api/public/info-request/{token}/respond` — closes with `response_channel="link"` + `nonce_used`.
- Standalone page `InfoRequestResponse.jsx` at route `/respond/:token`. No auth wrapper. Renders success (Sent), expired (410 fallback), invalid (401 fallback), and already-responded states.
- Env var: `APP_PUBLIC_URL` for link generation (falls back to `QBO_APP_URL`).

**Shared enhancements**
- `info_requests[]` entry schema: `{id, note, response_type, requested_at, requested_by, responded_at, response_note, response_channel, response_file_ids, nonce_used}`.
- `RequestInfoModal` on the underwriter side has a 3-option toggle (Documents / Written reply / Either) — stored on the entry, drives the client UI + submit gate on both paths.
- Underwriter gets an email when a client responds (both paths); opt-out via `users.prefs.notify_on_response`.
- `MerchantReviewDetail` Additional Requests timeline shows: response type pill ("Docs required" / "Text required"), the client's reply in a violet callout, response channel (**"via portal"** or **"via email link"**).

## Underwriter Portal — 7-Bucket Workflow (Sep 2026)
Portal sidebar now has 7 lifecycle buckets in this order:

1. **Application Started** (`draft`) — clients mid-signup, visible so underwriters can proactively reach out.
2. **Awaiting Review** (`submitted`) — freshly submitted, nothing touched yet.
3. **Processing Review** (`processing`) — underwriter picked up. Set automatically on first detail-page open (silent), also via manual "Start Review" button on `submitted` / `info_received`.
4. **Waiting on Client** (`waiting_on_client`) — underwriter requested more info via `POST /underwriter/apps/{cid}/request-info` with a note (min 4 chars). Client receives an email + sees a matching banner (orange callout with the note verbatim) on their `/welcome/payments` page.
5. **Info Received** (`info_received`) — client re-submitted from `waiting_on_client`. Automatically set by `submit_payments_app` when prior status was `waiting_on_client` or `info_received`. Fresh submissions still go to `submitted`.
6. **Approved** (`approved`)
7. **Declined** (`declined`)

Endpoints added:
- `POST /api/underwriter/apps/{cid}/mark-processing` — flips `submitted`/`info_received` → `processing` (idempotent from `processing`).
- `POST /api/underwriter/apps/{cid}/request-info` — flips to `waiting_on_client`, saves `info_request_note`/`info_requested_at`/`info_requested_by`, sends email.

Frontend files updated: `Sidebar.jsx` (7 nav items + live badges), `MerchantReviewList.jsx` (status maps + "Last activity" column with fallback), `MerchantReviewDetail.jsx` (auto-claim + Start Review / Request Info buttons + info_request_note callout + info_received callout), `MerchantReviewModals.jsx` (new `RequestInfoModal`), `PaymentsApplication.jsx` (client-side "Info requested" banner card).

Backend files updated: `underwriter.py` (expanded `_ALL_STATUSES`, new endpoints, new `_request_info_email_html` template), `payments_app.py` (submit resolves prior `waiting_on_client` → `info_received`, sets `info_received_at`).

## Receipts Modal — AI Phase 2 "Review Card" Refactor (Feb 2026)
After GPT-4o vision scans a receipt, the modal now collapses the four
small header fields (Date · Vendor · Amount · Paid from) into a single
clickable summary pill so the line-item CoA breakdown has more room to
breathe. Missing "Paid from" pulses amber. Tap the pill → inline field
editor drops down underneath.

Notes replaced with a `+ Add note` / preview button. Clicking opens a
dedicated in-modal note screen with:
- Standard textarea
- Large circular mic button (96×96) — Whisper via
  `POST /api/reviewv2/transcribe` using `useVoiceRecorder` hook
- Smart insert: replace when draft is empty, append with a space when
  non-empty
- Save note / Cancel controls

Files updated: `frontend/src/pages/Receipts.jsx` (added `pillOpen`,
`noteView`, `noteDraft`, `transcribing`, `voiceError` state; wired
`useVoiceRecorder`; injected compact-mode IIFE at top of form block).
Manual mode and Edit mode preserve the classic vertical form.

## Receipts — Category Drill + Multi-Line Split JE (Feb 2026)
On the AI Phase 2 review card, each category bubble is now a button.
Tap it to open a dedicated drill screen showing every line item in
that group with a per-item CoA picker under each row. Bulk actions:
  - "Move all N to …" (default)
  - Checkbox mode toggle → "Move X selected to …"
Edits persist in-modal via an `editedLines` working copy that also
feeds the review-card preview so moves reflect immediately.

On Save, the frontend sends `line_items[]` with resolved
`{description, amount, account_id, account_code, account_name}` per
line. Backend groups by `account_id` and posts a split JE:
  - CR payment_account for the total
  - DR one expense line per unique account (rounding delta absorbed
    by the biggest bucket so the JE always balances)

**Side-fix**: the single-line fallback path used to book DR cash /
CR revenue (a "sales receipt"), even though the Receipts UI is for
*expense* receipts and the category picker filters to `type=expense`.
Both paths now book DR expense / CR cash consistently.

Files updated: `backend/models.py` (`ReceiptCreate.line_items`),
`backend/posting_service.py` (`post_receipt_je` split logic),
`frontend/src/pages/Receipts.jsx` (drill screen, editedLines state,
bulk toolbar, clickable category bubbles).

## Receipts — Paid-From Resolver + No-Doubling (Feb 2026)

**Sales tax split** — updated `_RECEIPT_CATEGORIZATION_PROMPT` to
force sales tax onto its own line under a dedicated tax account
(Sales Tax Paid / Taxes & Licenses / Sales Tax Expense), never
lumped with the underlying goods.

**Paid-from resolver** (`PaidFromResolver` in Receipts.jsx) — opens
when Save is pressed with an empty payment account:
  - Top pill: **"Personal Account"** (violet CTA) — auto-creates or
    finds a liability account `2350 · Due to Owner` (falls to 2351+
    if 2350 is taken by the CoA seed), then books receipt CR side
    there so the company's ledger reflects it still owes the owner.
  - Below: searchable, scrollable list of asset + liability accounts.

**No-doubling links** — new `receipt_match.py`:
  - `find_matching_transaction(cid, account_id, date, amount)`
  - `find_pending_receipt_match(cid, account_id, date, amount)`
  - `link_receipt_to_transaction(cid, receipt, txn)` — copies the
    receipt's `line_items[]` split onto the transaction (top-level
    `category_account_id` = biggest bucket for legacy views),
    cross-links `matched_receipt_id ↔ matched_transaction_id`,
    reverses the receipt's JE if one was posted.

Two match hooks:
  1. `create_receipt` (routes/payments.py) — attempts match immediately
     on save when `payment_account_id` is set and `paid_personally` is
     False.
  2. `categorize_and_insert_plaid_txns` (plaid_connect.py) — scans
     newly-inserted transactions for pending unmatched receipts.

**JE flip fix** — the single-line receipt JE fallback used to book
DR cash / CR revenue (a sales receipt), even though the Receipts UI
is for *expense* receipts. Multi-line path books DR expense / CR
cash correctly; fallback now matches.

**Files touched**: `backend/models.py` (`ReceiptCreate.line_items`,
`paid_personally`), `backend/posting_service.py` (multi-line split
+ direction fix), `backend/client_review_engine.py` (tax prompt),
`backend/routes/payments.py` (auto-match hook, owner-liability
endpoint), `backend/plaid_connect.py` (ingest match sweep),
`backend/receipt_match.py` (new module),
`frontend/src/pages/Receipts.jsx` (resolver, drill screen,
compact review card, big-mic note screen, taller modal).

## Receipts — Canonical Kind-Based Resolver (Zero Hallucinations, Feb 2026)

**Problem**: GPT-4o vision could return `account_name`s that don't exist
on the company's real CoA (e.g. "Fertilizer & Chemicals" for a lumber
receipt on an ag-flavored CoA). Even when the AI's name looked
plausible, if it didn't match anything on `db.accounts` the receipt
got stamped with garbage that never reconciles.

**Fix**: The prompt now returns a `line_kind` enum per line (closed
set: `tax`, `shipping`, `fuel`, `vehicle`, `repairs`, `meals`,
`office_supplies`, `software`, `utilities`, `telecom`, `insurance`,
`rent`, `professional_fees`, `bank_fees`, `travel`, `advertising`,
`uncategorized_expense`, `matched`). Server-side, a new
`curated_receipt_accounts.resolve_line_account()`:

  1. If `kind` is generic → find an existing expense account by
     alias regex on `db.accounts`; if none exists, auto-create from
     a canonical spec (`Taxes & Licenses` 6500, `Shipping & Delivery`
     6420, `Fuel` 6440, etc. — 17 kinds total).
  2. If `kind` is `matched` → fuzzy-match the AI's proposed
     `account_code` / `account_name` against real accounts (exact
     name / code first, then substring within expense-family).
  3. On total miss → auto-create + land on `Uncategorized Expense`
     6999. Line still gets stamped with a real `account_id`.

Auto-created accounts:
  - `type=expense`, `subtype=operating_expense`, canonical `detail_type`
  - `system_generated=True`, `auto_created_purpose=receipt_kind:<kind>`
  - Preferred code in the 6000-6999 band; increments to next free
    slot if colliding with an industry-seed code (same self-healing
    pattern as owner-liability).

Hooked into both:
  - `/api/companies/{cid}/receipts/analyze` (routes/payments.py) —
    post-processes the AI response before returning to the FE.
  - Quick Check-in categorization path (routes/client_review.py) —
    same post-process before persisting on the batch item.

**Files**: `backend/curated_receipt_accounts.py` (new),
`backend/client_review_engine.py` (prompt update),
`backend/routes/payments.py` (resolver hook),
`backend/routes/client_review.py` (resolver hook).

## Onboarding Pricing → Stripe Checkout with 7-day trial (Feb 2026)
The `/welcome/pricing` step now wires **all four plans (Core, AI
Assistant, AI Bookkeeper, Advanced) × both cadences (monthly, annual)**
into Stripe Checkout with a 7-day free trial — 8 SKUs total.
- Provisioned an Emergent claimable Stripe sandbox for preview so we
  don't touch the user's live account. Real test-mode keys live in
  `backend/.env` (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_ACCOUNT_ID`, `STRIPE_MODE=test`).
- Backend `_price_id(product, discount, cadence)` resolves via
  `STRIPE_PRICE_<PRODUCT>_<CADENCE>` (preferred). Legacy discount-tier
  and `_MONTHLY_38/19` keys still supported.
- `CheckoutSessionIn.trial_period_days` and `.cadence` are new
  optional fields on `POST /api/companies/{cid}/billing/checkout-session`.
- Frontend `PricingPlans.jsx`: all 4 cards carry `stripeProduct` +
  `trialDays: 7`. Their CTAs read "Start 7-day free trial" with a
  ⭐ trial ribbon. Cadence toggle (Monthly/Annual) is honored in the
  API call. Redirect via `window.location.href`.
- User's LIVE product IDs are documented at
  `/app/memory/STRIPE_LIVE_CATALOG.md` (all 8 SKUs) for Railway.
- Verified end-to-end on all 8 combinations: Stripe Checkout renders
  correct plan name, "7 days free", correct billing cadence line
  (per month vs per year), "Total due today: US$0.00", "Start trial".
**Files**: `backend/.env`, `backend/routes/stripe_billing.py`,
`frontend/src/pages/PricingPlans.jsx`, `memory/STRIPE_LIVE_CATALOG.md`.

## Review Chat FAQ Action Links (Feb 2026)
Each of the 5 FAQ cards in the Review | Chat panel (`ReviewStartersPane`)
now surfaces a clickable action link inside its expanded content — no
need to type into the chat box to invoke the matching help flow.
- **How does this work?** → "▶ Start the tour" fires
  `chat-review-start-tour` window event; `ChatReview.jsx` mounts the
  19-beat Guided Walkthrough (same as the header Tour button).
- **View all transactions** → "▶ Show me how" runs new lightweight
  `view-all-transactions` playbook (2 beats: narrate + synthetic click
  on `chat-review-show-all`).
- **Multiple contacts / Multiple categories / Link to a bill or
  invoice** → "▶ Walk me through it" fires the pre-authored
  `wrong-mixed-contacts` / `wrong-mixed-categories` / `link-to-invoice`
  playbooks via `chat-review-run-playbook` with `force: true` so the
  demo runs even on cards under the normal `sampleCount >= 5` gate.
**Files**: `frontend/src/components/AiPanel.jsx`,
`frontend/src/pages/ChatReview.jsx`,
`frontend/src/tours/reviewChatPlaybooks/index.js`.

## Known Issues
- Wells Fargo Plaid syncing 0 transactions (upstream, P3)
- P0 Theme Coloring bug (saved brand colors never applied to live CSS
  vars on boot) — deferred by user preference


## 2026-10-01 — In Progress company multi-select
- Added multi-select company filter (search, select all, clear, removable chips) to the Cockpit In Progress panel; filters all 6 tabs + badge counts.
- Backend `today-v4` now returns `company_id`/`company` on in_progress, blocking and judgment_needed items.
- P0 Theme Coloring bug still OPEN (13 sessions).

## 2026-10-01 — Inline QC viewer in In Progress
- Every QC-backed row (Messages, AI Email Questions, Scheduled / Awaiting / Engagement) has an "Open QC" button that loads the client Quick Check-in inline (iframe to /client-review/{token}) under the tab strip; tabs stay clickable and switching tabs returns to the list. "Open in new tab" link included.
- Backend scheduled-qc + today-v4 now return client_token on batch rows.

## 2026-10-01 — Scheduled QC pills
- Scheduled QC tab now has Scheduled / Missed / No Response pills. Scheduled = upcoming + emailed-in-progress; Missed = scheduled_for passed with zero engagement (shows reminded/nudged); No Response = emailed with 0 answers + expired-unanswered (60d) + never-completed clients.
- Backend scheduled-qc returns `missed` and `expired_no_response` arrays.

## 2026-10-01 — QC lifecycle pills + client reminders
- Scheduled QC pills: Scheduled (client-picked date+time, future) / In Progress (engaged: answers, defers, follow-up or parked questions; shows follow-up time) / Missed / No Response / Completed.
- Client QC footer: "Don't have it now — remind me" (per-question snooze → POST /{token}/items/{id}/snooze, item parked & skipped, ParkedScreen when all remaining are parked) and "I'll finish later" (POST /{token}/follow-up). ScheduleModal generalized with presets (Tomorrow 9 AM / In 3 days / Next Monday).
- Cron send_follow_up_reminders() in client_review_tick sends one "follow_up" email when follow_up_at / snoozed_until arrives.

## 2026-10-01 — Parked question chips
- In Progress rows show one chip per parked question (prompt + "reminds <date time>", "reminded" once sent). Backend scheduled-qc in_progress rows carry `parked[]` {item_id,prompt,item_type,remind_at,reminded}.

## 2026-10-01 — One-click nudge
- "Send reminder" button on Missed + No Response (emailed, live) rows → POST /api/cockpit/scheduled-qc/{batch_id}/nudge sends the 3-CTA passive_miss reminder, stamps manual_nudge_at/count; row shows "Reminded Xm ago · ×N". Expired/completed batches are rejected (409). Test-domain recipients surface as "Not sent — test address".

## 2026-10-01 — Jump to question
- Parked chips are buttons → open inline QC viewer with ?item=<item_id>; ClientReviewPage honors ?item= on load (even if parked). Answering a parked item clears snoozed_until locally.

## 2026-10-01 — Live row refresh
- ClientReviewPage posts `qc:changed` (postMessage, same-origin) to parent on any progress change; InProgressPanel listens, debounces 600ms, re-pulls /cockpit/scheduled-qc + today-v4. QC pill selection lifted to InProgressPanel so it persists across the inline viewer.

## 2026-10-01 — Answered by pro attribution
- Inline viewer / Messages nav open QC with ?via=pro; ClientReviewPage then POSTs /{token}/items/{id}/attribute with the pro JWT after each markCompleted → items.$.answered_by {user_id,name,email,role,via,at}, batch.pro_participants, audit_events `client_review.item_answered_by_pro`. Header chips: "answering as pro", "answered by <name>" (client sees "by your bookkeeper"). Cockpit rows show "N by <Pro>".

## 2026-10-01 — More dropdown under All (card-mode sidebar)
- Todo2CardList: added MoreAccordion (My Businesses, Billing, Refer & earn, Settings) directly below the All accordion; shares sb_more_open key with Full-mode sidebar.

## 2026-10-01 — Settings consolidation
- Profile, Danger Zone, Notifications & Mobile App moved from /settings to /accounting/settings (AccountingSettings ACCOUNTING_TABS). /settings now shows only User Settings. Notifications button gated by allowedTabs "notifications" pseudo-key.

## 2026-10-01 — Email log under Audit log
- Full sidebar: Email log moved into the Accounting group directly after Audit log (removed standalone entry). Card-mode All list reordered to match.

## 2026-10-01 — Email Notifications Settings tab
- Extracted Communications Settings tab → components/EmailNotificationSettings.jsx; added as "Email Notifications Settings" tab on /accounting/settings (also supports ?tab= deep link). Removed Settings tab from /communications-audit; header links to the new tab.

## 2026-10-01 — Sidebar Mode tab
- Moved Sidebar Mode toggle out of Bookkeeping into its own "Sidebar Mode" tab (key "sidebar") on /accounting/settings.

## 2026-10-01 — Navigation style moved
- NavStyleCard moved from /settings User Settings tab to /accounting/settings Sidebar Mode tab (below Sidebar Mode card). /settings User Settings now = Booking + Note-takers only.

## 2026-10-01 — Company Settings page retired
- BookingPanel + NoteTakersPanel now render at the bottom of /crm/settings. /settings → Navigate redirect to /accounting/settings (many pages link to /settings for company tabs). "user" tab removed from CompanySettings.

## 2026-10-01 — Removed duplicate Settings under More
- STANDALONE_BOTTOM (Sidebar.jsx) and MORE_LINKS (Todo2CardList.jsx) no longer include /settings; Accounting settings link retained.

## 2026-10-01 — AI Email Questions tab rebuilt
- GET /api/cockpit/email-questions: db.communications rows (kinds ai_ask_client, ask_client, client_review_batch, client_welcome*, portal_invite, team_invite) joined to outcome (client_questions / client_review_batches / password_set_tokens / invites). Scope: superadmin=all; enterprise owner (enterprises.owner_user_id) = rollup_stats company_ids ∪ memberships; pro = memberships. Tab pills Quick Ones / Set-up & Invites / QC Emails, sections Waiting / Resolved / Not delivered (collapsed). Open → inline viewer (/q/{token} or /client-review/{token}). Live-refresh re-pulls it.

## 2026-10-01 — Duplicate "Quick one" fix
- Root cause: in-process hourly sweep per pod + manual /communications/ai-ask-client/run, no lock, txn stamped AFTER LLM+insert (TOCTOU). Fix: atomic _claim_txn (update_one on client_question_id empty→token) BEFORE LLM, release on failure; _sent_recently_for_txn 24h guard on communications.related.txn_id; db.scheduler_locks lease (acquire_sweep_lock/release) around tick + manual run (409 if held); 30-150s startup jitter. Tests: tests/test_ai_ask_client_race.py (3 concurrent runners → 1 email).

## 2026-10-02 — AI cleanup chat mis-targeting fix
- Root causes: pendingIntentRef single-slot set BEFORE awaits (prompt for B fired mid-await re-pointed reply meant for A); CPA_REVIEWER prompt biased "these are …" → approve_existing; no canonical account path.
- Fixes: AiPanel sets pending intent when bubble appends + tags bubble `inquiry`; interceptor trusts last displayed prompt; stale focus pin cleared on new vendor prompt; Undo chip after bulk approve → POST /companies/{cid}/transactions/bulk-unapprove. ai_service: is_explicit_approval() regex gate (approve_existing only on explicit sign-off; otherwise clarifying question), nothing_to_approve gate when rows are Uncategorized; prompt rewritten (donations examples). ai_ops: new-account proposals routed via canonical_semantic_for_name → ensure_semantic_account (added charitable_contributions 6850). Reverted the 204 accidental Walmart approvals on Michael Co 2.

## 2026-10-02 — Meaning-first category resolver (pro AI panel)
- backend/ai_category_resolver.py: canonical cue table (direction-aware) → existing account (linked_semantic / normalized-name / contains) or full-field proposal from CANONICAL spec; else LLM with CoA → closest existing or complete GAAP new account (type/subtype/detail_type/parent/code). POST /companies/{cid}/ai/resolve-category (creates nothing) and /resolve-category/apply (ensure/create account with all fields, categorize+review txns, optional contact rule). Added canonical: contract_labor, cleaning_janitorial, consulting_revenue, donation_income.
- AiPanel: recategorize-focused branch + pinned-txn free-text fallback → recommendCategory → CategoryRecommendCard (Use this / Create account & categorize / Also N similar + save rule / alternatives / Owner's Draw escape hatch). Review Chat untouched.

## 2026-10-02 — Resolver direction enforcement
- direction_ok(): money_out never revenue; money_in never expense/cogs unless refund/reimbursement wording. CoA pre-filtered before LLM + post-validation; LLM may return account code or id. Money-out "consulting" → Professional Fees cue. Frontend no-match message is direction-aware.
- Vagueness gate (is_too_vague) → direction-aware clarifying question; bank Conf#/Ref# codes stripped from memo before LLM.
- find_semantic_duplicate(): type + detail_type / word-set (order-free) / subset match; applied to canonical AND LLM proposals before any "new account" is offered ("Marketing & Advertising" → existing "Advertising & Marketing").

## 2026-06 — AI-first category resolver (painter → Food Cost bug)
- Root cause: `find_semantic_duplicate` matched on generic `detail_type=operating_expense` (shared by every expense account) and returned the first one (5000 Food Cost). Also a hardcoded regex cue list ran before the AI.
- Fix: backend/ai_category_resolver.py rewritten AI-first — no keyword lists. LLM (LLM_MODEL_RESOLVER=gpt-4o in .env) sees direction-filtered CoA + canonical library; returns existing id / library `semantic` key / full new_account / `ask` clarifying question. New-account proposals go through a second LLM semantic dedupe (`_llm_dedupe`, exact-name identity only shortcut). Direction guard unchanged (structural).
- Frontend AiPanel.recommendCategory prefers `data.ask` over canned text.
- Tests: backend/tests/test_ai_category_resolver.py (live painter regression + mocked dedupe).
- "Show N similar" button on the category card (between Use this / Also N similar + save rule): read-only. Resolver returns `similar_ids`/`similar_label`; GET /transactions accepts `ids=` (comma list, max 500). Transactions page: `similarView` state + chip "Showing N similar to X · unreviewed only · Clear"; hydrates via `show-similar-txns` action (same page) or sessionStorage `axiom_similar_view` (cross-page navigate). Verified via Playwright.
- Similar view v2: list = focused + similar ids, all pre-ticked on load (`similarFreshRef`); card ADDS "Apply to X" (X = live ticked count via `similar-selection-changed` action; applies only ticked ids, no rule) and "Clear" (`similar-clear` → Transactions restores snapshot of filter/search/page/view/selection/advanced filters and navigates back to `returnTo` if it came from another page; emits `similar-view-cleared`). Chip: "Showing <label> · X of N ticked (focused + N similar)".
- Voice/text → card buttons: `routeToCategoryCard` in AiPanel.send runs before chat routing when a category-recommend card is active. Posts visible actions (use_this, show_similar, apply_similar_rule, apply_ticked, clear_similar, not_this, alt:<id>, owner_draw) to POST /companies/{cid}/ai/card-intent (`classify_card_intent`, LLM_MODEL_FAST) → action_id/confidence ≥0.6 → runs the same handlers as the buttons (`applyCategoryCard`, `showSimilarForCard`, `dismissCard`); otherwise falls through to normal chat. No keyword lists.

## 2026-06 — Receipt categorization unified on AI-first resolver
- Deleted `curated_receipt_accounts.py` (regex kinds/aliases). Vision prompt no longer emits a closed `line_kind` enum; it copies exact CoA code+name when one fits, else `category_hint` plain English.
- `ai_category_resolver.categorize_receipt_lines(cid, lines, vendor, industry)`: exact CoA picks trusted (identity), all other lines in ONE batched LLM call (direction money_out, CoA + library) → existing code / library semantic / new_account; distinct proposals deduped once via `_llm_dedupe` then created via `create_account_from_proposal`; unresolved → Uncategorized Expense. `categorize_receipt_analysis` stamps account_id/code/name and rebuilds `suggested_categories` (rollup now reflects resolved accounts). Callers: routes/client_review.py (QC receipt) and routes/payments.py (/receipts/analyze, cat arm resolved once and re-spliced onto merged lines).
- Sales tax paid → expense (Sales Tax Paid / Taxes & Licenses), never Sales Tax Payable. Tests: tests/test_receipt_lines_resolver.py (mocked), live /receipts/analyze verified on Bright Beans with the Home Depot demo receipt.
- Per-party balance-sheet sub-accounts: resolver LLM returns `counterparty_subaccount` for loans/notes/credit cards/due-to-from/deposits; `_counterparty_subaccount(parent, accounts, txn)` reuses the child named after txn.contact_name (or merchant) under the generic parent, else proposes a new sub-account (next free code after parent, inherits type/subtype/detail_type, `parent_account_id`). rec.subaccount=True; card button "Create sub-account & categorize". `create_account_from_proposal` scopes name-reuse to the same parent. Verified: Larry D Brown loan deposit → new 2501 "Larry D Brown" under Loans Payable; forklift → Equipment (no sub); "paid down sofi loan" → existing 2530 SoFi.
- Direction-aware loans: money OUT "a loan" → asset Loans Receivable (new library key `loans_receivable`, 1400) per-borrower sub; money OUT "loan payment/paid down" → lender sub under Loans Payable; money IN "a loan" → Loans Payable per-lender sub; money IN "paid me back" → borrower sub under Loans Receivable. When the parent doesn't exist, rec.account carries `parent_proposal`; `create_account_from_proposal` creates parent then child (idempotent). Verified: Kevin Petersen −$1,500 "this was alone" → new 1401 Kevin Petersen under new Loans Receivable.
- Row approve ✓ → `approve-with-suggestion` (now returns full `similar.items`) → `SimilarApproveModal` (components/SimilarApproveModal.jsx: pre-ticked rows, "Categorize & approve N", "Approve N + create rule" (hidden if rule exists), "No, just this one") AND AiPanel `ai-bulk-approve-prompt` card with the same two buttons. Sync via actions `bulk-approve-selection-changed` {ids, origin} and `bulk-approve-done` {msg, origin, declined}. Voice/text "yes" / "yes and make a rule" / "no" routed through the LLM card-intent (`routeToCategoryCard` now handles bulk-approve-confirm cards) → `runBulkApprove(i, card, withRule)` applies only ticked ids. Voice-approve path also opens the modal (`open-similar-approve-modal`).
- Uncategorized guard: `/approve` and `/approve-with-suggestion` return 400 when category is missing / code in {9999,6999,4999} / name contains "uncategorized" (`_reject_uncategorized`). Frontend check icon greyed (title "Pick a category before approving"); click → toast + `ai-tell-me-about` so the AI asks what it was. Voice-approve path surfaces the backend detail.
- Party naming is AI-driven: resolver LLM returns `party_name` (from the user's words first; bank/Zelle/ACH channel is NOT the party → null → `ask` "Who lent you this money?"). `_counterparty_subaccount(parent, accounts, party)`; response carries `party_name` + `set_contact` (when party ≠ row contact). Card shows "Also set contact to X (currently Y)" ticked by default; apply sends `set_contact_name` → `/resolve-category/apply` get_or_create_contact + stamps contact_id/name/contact_source=user on the rows. Single-sentence why. Verified: Wells Fargo ACH + "loan from Mark Robinson" → 2502 Mark Robinson under Loans Payable, set contact Mark Robinson; bare "this was a loan" on a bank-channel row → asks for the lender.

## 2026-06 — Uncategorized Sweep
- GET /companies/{cid}/ai/uncategorized-sweep → unreviewed rows in Uncategorized (no category / codes 9999,6999,4999 / name match) grouped by contact (fallback merchant): {label, count, total, money_in/out, ids, sample, first/last_date}, sorted by count desc.
- Transactions page button "Sweep uncategorized" (`uncat-sweep-btn`) → `uncat-sweep-start`. AiPanel `sweepRef` {groups, idx, done, doneTxns, skipped}; `sweepStep` pins focus on the group's sample txn, emits `show-similar-txns` with the group's ids (rows filtered + pre-ticked), posts "N of M · Vendor — …what were these for? skip/stop", opens mic. Free-text answer → existing recommendCategory; card gets `sweep: true` + similarMode (ticked from `lastSimilarSelectionRef`): primary applies to ticked rows ("Use this (13 ticked)"), "Use for N + save rule", "Skip vendor". After apply → `sweepAdvance("done")` (450ms delay before next step to let similar-clear restore). "skip"/"stop" by voice/text via LLM card-intent (`SWEEP_ACTIONS`), with or without a card showing. `endSweep` posts summary (categorized groups/txns, skipped, left). Verified live on Michael Co 2 (start, skip, describe → card, stop); apply path reuses proven applyCategoryCard.

## 2026-06 — Transactions page tour
- Reuses the Review Chat engine `components/tour/ChatReviewTour.jsx` (now accepts `beats`, `chapters`, `finaleLabel`; beats support `emit` (fires an action on enter) and ghost kind `popup` (mock same-vendor approval modal)). Beats in `tours/transactionsBeats.js` (7 beats / 3 chapters): welcome → click "To do" (real click) → green check (pointer) → same-vendor popup (ghost) → sparkles (pointer) → AI focus + typing ghost "this was landscaping for one of my rental properties" (emit ai-open) → finale "Got it".
- Transactions.jsx: Lightbulb "Tour" button (`txn-tour-btn`) next to the filter toggles; auto-opens once per browser (`transactions-tour-completed-v1`) when rows are loaded and not in review modes; close restores the filter/page snapshot. `chat-cta:restart-transactions-tour` action replays. Row selectors: `css:tbody tr [data-testid='txn-approve-btn']`, `css:tbody tr [data-testid^='txn-ai-']`.
- No-contact approve → "Similar description" popup: `approve-with-suggestion` falls back to `_desc_key` (memo minus conf/ref codes, dates, digit tokens; first 6 words) across other unapproved no-contact rows; `similar.match_kind="description"`, `match_value=key`, `contact_name`=cleaned memo. Same modal/card/voice flow; rule created as `merchant_contains` with the key (`apply-bulk-approve-rule.match_text`). Quick-action strip (vertical) beside the pointer in SimilarApproveModal; `approve(id, anchor)` captures click coords. ETA "~15 min per 1,300" shown on dashboard AI card, checklist Step 1, and Transactions hero (CleanupCopilot), refetched on txns:changed.


## 2026-10-02 — Similar-approve popup search filter
- Added live search box to `SimilarApproveModal.jsx` (filters by description/date/amount/category); header tick-all acts on visible rows only, hidden ticks preserved; button counts = total ticked; empty state.
- P0 Theme Coloring bug still OPEN (deferred 15 sessions) — propose fixing next.
- Added amount filters to the popup: All / Money out / Money in toggle + $Min–$Max range (absolute amount); 'Clear' resets all filters. Verified in-browser with mock data.
- Similar Description popup now groups with the same `_desc_group_key` normalizer as Step 3B (`_similar_desc_group`): account numbers kept, filler words dropped → 6278 vs 7984 are separate groups, title = 3B label. Rule match_value now = raw memo up to the noise marker (`_desc_rule_text`, e.g. 'online banking transfer to chk 6278') so `merchant_contains` genuinely matches and stays account-specific. AI chat card uses the same payload.
- Popup grouping is now a HYBRID (popup only; 3B untouched): `_similar_tokens`/`_similar_desc_group` keep 3–6 digit numbers only when anchored to an account word (chk/acct/card/ending/loan…), drop store/order codes & masked IDs, and split money-in vs money-out. Rule text = longest raw substring hitting every sibling and no other group (`_pick_similar_rule_text`, checked against ALL company rows incl. contacts, so 'checkcard' is rejected → 'dental insurance autopa'). When no safe substring exists, backend returns rule_available=false + rule_exists=true so modal & chat hide '+ create rule'.
- Changing a transaction's category (PATCH /transactions/{tid}) no longer auto-approves: `human_reviewed` is left untouched (needs_review still cleared). The green check is the only single-row approval path. Applies to grid dropdown, AI chat recategorize, and editor.
- Transactions list: CONTACT cell is now an inline `ContactPicker` (new component, portaled like AccountPicker) with search, 'No contact' clear, and 'Add new contact' (creates vendor via POST /contacts). PATCH /transactions/{tid} with contact_id='' now clears contact_id + contact_name. Picking a contact does not approve.
- Sidebar To-Do 'Transactions' card (Todo2CardList.jsx): when dashboard mode is 'AI Transaction Review' (localStorage `dashboard-todos-mode`='ai', default) it shows the '~N min' ETA chip + 'N transactions to review' and opens /accounting/transactions?filter=unapproved (To-do tab). Chat/checklist modes unchanged. Dashboard dropdown now emits `dashboard-mode-changed` so the sidebar updates in the same tab; card refreshes on txns:changed.
- Sidebar 'Liability Payments' card now opens /accounting/liability-payments (inside the app shell: sidebar/topbar/AI chat intact) rendering the live Quick Check-in via new `EmbeddedCheckin.jsx` → `ClientReviewPage` with props `embedded`, `token`, `itemTypes=[9]`, `embeddedTitle`. Embedded mode: pro attribution on, items scoped to the given types, own scroll container (sticky header/footer), 'All caught up' panel when none, never calls /complete. `CHECKIN_SCOPES` also defines receipt_followup [3] and checks [11,13] for reuse.
- Sidebar 'Receipts' card now opens /accounting/receipt-followup (EmbeddedCheckin scope=receipt_followup, item type 3) in-shell; card highlights as selected on that route.
- Sidebar 'Checks' card → /accounting/checks-review (EmbeddedCheckin scope=checks, item types 11 Owner's Draw + 13 checks-without-payee). Backend `_open_checkin_items_by_bucket` now also puts ITEM_OWNER_DRAW rows into the `checks_no_payee` bucket so the card appears when only owner's-draw checks are open. Sidebar routing consolidated into EMBEDDED_CHECKIN_ROUTES map.
- Liability statement breakdown card redesigned (ClientReviewPage `LiabilityBreakdown`): document-icon header with 'Mortgage statement · Lender', narrative as subtitle, optional 'View statement' button (new GET /client-review/{token}/items/{item_id}/attachments/{aid}/file streams the stored upload inline), per-row icon + account sub-label + Change, % share, amount input, colored progress bar, total row; 'Use this split' (indigo filled) / 'Something's off' buttons. Card renders full-width (no chat-bubble chrome). Mobile hides % and bars.
- Quick Check-in ItemContextCard polished: type icon badge (ITEM_TYPE_ICONS) beside the LIABILITY PAYMENT pill, key words bolded via emphasizePrompt(), and the Date/Description/Amount strip now uses icon badges with vertical dividers.
- LiabilityShortcuts tiles restyled: horizontal icon-badge tiles (paperclip / pencil), white cards with soft shadow, chevron, stack to 1 col on mobile.
- 'Start over' button on the liability statement card header (next to View statement): confirms, then POST /client-review/{token}/items/{item_id}/reset-statement (new) clears attachments (batch + source record), liability/categorization/receipt analyses and per-item chat; UI returns to the Upload / No-statement tiles. Refused (409) once the item is answered.
- Live sidebar counts: embedded ClientReviewPage emits `checkin:changed` (axiom:action bus) whenever item progress changes; Todo2CardList silently refetches /responsibilities/status on that event (no spinner). Verified Receipts 2→1 on defer; demo item restored.
- Sidebar 'Checks' card now opens /accounting/review-chat?tab=checks (Review Chat Checks tab with payee/category allocator) instead of the embedded check-in; the /accounting/checks-review route remains available but unlinked.
- Embedded check-in column widened (max-w-4xl via `colW`; standalone client page stays max-w-2xl); question prompt text reduced to 14px.
- Third liability tile 'Not a liability statement' with confirm popup → POST /client-review/{token}/items/{item_id}/not-liability (new): marks item answered (action_taken=not_liability), flags the txn needs_review with review_note for the pro; 409 if already finalized. Completion gate + bus refresh follow.
- Sidebar Checks card count now = Review Chat 'Checks' tab queue (chat_review_queue checks, computed once per status call via _chat_counts_once) with detail 'N checks need a payee' — matches the tab it opens.
- Onboarding pricing gate: PricingPlans.jsx checks GET /companies/{cid}/billing/state; if billing_payer is 'enterprise' or 'free_spot' it redirects to /welcome/summary (spinner while checking). WelcomeSummary 'Back' goes to /welcome/payments for sponsored companies. Client-email / client-card payers still see pricing.
- Sidebar To-Do: Cash Flow card now only when cashflow-snapshot `issue_30d` (has transactions AND runway<30d or projected cash <0 within 30 days; new fields has_transactions/low_30d/issue_30d); burn text uses forward_monthly_burn/30. Close (eom_closing) card marked done with 'no activity to close' when the previous month has zero transactions.
- Onboarding order changed: /welcome → /welcome/payments → /welcome/summary → /welcome/pricing → /accounting/transactions?from=onboarding. Pricing page got a Back button (to summary); Continue/Not right now/un-wired plan go to transactions. Sponsored (enterprise/free_spot) companies: summary Next → transactions directly; /welcome/pricing redirects to transactions.
- Self-serve signup (/signup, client mode): added required 'Business name' field; after /auth/signup the frontend POSTs /companies with that name, selects it, and navigates to /onboarding (was /dashboard, which hit the 'Accounting is in preview' ProductGuard in prod). Guarded the 'already signed in' redirect with routingRef so it doesn't hijack post-signup routing. Enterprise/affiliate signup paths unchanged.
- Pricing page: top-left brand logo (firm logo or SmartBooks mark fallback) is clickable → reveals a masked passcode field; correct code (SHA-256 compared client-side, digits never shipped) → /accounting/transactions?from=onboarding. Wrong code → red border, field cleared. Code noted in /app/memory/test_credentials.md.
- Welcome tour (WelcomeModal) now auto-plays on first visit to /onboarding (per-user localStorage flag smartbooks_welcome_seen shared with Dashboard, so it never double-fires; closing from onboarding marks it seen). Replay via Settings → Tours & Tips unchanged.
- Signup page white-label: now uses the same branding resolution chain as Login (?firm → subdomain slug → /branding/by-host → cached slug, flagship hosts excluded), so firm.accountingapp.ai/signup shows the firm's logo + name. Enterprise/affiliate recruit links hidden when firm-branded.
- WelcomeModal: removed auto-advance; every slide waits for a 'Next' click (Skip line removed). Final slide has a single 'Start Onboarding' button (narration preference follows the speaker toggle) → /onboarding.
- Superadmin /pro/clients list view: new ENTERPRISE column (GET /pro/clients now returns enterprise_id/enterprise_name for superadmin via company → pro membership → users.enterprise_id → enterprises). Rows without an enterprise show 'SmartBooks direct'; search also matches enterprise name.
- Enterprises list/grid: 'Open' button on every row incl. SmartBooks DEFAULT. New POST /admin/enterprises/{eid}/open provisions a login-disabled `pro` service account ('<Enterprise> Team', team+<slug>@smartbookssoftware.ai, random password) as owner on first use and returns an impersonation token (same shape as /admin/impersonate); frontend openAsOwner uses it when owner_user_id is missing.
- White-label signup attribution (tested, iteration_99): Signup.jsx sends firm_slug (subdomain / ?firm / by-host slug) to POST /companies; create_company resolves the branded pro user (users.branding.signin_subdomain|subdomain|subdomain_slug), stamps company.enterprise_id (+partner_id, signup_firm_slug) and inserts a role='pro' membership for that pro. /pro/clients superadmin attribution now also reads company.enterprise_id directly. branding/by-host returns slug. NOTE: the already-created prod company 'Michael Proactive 2 LLC' predates the fix and still needs manual attribution.

## 2026-10-03 — SmartBooks Team white-label + P0 Theme fix (RESOLVED)
- `_whitelabel_state()` (pro.py) treats `is_service_account` users as comp-unlocked; `/admin/enterprises/{eid}/open` seeds `branding.whitelabel_comp=true` on the SmartBooks Team service account (existing one backfilled).
- **P0 Theme Coloring FIXED**: tailwind.config.js now maps `indigo/violet/fuchsia` palettes to `rgb(var(--tw-<name>-<shade>) / <alpha>)` with canonical defaults in index.css `:root`. `BrandingProvider` (lib/branding.js) builds hue-shifted shade ramps from `theme.accent` (shade 600 == brand hex exactly), sets `--primary/--ring/--primary-foreground` from `theme.primary`, and `data-brand-sidebar|topbar="dark|light"` on `<html>`. Sidebar `<aside data-testid="app-sidebar">` and Layout `<header data-testid="app-topbar">` use `var(--brand-sidebar-bg)` / `var(--brand-topbar-bg)`; index.css remaps slate text/border/hover inside dark chrome for legibility. Default preset accent changed `#0891B2` → `#4F46E5` so "Default" == stock look (ramps removed when accent is default). Verified with Forest preset on pro@axiom.ai (reset to default afterwards).

## 2026-10-03 — Enterprise attribution hardening + admin reassign
- `POST /companies` now resolves the firm slug from (1) body `firm_slug`, (2) request Origin/Referer host via `subdomain_from_host` (acme.accountingapp.ai → acme), (3) `user.signup_firm_slug`. `/auth/signup` accepts `firm_slug` and stamps `signup_firm_slug` on the user (from body or Origin).
- `enterprises.rollup_stats` unions companies stamped with `enterprise_id` into `company_ids` → Enterprises page counts + enterprise detail Companies table include white-label signups.
- NEW `PATCH /admin/companies/{cid}/enterprise` {enterprise_id|null} — re-attributes a company, swaps the enterprise owner's pro membership (`via: admin_reassign`). Superadmin Clients list "Enterprise" cell is now a dropdown (`pro-clients-enterprise-select-{cid}`) using it.
- Root cause for prod "Michael Proactive 5 LLC" mis-attribution: most likely stale production frontend (pre-`firm_slug` build); user must re-publish and then use the dropdown to fix existing rows.

## 2026-10-03 — Post-checkout landing → Transactions
- `BillingReturn.jsx` (`/billing/success`): client-role users (self-serve) now auto-redirect to `/accounting/transactions` after billing_state flips active, and the 30s-timeout fallback button ("Continue to transactions", `billing-success-continue-btn`) also goes there. Pros/superadmins returning from "Pay with client card" still go to `/dashboard`. Branded host preserved via `origin_url`.
- Prod Stripe: user set the 8 `STRIPE_PRICE_<PRODUCT>_<MONTHLY|ANNUAL>` live env vars on Railway; live checkout with 7-day trial verified by user. Webhook at api.smartbookssoftware.ai/api/stripe/webhook active (6 events — advised to confirm subscription.updated/deleted + invoice.paid/payment_failed are included).
- Open product question: pro Add-client catalog (Simple Start/Essentials/Plus/Advanced) ≠ self-serve pricing catalog (Core/AI Assistant/AI Bookkeeper/Advanced); user may want to unify.

## 2026-10-03 — Superadmin → Client Payments (steps 1+2 of plan) ✅ tested (iteration_100: 100%)
- Data layer: `_sub_snapshot()` in stripe_billing.py flattens Stripe subscription → `companies.sub_status/sub_trial_end/sub_current_period_end/sub_cancel_at_period_end/sub_canceled_at/sub_started_at/sub_price_id/sub_amount_cents/sub_interval/sub_card_brand/sub_card_last4/sub_synced_at` (+ billing_product/billing_cadence from price id via `_plan_from_price_id`, which reverse-maps any STRIPE_PRICE_* env var). Applied on checkout.session.completed (fetches sub), customer.subscription.updated/deleted. invoice.payment_failed stores `sub_last_failure {amount_cents, attempt_count, next_payment_attempt, reason, hosted_invoice_url, at}`; invoice.paid clears it + sets sub_last_paid_at. platform_payments now snapshot billing_cadence/billing_reason and resolve self-serve products.
- `PLAN_LABELS` (simple_start→Core, assistant, bookkeeper, advanced, essentials, plus) + `PLAN_MONTHLY_CENTS`.
- NEW routes/admin_client_payments.py: GET /admin/client-payments (metrics: mrr [active+past_due, annual/12], active, trialing, past_due(+cents), due_30d(+cents), churned_30d, enterprise_paid; attention list; rows), GET /admin/client-payments/{cid} (client, payments, timeline), POST /admin/client-payments/backfill (Stripe re-sync of all subs).
- NEW page AdminClientPayments.jsx at /admin/client-payments (sidebar: Superadmin → "Client Payments" in Todo2CardList.jsx proSectionLinks). Metrics tiles, attention strip, filters (search/status/plan/cadence/enterprise), table, right drawer (plan card, card on file, failure box, payment history w/ receipt links, timeline). data-testids prefixed `cp-`.
- Backlog (step 3): actions — Cancel at period end, Stripe Customer Portal link (also gives clients self-serve cancel), Change plan; step 4: CSV export, dunning emails, revenue chart. Prod: run "Sync from Stripe" once after publish to backfill existing subs.

## 2026-10-03 — Client Payments for enterprise (pro) users
- `/admin/client-payments` + `/{cid}` now allow role `pro`; `_scope_query()` limits to companies the pro has a pro-membership on OR `enterprise_id == user.enterprise_id`. Response carries `scope: platform|enterprise`.
- Route alias `/pro/client-payments` → same AdminClientPayments page; enterprise scope hides Sync/Open Stripe, Stripe mode badge, enterprise filter+column, drawer Stripe link, and snapshot hint.
- Sidebar: "Client Payments" under Client Cockpit for pros (Todo2CardList proSectionLinks + Sidebar.jsx role=pro item). Verified pro@axiom.ai sees only its 4 companies; client role → 403.

## 2026-10-03 — Client Payments: Billing Actions (step 3) ✅ verified against Stripe test mode
- NEW endpoints (superadmin + pro, scoped): `POST /admin/client-payments/{cid}/cancel {cancel: bool}` (Subscription.modify cancel_at_period_end, undo supported), `POST …/change-plan {product, cadence}` (swaps item price via `_price_id`, proration_behavior=create_prorations, resets cancel flag, updates billing_product/cadence), `POST …/portal {return_url}` (billing_portal.Session.create → url; friendly hint if portal config missing). Each re-snapshots the sub.
- `_fetch_sub_snapshot` now also expands `customer.invoice_settings.default_payment_method` so card last4 shows when the PM lives on the customer.
- Drawer `BillingActions` (cp-action-cancel / cp-cancel-confirm-yes / cp-action-change-plan / cp-plan-product / cp-plan-cadence / cp-plan-apply / cp-action-portal) with inline confirm + plan form; refreshes drawer + table silently.
- Prod prerequisite for portal: enable Customer Portal once in Stripe Dashboard → Settings → Billing → Customer portal (live mode).

## 2026-10-03 — Post-checkout congrats + tour invite
- BillingSuccess (client role) now lands on `/accounting/transactions?from=checkout`. Transactions.jsx: `fromCheckout` opens the existing tour-invite modal (800ms delay, no row requirement) with a celebratory variant (`txn-checkout-congrats`, PartyPopper, copy adapts to 0 rows → "connect a bank or upload a statement"). "Show me around" starts the Transactions tour (works with zero rows); "Skip for now" marks seen + strips the param. Auto-tour guard also skips when fromCheckout.

## 2026-10-03 — Branded checkout welcome email ✅ (sent via Resend in preview, status=sent)
- `_send_checkout_welcome(company_id, snap)` in stripe_billing.py, called from checkout.session.completed company branch after the sub snapshot. Idempotent via `companies.checkout_welcome_sent_at`. Resolves firm from company.enterprise_id → enterprise owner branding (firm_name, signin_subdomain, logo); falls back to SmartBooks copy when no firm_name.
- Template `email_templates.checkout_welcome(...)`: firm logo (hosted) or firm name, plan summary card (business, plan·cadence, price, trial end/first charge or next charge, card), "Open my Transactions →" deep link (`public_base_url(slug)` + `?firm=` when PRIVATE_LABEL_HOST_TEMPLATE unset), white-label footer.
- NEW public `GET /api/branding/logo/{slug}` serves the firm's logo_light data-URL as a real image (email clients block data: URIs). Dispatcher kind `checkout_welcome`.
- Prod env reminder (Railway backend): set `PUBLIC_APP_URL=https://app.smartbookssoftware.ai` and `PRIVATE_LABEL_HOST_TEMPLATE=https://{slug}.accountingapp.ai` so email links/logo URLs resolve (currently falls back to PUBLIC_BACKEND_URL with a warning).

## 2026-10-03 — Pricing page entity picker + popup copy
- PricingPlans.jsx: when `companies.length > 1`, a "Plan for" `CompanySwitcher` (imported from Layout.jsx) renders next to the firm logo (`pricing-entity-picker`); checkout + sponsored check already key off `currentId`, so switching changes the plan target.
- Post-checkout popup copy fixed to the user's exact wording (no rows-dependent variant).

## 2026-10-03 — Client "Add new company" popup with owner delegation ✅ verified (API + UI)
- `CompanyCreate.owner_email`. In `POST /companies`: for role=client, a different owner email → existing user becomes Owner, or a new client account is created (`must_set_password`, placeholder pw) and emailed a branded set-password invite (`client_welcome_first_time`, firm branding/host); existing users get `client_welcome_returning`. Caller gets an `editor` membership (`via: owner_delegation`). Non-clients get 400 on delegation. Self-add "returning" email is skipped when delegated.
- Enterprise inheritance: when no firm slug is in body/Origin/user, a client's new company inherits `enterprise_id`/`signup_firm_slug` from a sibling company they belong to (pro membership for the enterprise owner added).
- Frontend: `AddCompanyModal.jsx` (add-company-name / add-company-owner-email / add-company-owner-hint / add-company-submit). `CompanySwitcher` "Add new company" opens it for clients only; pros/superadmins still go to `/pro/clients?new=1`. On submit → refresh → switchCompany → `/onboarding`.

## 2026-10-03 — Unpaid-company routing to pricing ✅ verified
- `/companies/{cid}/billing/state` returns `needs_checkout` = billing_state pending ∧ no stripe_subscription_id ∧ payer ∉ {enterprise, free_spot, client_email} ∧ onboarding_complete ∧ user.role == client ∧ not pro-side.
- `BillingLockedModal` (mounted in Layout) redirects to `/welcome/pricing` whenever the current company has `needs_checkout` (login landing + picker switch), skipping /welcome, /onboarding, /billing, /set-password, /login, /signup paths.
- PricingPlans: a company that's already active (or has a subscription) bounces to `/accounting/transactions`; sponsored still skip to summary. So switching paid ↔ unpaid in the "Plan for" picker routes correctly both ways.

## 2026-10-03 — Trial gate on Reports + "Pay now" ✅ verified against Stripe test mode
- `/companies/{cid}/billing/state` adds `trialing, trial_end, trial_gate (client-side + trialing), plan_amount_cents, plan_cadence, plan_label, card`.
- NEW `POST /companies/{cid}/billing/end-trial` (owner/editor or superadmin): `Subscription.modify(trial_end="now", proration_behavior="none", payment_behavior="error_if_incomplete")` → 402 on card decline; re-snapshots sub, sets billing_state, `trial_ended_early_at`.
- `TrialReportsGate.jsx` wraps `/reports` route (App.js): blurs page, modal with plan/price/card, "Pay now & unlock Reports" (trial-gate-pay-now), "I'll wait until {date}" (navigate back), "Back to Transactions". Pros/superadmins/sponsored unaffected.

## 2026-10-03 — Fuzzy receipt ↔ transaction matching ✅ verified (API + UI)
- `receipt_match.py`: new scored engine `score_pair()` (amount exact +50 / ≤1% +40 / tip ≤+30% +25; date same +30 / 1d +25 / 2-3d +15 / 4-5d +8; same account +15 (different −10); merchant token similarity +20/+10/−5). `rank_transactions_for_receipt()` / `rank_receipts_for_transaction()` return candidates with `score`, `confidence` (high ≥85, medium ≥55), `reasons`. `find_matching_transaction()` / `find_pending_receipt_match()` now auto-link only on a clear high-confidence winner (≥10 pts ahead). Window ±5 days.
- `POST /companies/{cid}/receipts` auto-links high; otherwise stamps `receipts.suggested_matches[]` (top 3). Also runs when no payment account is given. Plaid ingest passes description to the matcher.
- NEW endpoints: `GET /receipts/{rid}/match-candidates`, `POST /receipts/{rid}/match {transaction_id}` (manual/confirm; 400 if either side already matched), `GET /transactions/{tid}/receipt-candidates`.
- UI: Receipts table "Bank match" column (Matched / Suggested + Confirm / Other… / Attach to transaction…; personal receipts n/a). `ReceiptMatchPicker.jsx` modal (both directions). Transaction editor: "Attach existing receipt" button next to "Add receipt" → picker; shows "Receipt linked" chip.
- Backlog (step 4): Quick Check-in "Missing receipt" → photograph + OCR + link to that transaction.

## 2026-10-03 — Check-in Receipt Snap (Missing-receipt → OCR → exact link) ✅ verified API + UI
- `client_review_engine.analyze_receipt_for_categorization` prompt now also returns top-level `merchant` and `date` (YYYY-MM-DD).
- routes/client_review.py: `_snap_link_missing_receipt(batch, item, attachment, analysis)` runs at the end of `POST /{token}/items/{item_id}/upload` for item_type 3 (after the generic receipts-page mirror): resolves the exact txn (meta.txn_id → amount/date fallback), patches the mirrored receipt (merchant/date/line_items/narrative, source=checkin_snap, payment_account_id), `link_receipt_to_transaction` (sets matched ids, copies split + image to txn), clears `receipt_dismissed*`, stamps `receipt_attached_at/by`, resolves the `missing_receipt` agent finding (`client:receipt_attached`), marks the item answered (`action_taken: receipt_attached`). Response carries `receipt_link {receipt_id, txn_id, linked, merchant, amount, date, detail}`.
- ClientReviewPage.jsx: tile renamed "Snap the receipt" (Camera icon); on `receipt_link` shows the read-only OCR breakdown + ack (`missing-receipt-linked-ack`) and `markCompleted` ("Receipt attached" → Continue) instead of the "Use this split" proposal.

## 2026-10-04 — Owner Dashboard research + Projections engine tuning ✅ tested (iteration_101: backend 9/9, FE verified)
Research (no code): "Your business, in view" owner dashboard concept (Overview / Money / Documents / Your team) maps ~85% to existing data; competitor forecast methodology (QBO ML per-stream + invoice pay-date model, Xero Analytics Plus 3-month predictions, Float Smart Expected Dates, Fathom timing profiles). Decision: keep our direct-method engine, recalibrate, outsource recurring detection to Plaid.
Engine changes (`routes/projections.py`, `routes/projection_patterns.py`, `plaid_service.py`):
- **Plaid Recurring Transactions** (`/transactions/recurring/get`, `plaid_service.get_recurring_streams`) is now the primary pattern source for Plaid-linked accounts (`source: "plaid"`, pattern_key `plaid|<stream_id>`, MATURE+active only, TRANSFER_* excluded, CC-payment streams excluded when a credit-card ledger account exists). Local fingerprint detection stays as fallback for accounts not covered. **Prod prerequisite: enable "Recurring Transactions" on the Plaid dashboard**; failures log a warning and fall back to local.
- Local detection now excludes internal movements: `transfer_pair_id`, category account type equity or detail_type in {credit_card, cash_and_bank, bank, opening_balance_equity}, transfer-worded memos (`_is_internal_movement`). Historical burn also excludes transfer pairs and uses a 90-day window; residual drift capped at historical gross in/out (`residual_capped`).
- Pattern weighting: high 1.0 / medium 0.85 / low NOT booked until user keeps it (`user_confirmed` set by override status=active). `annual` cadence supported.
- AR (Float-style): per-customer median days-late from paid invoices (`_customer_lateness`, clamp 0–60, company median fallback). Not-due → due+lateness; ≤30d overdue → max(due+lateness, today+3); 31–60d → today+14; **>60d overdue excluded** from base case → `excluded_ar[]` + insight. New `POST /companies/{cid}/projections/invoices/{iid}/expected-date` sets `invoices.expected_payment_date` (null clears) which re-includes the invoice.
- Payroll: when `responsibilities.payroll_frequency` unset, cadence inferred from ≥3 payroll-tagged txns in last 120d (`inferred: true`). Dedup drops payroll-like detected patterns when explicit payroll exists, and patterns matching a user custom item label.
- Sales tax: `projection_settings.sales_tax {frequency monthly|quarterly|annual, due_day 1–28}` drives `_tax_periods` (default monthly/20). Settable via `POST /projections/settings`.
- Response additions: `timeline_conservative`, `conservative {ending_cash, low_30d}`, `excluded_ar`, `confidence {level, score, reasons}` (bank freshness, uncategorized %, history depth, last month closed, unconfirmed low detections), `pattern_summary.plaid`, `settings_summary.sales_tax`. Dead duplicate `_cash_balance` removed.
Frontend (`Projections.jsx`): `ConfidenceBadge` (hover reasons), `ExcludedArPanel` (date picker → expected-date API), dashed conservative line + legend on chart, "via Plaid" / "not booked" tags in detections modal, sales-tax frequency/due-day in Assumptions modal.
Next: owner dashboard spec/build (Overview tab first) on top of the tuned engine; "Can I afford…?" prompt over projections; safe-to-draw number.

## 2026-10-04 — Owner Dashboard "Your business, in view" ✅ shipped (iteration_102: backend 7/7, FE e2e pass)
- Backend: `routes/owner_dashboard.py` → `GET /companies/{cid}/owner-dashboard?period=YYYY-MM` (default last complete month). One aggregator (~0.5s) reusing `projections_cashflow`, `_month_status`, `compute_income_statement`, `sync_status`; returns books / profit / cash / attention / team / money / documents / banner. No writes.
- Frontend: `pages/OwnerDashboard.jsx` + `components/owner/{ui,OverviewCards,MoneyTab,DocumentsTab,TeamTab}.jsx`; routes `/owner` and `/owner/:tab` (overview|money|documents|team). Client-role users land on `/owner` (Login.jsx) and `/dashboard` redirects them there (`ClientHome` in App.js). Sidebar "My business" item added for pros (ACCOUNTING_OWNER) and in the client quick-nav strip (Todo2CardList QUICK_LINKS).
- Actions wired: Answer → `/q/{token}` check-in; Send reminder → `POST /communications/dunning`; Expect date on 60+d overdue → `POST /projections/invoices/{id}/expected-date`; statement upload embeds `StatementsTab`; booking link `/book/{slug}`.
- Static concept mock kept at `frontend/public/mock/owner-overview.html` (reference only).
- Known gaps / follow-ups: plain-English "why" is deterministic (not LLM); weekly counts use approved_at/human_reviewed_at/cleared_at/matched_at (AI categorization has no timestamp → new-this-week proxy); no job titles on pro users; reports not stored as documents. Ideas: "Can I afford…?" prompt, safe-to-draw number, weekly digest email mirroring Overview, dark white-label theme.

## 2026-10-04 — Billing lock: canceled self-serve → pricing page ✅
- `GET /billing/state`: `needs_checkout` now also true for `billing_state == "canceled"` on self-serve companies (payer not enterprise/free_spot/client_email) for client-role users → `BillingLockedModal` redirects to `/welcome/pricing` to pick a plan again instead of showing the lock modal. past_due/unpaid keep the modal + Pay now.
- Modal shows friendly "Plan: Core · monthly" and "Billed to: …" labels (PLAN_LABELS / PAYER_LABELS); raw `simple_start` / `—` rows removed; row hidden when payer unknown.
- Fix (same day): strobe loop for canceled self-serve clients — `PricingPlans.jsx` treated any `stripe_subscription_id` as "already paid" and bounced to /accounting/transactions, where the lock modal redirected back to pricing. Now only `billing_state === "active"` (or a non-lapsed sub) counts as paid. Verified: canceled client stays on /welcome/pricing, no modal.
- Open question: pricing page still offers a 7-day trial to re-subscribing canceled customers (Stripe `trial_period_days`).

## 2026-10-04 — No second free trial for returning customers ✅
- `_trial_eligible(company)` in `stripe_billing.py`: false when any prior sub exists (`stripe_subscription_id`, `sub_last_paid_at`, `sub_started_at`, or billing_state ever active/past_due/canceled/unpaid). `GET /billing/state` returns `trial_eligible`, `previous_product`, `previous_plan_label`, `canceled_at`.
- `POST /billing/checkout-session` drops `trial_period_days` server-side when not eligible (verified: Stripe test session created with trial_period_days=None, amount_total 3800).
- `PricingPlans.jsx`: returning copy ("Welcome back — pick up where you left off." + "Your Core plan was canceled… billing starts today"), trial badges/chips hidden, "Your previous plan" tag, buttons "Reactivate X" / "Switch to X".
- Welcome email: `_send_checkout_welcome` sends `checkout_reactivated` ("You're back — the books are open again") when `checkout_welcome_sent_at` already set; Transactions skips the tour invite if previously seen.

## 2026-10-04 — Quick Check-in re-tiering: current / older / grey / catch-up ✅ (iteration_103: 8/8 backend + FE e2e)
Owner decisions: current = last 7 days by TRANSACTION DATE (not ingest), ingested ≥48h ago, NEVER capped; older compliance items (receipt/meals/travel/liability) 8–30d ride along capped 2/type; W-9s never age out; >30d or skipped twice → grey Clean Up; grey never emailed, visible on Cockpit + Owner Dashboard; owner-paced catch-up sessions of 7.
- `client_review.py`: constants (AGED_UNCATEGORIZED_DAYS=7, INGEST_GRACE_HOURS=48, OLDER_LOOKBACK_DAYS=30, OLDER_PER_TYPE_CAP=2, GREY_AFTER_SKIPS=2, CATCHUP_BATCH_SIZE=7); items carry `tier` (current|older|grey) + `age_days`; `_txn_to_uncat_item`/`_finding_to_item` builders; `has_open_batch` ignores kinds cleanup/catchup; `expire_stale_batches` `$inc checkin_skips` on released sources; `graduate_company_to_cleanup` / `graduate_to_cleanup` (run each tick) append to the single kind=cleanup batch (`graduated_total`), stamp batch_id; `cleanup_progress`; `mint_catchup_batch` pulls ≤7 unanswered grey items into kind=catchup batch with token (no email).
- `routes/owner_dashboard.py`: `books.cleanup {pending,done,total,in_catchup,open_catchup_token}`; `POST /companies/{cid}/owner-dashboard/catchup` → review_url. Forward-batch lookups (owner dashboard + 3 in responsibilities.py) exclude cleanup/catchup kinds.
- FE: BooksCard "Older items · N to clear" progress + Start/Continue catch-up → /client-review/{token}.
- Known: legacy failing tests in test_client_review.py (4) predate this work. Follow-ups: in-week receipt nudge (same-day), per-client cadence toggle + surface `pause_review_batches`, catch-up auto-advance after answer, cleanup kickoff from onboarding has never run in prod (0 cleanup_jobs) — verify.

## 2026-10-04 — Compliance watcher + sanity rule ✅
- NEW `backend/compliance_watcher.py` (runs each check-in tick, before graduation): creates per-transaction `agent_findings` — `missing_receipt` (expense-category outflows ≥ $75, no receipt; never loan/CC/transfer/equity), `meals_compliance` (ANY charge on a Meals/Dining/Restaurant account without `irs_substantiation`), `travel_compliance` (Travel/Lodging/Airfare/Mileage). Deduped on meta.txn_id; auto-resolves when receipt attached / substantiation saved / txn deleted. **Before this nothing in production created these kinds — only seeds did.**
- Direction-vs-category sanity: inflow booked to expense or outflow booked to income → `needs_review=True`, `review_reason`, `sanity_flagged_at` (skips human-reviewed rows).
- Michael Co 2 dry run: legacy 15-item batch retired (`superseded_by_retiering`), new 16-item batch minted under new rules (/client-review/uB67Mzae…). Company has no owner_email → scheduler skips email (`no_client_email`); owner membership is michael+preview@bigsaas.ai.

## 2026-10-04 — Grey boxes for Michael Co 2, LLC ✅ (self-tested: API + Cockpit e2e answer flow; test_cleanup_scan 4/4, retiering 8/8)
- Root cause of empty grey cards: watcher only looked back 30d (nothing old ever became grey) and the cleanup batch held only type-1 uncategorized txns, which had no Cockpit card.
- `compliance_watcher.scan_company(cid, since=None, limit=300)` + NEW `historical_scan(cid, since)` (one-time backfill, NOT in the tick) → scans from `since`, then `graduate_company_to_cleanup`. Ran once for Michael Co 2 with since=2026-01-01: 216 missing_receipt + 162 meals findings, 364 graduated (rest on next tick).
- NEW grey card `cleanup_uncategorized` ("Clean Up · Uncategorized") in responsibilities CATALOG / CLEANUP_ITEM_KEYS / CLEANUP_KEY_TO_BUCKET / `_open_cleanup_items_by_bucket` (rows carry direction + account). Finding-sourced rows now fall back to `context.meta.txn_date / txn_amount / vendor` for date/description/amount.
- FIX: Cockpit `POST /checkin/items/{id}/submit` and `/check-assign` looked only at forward batches → grey-card "Answer" would 404. Now finds the open batch containing `items.item_id` (any kind).
- FE: `CheckinAnswerForm` type 1 (Cockpit mode) loads `/accounts` and shows `AccountPicker` (`uncat-category-field` / `uncat-category-picker`); payload `account_id` + `account_name` → `_handle_uncategorized` fallback books it (human_reviewed). Note-only still annotates. `ResponsibilitiesPanel` label added.
- Michael Co 2 Cockpit now shows 3 grey boxes: Receipt Follow-up 216, IRS Compliance 162, Uncategorized 85. Test answer reverted afterwards.
- Still open: `owner_email` missing on new companies (P0) — Michael Co 2 check-in emails skip.
- 2026-10-04: Grey Clean Up cards (`variant: "cleanup"` / `cleanup_*` keys) are filtered out of the left-side To Do card strip (`Todo2CardList.openItems`). They live on the Cockpit `ResponsibilitiesPanel` only.
- 2026-10-04: `/welcome/pricing` now renders the shared `ProfileMenu` (from Layout.jsx) pinned top-right (`pricing-profile-menu`) so locked-out / returning customers can sign out or switch accounts. Verified desktop + mobile (no overflow); Sign out → /login.

## 2026-10-04 — Affiliate referral link follows the white-label firm ✅ (API + UI verified)
- Bug: affiliates who signed up on a firm's private-label host got `https://app.smartbookssoftware.ai/r/{slug}` (platform) because `_share_link_for` only read the *user's own* branding.
- `routes/auth.py`: NEW `_resolve_firm_for_user(user)` (self if they own a slug/buy page → `signup_firm_slug` firm pro → enterprise owner), `_firm_public_info()`; `_share_link_for(user, slug, firm)` uses the firm's `buy_page_url` / subdomain; when `PRIVATE_LABEL_HOST_TEMPLATE` is unset it falls back to `https://{slug}.{PRIVATE_LABEL_ROOT}` (`subdomain_to_host`). `GET /share` returns `firm {slug,name,logo_url}` + `can_set_buy_page`.
- `routes/leads.py` `GET /public/refer/{slug}` returns `firm_slug / firm_name / firm_logo_url`; `EnterReferral.jsx` shows the firm brand strip and forwards `/signup?ref=…&firm=…` so signups attribute to the firm even from the platform host.
- `Share.jsx`: "for {Firm}" chip, firm-aware copy, Buy-page hint only for pros/partners.
- Prod note: existing affiliates are picked up via their `signup_firm_slug`; if an older affiliate lacks it, set `users.signup_firm_slug` to the firm's slug.

## 2026-10-04 — Affiliates directory (superadmin + firm-scoped) ✅ self-tested API + UI
- NEW `routes/affiliates_admin.py`: `GET /admin/affiliates?q=&firm=` (superadmin; rows = role=affiliate ∪ anyone with a slug + clicks/leads/signups/earnings; per-row firm via `_resolve_firm_for_user`, link via `_share_link_for`, counts from referral_clicks / leads / users.referred_by_user_id / referral_earnings; `firms[]` list), `GET /admin/affiliates/{uid}` (referrals w/ paying flag + earnings + leads + clicks), `PATCH /admin/affiliates/{uid}/firm {firm_slug|null}` (validates slug against registered firms → sets/unsets `users.signup_firm_slug`). Firm-scoped: `GET /firm/affiliates` + `/firm/affiliates/{uid}` for pro/partner (slugs from own branding or enterprise owner's; 403 on foreign affiliate; `no_firm:true` when no slug).
- FE: `components/AffiliatesTable.jsx` (stats strip, search, firm filter, expandable row detail, inline firm `<select>` when `canReassign`); `pages/AdminAffiliates.jsx` at `/admin/affiliates` + "Affiliates" button on SuperadminDash header; `PartnerDash.jsx` "Affiliates" section; `ProSettings.jsx` "Affiliates" card (both use `/firm/affiliates`, firm column hidden).
- Seeded `affiliate@axiom.ai / aff123` under axiompartners.
- 2026-10-04: Enterprise view moved — "Affiliates" link in the pro/partner profile menu (under My feedback, `profile-menu-affiliates`) → new page `/pro/affiliates` (`pages/ProAffiliates.jsx`). Embedded cards removed from ProSettings and PartnerDash.
- 2026-10-04: `/refer/:slug` "Tell us who you are" (new-contact self-serve form only; affiliate's "Enter referral" tab untouched): 4th tile is now **New Affiliate** (role `affiliate`, DollarSign icon) → forwards to `/signup/affiliate?ref=&firm=`; Firm name required for Accounting professional, Business name required for Business owner / Enterprise (label `*` + `required` + toast guard). `leads.VALID_ROLES` += `affiliate`; AdminLeads shows "New Affiliate" badge.
- 2026-10-04: Affiliate Upgrade (final): Upgrade button opens `AddCompanyModal mode="upgrade"` (title "Upgrade to full platform", same company-name + owner-email form). On submit: `POST /affiliate/upgrade` (role→client, keeps slug/earnings) → `POST /companies` → switch → `/onboarding` (normal new-company flow; pricing comes later in onboarding). Earlier pricing-page breadcrumb variant reverted. Verified e2e.

## 2026-10-05 — Superadmin "Delete client" flow + generic company purge ✅ e2e verified (0 orphans)
- NEW `backend/company_purge.py`: `company_data_preview(cid)` / `purge_company_data(cid)` sweep EVERY collection for `company_id == cid` except `KEEP` ledgers (companies/users/enterprises roots, audit_events/audit_logs/admin_audit_log, platform_payments, enterprise_invoices, referral_earnings, referral_payout_batches, stripe_events, ai_spend_daily). Replaces the stale 16-name lists in `DELETE /companies/{cid}`, admin bulk-delete-by-owner and enterprise-delete (previously orphaned ~17 collections per company — contacts, agent_findings, client_review_batches, communications, reconciliations…).
- NEW `routes/admin_users.py` (superadmin): `GET /admin/users/{uid}/deletion-preview` (owned companies via memberships role=owner ∪ companies.owner_user_id, with per-collection record counts; other_memberships; `enterprise_block` for enterprise/partner owners; referral summary; `can_delete_user`), `DELETE /admin/users/{uid}/companies/{cid}` body `{confirm: name}` (Firm/Partner Books protected), `POST /admin/users/{uid}/delete` body `{confirm_email}` → **demotes to `affiliate`** (not a hard delete): drops all memberships + user-scoped rows, unsets enterprise_id/partner_id/branding, stamps previous_role/demoted_*; 409 while companies owned or enterprise/partner block; audit-logged. Referral slug, earnings, clicks, leads, referred_by untouched.
- `GET /pro/clients` now includes `owner_user_id`.
- FE `components/DeleteClientModal.jsx` + trash button on each Clients **list** row (superadmin only, `delete-client-list-{cid}`): top "Delete user" row locked (email box disabled) until no owned companies; per-company "Type company name to confirm" + Delete with record preview; enterprise/partner owners show an amber block with a disabled "Transfer users to" dropdown (**transfer endpoint = next pass**).
- Verified: 2-company client → both purged (only admin_audit_log rows remain) → user demoted → still logs in to /share with slug + lead intact.
- 2026-10-05 — **Firm transfer** ✅ e2e verified. `routes/admin_users.py`: `enterprise_block` now carries `targets[]` (other enterprises with owners / other partners) + invoice count; NEW `POST /admin/users/{uid}/transfer-firm {target_id, confirm_name}`. Enterprise: companies.enterprise_id(+partner_id) → target, users.enterprise_id → target (excl. owner), pro seats swapped to target owner (incl. owner's non-enterprise pro seats), enterprise_invoices re-pointed (`transferred_from`), source enterprise `merged_into` + archived, owner's enterprise_id unset. Partner: enterprises/companies/users.partner_id → target partner, pro seats swapped, `partners.merged_into`, `users.partner_merged_into`. Both: owner's Firm/Partner Books unflagged (`was_firm_books`) so it can be deleted via the popup; audit-logged. Block clears → Delete user (→ affiliate) unlocks. FE `TransferBlock` in `DeleteClientModal.jsx`: dropdown + "type target name" confirm + Transfer.

## 2026-10-05 — Self-serve signups join the SmartBooks DEFAULT enterprise ✅
- "SmartBooks direct" was only a UI label for `enterprise_id=null`. Now: `POST /companies` with no firm context (platform host, unknown slug) stamps `enterprise_id` = default enterprise (`slug smartbooks`) and adds its owner as `pro` (`via: platform_default`). Billing untouched (per-company Stripe; scheduler only bills `billing_payer=enterprise`).
- `enterprises.py`: `DEFAULT_OWNER_EMAIL` (env `DEFAULT_ENTERPRISE_OWNER_EMAIL`, default **admin@bigsaas.ai**) — boot sets the default enterprise's `owner_user_id` if unset and that user exists; `attach_direct_companies_to_default()` runs at boot (idempotent) → attaches any no-enterprise company (skips Firm/Partner Books + pro/partner/superadmin-owned) and seats the owner as pro.
- FE labels: "SmartBooks direct" → "No enterprise" (ProClients dropdown, AdminClientPayments filter/rows). Tests updated (`test_white_label_signup_attribution.py`: direct → "SmartBooks").
- Preview env: `DEFAULT_ENTERPRISE_OWNER_EMAIL=admin@axiom.ai` (preview default ent already owned by team+smartbooks@…). PROD: on next deploy, owner = admin@bigsaas.ai (must exist as a user) and existing direct companies get attached automatically.
- 2026-10-05 — Transactions tour: new Chapter 4 "Linking invoices & bills" (`tours/transactionsBeats.js`): `more` (clicks All → first row ⋯, opens RowMoreMenu), `link` (spotlights + clicks `txn-link-btn` → LinkModal), `multilink` (spotlights `modal-panel`, "tick several… link multiple invoices or bills", `exitClick: "cancel-btn"` closes modal on leave), finale updated. Engine (`ChatReviewTour.jsx`) gained `beat.exitClick` (clicked on beat exit/unmount). `Modal` panel now has `data-testid="modal-panel"`. RowMoreMenu ignores mousedowns inside the tour overlay so Next/Back don't dismiss the menu. Tour is now 10 beats.
- 2026-10-05 — Tour palette: fuchsia → emerald across `ChatReviewTour.jsx` (chapter label, progress dots, spotlight ring/glow, ghost popup checkboxes/buttons, Next button). Applies to both Transactions and Review Chat tours (shared engine).
- 2026-10-05 — Tour: green countdown badge right of Next (`chat-review-tour-v2-countdown`, "3s…1s") ticking only while the auto-advance timer runs (after voice + clicks complete); hidden when paused or on the finale.

## 2026-10-05 — Receipt-match notifications ✅ (self-tested)
- NEW notification kind `receipt_matched` (bell + NotificationSettings category "Receipt matched to a transaction"; Paperclip icon, teal tone). Fired by `receipt_match.notify_receipt_matched()` only when `link_receipt_to_transaction(..., notify_user=True)` — i.e. the Plaid-ingest background match (`plaid_connect.py`). Goes to `receipts.uploaded_by` (now stamped on `POST /receipts`) else company owner(s). Link `/accounting/transactions?focus={txn_id}`. Dedup via notify()'s 1h source key.
- `receipts.matched_at` stamped on every link. `client_review.receipts_matched_last_7d()` → weekly Quick Check-in email gets a teal "Good news: N receipts you uploaded this week were matched automatically" line (html + text).
- Transactions table + narrow card rows show a teal Paperclip badge (`txn-receipt-badge-{id}`) when `matched_receipt_id | receipt_id | veryfi_receipt_id` is set.
- Per user: NO toast on upload auto-match (explicitly declined).
- 2026-10-05 — Receipt match fix: Michael Co LLC had TWO Home Depot #6234 −$483.29 charges (Sep 6 + Sep 7); receipt dated Sep 6 scored 100 vs 95 → gap <10 → "ambiguous", no auto-link. `score_pair` date points now 0d=35 / 1d=20 / 2-3d=12 / else 6 so a same-day exact match beats its next-day twin (100 vs 90); two charges on the SAME day still tie → suggestions. NEW `POST /companies/{cid}/receipts/match-preview {date, amount, merchant, payment_account_id}` → `{will_link, candidates}`; `Receipts.jsx` RecModal shows a live `BankMatchPreview` strip (green "Bank match: … — links on save" / amber "N possible matches — pick after saving" / grey "No bank transaction found yet") in both Manual and AI views, debounced 350ms.
- 2026-10-05 — Receipt "Paid from" auto-fill: `match-preview` now returns `bank_account_id`; when a confident bank match exists and Paid from is empty, RecModal sets `payAcct` from the matched transaction (pill shows the account) and `save()` skips the "Which account did this come out of?" resolver, committing with the matched account.
- 2026-10-05 — Ambiguous receipt match → tap-to-pick. Root cause of "2 possible matches" even with a same-day winner: `score_pair` capped at 100, so +15 "same account" collapsed 115/105 → 100/100. Cap removed (scores can exceed 100; thresholds unchanged). `ReceiptCreate.match_transaction_id` (optional) → `create_receipt` links that exact unmatched txn before falling back to auto-match. FE: amber strip rows are buttons (`receipt-bank-match-pick-{tid}`) that select a candidate (fills Paid from from it); Save with >1 candidates and no pick opens `BankMatchPicker` popup (`receipt-bank-match-picker`, options `receipt-bank-match-option-{tid}`, "None of these — match it later", Cancel) styled like the Paid-from resolver; picking saves immediately with that txn + its account. User pick always overrides auto will_link.
- 2026-10-05 — Transactions table: receipt Paperclip badge moved from the merchant cell into the row-actions cluster, left of the approve check (`txn-receipt-badge-{id}`). Narrow-card badge unchanged.
- 2026-10-05 — Receipt→transaction link now mirrors UI shapes: `link_receipt_to_transaction` writes `splits[]` (signed, category_account_id/code/name, description; only when >1 line) and appends an `attachments[]` entry (kind receipt, receipt_id, data_url) alongside `line_items` + `attachment_data_url`; sets `category_account_name` for the top bucket. Previously the Edit modal showed no splits / "No receipts on file" for matched receipts. Backfilled Michael Co LLC Sep 6 Home Depot row (8 splits, 1 on file). Paperclip badge now orange (table + card).
- 2026-10-05 — Receipt↔txn lifecycle: `DELETE /receipts/{rid}` → `unlink_receipt_from_transaction` clears splits/line_items/category/attachment(receipt entry)/matched ids and sets needs_review (txn back to uncategorized). `DELETE /transactions/{tid}` → `unmatch_receipt_for_deleted_transaction` nulls `matched_transaction_id/matched_at/match_transaction_id` on its receipt (back to unmatched). NEW `GET /companies/{cid}/receipts/{rid}`. Paperclip badge (table + card) is now a button → `ReceiptPopup` on the Transactions page (`receipt-popup`: image/PDF left, AI narrative + line items right, "Open Receipts" link, Esc/overlay close).
- 2026-10-05 — Edit transaction → Attachments → Remove on a receipt-derived attachment: `DELETE /transactions/{tid}/attachments/{aid}` detects `receipt_id`/kind=receipt → unlinks receipt (splits/category/attachment cleared, needs_review) AND sets the receipt back to unmatched; returns `receipt_unlinked`. Modal resets splits/category/"Receipt linked" and toasts "Receipt removed — transaction is back to uncategorized."

## 2026-10-05 — Receipt match verification (QBO-style 3 states) ✅ self-tested API + UI
- `link_receipt_to_transaction(..., verified=None)`: `_is_exact_match` (amount to the cent AND ≤1 day) → `receipt_match_status: verified`, else `suggested` (still linked w/ splits). User-chosen matches (picker on save, `/receipts/{rid}/match`, rematch) are always verified. Mirrored on `receipts.match_status`.
- NEW: `GET /receipts/verify-count`, `POST /transactions/{tid}/receipt/verify|unlink|rematch {transaction_id:=receipt id}`; list filter `status=receipt_verify` (both list endpoints).
- FE Transactions: amber ringed paperclip for suggested (orange = verified); toolbar chip "N receipts to verify" (`txn-receipts-verify-chip`) toggles the filter; `ReceiptPopup` header status chip + action bar: **Looks right** (suggested only) · **Unlink** · **Match a different receipt** (inline picker from `/receipt-candidates`, unmatched receipts only) · **Snap a new receipt** (opens Edit transaction → Add receipt).
- Not done (backlog): "Receipts to verify" line in grey Cockpit card / Owner Dashboard catch-up.

## 2026-10-05 — ReceiptPopup mobile Receipt | Categories toggle ✅ self-tested (390px + 1920px)
- `ReceiptPopup` (Transactions.jsx): segmented toggle `receipt-popup-pane-toggle` (`receipt-popup-pane-receipt` / `receipt-popup-pane-categories`) shown only `<md`; desktop keeps the split view. Panes: `receipt-popup-image-pane`, `receipt-popup-categories-pane`.
- `MobileTxnCards.jsx` now renders the orange/amber paperclip badge (`txn-receipt-badge-mobile-{id}`) → opens the same popup (was missing on mobile cards).

## 2026-10-05 — "Receipt matches to confirm" on Owner "What needs me?" + Cockpit grey card ✅ self-tested (API + UI)
- `owner_dashboard.py::_attention`: item `id=receipt-verify`, `kind=receipt_verify` (Paperclip icon), tone warn, "N receipt match(es) to confirm", subtitle "<who> · $amt · <date> — amount or date is slightly off", action **Review** → `/accounting/transactions?filter=receipt_verify`. Placed after "receipts are missing".
- `responsibilities.py`: new CATALOG key `receipt_matches_to_confirm` (grey `variant=cleanup`, hidden when 0, default assignment both, not expandable → "Open" link to the filtered Transactions page).
- Transactions.jsx `load()`: added `loadSeq` stale-response guard — deep-link `?filter=receipt_verify` previously lost to a slower unfiltered request racing in after company-switch reset.

## 2026-10-05 — Missing-receipt logic rewrite (receipt_policy) ✅ unit tests + live re-sweep
- NEW `/app/backend/receipt_policy.py` — single "does this need a receipt?" decision shared by `compliance_watcher.scan_company`, `cleanup_scan._scan_missing_receipts`, `routes/agents._run_missing_receipts`. NO account-name regex. Order: not outflow → <$75 floor → documented (receipt/matched/veryfi/linked_bill/linked_invoice/attachments) → transfer pair → uncategorized (categorization question first, never a receipt ask) → non-expense account → P2P (Zelle/Venmo/PayPal/Cash App, PFC TRANSFER_OUT_FROM_APPS) → bank descriptor tokens (RECURRING, BILL PAY, AUTOPAY, DES:INS/LOAN, MORTGAGE, EFTPS, PAYROLL, INTEREST CHARGE…) → Plaid PFC (skip RENT_AND_UTILITIES/LOAN_PAYMENTS/BANK_FEES/TRANSFER/GOV/INSURANCE/streaming; flag GENERAL_MERCHANDISE=pos_retail, FOOD_AND_DRINK=meals, HOME_IMPROVEMENT=supplies_equipment, GAS=fuel, PARKING/TOLLS/RIDESHARE=parking_transport, WITHDRAWAL=cash_withdrawal) → merchant profile (LLM, cached globally in `merchant_receipt_profiles` by normalized name; only consulted when cheap rules can't settle) → account profile (LLM, cached on `accounts.receipt_profile` + `receipt_profile_name`, re-run on rename). Online marketplaces flag ONLY if account is point_of_sale (`online_unknown_items`). Unknown → don't flag.
- Findings now carry `meta.reason_code` / `meta.reason_label`; detail copy = reason ("In-store purchase — the receipt shows what was bought (Target, 2026-09-18)…"). Auto-close re-evaluates open receipt findings every tick (`resolved_reason`), resolves seeded findings lacking txn_id by amount+date, and refreshes copy when the reason changes.
- Re-sweep run via `scripts/resweep_receipts.py` (scan all companies, prune resolved items from check-in/cleanup batches, re-graduate). Michael Co LLC: 21 closed (DIRECTV, Capital One pmts, Zelle, Pennymac, insurance, AT&T…), demo "$2,500" Best Buy/Delta closed (no txn). No recurring-pattern skip by design (user: repeat store trips still need receipts).
- Tests: `tests/test_receipt_policy.py` (6), updated `tests/test_cleanup_scan.py`, `tests/test_agents_phase5_2.py`.

## 2026-10-05 — Transactions tour runs on sample data ✅ self-tested (empty QA company + Michael Co LLC)
- NEW `frontend/src/tours/transactionsSample.js`: `buildSampleTxns(accts)` (12 rows: uncategorized Zelle ×2, AI-suggested, approved, receipt-matched Home Depot, flagged Best Buy, transfer, deposit matching INV-1042) mapped onto the company's own CoA by type+keyword; `SAMPLE_INVOICES` / `SAMPLE_BILLS`; `filterSample`, `sampleProgress`.
- Transactions.jsx: `sampleMode` state + `sampleRef`. `startTxnTour` → sample on; `closeTxnTour` → off + live reload. `load()` short-circuits to sample rows; approve/unapprove/updateCategory/updateContact/del/recategorize mutate locally via `sampleMutate` (toast "Sample data — nothing is saved"). Banner `txn-sample-banner`. CleanupCopilot gets `sampleProgress` prop (overrides donut/pitch). LinkModal gets `sampleDocs` prop (no fetch, no post). ReceiptPopup renders a static sample receipt for `sample-*` ids.
- Auto-fire/onboarding invite now gated on `loadedOnce` instead of `txns.length` (tour fires for empty companies). `load()` now try/catches (429 toast) instead of unhandled rejection.
- AiPanel: chat-history effect has a cancelled guard — fixes stale "I'm watching <previous company>" greeting after switching companies.

## 2026-10-05 — Tour narrator as top bar ✅ self-tested (1920 + 390)
- FINAL: Transactions tour uses `layout="top-bar"` (bar at `top-3`, anchors nudge-scroll below a 170px reserve, floating X hidden in bar layouts since Skip is inline). `bottom-bar` remains available.
- `ChatReviewTour` new props `layout="bottom-bar"` + `barAnchor` (testid/`css:`); `useBarSpan` measures the anchor's left/width (400ms poll + resize/scroll) so the narrator spans exactly the transactions table; horizontal layout (chapter + copy left, controls right), stays bottom for welcome/finale too; mobile falls back to full-width bottom sheet. Card layout unchanged for other tours.
- `useAnchorRect(anchor, idx, reserveBottom)`: popup-ghost beats reserve 420px and nudge-scroll (scrollBy on nearest `main`) so the ghost never hides under the bar.
- Transactions.jsx: `data-testid="txn-table-wrap"` on the table wrapper; tour mounted with `layout="bottom-bar" barAnchor="txn-table-wrap"`.

## 2026-10-05 — Tour beats: copy, re-anchoring, receipts chapter ✅ self-tested
- `ChatReviewTour`: new beat field `afterClickAnchor` — once the beat's click fires, the spotlight re-targets (menu item → `modal-panel`; paperclip → `receipt-popup-panel`) so the opened UI is bright immediately.
- `transactionsBeats.js`: "more" beat now opens with "Next, every row…"; "link" beat uses `afterClickAnchor: "modal-panel"`; NEW chapter 5 "Receipts" — `paperclip` (highlights `txn-receipt-badge-*`, explains orange = exact / amber = confirm) and `receipt-popup` (clicks it, spotlights the popup, `exitClick: receipt-popup-close`); finale copy mentions the paperclip. 12 beats total.
- Sample receipt now shows a real image: `/app/frontend/public/sample-receipt.png` (Home Depot demo) via `attachment_data_url: "/sample-receipt.png"`; `receipt-popup-panel` testid added to the popup's inner panel.

## 2026-10-05 — Tour copy pass + 14-beat finale ✅ self-tested
- Beats 1/4/8/10 reworded per user (checked/uncheck wording, "Link to invoice or bill", "Now, see the orange paperclip…"). Beat 12 "That's it!…", beat 13 recap of the five moves, beat 14 finale "I will put you on the To do screen…" (button "Let's go 🎉").
- `closeTxnTour({completed:true})` now sets filter=unapproved (To do) on live data instead of restoring the pre-tour filter; skip/close still restores.
- Beat 7 reworded ("…I'll open it so you can see."); no longer switches back to All — stays on To do and single-clicks the row's three-dots menu.
- Beat 3 ("check") adds `spotlights: [FIRST_ROW_CATEGORY]` (`txn-cat-picker-*`) so the category field is highlighted alongside the green check.
- `ChatReviewTour` new beat field `spotlightsDelay` (ms) — extra `spotlights` appear N ms into the beat; beat 3 uses 2800ms so the category field lights up when the narrator says "If the category looks right".

## 2026-10-05 — Compact tour ticker ✅ self-tested (1100px w/ AI panel, 390px)
- `ChatReviewTour` bar layouts: `compact` when window < 768 or bar width < 900 (e.g. AI panel squeezes the table). Compact = one thin row (≈42px): mute · word-by-word ticker (`useTypedWords`, 380ms/word, shows trailing 6 words / 4 on phones, flex-end so the tail is always visible, `chat-review-tour-v2-ticker`) · n/N · Back · Next/Finish · Pause(icon) · X(skip). On md+ compact spans from the table's left edge to the window's right edge.
- Non-compact bar: controls column is `w-auto` (was fixed 300px, which collapsed the copy into one word per line on ~1100px screens).

## 2026-10-05 — Mobile transaction cards: action row ✅ self-tested (390px)
- `MobileTxnCards` takes `renderActions(t)`; each card ends with a row (`mobile-txn-actions-{id}`): Receipt chip (orange / amber "Verify receipt", left) · green check (`txn-approve-btn`, same toggleApprove) · sparkles (`txn-ai-{id}`, AI focus) · `RowMoreMenu` (edit/split/link/ask client/delete). Actions stop propagation so taps don't open the Edit modal.
- Note: the demo Home Depot 2026-09-06 receipt had been unlinked (POST receipt/unlink at 16:27Z, likely manual) — re-matched via `/receipts/{rid}/match`.
- `SimilarApproveModal`: pointer-anchored quick strip (`similar-approve-quick-strip`) only renders when `window.innerWidth >= 768`; phones rely on the footer buttons.

## 2026-10-05 — Mobile AI chat as bottom sheet ✅ self-tested (390px)
- `AiPanel`: on mobile (`useIsMobile`) the aside is `fixed left-0 right-0` above the bottom nav (`bottom: 64px + safe-area`), full width, 46vh tall (`data-mobile-sheet="1"`); grows to ~78vh while the text input is focused (`typing` state via onFocus/onBlur). Collapsed on mobile renders nothing (Chat tab / sparkles emit `ai-open`). Resize handle hidden on mobile.
- `Layout` mobile `main` paddingBottom grows to `46vh + 80px` while the panel is open so the last cards stay reachable above the sheet.

## 2026-10-05 — Mobile chat sheet snap points (peek / half / full) ✅ self-tested (390px)
- `AiPanel` mobile `sheet` state: **peek** (~150px: handle `ai-sheet-handle`, one-line last AI message `ai-sheet-peek-line`, input; header/messages/focus card/listening pill/hint tape hidden), **half** (48vh), **full** (100dvh − nav). `ai-sheet-up` / `ai-sheet-down` chevrons; swipe on handle (±40px) steps levels; down from peek closes.
- Routing: `ai-open {source:"nav"}` (bottom-nav Chat tab) → full; `{source:"row"}` (sparkle) or `ai-tell-me-about` → half; other → peek. Input focus from peek → half. Soft keyboard: `visualViewport` inset lifts the sheet (`kbInset`), nav offset dropped while keyboard is up.
- Backlog from this discussion: inline AI answer card on the transaction row (sparkle → answer in-card, "Ask more" → sheet).
- Chat sheet replaces the bottom nav while open (`Layout`: `{aiCollapsed && <MobileBottomNav/>}`; sheet `bottom:0`, full = 100dvh). Closing (X on peek / header X) brings the nav back.
- `SimilarApproveModal` is `z-[70] md:z-50` (above the sheet on phones, unchanged on desktop); AiPanel drops to peek on `ai-bulk-approve-prompt` so the modal's footer stays reachable.
- Mobile sheet header: single 44px row = shrink chevron · drag handle · expand chevron · mute · clear · voice ▾ · X (separate handle row only in peek). Focus on mobile renders a pinned transaction-style card (`ai-focus-txn-card`: FOCUSED / merchant / date / amount / X) instead of the chip + bottom "Cancel focus" pill.
- Sheet is `z-[45]` on mobile so every modal (z-50+) sits above it; a MutationObserver drops the sheet to peek whenever a `[role=dialog]` / `*-modal` / `modal-panel` node appears. SimilarApproveModal back to z-50.

## 2026-10-05 — Mobile bottom nav: swipeable strip ✅ self-tested (390px)
- `MobileBottomNav`: scroll-snap strip (`mobile-nav-strip`, 3 tabs visible + faded sliver of the 4th) with My Business (/owner) · Receipts · Invoices · Transactions · Bills · Reports · Accounting · CRM · Home (product-gated); Chat pinned right (22%). Active = longest matching route prefix. testids `mobile-nav-<label-kebab>`.

## 2026-10-05 — Owner email fix (P0) ✅ verified
- Root cause: no creation path persisted `owner_email`; `_pick_client_email` fell back to `company.owner_id`, a field never written (real field is `owner_user_id`) → dispatcher skipped Check-in emails.
- NEW `company_owner.py`: `resolve_owner_email(company)` (client_email → owner_email → users[owner_user_id|owner_id] → memberships owner), `owner_email_for(cid)`, `backfill_owner_email()`. Used by `client_review._pick_client_email`, cleanup batch creation (client_review + cleanup_scan). Dispatcher projection now includes `owner_user_id`.
- `owner_email` stamped at creation in routes/companies.py (self-onboarding), routes/pro.py (`POST /pro/clients`), enterprises.py (firm books), partners.py (partner books).
- Backfill run: 16 real companies stamped; the 30 still missing are `test-*` fixtures with no owner. Live test: new client via /pro/clients → `owner_email` stored + resolved (then purged).

## 2026-10-05 — Step 1 card respects "AI Transaction Review" mode ✅ self-tested
- `CleanupCopilot` reads `dashboard-todos-mode`: `chat` → review-chat CTAs (existing), NEW `ai` → Step 1 = `/accounting/transactions?filter=unapproved` (work it on the Transactions page), other steps → `/accounting/review-chat?tab=checks`; `checklist` → backend `cta_link` (ai-cleanup-review stepper + tour) unchanged.
- Step 1 in `ai` mode → `/accounting/transactions?filter=unapproved&txnTour=1`; Transactions.jsx consumes `txnTour=1` (after first load) → strips the param and calls `startTxnTour()`.

## 2026-10-05 — Step 1 card title rename ✅ self-tested (curl)
- `backend/routes/firm_glance.py` step1.title: "Review AI categorized" → "AI Transaction Review". Frontend renders `Step 1: {title}` → "Step 1: AI Transaction Review".

## 2026-10-05 — Office Equipment → expense (de minimis <$2,500) ✅ self-tested
- `seed.py`: US `1650 Office Equipment` (asset) removed → `6350 Office Equipment` (expense/operating_expense/operating_expense). UK `7140` → `6330`. `1600 Equipment` stays the fixed-asset account for ≥$2,500.
- `industry_templates.py`: professional_services/advertising/healthcare/legal now seed `6610 Office Equipment` (expense) instead of asset 1500/1510.
- Migration `backend/scripts/migrate_office_equipment_to_expense.py` flipped 11 zero-activity accounts in place; skipped **Michael Co 2, LLC** (acct 1650 has 3 bill JEs incl. $2,249.50 BILL-2004) — user to decide/reclass manually.
- Verified: new company via POST /api/companies seeds 6350 as expense. Note: `tests/test_industry_template_switch.py::test_shared_codes_renamed_on_switch` fails pre-existing (unrelated).

## 2026-10-05 — Michael Co 2 Office Equipment reclass ✅ self-tested
- Created expense `6360 Office Equipment` (6350 was already Fuel & Vehicle Expense in this company); repointed 3 bills (BILL-2004/2005/2014) + their 3 JE lines; deleted asset row 1650. P&L now shows Office Equipment $5,446.79 under expenses; Balance Sheet no longer lists it. Script: `backend/scripts/reclass_michael_co2_office_equipment.py`.

## 2026-10-05 — "Continue catch-up" → To Do clean-up view ✅ self-tested (screenshot)
- OwnerDashboard `startCatchup` now navigates to `/accounting/todo?view=cleanup` (no longer mints a client-review batch).
- ToDo.jsx reads `view=cleanup`: heading "Clean-up items for {company}", hides PendingReview/AgentInquiries cards, scrolls to panel. ResponsibilitiesPanel new props `filter="cleanup"` (keeps only `variant==="cleanup"` items, hides preamble) + `onClearFilter` ("Show all items" banner, testid `resp-panel-cleanup-filter` / `resp-panel-show-all`).

## 2026-10-05 — Owner "Snap it" → missing-receipts picker → pre-linked New Receipt ✅ self-tested
- Backend `owner_dashboard._missing_receipt_rows`: attention `receipts` item + `documents.missing_receipts` now carry `items[].transaction {transaction_id, merchant, description, amount, date, bank_account_id}`; title/count use total open findings.
- `receipt_match.link_receipt_to_transaction` resolves open `missing_receipt` findings for the txn immediately (resolved_by=receipt_link).
- Frontend: `RecModal` (Receipts.jsx, now named-exported) accepts `linkTransaction` → AI mode default, amber "Attaches to: …" strip (testid `receipt-link-target`), prefilled date/amount/paid-from/vendor, forces `match_transaction_id`, skips match-preview. New `components/owner/MissingReceiptsModal.jsx` (testids `missing-receipts-modal`, `missing-receipt-snap-{id}`). OwnerDashboard Snap it opens picker; DocumentsTab Snap receipt opens RecModal directly.

## 2026-10-06 — Owner "Send reminder" → overdue invoices popup ✅ self-tested
- New `components/owner/OverdueInvoicesModal.jsx` (testids `overdue-invoices-modal`, `overdue-invoice-expect-date-{id}`, `overdue-invoice-remind-{id}`): lists `money.invoices` with days_overdue>0; date input saves via `/projections/invoices/{id}/expected-date` on change (reloads dashboard), Send reminder posts `/communications/dunning` and flips to "Sent". OwnerDashboard `onAttention` id=overdue opens it.

## 2026-10-06 — Owner "Upload" (statement needed) → inline upload popup ✅ self-tested
- Attention `stmt-*` items now carry `account_id`, `account_name`, `period_label`. New `components/owner/StatementUploadModal.jsx` (testid `statement-upload-modal`) wraps `StatementsTab bare` with new `defaultAccountId` prop (preselects the bank account → drops skip the confirm modal). OwnerDashboard `onAttention` kind=statement opens it; closing reloads dashboard.
