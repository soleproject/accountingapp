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

