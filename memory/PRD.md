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

## Backlog
- **P0** Theme Coloring not applied to live app (`PRO_SETTINGS.branding.theme` not loaded into CSS vars on boot)
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
The `/welcome/pricing` step now wires **Core, AI Assistant, and AI
Bookkeeper** plans (both monthly and annual cadences) straight into
Stripe Checkout with a 7-day free trial. Advanced is still un-wired
pending Price ID upload.
- Provisioned an Emergent claimable Stripe sandbox for preview so we
  don't touch the user's live account. Real test-mode keys live in
  `backend/.env` (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_ACCOUNT_ID`, `STRIPE_MODE=test`).
- Backend `_price_id(product, discount, cadence)` now resolves via
  `STRIPE_PRICE_<PRODUCT>_<CADENCE>` (preferred), falling back to the
  legacy discount-tier keys and the very-old `_MONTHLY_38/19` keys.
- `CheckoutSessionIn.trial_period_days` and `.cadence` are new
  optional fields on `POST /api/companies/{cid}/billing/checkout-session`.
  Trial passes through to `subscription_data.trial_period_days`;
  cadence picks the matching Price ID.
- Frontend `PricingPlans.jsx`: Core / Assistant / Bookkeeper cards
  carry `stripeProduct` + `trialDays: 7`. Their CTAs read
  "Start 7-day free trial", show a ⭐ trial ribbon, and on click call
  the checkout-session endpoint with the current cadence toggle
  (monthly/annual) and redirect via `window.location.href`.
- Advanced still routes to `/welcome/summary` and returns a 400 with
  the exact env-var name to add if called directly.
- User's LIVE product IDs (from `acct_1SNoxrECKMX6pzcA`) are
  documented at `/app/memory/STRIPE_LIVE_CATALOG.md` for Railway
  deployment.
- Verified end-to-end on both cadences: Stripe Checkout page renders
  **"7 days free"**, cadence-correct billing detail (per month vs
  per year), **"Total due today: US$0.00"**, **"Start trial"** CTA.
**Files**: `backend/.env`, `backend/routes/stripe_billing.py`
(`_price_id` cadence dim + endpoint), `frontend/src/pages/PricingPlans.jsx`
(all 3 wired plans + cadence pass-through),
`memory/STRIPE_LIVE_CATALOG.md` (new).

## Known Issues
- Wells Fargo Plaid syncing 0 transactions (upstream, P3)
- P0 Theme Coloring bug (saved brand colors never applied to live CSS
  vars on boot) — deferred by user preference
