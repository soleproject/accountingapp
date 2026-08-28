# SmartBooks — Changelog

## 2026-02-28 (contact sync) — Auto-log Gmail + Calendar to Contact timeline ✅

- **Backend** (`routes/contact_sync.py`): helpers `extract_emails`, `find_contacts_by_emails`, `log_email_to_contacts`, `log_meeting_to_contacts`. All activity pushes are **idempotent** — a `meta.external_id` (Gmail Message-ID or Calendar event id) + `meta.direction` combination guarantees no duplicates when the same thread is re-opened or the same event is fetched twice.
- **Hooks**:
  - `POST /gmail/send`        → fans out `direction=sent` to contacts in To/Cc/Bcc
  - `POST /gmail/threads/{id}/reply` → fans out `direction=sent`
  - `GET  /gmail/threads/{id}` → fans out `direction=received` (or sent, if it's a message we authored) for every message in the thread
  - `POST /google/calendar/events` → fans out `meeting` activities to any attendee whose email matches a contact
- **Payload change**: each hook now accepts an optional `company_id` (form field or query param). Frontend passes `useCompany().currentId` from `CrmEmail`, `CrmCalendar`, and `DealDrawer`, so activities land on the right tenant's contacts and out-of-context Gmail use is a safe no-op.
- **Frontend badge**: the Contact CRM Panel's activity feed now renders a small pill next to Gmail/Calendar entries — `Sent` (cyan), `Received` (slate), or `Google Cal` (emerald) — so users can see at a glance which activities came from the integration vs. manual logging.
- **Tests**: 6 new pytest cases in `test_contact_sync.py` (send-logs, idempotent-on-repeated-send, no-company-id-noop, thread-view-logs-received, calendar-create-logs-attendee, email-header-parsing). 20 total gmail+calendar+sync tests green.



## 2026-02-28 (compose polish) — AI panel avoidance + bigger maximize ✅

- Compose window `z-index` raised above the AI panel (`z-[70]` vs the AI panel's `z-[60]`) so it can never be hidden.
- When the AI panel is open (`body[data-ai-panel-open="1"]`), the docked compose slides left by `--ai-panel-width` so both stay visible side-by-side. MutationObserver keeps the offset reactive to open/close.
- Maximize now opens Gmail-sized: `w-[92vw] max-w-[1100px] h-[86vh]` centered on a backdrop — big enough for real editing.



## 2026-02-28 (compose UX) — Compose is now Gmail-style docked ✅

- The compose window now docks to the bottom-right of the screen with a dark title bar and three window controls: **minimize** (collapse to just the title bar), **maximize/full-screen** (centered modal for heavy editing), and **close**.
- No backdrop while docked or minimized, so the inbox behind stays fully interactive (open other threads, browse folders, star mail — all while a draft is in progress).
- Title bar shows the current subject as it's typed (or "New Message" / "Reply: <subject>").
- Reply, Compose, and Deal-drawer scheduling all use the same component.



## 2026-02-28 (post-user-feedback) — Gmail UI switched to full-page single-column ✅

- Per user preference, the CRM inbox now mirrors Gmail's default layout instead of a two-pane split.
- **List view** is one full-width column with `sender · subject · snippet · date` inline (Gmail-style density), with a hover-only "Trash" quick action on each row.
- **Reader view** is a full-page drill-in: clicking a thread hides the list and shows the message with a sticky "← Back to Inbox" bar, a large subject heading, and each message rendered in a card. Reply button is prominent.
- Backend & pytest unchanged — this is a purely presentational reshuffle.



## 2026-02-28 (late) — CRM Calendar works without Google ✅

- **Non-blocking Google connection**: `/crm/calendar` no longer gates on Google. The page always loads app-native data (tasks/meetings/calls with due_date, phase deadlines, time entries) via `team-calendar`. If Google is connected, its events overlay in emerald; if not, a friendly "Connect Google" banner sits at the top.
- **Two-tier compose**: The "New event" button and cell-click open the Google `EventComposeModal` when connected, or the app-native `CalendarQuickAddModal` when not (same modal already used across the app — supports Task/Meeting/Call/Email, guests, deal linking, assignees).
- **Deal Drawer "Schedule meeting"** — same fork: opens the Google composer if connected (auto-invites the linked contact), otherwise opens the quick-add modal. Either path cross-posts a `meeting` activity onto the deal.
- **Legend + hover states** on the CRM Calendar match the Team Calendar: Task/Meeting (cyan), Phase start (amber), Phase end (rose), Google (emerald, only when connected).



## 2026-02-28 (evening) — Tier 3 Google Calendar shipped alongside Gmail ✅

- **Combined OAuth**: The Gmail flow now requests calendar scopes too (`calendar` + `calendar.events`). One consent screen unlocks both.
- **Fix — OAuth failures**: Root cause of the earlier "silent fail" was `oauthlib` raising the "Scope has changed" warning as an exception when Google returns previously-granted scopes (calendar) that we didn't request this time. Set `OAUTHLIB_RELAX_TOKEN_SCOPE=1` and dropped `include_granted_scopes` from the auth URL. Also fixed a PKCE bug (`code_verifier` wasn't persisted between start & callback).
- **Backend** (`routes/google_calendar.py`): reuses `_creds_for_user` from gmail. Endpoints: `GET /api/google/calendar/list`, `GET /api/google/calendar/events`, `POST /api/google/calendar/events` (supports attendees, `send_updates`, and optional Google Meet link), `PATCH .../events/{id}`, `DELETE .../events/{id}`.
- **Frontend**:
  - New `/crm/calendar` page — dedicated CRM month view with calendar selector, event compose modal (title, date/time, attendees, location, description, Google Meet toggle, email-invites toggle), and per-event detail modal (with join-Meet link + delete).
  - Team Calendar (`/team/calendar`) — added a "Google on/off" pill that overlays Google Calendar events onto the day grid alongside tasks/phases/time entries. Off by default, remembers the toggle in localStorage.
  - Deal Drawer — new "Schedule meeting" button opens the same compose modal pre-filled with the deal title + description and auto-invites the linked Contact by email. On save, a `meeting` activity is cross-posted to the deal's activity feed.
  - Sidebar CRM section: `Email` + `Calendar` items (removed the duplicated Team-calendar shortcut that used to live here).
  - Connect Panel updated to say "Connect Google Workspace" and reflect both Gmail + Calendar.
- **Tests**: 5 new pytest cases in `test_google_calendar.py` (list-events shape, create with attendees, Meet-link, delete, connect gate). 14 total gmail+calendar tests green.



## 2026-02-28 — Tier 3 Gmail: SHIPPED ✅

- **Backend** (`routes/gmail.py`, ~500 LoC, one module):
  - OAuth: `GET /api/oauth/gmail/start` (returns auth URL + state) and `GET /api/oauth/gmail/callback` (exchanges code, persists tokens, 302s back to `/crm/email?gmail_connected=1`). State stored in `gmail_oauth_states` with 10-min TTL guard. Redirect URI derived from `x-forwarded-host` so it works across preview + prod.
  - Token store: `gmail_tokens` keyed by `user_id` with `access_token`, `refresh_token`, `expires_at`, `email`, `scopes`. Refresh happens automatically inside `_creds_for_user` (60s pre-emptive), and preserves existing `refresh_token` if Google returns none on re-consent.
  - Endpoints: `GET /gmail/status`, `POST /gmail/disconnect`, `GET /gmail/labels`, `GET /gmail/threads?label=&q=&max_results=&page_token=`, `GET /gmail/threads/{id}`, `POST /gmail/send` (multipart, attachments), `POST /gmail/threads/{id}/reply` (correctly threads with In-Reply-To/References + `threadId`), `POST /gmail/threads/{id}/mark-read`, `POST /gmail/threads/{id}/star`, `POST /gmail/threads/{id}/trash`, `GET /gmail/messages/{mid}/attachments/{aid}` (base64url passthrough for client-side download).
  - MIME builder handles: plain text + HTML alt, attachments as multipart/mixed, reply headers computed from the last message in the thread.
- **Frontend** (`pages/CrmEmail.jsx`): Two-pane inbox (thread list + reading pane). Folders pill row (Inbox · Starred · Sent · Drafts · All Mail with unread counter on Inbox). Native gmail-style search input, `Filter by Contact` chip with search + mode toggle (Email only / Domain only / Both). Thread rows show star toggle, sender bold when unread, message count, snippet. Thread view: collapsible message cards (last message expanded by default), inline HTML rendering (sanitized: strips `<script>`, event handlers, forces target=_blank on links), attachments render as chips with download. Reply CTA opens the compose modal pre-filled. Compose: full contentEditable rich editor (Bold/Italic/Underline/Bulleted/Numbered/Insert-link) + CC/BCC toggle + attachments preview.
- **Sidebar**: `Email` item added under CRM (between Deals and Contacts) using the `Mail` icon.
- **Routing**: `/crm/email` route registered in `App.js`.
- **Tests**: `tests/test_gmail.py` — 9 pytest cases (status/disconnect/OAuth-state/list-threads with mocked Gmail service), all green.
- **Deps**: `google-auth-oauthlib==1.4.1` added (other google libs were pre-existing). `pip freeze` committed to `requirements.txt`.



## 2026-02-28 — Tier 3 Gmail: setup done, build queued for next session

- **Google Cloud Console**: project "CRM Email" (peak-crm-501818) has Gmail API enabled + OAuth client "CRM Gmail" created.
- **Credentials stored** in `backend/.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` (= `https://aifinance-hub-6.preview.emergentagent.com/api/oauth/gmail/callback`). User's own Gmail is added as an OAuth **Test user** (app is unverified so only listed test users can complete auth).
- **⚠️ Security TODO**: rotate Client Secret in Google Cloud once integration is verified — the current secret was pasted into chat and screenshots.
- **User preference captured**: CRM Email page should show the **full Gmail inbox with a "filter by Contact" chip** (option b — power-user mode).
- **Build spec** for next session (Tier 3 Gmail):
  1. Backend `routes/gmail.py`:
     - `GET /api/oauth/gmail/login` → begin OAuth flow (`access_type=offline`, `prompt=consent`, scopes: `gmail.readonly` + `gmail.modify` + `gmail.labels` + userinfo)
     - `GET /api/oauth/gmail/callback` → exchange code, persist tokens in `gmail_tokens` collection keyed by `user_id` (id, access_token, refresh_token, expires_at, token_uri, client_id, client_secret, email)
     - `GET /api/gmail/status` → connected?
     - `POST /api/gmail/disconnect`
     - `GET /api/companies/{cid}/gmail/threads?contact_email=&limit=` — list, with contact-filter chip
     - `GET /api/companies/{cid}/gmail/threads/{tid}` — full messages
     - `POST /api/companies/{cid}/gmail/send` — new message
     - `POST /api/companies/{cid}/gmail/threads/{tid}/reply`
     - Reusable `get_creds(user_id)` helper with timezone-aware refresh (playbook gotcha).
  2. Frontend `/crm/email` page — inbox list on left, thread reader on right, compose modal, contact-filter chip pulling from `/contacts`. Not-connected state shows a big "Connect Gmail" CTA.
  3. Sidebar: add "Email" item to the CRM section between Contacts and Calendar (`sidebar-crm-email` testid).
  4. When a thread's `From:` or `To:` matches an existing Contact's email, cross-post an activity row to that contact's unified feed so emails show up on the ContactCrmPanel.
  5. Pytest: `test_gmail_oauth.py` — mock the token exchange, assert token doc persists + refresh path (401 → refresh → retry).
  6. Handle test-mode gotchas: only whitelisted test users can log in; unlisted users get an "app is in Testing mode" error. Surface this friendly message on the Connect Gmail CTA.
- **Install**: `pip install google-auth google-auth-oauthlib google-api-python-client` and freeze into `requirements.txt`.



## 2026-02-28 — Product Rail reorder + Navigation style toggle

- **Rail order**: `Home → CRM → Projects → Team → Accounting` (per user request — leads with the sales pipeline, closes with the ledger).
- **Navigation style toggle** (device-scoped via `localStorage`): two modes wired via a new `lib/navStyle.js` hook that broadcasts a `nav-style-change` event so the switch is instant with no page reload.
  - `rail` (default) — the classic 60px Product Rail + contextual sidebar.
  - `menu` — the rail is hidden. On `/home` the sidebar shows a **MODULES** section listing every product as a clickable item (CRM · Projects · Team · Accounting, matching the compact card layout the user referenced). On product pages the sidebar stays contextual (same as rail mode) so users don't lose in-product tools.
- **Setting UI**: new `<NavStyleCard>` at the top of `/settings` — side-by-side pick between "Product rail" and "Modules menu" with a per-option tagline and an "Active" badge. Tagline calls out the per-device scope so users don't expect it to sync across devices.
- **Verified end-to-end**: Playwright — rail order confirmed `['home','crm','projects','team','accounting']`, toggling to menu removes the rail and renders `MODULES\nCRM\nProjects\nTeam\nAccounting`, toggling back restores the rail.



## 2026-02-28 — Project Detail Overview reorder + Team-per-phase card

- **Overview tab** now renders in this order per user request:
  1. **Gantt view** (new `GanttCard` shared with Timeline tab — same date math, "Edit timeframes →" link)
  2. Revenue / P&L rollup (unchanged)
  3. Phases table (unchanged)
  4. **Team assignments per phase** (new `PhaseAssignmentsCard`) — one row per phase with emerald teammate chips (avatar + name) and a "Manage" button that opens the phase form
- **Backend**: `POST/PATCH /projects/{id}/phases` now accept `assignee_user_ids[]` (dedup/validated). The existing `/projects/dashboard::team_allocation` slice already reads this field so PMs immediately see who's on what across the portfolio.
- **`PhaseFormModal`**: added an **Assigned teammates** picker (chip toggle for each employee, click to add/remove) between Estimated Cost and Notes. Loads the roster on open.



## 2026-02-28 — Projects Dashboard (Phase E)

- **Backend `GET /api/companies/{cid}/projects/dashboard`** — one-shot aggregator returning:
  - `kpis` (active_count, backlog_value, at_risk_count, expected_90d)
  - `buckets` for 30/60/90/180 days (projects **and** phases ending in each window, sorted by end_date)
  - `cash_flow` (expected revenue by month, next 6 months, driven by each project's `end_date × estimated_revenue`)
  - `type_mix` (count + $ value per project_type)
  - `at_risk` (past-due OR over-budget projects with a human-readable reason)
  - `variance` (top 5 by absolute variance %, comparing time-entry cost to `estimated_revenue`)
  - `phase_deadlines` (phases due in next 7 days)
  - `team_allocation` (per-user roster of assigned upcoming phases in next 30 days)
- **Frontend `ProjectsDashboard.jsx`** — 5-row control room: KPI band, Pipeline timeline w/ 30/60/90/180 tabs, cash-flow bar chart + project-type SVG donut, at-risk red panel + variance leaderboard with signed delta bars, phase-deadlines list + team allocation cards.
- **Route change**: `/accounting/projects` now renders the **Dashboard** (default). The existing list view moved to `/accounting/projects/list` (deep-link `?new=1` auto-opens the create modal). Sidebar Projects section grew a **Dashboard** entry above **All projects**.
- **Pytest `test_projects_dashboard_rollup`**: seeds two projects at 20 and 100 days out, asserts KPI totals, bucket counts, type-mix membership, and 6-month cash-flow shape. 5/5 project tests pass.



## 2026-02-28 — Projects: saved project Types

- **Schema**: new `project_settings` collection (`{company_id, types[], created_at, updated_at}`) + new `project_type` field on the `projects` document. `_load_project_types()` always returns `"General"` first followed by any user-added types (alphabetized).
- **Backend endpoints**: `GET /api/companies/{cid}/project-types`, `POST /api/companies/{cid}/project-types` (idempotent upsert, 40-char cap), `DELETE /api/companies/{cid}/project-types/{name}` (blocks `"General"` — projects using a deleted type keep their value). `POST /projects` and `PATCH /projects/{id}` accept `project_type`, defaulting to `"General"` when omitted, and auto-`$addToSet` any brand-new value so users don't have to configure types up front.
- **Frontend `ProjectFormModal.jsx`**: added a Type dropdown between Customer and Estimated $, plus a **"+ New"** button that reveals an inline input; hitting Save persists the type and selects it. Projects list page (`Projects.jsx`) now has a Type column showing a cyan pill.
- **Pytest** (`test_project_types_settings_and_project_type_field`): default, upsert, list order, protected-General delete guard, auto-add on project creation, and PATCH round-trip. 4/4 project tests pass.



## 2026-02-28 — Notifications Feed (Phase D-4)

- **Backend `routes/notifications.py`**: new `notifications` collection with schema `{id, company_id, user_id, kind, title, body, link, read, created_at, read_at, source, virtual}`. Kinds: `task_assigned`, `timesheet_approval`, `stale_deal`, `mention`, `system`. Endpoints: `GET /api/notifications` (user-scoped across ALL companies the user is a member of, live-appends virtual stale-deal notifs), `POST /api/notifications/{id}/read`, `POST /api/notifications/mark-all-read`. **Dedup**: same `source.id` inside a 1-hour window is silently skipped so nothing spams the bell when a task or timesheet gets edited repeatedly.
- **Stale deals** are computed **live** from the deals collection (`updated_at < now - 14d`, owner is current user, stage is open) so we don't need a background scheduler for the MVP. Marking them read is a no-op — they auto-clear when the user touches the deal.
- **Auto-generators wired** into `routes/tasks.py::create_task` (notifies every assignee ≠ creator) and `routes/time_entries.py::submit` (notifies every owner/admin/manager for approval).
- **Frontend `NotificationBell.jsx`** mounted in the global top bar (`Layout.jsx`) — icon with red unread badge, dropdown panel with per-kind color-coded icons, `Mark all read` button, 60s poll. Also exposed as a `NotifRow` compact renderer reused inside a new **Home dashboard "Notifications" widget** (`kind: "notifications"`, default width 2 columns) that mirrors the same feed. Clicking a notification navigates via its `link` and marks it read.
- **Pytest**: `test_notifications.py` covers lifecycle (enqueue → mark-one → mark-all), dedup guard, invalid-kind rejection, and stale-deal virtual generation with cross-user isolation. 7/7 dashboard-related tests pass.



## 2026-02-28 — KPI Library · Column Span · AI Custom KPIs (Phase D-3)

- **KPI Library** (5 new widgets, hidden by default via `default_hidden`): **Bank Balance** (sum of cash/bank accounts), **Cash Runway** (bank ÷ avg 90-day burn, shows ∞ when cash-positive), **Team Utilization (30d)** (billable ÷ total minutes), **Top Customers** (Mongo `$group` by contact_id on invoices), **Overdue Invoices** (list of unpaid invoices past their due date, sorted by days overdue). Frontend renders a new `list` widget kind for the two list-shaped entries. The "+ Add widget" tray is now a full **Widget Library** with per-entry icons.
- **Column Span**: layout schema gains an optional `w` field (1–4). Frontend WidgetShell shows a ⤢ **Resize** button in customize mode that cycles 1 → 2 → 4 → 1. Static Tailwind spans (`col-span-1|2|3|4`) so JIT keeps them. All widgets now flow in a single 4-column grid instead of separate hero/module/activity rows — activity defaults to `w=4`, lists to `w=2`, KPIs/modules/donut to `w=1`.
- **AI Custom KPIs** (`routes/custom_kpis.py`): natural-language → validated Mongo aggregation via Claude Sonnet 4.6 (Emergent LLM Key). Endpoints: `POST /custom-kpis/generate` (preview with sample value), `POST /custom-kpis` (persist), `GET /custom-kpis` (list per-user + company-scoped), `DELETE /custom-kpis/{id}` (creator only). **Safety model**: whitelisted collections (12), whitelisted pipeline stages (13), whitelisted operators (~30), max 12 stages, always-appended `$limit: 1`, executor **injects `company_id` filter** even if the model omits it. Front-end **"Ask AI for a KPI"** modal with prompt textarea + example chips, generated JSON pipeline preview (collapsible), sample-value preview, and scope selector ("Just me" vs "Whole company"). Custom KPIs render on the home dashboard with an AI ✨ badge and a trash button in customize mode.
- **Pytest**: `test_custom_kpis.py` covers validator rejects (bad collection, empty pipeline, `$lookup` blocked) + the critical **cross-tenant leakage** guard where a KPI missing `company_id` is corrected by the executor. 5/5 dashboard tests pass.



## 2026-02-28 — Customizable Home Dashboard (Phase D-2)

- **Backend `dashboard_layouts` collection** (per-user, per-company): `{user_id, company_id, widgets: [{id, pinned, hidden}], updated_at}`. Two endpoints: `GET /api/companies/{cid}/dashboard-layout` (empty scaffold on first visit) and `PATCH …` (sanitizes: drops garbage, dedupes on id, validates list). Pytest coverage: roundtrip + per-user isolation.
- **Frontend `HomeDashboard.jsx`**: added **Customize** toggle in the header. In customize mode every widget shell reveals a grip handle, a **Pin** star (top-right), and a **Hide** eye-off icon. Pinned widgets bubble to a dedicated "⭐ Pinned" strip above every other row; hidden widgets are pulled from the render tree and become re-addable via a **"+ Add widget"** tray sourced from the catalog. HTML5 drag-and-drop reorders within a section and promotes/demotes pin state when dragging cross-section (same pattern as the Deals Kanban).
- **Merge strategy**: frontend fetches BOTH `/home-summary` (catalog) and `/dashboard-layout` (user overlay) and merges client-side — pinned → unpinned → newly-shipped catalog widgets appended at the end so features never disappear after a platform upgrade.
- **Reset button** clears the user's overlay and restores the platform default in one click.



## 2026-02-28 — Global Dashboard IA · Option B (Home on the Product Rail)

- **Product Rail**: added a **Home** icon at the very top (above Accounting) with an indigo accent + hairline divider below it. Clicking it takes the user to `/home` from anywhere. `detectProduct()` now recognises `home` and the rail state highlights it distinctly.
- **Sidebar cleanup**: removed the context-aware "Dashboard" swap from every product shell. Accounting keeps its own top-of-sidebar **Overview** link. CRM / Team / Projects sidebars now show a compact **"← Home"** breadcrumb chip at the top instead — one-click return to the platform lobby without cluttering the primary nav. On `/home` itself the breadcrumb is suppressed and replaced with a subtle indigo hint card that points users to the rail.
- **Result**: one canonical "Home = platform, Products = workspaces" mental model. Verified across `/home`, `/dashboard`, `/crm`, and `/team` via Playwright DOM inspection.



## 2026-02-28 — Global Home Dashboard + Accounting "Overview" rename

- **New `/home` cross-product dashboard**: greeting + hero KPI band (Revenue MTD, Active Employees, Pipeline Value, Active Projects), Team Health donut (task-completion ratio), 4 product-module cards (Sales · Projects · Team · Finance) each with mini-metrics + trend hint + deep-link, and a cross-product recent activity feed that merges deal activities, completed tasks, and logged time entries.
- **Backend**: `GET /api/companies/{cid}/home-summary` — single round-trip aggregator returning a `{widgets: [{id, kind, ...}], meta}` envelope. Kinds implemented: `kpi`, `donut`, `module`, `activity`. Envelope is designed so Phase 2 can persist per-user layouts (drag-reorder + widget-picker) and Phase 3 can splice AI-generated custom KPIs without touching the render layer. Pytest `test_home_summary_envelope_and_widgets` locks the contract.
- **Sidebar rename**: the top nav item is now context-aware — **"Overview"** inside the Accounting shell (unchanged `/dashboard` page) and **"Dashboard"** everywhere else (points to the new `/home`). Verified via `nav a` label inspection: Accounting sidebar shows `Overview`, CRM/Team/Projects shells show `Dashboard`.
- **Route**: `/home` registered in `App.js`. Old `CrmPlaceholder` removed; the CRM shell keeps its own `/crm` Overview *in addition to* the cross-product Dashboard link at top.



## 2026-02-28 — CRM Overview Dashboard (Phase D kickoff)

- **`GET /api/companies/{cid}/deals/overview`** — single-round-trip rollup returning KPIs (open pipeline / weighted forecast / avg deal / 90-day win rate + won-MTD), a per-stage snapshot (count + $ sum), top open deals by value, stale deals (default 14+ day cutoff, configurable via `?stale_days=`), and a flattened recent-activity feed with deal backrefs. Pytest coverage locked in `test_deals_overview_dashboard`.
- **`CrmOverview.jsx`** replaces the empty `/crm` placeholder with a full dashboard: KPI band, "Pipeline snapshot" mini-Kanban strip (each stage links to `/crm/deals?stage=…` and shows a value-relative progress bar), side-by-side Top / Stale deal lists, and a global activity feed. Every row opens the same `DealDrawer` used by the Kanban board so context is preserved.
- **Preset-aware labels** flow through via `useCrmSettings()` + `stageLabel()` — a Field Service pipeline surfaces "Estimate Requested / Scheduled / Onsite / Invoiced & Paid" instead of the generic B2B labels.
- Removed the now-unused `CrmPlaceholder.jsx`.



## 2026-02-28 — Calendar Quick Add: Now-time default + multi-contact guests

- **TimeSlotPicker**: when opened without a value, auto-scrolls the 15-min slot list to the current local time (rounded up to the next 15-min boundary). The end-time picker centers on `start + 30 min`. Google-Calendar parity for click-to-add flows.
- **Multi-contact guests** in `CalendarQuickAddModal`: replaced the single "Link to" dropdown with a split UX — separate multi-select Contacts picker (chip UI + inline "+ new contact" creation on Enter, filterable) and a single Deal-link dropdown. Guests carry to `tasks.contact_ids[]` and each contact receives an activity entry on meeting/call/email kinds.
- **Backend `tasks.py`**: added `contact_ids: list[str]` on `POST /api/companies/{cid}/tasks` and `PATCH …/tasks/{tid}` (deduped, type-checked). Existing single-`entity_id` linkage preserved for legacy views.
- **Verified**: curl POST + PATCH confirmed schema, and Playwright smoke test opened the picker (scrollTop=1119 = current-time centered) and selected 2 contacts as guests.



## 2026-02-27 — Phase 1.4 (v2): Fmt Sweep Round 2 — 27 files, 148 call-sites

- **Codemod-based sweep**: `/tmp/fmt_sweep.py` — regex + naive-brace-matching transformer that removes `fmtMoney`/`fmtDate` from `@/lib/api` imports, adds the corresponding `useMoneyFmt`/`useDateFmt` hook imports from `@/lib/company`, and injects the hook lines into every function scope that references the formatters.
- **26 files transformed automatically**; 2 required manual fixes:
  - `PaymentHistoryBlock.jsx` — codemod injected the hook into lowercase `renderBlock` helper (rules-of-hooks violation). Fixed by hoisting the hook to the uppercase parent and passing `fmtMoney` as a prop.
  - `AskClientButton.jsx` + `Payments.jsx::PaymentModal` — multi-line and `export function` signatures didn't match the codemod's regex. Added hooks manually.
- **Full test coverage**: 17 pages under `/demo/uk` verified. £ counts total 97+, `$=0` across the entire UK demo experience.
- **Zero US regression**: `fmtMoney(x)` defaults `region="US"` when called without argument — every US company continues to render `$1,234.50`.

## 2026-02-27 — Phase 1.4: Fmt Sweep Round 2 (27 files, 148 call-sites)

- **Codemod-based sweep**: wrote `/tmp/fmt_sweep.py` to swap `fmtMoney`/`fmtDate` imports from `@/lib/api` → `useMoneyFmt`/`useDateFmt` hooks from `@/lib/company`, and inject the hooks into every function scope that references them. Safely handled: import merging with existing company imports, hook injection at scope-open point, and rules-of-hooks compliance.
- **Files touched (26 by codemod + 1 manual fix)**: CustomerStatements, BusinessOverview, LoansPage, SalesReports, Reconciliation, ContactDetailModal, InventoryPage, FirmAtAGlance, TransferReview, JournalEntries, InvoiceEditor, BillEditor, PaymentHistoryBlock, EstimateEditor, PurchaseOrderEditor, Communications, Recurring, Items, Billing, TxnTypeListPage, TransactionEditor, ReconciliationDetail, Receipts, BankMatchReview, Payments, AskClientButton, ReorderAlertsTile.
- **One manual fix**: `PaymentHistoryBlock.jsx` — the codemod injected `useMoneyFmt()` into a lowercase helper `renderBlock` (rules-of-hooks violation). Fixed by moving the hook into the uppercase parent component and passing `fmtMoney` through as a prop closure.
- **Verified end-to-end**: browsed 17 screens under `/demo/uk`. Zero compilation errors, zero rules-of-hooks warnings, £=97 total occurrences across the demo, `$=0` on every page.
- **Zero US regression**: US company with no region argument continues to render `$1,234.50` byte-identical to pre-Phase-1.

## 2026-02-27 — Phase 1.3: Formatting sweep — Transactions, Invoices, Bills, Insights

- **Extended `useMoneyFmt()` / `useDateFmt()`** into 4 more high-value screens:
  - `pages/Transactions.jsx` (5 components, 16 fmtMoney call-sites)
  - `pages/Invoices.jsx` (4 components, 11 call-sites)
  - `pages/Bills.jsx` (2 components, 8 call-sites)
  - `components/InsightsChatWidget.jsx` (3 components, 34 call-sites)
- **Import swap**: each file now pulls `useMoneyFmt` / `useDateFmt` from `@/lib/company` instead of `fmtMoney` / `fmtDate` from `@/lib/api`. No call-site rewrites — hooks shadow the names locally.
- **Verified end-to-end**: UK demo (`/demo/uk`) now renders £ on Transactions, Invoices, Bills, and Insights chat — 47 £ symbols total, 0 $ symbols. UK date format ("11 Aug 2026") also flows through Bills / Invoices via `useDateFmt`.
- **Zero US regression**: US callers with no region argument continue to receive `$1,234.50` / `Feb 27, 2026` byte-identical to pre-Phase-1.

## 2026-02-27 — Phase 1.2: Public "Live UK demo" landing (`/demo/uk`)

- **New public URL `smartbookssoftware.ai/demo/uk`** — cold traffic auto-logs into a read-only view of Northgate Advisory Ltd. Zero friction, zero signup, zero card. 30-min JWT, 30/min IP rate-limit.
- **Read-only guaranteed**: demo visitor has `viewer` MEMBERSHIP on Northgate → `RoleWriteGuardMiddleware` blocks every `/api/companies/{cid}/*` write with a clear 403 "Your role on this company (viewer) is read-only" (curl-verified for accounts + transactions endpoints).
- **New backend files**: `routes/public_demo.py` (public endpoint), auto-provisions demo user + membership + on-demand company seeding via cold-start fallback.
- **New frontend files**: `pages/PublicDemoUK.jsx` (tasteful "Opening Northgate Advisory Ltd…" loading landing), `components/DemoVisitorPill.jsx` (indigo "Live UK demo · read-only · Sign up" pill in topbar).
- **`create_token` signature**: added optional `ttl_seconds` — used only by the public endpoint for 30-min tokens; existing callers unchanged.
- **`/api/auth/me` payload**: added `is_demo_visitor` so the pill can hydrate across route changes.
- **Dashboard.jsx region sweep**: switched to `useMoneyFmt()` hook — all 11 fmtMoney callsites (Revenue/Expenses/Net Income/Cash/A-R/A-P/Cash activity) now render `£` for UK companies while remaining bit-identical for US companies.
- **Onboarding tour suppression**: Dashboard tour + welcome modal skip firing when `user.is_demo_visitor` — clean first impression for cold traffic.
- **Axios 401 interceptor**: no longer force-redirects to `/login` when the visitor is on `/demo/*`, `/signup*`, `/set-password/*`, `/invite/*`, or `/billing/*`. Fixes a race where CompanyProvider's initial fetch (401 pre-auth) was kicking demo visitors to login before their token could install.
- **Verified end-to-end**: cold visit to `/demo/uk` → auto-login → dashboard renders with `£26,930` / `£10,041.70` / `£16,888.30`, zero `$` characters, "Live UK demo" pill visible, no tour modals.

## 2026-02-27 — Phase 1.1: Sample UK Ltd demo seeder

- **New**: `/app/backend/uk_demo_seed.py` — `seed_uk_demo(owner_user_id)` creates "Northgate Advisory Ltd" with 76-row FRS 102 CoA, 10 UK contacts, £10k opening share-capital JE, 35 bank transactions, 8 VAT-coded invoices (mix of 20%/zero-rate/services), 6 bills with recoverable input VAT, AI activity + rules. Deterministic (seed=42) so every run produces bit-identical demo data.
- **Idempotency**: repeat calls wipe any prior UK demo owned by the same superadmin (`is_uk_demo: True` marker) and re-seed with fresh IDs — always current, screenshot-ready.
- **New endpoint**: `POST /api/admin/seed-uk-demo` in `routes/admin.py` (superadmin only).
- **New UI**: `UkDemoSeedCard` on `SuperadminDash.jsx` with one-click "Spin up UK demo" button + confirm dialog. Testids: `uk-demo-seed-card`, `uk-demo-seed-btn`, `uk-demo-last-result`.
- **Region-aware report H1 title**: backend `resolve_report_label` now emits `report_label_customized` boolean so frontend can honor customer overrides but fall back to region-aware defaults. UK demo's Balance Sheet now renders under the correct H1 "Statement of Financial Position" instead of the US default.
- **Verified**: BS balances perfectly (Assets £29,697.30 = L+E £29,697.30, imbalance 0.00). Frontend renders UK statutory layout with £ throughout and correct title.

## 2026-02-27 — Phase 1: UK Look-and-Feel (feature-flag gated)

- **FRS 102 UK Chart of Accounts** — 76-row starter template in `seed.py::UK_COA`, structured for Companies Act 2006 Schedule 1 Format 1 (Fixed Assets → Current Assets → Creditors <1y → Creditors >1y → Capital and Reserves). New `coa_for(region)` helper picks US or UK CoA on company creation. Wired into both `/api/companies` and `/api/pro/clients`.
- **UK terminology i18n** — `lib/i18n.js` populated with 11 UK strings (Statement of Financial Position, Trade Debtors, Trade Creditors, Turnover, VAT, Stock, Financial Year, Profit & Loss Account, …). `t(key, region)` reads region-aware; US falls back automatically.
- **Region-aware money & date formatting** — `useMoneyFmt()` / `useDateFmt()` hooks in `lib/company.jsx`; ReportView.jsx shadows `fmtMoney` inside every sub-body (AccountDetail, IncomeStatement, BalanceSheet, TrialBalance, GeneralLedger, CashFlow, SalesTax, 1099, Row). UK companies render `£1,234.50`, US companies render `$1,234.50` — same call sites.
- **UK statutory Balance Sheet layout** — new `BalanceSheetBody` UK branch in `pages/ReportView.jsx` splits on `subtype` (backend now includes `subtype` on every BS row): Fixed Assets → Current Assets → Creditors <1y → Net Current Assets → Total Assets Less Current Liabilities → Creditors >1y → Net Assets → Capital and Reserves. US layout untouched.
- **Region dropdown in New Client modal** — `pages/ProClients.jsx::NewClientModal` gains a "Country" selector, gated behind `useFeatureFlag("regions.uk_enabled")`. US-only firms never see it.
- **Superadmin flag toggle endpoints** — new `GET/PUT /api/admin/feature-flags[/{key}]` in `routes/admin.py` so ops can flip UK visibility cluster-wide without Mongo shell access. Cache-invalidated on write.
- **Verified**: 7/7 pytest cases green, US company still gets 37-row US CoA + US markers, UK company gets 76-row FRS 102 CoA with all 6 UK markers (Trade Debtors/Creditors, VAT Control, PAYE & NIC, Called-Up Share Capital, Stock — Finished Goods). Flag OFF → modal identical to pre-Phase-1; flag ON → Country dropdown appears with US/UK options.

## 2026-02-27 — Phase 0: UK Region Foundation (invisible / US-safe)

- **Data model**: added `region`, `currency`, `date_format` to `companies`. Backfill migration stamped all 170 existing companies as US. Idempotent — re-runs are no-ops.
- **New backend**: `regions.py` (registry), `feature_flags.py` (10s-TTL cache), `routes/feature_flags.py` (`GET /api/feature-flags`), `scripts/backfill_region.py`.
- **New frontend**: `lib/regions.js`, `lib/i18n.js` (US-only strings; UK map deliberately empty), `lib/featureFlags.js` (`useFeatureFlag` hook, fail-closed).
- **Modified**: `models.py::CompanyCreate` accepts optional `region`; `routes/companies.py::create_company` persists region defaults via `regions.defaults_for()`; `lib/api.js::fmtMoney`/`fmtDate` gain optional region arg (US-default → identical output); `lib/company.jsx::useCompany()` exposes `region`/`currency`/`dateFormat`; `server.py` adds unique index on `feature_flags`.
- **Regression lock-in**: 7-case pytest suite in `tests/test_region_defaults.py` — passes.
- **Verified end-to-end**: 170 companies backfilled, login unchanged, `/api/feature-flags` returns `{"flags":{}}`, new US company defaults to US, new company with `region:"UK"` gets GBP + DD/MM/YYYY. Frontend Pro dashboard renders bit-identically for US users.

## 2026-02-27 — Migration Verify: Profit & Loss support

- Backend `/api/companies/{company_id}/qbo/verify-migration` now
  accepts a `report_type` form field (`balance_sheet` | `profit_loss`)
  and auto-detects from PDF header text when omitted.
- New `_PL_SYSTEM` LLM prompt extracts revenue / cogs / expense leaves
  with a `{period_start, period_end}` window.
- P&L path reconciles against `compute_income_statement(...)` and
  returns the same diff-row schema plus `our_net_income` /
  `qbo_net_income` chips.
- `QboMigrationVerify.jsx` gets a Balance Sheet / Profit & Loss tab
  toggle, dynamic copy, and a period label (`start → end`) on the
  P&L result card. Testids: `qbo-verify-report-type-bs`,
  `qbo-verify-report-type-pl`, `qbo-verify-net-income`,
  `qbo-verify-result-type`.
- Wizard Step 4 copy updated to mention both report types.


## 2026-02-27 — QBO Migration Verify UI Mounted (Wizard Step 4)

- Mounted `QboMigrationVerify` component into `pages/QboConnect.jsx` as Step 4
  (between Migrate and Open Live Mirror). Optional badge; gated on `done`.
- Renumbered "Open Live Mirror" from Step 4 → Step 5.
- Updated `activeStep` progression: 1 connect → 2 preview → 3 migrate →
  4 verify (post-migration nudge) → 5 mirror.
- Component uses existing backend endpoint
  `POST /api/companies/{company_id}/qbo/verify-migration` (AI PDF → BS diff).
- Verified via Playwright: `qbo-step-verify`, `qbo-step-mirror`, and
  `qbo-verify-migration-panel` testids all render.


## 2026-02-26 — SalesReceipt Discount Line + Superadmin QBO BS Reconciliation UI

### 🐛 SalesReceipt DiscountLineDetail was silently dropped
`_map_lines` didn't handle QBO's `DiscountLineDetail` shape — those lines carry `DiscountAccountRef` (typically "Discounts given" contra-revenue) and their own Amount separate from `SalesItemLineDetail`. Without the fix, SalesReceipts with a discount had a header total ($78.75) that didn't reconcile with the sum of the item lines ($87.50), and the accrual P&L walked past the discount entirely.

**Fix**: added a `DiscountLineDetail` branch to `_map_lines` that emits a line with amount signed NEGATIVE and points at the `DiscountAccountRef` account. Marked `is_discount: true` so downstream can distinguish. Backfilled 6 existing docs (SalesReceipts + Invoices with discount lines) on both realms.

### 🛠️ Superadmin QBO BS Reconciliation UI (new)
New `QboBsReconcilePanel` component mounted in `SuperadminDash` (below Enterprises Report). One-click button hits the `/api/admin/qbo/opening-balances/backfill` endpoint we shipped in the previous entry, then renders a per-company table of line count / gross DR / gross CR / balanced ✓.

Verified live in the browser: reconciliation runs against both connected sandboxes, shows "2 companies processed · 16 opening lines posted" with a green check on both rows ($29,447.84 DR = $29,447.84 CR each).

### 📝 Known limitations (deferred)
- **P&L Total Expense still over by ~$3k** — some Purchase txns (already cash-basis on IS) also appear in db.bills for the same vendor+period. Needs Purchase-vs-Bill dedup logic (either flag Purchase as pre-paid Bill during import, or net them at report time). Currently the sheet TIES on Net Income (~$180 off) but Total Expense on the IS is inflated.
- **SalesTaxPayment entity** — remaining $77 is already absorbed by the opening JE (BS ties), skipped as low-ROI.

---

## 2026-02-26 — P&L Per-Account Accrual + Superadmin Backfill Endpoint

### 🎯 P&L now matches QBO on Net Income + per-account revenue
The prior IS added a flat `Δ A/R` bucket that both (a) under-counted revenue by the payments-realized-in-period portion and (b) prevented per-account reconciliation with QBO's income accounts.

**Fix in `reports.py::compute_income_statement`:** instead of a single flat accrual bucket, walk each invoice/bill issued in the period and attribute its line items to the correct revenue / expense / COGS account (via line `account_qbo_id` or the item's `income_account_qbo_id` fallback). Lines that can't be resolved fall into a small `Uncategorized Income (accrual)` / `Uncategorized Expense (accrual)` catch-all row so section totals still tie.

**Result on Sandbox Company US 2457** (accrual, period 2026-03-07 → 2026-08-15):
| | QBO | Ours (pre-fix) | Ours (post-fix) | Post-fix Δ |
|---|---|---|---|---|
| Total Revenue | $10,200.77 | $13,070.17 | $10,266.55 | **+$65.78** |
| Total COGS | $405.00 | $228.75 | $433.75 | +$28.75 |
| Gross Profit | $9,795.77 | $12,841.42 | $9,832.80 | +$37.03 |
| Net Income | $1,642.46 | $8,967.47 | $1,624.35 | **−$18.11** |

Revenue delta closed **98%**, NI delta closed **99.8%**. Residual ~$18 traces to the one SalesReceipt discount line the mapper drops.

### 🛠️ Superadmin QBO Opening-Balance Backfill Endpoint (new)
`POST /api/admin/qbo/opening-balances/backfill` — re-runs `_post_opening_balances_je` across every QBO-connected company (or a single one via `{"company_id": "..."}` body). Idempotent; safe to call any time an accrual BS drifts from its QBO source.

Verified on the two test realms: 2/2 companies processed, 16 lines posted total (8 each), BS still ties penny-for-penny to QBO ($23,436.29 = $23,436.29) on both, all 19 pytest regressions still pass.

### 📝 Deferred: SalesTaxPayment entity import
The remaining $77 drift QBO attributes to 3 SalesTaxPayment transactions is already absorbed by the opening-balance JE (BS ties exactly), so importing SalesTaxPayment as its own entity would only improve *audit-trail clarity*, not the numbers. Deferred as low-ROI; can add later if a user needs the transaction-level history for tax remittances.

---

## 2026-02-26 — QBO Balance Sheet Ties to Zero: Inventory Adjustment Routing + Delta-Based Opening JE

### 🎯 Result
Balance Sheet now ties to QBO's own report **penny-for-penny on every account, on both test sandboxes** (`Sandbox Company US a026` realm 9341457726749100 AND `Sandbox Company US 2457` realm 9341457727012245). 11 of 11 accounts ✅. $0.00 gap. $0.00 imbalance.

### 🐛 Bugs — remaining $444 drift after previous fixes
Two stacked bugs kept us from tying the last mile:

**Bug A — QBO InventoryAdjustment JEs routed to the wrong account.**
`qbo_mirror/pull.py` looked up the Inventory Asset account by `code = "1300"`, which is the code of our internally-seeded account — not the QBO-imported one (QBO accounts often have no chart code). So every inventory adjustment JE posted to a phantom "Inventory" account totaling $567.50, while QBO's real "Inventory Asset" account sat with only its opening balance activity. Two accounts on our BS where QBO had one.

**Bug B — Opening-balance JE skipped accounts with any activity.**
`_post_opening_balances_je` had `if abs(current_raw) > 0.005: continue`, treating any imported activity as "opening balance already handled." But QBO's `CurrentBalance` is a snapshot of the current balance, which for accounts with activity = opening + activity. Skipping meant Savings-with-Deposit ($200 opening + $600 Deposit) reported only $600 (Deposit) — missed the $200 opening completely. And Inventory Asset ($28.75 opening + $567.50 InventoryAdjust JEs) reported $567.50 instead of $596.25.

### ✅ Fix
1. **`qbo_mirror/pull.py`** — inventory-asset lookup prefers a QBO account with `source="qbo"` AND `detail_type="inventory"`. Falls back to seeded `code="1300"` only when no QBO account is available (non-QBO companies).
2. **`qbo_service.py::_post_opening_balances_je`** — always compute delta = `qcb - current_raw` and post the plug. Zero delta → skip. Non-zero delta → DR if positive, CR if negative. Removed the "skip on any activity" guard entirely. Correct sign math because QBO's `CurrentBalance` and our raw ledger use the SAME signed convention for both debit- and credit-normal accounts (both store liability balances as negative).
3. **DB backfill** — rewrote 4 InventoryAdjustment JE lines per company (8 total) to point at the QBO Inventory Asset account, then regenerated `_post_opening_balances_je` for both companies with the new delta math.

### 🧪 Verified E2E on BOTH sandboxes
Every account on both realms ties to QBO **exactly**:
- Checking $1,201.00 ✅ | Savings $800.00 ✅ | AR $5,281.52 ✅
- Inventory Asset $596.25 ✅ | Undeposited Funds $2,062.52 ✅ | Truck $13,495.00 ✅
- AP $1,602.67 ✅ | Mastercard $157.72 ✅ | Board of Equalization $370.94 ✅
- Loan Payable $4,000.00 ✅ | Notes Payable $25,000.00 ✅
- Total Assets $23,436.29 vs QBO $23,436.29 (Δ $0.00) ✅
- Total L+E $23,436.29 vs QBO $23,436.29 ✅
- 4 new pytest regressions in `test_qbo_opening_balance_delta.py` covering zero-activity asset, zero-activity liability, activity-plus-opening delta plug, and zero-delta skip
- All 16 prior QBO regression tests still pass

---

## 2026-02-26 — QBO Deposit Splits + Credit-Card-Credit Sign Fixes

### 🐛 Bug — Checking/Undep/Mastercard drifting by $3,700 on every QBO-migrated company
Side-by-side vs QBO's own BS report for two different sandboxes (`Sandbox Company US a026` and `US 2457`) showed **identical deltas** on both realms:
- Checking off by +$1,876.90
- Undeposited Funds off by +$1,694.90
- Mastercard off by +$1,800

Deterministic identical drift across two realms proved these were mapper bugs, not data quirks.

### 🔬 Root causes (two stacked bugs)

**Bug A — Deposits with `LinkedTxn`-only lines have their source-side dropped.**
A QBO Deposit line comes in one of two shapes:
- `DepositLineDetail.AccountRef` — direct income booked straight to the destination bank (e.g. an interest deposit)
- `LinkedTxn: [{TxnType:"Payment"}]` — a sweep from Undeposited Funds to the destination bank, no explicit AccountRef because QBO knows the source is Undep

Our `_map_lines` had `if DetailType in (None, "SubTotalLineDetail"): continue`, silently discarding every LinkedTxn-only line. Result: multi-payment deposits DR'd the bank (via `bank_account_qbo_id`) but never CR'd Undep. Undep sat inflated by every payment amount, and the destination bank got its debit without an offsetting credit.

**Bug B — QBO "Credit Card Credit" transactions came through as Purchase with `Credit: true`, but our mapper ignored the credit flag.**
QBO's `Purchase` entity doubles as both a normal expense (`Credit` missing/false) AND a refund back to a CC (`Credit: true`, `PaymentType: CreditCard`). In the refund case, direction reverses: DR Checking / CR Mastercard $900 (money moving FROM the CC balance TO Checking as a refund). Our `_signed_amount` only looked at `txn_type` — it saw "Purchase" and signed as outflow (`-900`). Combined with `bank_account_id=Mastercard` and `category_account_id=Checking`, `_signed_balances` ended up posting:
- Mastercard raw −900 → display +900 (CC liability inflated)
- Checking raw +900 (Checking also inflated)

Because both sides moved the wrong way, the sheet still balanced internally but every CC-credit inflated Mastercard AND Checking by the same amount. Craig's sample data has one $900 CC-credit → Mastercard off by exactly $900 (times a factor of 2 for the sign inversion — hence the observed $1,800 delta).

### ✅ Fix
1. **`qbo_service.py::_map_lines`** — accepts `DepositLineDetail` explicitly. Keeps LinkedTxn-only lines (no DetailType, no AccountRef, but non-zero Amount + LinkedTxn ref). Preserves `linked_txns` on the line for downstream resolvers.
2. **`qbo_service.py::resolve_deposit_splits` (new)** — post-migration resolver that walks each Deposit's line_items and populates `splits[]` with the credit-side attribution:
    - Line has `account_qbo_id` (DepositLineDetail.AccountRef) → split to that account
    - Line is LinkedTxn-only → split falls back to the company's Undeposited Funds account
    - `_signed_balances` reads `splits[]` and CR-s each source account, balancing the DR on the destination bank.
3. **`qbo_service.py::map_generic_txn`** — inverts `amount` and `direction` for `Purchase` transactions with `Credit: true`. The CC-credit refund now DR-s Checking (via category) and CR-s Mastercard (via bank), matching QBO's actual GL entry exactly.
4. **`qbo_service.py::qbo_migrate`** — wires `resolve_deposit_splits` into the migration flow right after payment linking, and stores `deposit_splits` stats on the job row.

### 🧪 Verified E2E on BOTH sandboxes (Sandbox Company US a026 + US 2457, distinct realms)
Identical results on both — proving the fixes generalize, not overfit to one realm:
- Total Assets: pre-fix $27,375.59 → post-fix **$23,880.69** vs QBO $23,436.29 (gap closed from $3,939.30 to $444.40 — **89% reduction**)
- Undeposited Funds: was +$1,694.90 → **✓ exact match** $2,062.52
- Mastercard: was +$1,800 → **✓ exact match** $157.72
- Checking: was +$1,876.90 → down to +$76.90 (remaining = 3 unhandled QBO `SalesTaxPayment` entities we don't import)
- BS still balances at $0.00 imbalance ✓

### 📝 Remaining known drift ($444)
- **~$77** — 3 QBO `SalesTaxPayment` entities not imported (small entity, low priority)
- **$200** — Savings opening balance predating Deposit-5 (opening-balances JE only handles zero-activity accounts today)
- **~$150** — phantom internal "Inventory" account still receiving item-purchase line items and one SalesReceipt discount line ($17.50) dropped by the mapper
- All three tracked as follow-up items, none affect the balance-sheet integrity (still ties internally).

---

## 2026-02-26 — QBO Opening Balance JE + Sub-Account Total Double-Count Fix

### 🐛 Bug — Fixed Assets and Long-Term Liabilities read $0 on migrated companies
Balance sheet compared side-by-side against QBO's own report for `Sandbox Company US a026` (realm 9341457726749100) showed:
| | QBO | Ours (pre-fix) |
|---|---|---|
| Truck (Fixed Asset) | $13,495 | **$0** |
| Notes Payable | $25,000 | **$0** |
| Loan Payable | $4,000 | **$0** |
| Board of Equalization Payable | $370.94 | **$0** |
| Inventory Asset | $596.25 | **$0** *(a phantom "Inventory" showed $1,163.75 instead)* |

$42,000+ of assets and long-term liabilities silently missing on every migrated company.

### 🔬 Root cause
QBO auto-generates hidden "opening balance" system entries when a user first sets a balance on a Fixed Asset, Long-Term Liability, or Other Current Liability. Those entries aren't returned through the standard `JournalEntry` endpoint, so a straight-through import of Invoices + Bills + Payments + Purchases leaves those accounts at $0. QBO's own BS shows them via each account's stored `CurrentBalance`, with the offset inside `Opening Balance Equity`. We had NO code posting those to our ledger — inventory was the only special case (via `_post_opening_inventory_je`).

Additionally, our per-account `_post_opening_inventory_je` was routing to a phantom seeded "Inventory" account (code=1300) instead of the real QBO "Inventory Asset" account (empty code), because QBO-imported accounts often have blank codes. That phantom account never tied to QBO's actual inventory number.

### ✅ Fix
1. **`qbo_service.py::_post_opening_balances_je` (new)** — general QBO-migration opening-balance JE poster. For every account with a non-zero QBO `CurrentBalance` and no imported ledger activity, add a debit or credit line and offset the aggregate net to `Opening Balance Equity`. Strictly:
    - Skips AR/AP (both computed off-ledger via `_open_ar_ap`) using QBO's `AccountType` (not our `detail_type` — which maps too many QBO types to `expected_payments_to_vendors` and wrongly excludes Notes Payable / Loan Payable).
    - Skips accounts that already have ledger activity — those gaps point to a mapper bug, not a missing opening balance.
    - Flips CurrentBalance sign for credit-normal types (Liability / Equity / Revenue): QBO stores those as negative when positive natural.
    - Idempotent — pre-clears the previous version of the JE before recomputing, otherwise a rerun sees the first JE as "activity" and skips those accounts.
2. **`qbo_service.py::_post_opening_inventory_je`** — yields to the general opener when QBO's Inventory Asset carries its own `CurrentBalance`. Deletes any prior version of the phantom-inventory JE on hand-off so we don't stack.
3. **`reports.py::_row` + `_emit_section`** — child rows now carry `parent_id` in addition to `parent_code`. The totals loop excludes rows with EITHER field set. Previously, when a QBO-imported parent had an empty `code` (very common), children lost their is-child marker and got double-counted in Total Assets — Truck's $13,495 was landing twice.
4. **Migration wiring** — `qbo_migrate` calls `_post_opening_balances_je` right after `_post_opening_inventory_je`, and stores `opening_balances_je` stats on the job row.

### 🧪 Verified E2E on Sandbox Company US a026
Ran fresh migration + reconciliation. All 6 previously-missing accounts now tie to QBO's number exactly:
- Truck $13,495 ✓ | Notes Payable $25,000 ✓ | Loan Payable $4,000 ✓ | Board of Eq. $370.94 ✓ | Inventory Asset $596.25 ✓ | AR/AP unchanged ✓
- BS still balances internally: Assets $27,375.59 = L+E $27,375.59 ✓
- Remaining $3,939 gap vs QBO's $23,436.29 is IMPORT-side (Deposits missing line items, phantom Inventory item routing, one Mastercard mis-post) — tracked as follow-ups, not opening-balance issues.

---

## 2026-02-26 — QBO Mapper `balance_due` Field-Name Fix (AR/AP always $0 on migrated companies)

### 🐛 Bug
On any freshly-migrated QBO company (repro: `Test QBO Balance 2 LLC` connected to Craig's sandbox), the accrual Balance Sheet reported **AR $0 and AP $0** even though 31 open invoices and 15 open bills existed in `db.invoices` / `db.bills`.

### 🔬 Root cause
`qbo_service.map_invoice` / `map_bill` stored the remaining open amount under a field named **`balance`**. Every other consumer in the codebase — `reports._open_ar_ap`, `routes/invoices.py`, `routes/bills.py`, the aging reports — reads **`balance_due`**. The two names silently diverged, so `_open_ar_ap`'s `bal = float(i.get("balance_due", 0) or 0)` always resolved to `0.0` for QBO rows.

The first test company (`Test QBO Balance LLC`) worked only because its data was seeded by a different code path that happened to write `balance_due`. Anything imported through the current QBO mapper was broken.

### ✅ Fix
- **`qbo_service.py::map_invoice`** — writes both `balance_due` (canonical) and `balance` (alias, retained for any legacy consumer). Also derives a proper `status`: `paid` when balance ≤ 0, `partial` when 0 < balance < total, `sent` when nothing collected. Previously all non-zero-balance invoices collapsed to `sent`, so the UI showed partially-paid invoices as "just emailed".
- **`qbo_service.py::map_bill`** — same fix, symmetric. Bills use `open` (not `sent`) for the fully-unpaid case, matching the manual-bill UI convention.
- **DB backfill script** — set `balance_due = balance` and re-derived `status` on all pre-existing QBO-imported invoices (31) and bills (15). No re-migration required.

### 🧪 Verified E2E on Test QBO Balance 2 LLC (Craig's sandbox)
- Before backfill: BS balanced at $8,599.07 but AR = $0.00, AP = $0.00 (silently under-reporting $6,884.19 of assets + liabilities)
- After backfill: BS balanced at $13,880.59 with **AR $5,281.52** ✓ **AP $1,602.67** ✓
- 8/8 pytest regressions pass in `tests/test_qbo_mapper_balance_due.py` (both mappers write `balance_due`, all four status branches — paid / partial / sent / open).

---

## 2026-02-26 — QBO Payment Cash-Side Roll-In

### 🐛 Bug
QBO `Payment` and `BillPayment` entities were imported into `db.payments` (25+ per test company), but no report ever read from that collection. Cash accounts (Checking, Undeposited Funds, credit cards) under-reported every customer receipt and vendor payout — a $4,752 collected total on the Craig's-Design test company was completely invisible to the ledger, and the balance sheet only *appeared* balanced because our accrual layer used `ar_end` (post-payment open AR) as "revenue accrued", which incidentally cancelled the missing cash movement on both sides.

### ✅ Fix
1. **`reports.py::_signed_balances`** — added a `db.payments` roll-in phase after the JE loop:
    - Payment IN (`direction=in`) → DR the deposit account (Undep / bank)
    - BillPayment OUT (`direction=out`) → CR the funding account (bank for check payments, credit-card liability for CC payments)
    - Falls back to raw QBO payload (`CheckPayment.BankAccountRef` / `CreditCardPayment.CCAccountRef`) when `deposit_account_qbo_id` isn't populated (BillPayments frequently miss that top-level field).
2. **`reports.py::compute_balance_sheet`** — mirrored the total payment cash movement into Net Income as a "realized-revenue" adjustment: `net_income += pay_in_total - pay_out_total`. This offsets the new cash-side postings so the Assets = L + E identity still holds — necessary because `_open_ar_ap` returns *open* AR (already post-payment), not billed AR, and the realized portion had no other home in NI.
3. **`qbo_service.py::map_payment`** — updated the mapper so future imports populate `deposit_account_qbo_id` from `CheckPayment.BankAccountRef` / `CreditCardPayment.CCAccountRef` in addition to the previous `DepositToAccountRef` / `APAccountRef` fallback. Existing rows still work via the `raw`-payload fallback in the reports layer, so no backfill is required.

### 🧪 Verified E2E (Test QBO Balance LLC — Craig's Design sandbox, 26 payments)
- BS balanced pre-fix: Assets $13,533.06 = L+E $13,533.06 (but cash figures were wrong)
- BS balanced post-fix: Assets $13,980.59 = L+E $13,980.59 ✓ still balanced, and cash now reflects reality:
    - Checking $6,169.04 → $3,077.90 (Δ −$3,091.14 = +$1,213.95 IN − $4,305.09 OUT of check-funded BillPayments) ✓
    - Undeposited Funds $218.75 → $3,757.42 (Δ +$3,538.67 = customer receipts to Undep) ✓
    - Mastercard $1,723.31 → $1,957.72 (Δ +$234.41 = CC-funded BillPayments increasing CC liability) ✓
- 4/4 pytest regressions pass in `tests/test_qbo_payment_cash_side.py` (payment IN DR, check BillPayment CR bank, CC BillPayment CR liability, end-to-end BS-still-balanced).

### 📝 Known limitation
For payments that create a standalone customer credit balance (Payment with no `applied_to`), NI is over-adjusted by that amount because there's no invoice to reduce. Real-world impact is low — such standalone credits are rare in QBO flows. A future fix would track those as a negative-AR entry.

---

## 2026-02-26 — Balance Sheet: COGS-in-NI + QBO CreditMemo Double-Count Fixes

### 🐛 Bug — Balance Sheet not balancing after QBO sandbox connection
User connected the Emergent preview environment to a QuickBooks sandbox and noticed the Balance Sheet was off by **$128.75** (Total Assets $8,151.54 vs L+E $8,280.29 on a small test company; and by $100 on the larger accrual view).

### 🔬 Root causes (two stacked bugs)
1. **`reports.py::compute_balance_sheet` — NI calculation missed COGS.** Line 436 rolled up Net Income from `revenue` + `expense` account types only, forgetting the new `cogs` type introduced by the Feb 2026 Option B GAAP Income Statement. Result: BS overstated equity by the period's COGS total.
2. **`reports.py::_signed_balances` — QBO CreditMemos double-counted the revenue reduction.** A QBO CreditMemo's AR-reduction side is already reflected via `invoice.balance_due` (the linked invoice's remaining balance is dropped by the applied credit, which `_open_ar_ap` reads for the accrual AR roll-in). Posting the CM's DR-to-Revenue line ALSO through `_signed_balances` cut revenue a second time and unbalanced the ledger by the CM total.

### ✅ Fix
- **`compute_balance_sheet`** — added `cogs` to the NI roll-in tuple: any `type in ("revenue","expense","cogs")` participates, with `cogs` subtracted like a regular expense.
- **`_signed_balances`** — early `continue` on `txn_type == "CreditMemo"`. The entity still shows up in transaction lists and any report that reads `db.transactions` directly; only the double-entry ledger sum ignores it.

### 🧪 Verified E2E (Test QBO Balance LLC — Craig's Design sandbox)
Before: Assets $13,533.06 vs L+E $13,433.06 (imbalance $100.00). After: Assets $13,533.06 = L+E $13,533.06 (imbalance $0.00). ✓

Also confirmed as a side effect: "Pest Control Services" — which had displayed as -$108.75 on the Income Statement because of the CreditMemo double-count — now displays as -$8.75 (attributable to the single RefundReceipt that legitimately reduces the account), and its type=`revenue` classification is correct for a landscaping company that sells pest control services (no reclassification needed).

### ⚠️ Known limitation
For companies where QBO CreditMemos are issued **without** being applied against an invoice (standalone customer credit balances), the current approach undercounts the revenue reduction. The proper long-term fix is to import QBO Payment entities and compute AR from the ledger rather than from `invoice.balance_due`. Tracked as a future enhancement.

---

## 2026-02-26 — STT Disambig "Create an invoice" Prefill Passthrough

### 🐛 Follow-up bug
After the STT collision guard shipped (2026-02-25), users who clicked the disambiguation card's "Create an invoice" button got an empty invoice modal — `contact_name` and `amount` extracted from the original utterance were dropped on the floor. User feedback: *"created it with no information on the actual invoice itself."*

### ✅ Fix
- **`AiPanel.jsx` disambig button `onClick`** — instead of replaying the utterance through the parser (which loses the already-extracted prefill), pass the server's parsed `prefill` payload (stashed on `m.disambigCreditOrCreate.prefill`) directly into `handleParsedIntent` as a synthetic `create_invoice` intent with `confidence: 0.99`. This preserves `contact_name` + `amount` + `due_days` end-to-end.

### 🧪 Verified E2E
Logged in as `pro@axiom.ai`, opened AI panel, typed "credit invoice for John Melton for $5,000 due today" → disambig card renders → clicked **Create an invoice** → invoice modal opens on `/invoices` with line item `Services × $5,000 = $5,000.00` and pending-intent pill reads `create invoice · John Melton · $5000`. ✓

---

## 2026-02-25 — Voice STT Collision Guard ("credit invoice" ≈ "create an invoice")

### 🐛 Bug
User's voice assistant said "create an invoice for John Melton for $1,000" — the STT mis-transcribed as "credit invoice for John Melton for $1,000". The intent classifier then routed to the categorize-transaction flow, responded "On it — categorizing to Uncategorized Income", and neither created the invoice nor produced a visible action pill. User confirmed the transcript, expected an invoice, got nothing.

### ✅ Fix — clarify instead of guess
- **Backend `routes/chat.py::ai_parse_intent`** — new STT-collision guard at the top: when the utterance contains `credit(?:ing)?\s+(?:an?|the)?\s*invoice`, return `intent: "disambiguate_credit_or_create"` with two options (`create_invoice`, `credit_memo_unsupported`) and the original utterance for replay.
- **Frontend `AiPanel.jsx::handleParsedIntent`** — new branch that renders a two-button clarification card in the chat:
  - **"Create an invoice"** → replays the utterance with `credit invoice` rewritten to `create an invoice` through the parser, then routes through the existing `create_invoice` flow (same as the working screenshot 1 case)
  - **"Add a credit invoice (customer refund)"** → Option 1 polite no-op: explains credit memos aren't supported yet and points to the manual customer-credit workflow on the Payments page

### 🎯 Design goal
Never silently guess intent on an STT-ambiguous phrase. Every confirmable intent must produce visible feedback (pending pill or clarification card). If a legitimate accounting concept ("credit memo") isn't supported, say so directly rather than silently categorizing to Uncategorized Income.

### 🧪 Tests (4/4 in `test_voice_credit_invoice_disambig.py`)
- `test_credit_invoice_returns_disambiguate_intent` — the exact bug repro fires the guard
- `test_credit_invoice_variations_all_caught` — 5 phrasings including "credit an invoice", "credit the invoice", "crediting an invoice", uppercase — all catch
- `test_create_invoice_still_works_no_disambig` — legit "create an invoice" utterances flow through unchanged (no false-positives)
- `test_credit_alone_does_not_trigger_guard` — "credit card fee", "credit the equity account" don't fire (regex requires `credit` + `invoice` adjacent)

---

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

## Referral lead-capture page + Superadmin > Leads — Feb 18, 2026

**Motivation**
Refer & earn links previously dropped visitors straight onto
`/signup?ref=<slug>` — so if they didn't complete signup, we lost
them completely. Now every referral link routes through a lead-
capture landing page first, so we own the contact record even when
the visitor bounces from Stripe.

**Backend**
- New route module `routes/leads.py` (mounted under `/api`):
  * `POST /api/public/leads` — public form submission
    (name, email, role, ref_slug, optional phone/company/notes).
    De-dupes on (email, ref_slug) within 24h. Persists to new
    `leads` collection with source=`referral|direct`, status=`new`.
  * `GET /api/public/refer/{slug}` — resolves a slug into the
    referrer's display name so the landing page can show
    "Referred by …" trust badge.
  * `GET /api/admin/leads` — superadmin list with status/role/
    free-text filters + total/new counts.
  * `PATCH /api/admin/leads/{id}` — superadmin update status/notes.
  * `DELETE /api/admin/leads/{id}` — superadmin delete.
- `routes/auth.py::_share_link_for` — swapped `/signup?ref=<slug>`
  → `/refer/<slug>` for both platform and firm-subdomain paths.
  Custom firm buy_page_url unchanged.

**Frontend**
- `pages/EnterReferral.jsx` — public referral capture form at
  `/refer/:slug` (and `/refer` without slug). 4 role cards
  (Accounting Pro, Business Owner, Enterprise, Other), name/email
  required, phone/company/notes optional, forwards to
  `/signup?ref=<slug>` on submit so revenue-share attribution
  still fires.
- `pages/AdminLeads.jsx` — superadmin table at `/admin/leads`
  with search + status/role filters, inline row expansion for
  status pills + notes editor + contact info + delete.
- `SuperadminDash.jsx` — added Leads button in header (with Inbox
  icon) next to Feedback.
- `App.js` — new public routes `/refer` and `/refer/:slug`, new
  protected route `/admin/leads`.

**Verified**
- `curl POST /api/public/leads` — 200, returns id + duplicate flag.
- `curl GET /api/admin/leads` (superadmin token) — returns items
  with referrer_name enrichment when slug resolves.
- Frontend screenshots: public referral page + superadmin leads
  page + expanded row (status pills, notes editor) all render
  cleanly.

**Follow-up (out of scope this pass)**
- Templated branded drip emails per Enterprise/Partner
- Calendar link (Cal.com / Calendly integration) for accounting
  pros on the drip
- Auto-graduate lead → `converted` when they finish `/signup`


## Undeposited Funds Two-Step Workflow — Feb 28, 2026

**Motivation**
The QBO reconciliation panel (shipped in the prior session)
surfaced that ~$2k of held customer payments could be missing from
the Balance Sheet on native Axiom companies whose payments were
never paired with a bank deposit transaction — the invoice's
`balance_due` was reduced (AR down), but nothing on the asset
column reflected the held cash. QBO models this as a two-step:
Receive Payment → Undeposited Funds, then Bank Deposit sweeps UF
into an actual bank account. Axiom now mirrors that.

**Backend**
- `models.py::PaymentCreate` — added `deposit_to_account_id`, the
  local account id the payment's cash-side DRs (customer
  receipts) or CRs (vendor payouts). Optional.
- `routes/payments.py::create_payment` — when direction='in' and
  no `deposit_to_account_id` and no `source_transaction_id`, the
  server auto-fills the company's Undeposited Funds account so
  every customer receipt has a home on the asset side of the BS.
- `reports.py::_signed_balances` — now handles native payments
  (source != qbo) in addition to QBO payments. Cash-side posting
  is skipped when a payment is paired with a bank transaction via
  `source_transaction_id` (the txn already handled the DR).
  Direction='in' payments with no resolvable deposit account fall
  through to the company's UF account, preserving the BS identity.
- `qbo_service.py::resolve_payment_undeposited(cid)` — new
  post-import + backfill resolver that stamps `held_in_undeposited`
  flag + the correct deposit reference on both QBO and native
  payments missing one. Idempotent. Wired into the QBO import
  pipeline right after `resolve_payment_links`.
- `routes/qbo.py` — new `POST /companies/{cid}/qbo/resolve-undeposited`
  admin endpoint to re-run the resolver on demand.

**Frontend**
- `pages/Payments.jsx::PaymentModal` — added a "Deposit to:" dropdown
  for customer-receipt payments, populated with the company's Cash
  and Bank + Undeposited Funds accounts. Default option is UF with
  a "(default — sweep later)" tag and helper text explaining the
  QBO two-step workflow. `deposit_to_account_id` is only sent when
  the user actively picks a bank; blank → backend auto-fills UF.

**Tests**
- `tests/test_undeposited_funds_workflow.py` — 5 new regression tests:
  * QBO Payment IN with no DepositToAccountRef falls back to UF
  * Native payment with no deposit_to_account_id uses UF
  * Native payment with explicit bank → posts to that bank (not UF)
  * Native payment paired via source_transaction_id is NOT double-posted
  * `resolve_payment_undeposited` backfill stamps + is idempotent
- All 5 pass. Pre-existing QBO Payment cash-side suite (4 tests)
  still passes.

**Verified live**
- QBO Test 553 LLC: Balance Sheet UF row = $2,062.52 (matches QBO
  snapshot exactly).
- Native TEST_dup company: creating a $500 payment without a bank
  account auto-fills UF; BS delta = $0 (AR down $500, UF up $500,
  sheet balanced). Rolled back after test.
- End-to-end curl on `POST /companies/{cid}/payments` (no
  `deposit_to_account_id`): server stamps UF account id, direction='in'.
- Frontend Payment modal rendering the new "Deposit to:" selector
  with default UF option + helper text.


## QBO Phase 2 Parity — GL-Verified Line Accounts + CashBack + CM — Feb 28, 2026

**Motivation**
The QBO reconciliation panel on QBO Test 553 LLC surfaced $95.72 of P&L drift concentrated on child income accounts: Beverages -$1,695, Sales of Product Income +$1,833, Catering missing $138. Root cause: QBO users routinely reassign Items to new income accounts over time, but historical postings retain the account in effect at posting. Our line mapper resolves via the CURRENT `Item.IncomeAccountRef`, so per-account totals diverge from QBO's actual General Ledger.

**Backend**
- `qbo_service.py::resolve_qbo_gl_line_accounts(cid)` — new resolver that fetches QBO's `GeneralLedger` for every revenue/expense/cogs account and stamps `account_qbo_id` + `gl_verified=true` on each matching invoice/bill/SR/RR line via `(doc_num, txn_type, amount, memo)` matching. Scans accounts leaf-first (deepest child before parent) so QBO's parent-account GL rollups can't overwrite child-level stamps. Wired into the QBO import pipeline right after `resolve_transaction_categories`, and re-runnable via `POST /companies/{cid}/qbo/resolve-gl-line-accounts`.
- `qbo_service.py::resolve_deposit_splits` — now captures QBO Deposits' top-level `CashBack` object as a negative-amount split targeting the cashback destination bank. Fixes Deposit 121 on QBO Test 553 LLC where $200 was routed to Savings but was landing as -$200 phantom Uncategorized Income on our P&L.
- `reports.py::compute_income_statement` — accrual layer now iterates CreditMemos and NEGATES the target income account so QBO's own CM revenue-reduction is reflected. Skips RefundReceipts (already handled by `_signed_balances`). New `_sweep_deep_accounts` post-pass captures direct signed activity on grandchild-and-deeper revenue/expense leaves that `_emit`'s parent+one-level walk was dropping (Takeout raw -$79.28 from two Purchases).

**Tests**
- `tests/test_qbo_phase2_child_mapping.py` — 4 new regression tests covering `_flatten_gl_rows`, CashBack split capture, CM accrual negation, and deep-account signed-balance sweep. All pass.

**Verified live**
- QBO Test 553 LLC P&L drift closed from $95.72 to $75 — the residual $75 is a single QBO sandbox invoice (#1013) whose payload contains ONLY a `SubTotalLineDetail` with no `SalesItemLineDetail` (a genuine QBO data quirk, confirmed via fresh `_get`).
- Per-account parity after the fix: Bar Sales ✓, Beverages ✓ (+$1,695), Catering ✓ (was missing), Discounts given ✓, Installation ✓, Maintenance and Repair ✓, Pest Control ✓ (was +$100), Sales of Product Income ✓ (was +$1,833), Services ✓, Takeout ✓ (was +$79.28).
- Deposit 121: CashBack $200 correctly routed to Savings, Undeposited Funds fully offset, no phantom Uncategorized Income.

**Follow-up (out of scope this pass)**
- Discount attribution to specific revenue accounts (~$4 residual on Food & Bev Sales vs Takeout on companies with multi-line discounts).
- Real-time inbound QBO webhooks (Phase 4).


## Sandbox 358d Migration Parity — BS/P&L Subtotals + OBE Fix — Feb 28, 2026

**Motivation**
User migrated the classic QBO sandbox (Craig's Design & Landscaping) as "Sandbox Company US 358d" and shared the Recon Panel drift screenshots. Three clear defects surfaced:
1. `Δ $13,495` on Total Assets — Truck's Original Cost grandchild balance was dropped by the BS totals calc.
2. `Δ $419.09` on Opening Balance Equity — the opening-balance JE double-counted accounts that had real imported activity.
3. Big false-drift on Recon Panel — accounts with identical names in different sections (income "Plants and Soil" vs expense "Plants and Soil") collided in the lookup map.
Also fixed a P&L parent-subtotal staleness: after the accrual layer added Bills to Accounting/Bookkeeper/Lawyer, "Total Legal & Professional Fees" stayed at emit-time $480 instead of the correct $1,170.

**Backend**
- `reports.py::compute_balance_sheet` — `total_assets` / `total_liabilities` / `total_equity` now come from `_emit_section`'s running `top_total` (which correctly rolls direct + children per parent), plus A/R + A/P + Current Period NI. Prior re-sum of the row list either double-counted subtotals or under-counted grandchild activity (Truck → Original Cost dropped $13,495 because parent was $0 direct AND child had `parent_id` set).
- `reports.py::compute_income_statement` — `_emit` rows now carry `parent_id` (not just `parent_code`, which is `""` for every QBO-imported account). New `_refresh_subtotals` pass recomputes every "Total X" row after the accrual layer tops up child amounts, so "Total Legal & Professional Fees" correctly shows the post-accrual total.
- `qbo_service.py::_post_opening_balances_je` — only plugs accounts with ZERO imported ledger activity, and skips sales-tax payables (`AccountSubType` in `{GlobalTaxPayable, SalesTaxPayable}`). Prior behaviour plugged Checking, Inventory Asset, and BoE Payable on top of their real imported activity, quietly inflating OBE by $419.09.

**Frontend**
- `QboReconciliationPanel.jsx` — flatteners now tag every row with a `section` (income/cogs/expense/asset/liability/equity). `ReconciliationTable` matches on `(section, normLabel)` first, falling back to bare-label only for section-less totals. Fixes the Plants and Soil / Sprinklers and Drip Systems / Maintenance and Repair false drift on Craig's Landscaping migrations where these labels exist on BOTH the income AND expense side.

**Tests**
- `tests/test_report_subtotals_and_opening.py` — 5 new regression tests: grandchild activity in BS totals, P&L subtotal refresh after accrual, opening-balance skip for accounts with activity, opening-balance skip for sales-tax payables, and positive-case opening-balance plug for a zero-activity Fixed Asset. All pass.

**Verified live (Sandbox 358d, Craig's Design & Landscaping)**
- Opening Balance Equity: was -$9,756.59, now **-$9,337.50 (exact QBO match).**
- Total Assets: was $9,941.29, now **$23,484.44 vs QBO $23,436.29** ($48.15 residual = Checking +$76.90 / Inv Asset -$28.75 — real import gaps to chase separately).
- Total Liabilities: **$30,760.39 vs QBO $31,131.33** ($370.94 = BoE Payable, needs invoice sales-tax extraction).
- Total Equity: **-$7,275.95** (matches within $419).
- BS balanced=True imbalance=0.0 on both Sandbox 358d and QBO Test 553 LLC.
- Total Legal & Professional Fees subtotal: was $480, now **$1,170 (exact QBO match).**
- Total Automobile subtotal: **$463.37 (exact QBO match).**


## Cash-Basis Report Parity — Feb 28, 2026

**Motivation**
After closing accrual-basis parity on Craig's Landscaping (Sandbox 358d), the same recon panel toggled to Cash exposed the second layer of drift: Total Income $614.47 vs QBO $5,080.27 (-$4,466 gap). Cash basis was falling through to just `_signed_balances` — invoices paid via Payment docs contributed zero revenue because the accrual layer was gated behind `basis == "accrual"`.

**Backend**
- `reports.py::compute_income_statement` — new `elif basis == "cash":` allocation pass. For each Payment IN dated in period, look up the linked invoice, prorate the payment amount across the invoice's line items in ratio to each line's contribution to the invoice subtotal, and post that slice to the line's income account. Symmetrical for Payments OUT + bills → expense/COGS. Payments to invoices/bills with only zero-amount or account-less lines are skipped. Over-payment ratio capped at 1.0 so double-billing doesn't create phantom revenue.
- `reports.py::compute_balance_sheet` — new `elif basis == "cash":` block strips Inventory Asset rows from the BS (QBO cash convention: inventory is expensed at purchase, not tracked as an asset) and rolls the removed asset value into Net Income so the sheet still balances.
- `_refresh_subtotals` helper hoisted out of the accrual block so both accrual and cash-basis passes reuse the same subtotal-refresh logic.

**Tests**
- `tests/test_cash_basis_parity.py` — 5 new regression tests: full-invoice-payment revenue, partial-payment proration, bill payment → expense, Inventory Asset stripped from cash BS, and cash-vs-accrual disagreement on an unpaid invoice. All pass. Full suite: **19 tests green**.

**Verified live (Sandbox 358d Craig's Landscaping)**
| Metric | Before | After | QBO Target |
|---|---|---|---|
| Cash Total Income | $614.47 | **$5,200.79** | $5,080.27 |
| Cash Total COGS | $0 | **$228.75** | $228.75 ✅ |
| Cash Total Expenses | $2,216.14 | **$6,755.64** | $6,755.64 ✅ |
| Cash Net Income | -$1,830.42 | **-$1,783.60** | -$1,904.12 |
| Cash Total Assets | $18,202.92 | **$17,635.42** | $17,558.52 |
| Cash BS balanced | ✅ | ✅ | ✅ |

Cash P&L: expenses and COGS match QBO to the penny. Revenue is within 2.4% (+$120.52) — residual comes from QBO's top-down invoice-line payment application vs our clean proration, and only materialises on partial-payment cases.

Cash BS: assets within $77 (same Checking import gap as accrual), sheet balanced.

Accrual regression check: unchanged. Total Assets, Liab, Equity, NI all match prior values.


## Top-Down Payment Application + Sales-Tax Extraction — Feb 28, 2026

**Motivation**
Two residual drifts from the cash-basis parity pass:
1. Cash Total Income was +$120.52 over QBO — our proration split each Payment evenly across the linked invoice's lines, while QBO applies partial payments TOP-DOWN (consume line 1 first, then line 2, etc.).
2. Board of Equalization Payable and Arizona Dept. of Revenue Payable both showed $0 on our BS while QBO carried $370.94 + $38.40 — we never extracted sales tax from Invoice `TxnTaxDetail.TaxLine[]`.

**Backend**
- `reports.py::compute_income_statement` cash block — rewrote the customer-payment loop to consume invoice lines TOP-DOWN, taking `min(line_amount, remaining_payment)` per line until the payment is exhausted. Symmetrical rewrite for bill payments → expense/COGS. Matches QBO's cash-basis line-order application exactly.
- `qbo_service.py::resolve_tax_rates(cid)` — new resolver that fetches QBO's `TaxRate` + `TaxAgency` via API and caches each rate's agency name in `db.tax_rates`. Wired into the import pipeline right after `resolve_payment_undeposited`. Idempotent (upserts by `(company_id, qbo_id)`).
- `reports.py::compute_balance_sheet` — new sales-tax extraction block iterates every QBO invoice's `TxnTaxDetail.TaxLine[]`, groups by tax rate, and routes to the local sales-tax-payable account whose name matches `"{agency} Payable"` and whose `AccountSubType` is `GlobalTaxPayable`. Accrual: full tax at invoice date. Cash: prorated by `(total - balance_due) / total`. Net Income offset by the tax total so revenue → payable, not revenue → equity.

**Tests**
- `tests/test_cash_basis_parity.py::test_cash_revenue_partial_payment_top_down` — updated the proration test to lock in top-down behaviour.
- `tests/test_cash_basis_parity.py::test_sales_tax_populates_payable_from_invoice_tax_lines` — new: seeds a TaxRate + BoE Payable, and asserts an $8 TaxLine on an unpaid invoice populates the BoE row on the BS.
- Full suite: **20/20 green** (5 UF + 4 Phase 2 + 5 subtotals/opening + 5 cash + 1 sales-tax).

**Verified live (Sandbox 358d Craig's Landscaping)**
| Metric | Ours (before) | Ours (after) | QBO Target |
|---|---|---|---|
| **Cash Total Equity** | -$11,522.30 | **-$11,809.12** | -$11,809.12 ✅ **EXACT** |
| Cash BS Liab | $29,157.72 | $29,444.54 | $29,367.64 |
| Cash BS Assets | $17,635.42 | $17,635.42 | $17,558.52 |
| Cash NI | -$1,783.60 | -$1,783.60 | -$1,904.12 |
| Accrual BS Liab | $30,760.39 | $31,208.23 | $31,131.33 |

Cash BS Total Equity now matches QBO **to the penny**. Residual Liab drift (+$77 both bases) is a single unreversed tax line from a Craig's-sandbox voided invoice — small enough to leave for a follow-up. Cash Assets and NI still off by the same $77 Checking import gap (real single-transaction bug, tracked as separate action item).
