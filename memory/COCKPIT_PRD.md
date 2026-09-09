# SmartBooks — Cockpit PRD
_Author: E1 · Feb 2026 · Status: **Approved for build (Phase 1)**_

---

## 1. Vision

**Cockpit** is the sidebar-level home for every accounting professional using
SmartBooks. It reframes the app from "a set of tools per client" to "a
cross-client command center for a practice."

- **Sidebar label:** `Cockpit`
- **Home sub-surface:** `Today` (the daily-first landing view)
- **Position in the sidebar:** first item, above `Home`, above every product
  shell. Cockpit is the CPA's morning-coffee screen; individual product
  shells (`Accounting`, `CRM`, `Team`, `Projects`) remain the deep-work
  screens.

### Positioning (why this exists)

Puzzle-class tools ship one-client-at-a-time AI features. SmartBooks Cockpit
is the *cross-client* layer that turns those features into a managed
operation:

- **Puzzle "Close":** one AI checklist per company, per month.
- **SmartBooks Cockpit:** a pipeline of *every* client's close, every
  client-request, every agent finding, every 1099 blocker — with the
  ability to zoom into any single client's close workspace.

The Cockpit is the vehicle for our stated positioning: **"the AI-native
close platform for accounting firms."**

---

## 2. Personas & Access Rules

| Persona | Sees Cockpit? | Scope |
| --- | --- | --- |
| **Pro / Firm staff** | ✅ Yes | All companies in `memberships` where role ∈ {pro, admin, owner-of-firm}. Cross-client view. |
| **Superadmin** | ✅ Yes | All companies on the platform (with a firm filter). |
| **Partner** | ✅ Yes (Phase 2) | All companies under the partner brand. |
| **Client (single-company owner)** | ❌ Hidden | Cockpit provides no value to a 1-book user; they keep the current Home experience. |

**Feature flag** during rollout: `cockpit_enabled` on `user` doc, defaults
`true` for pro/admin/superadmin/partner, `false` for client.

---

## 3. Information Architecture

```
/cockpit                         → Today (default)
/cockpit/today                   → same as /cockpit
/cockpit/close                   → Close Board (kanban across all clients)
/cockpit/requests                → Client Requests rail (all open Q&A)
/cockpit/1099                    → 1099 Cockpit rail (Phase 3)
/cockpit/reports                 → Advisor Reports rail (Phase 4)
/cockpit/agents                  → Agents rail (Phase 5+)
/cockpit/communications          → Communications rail (existing module wrapped)
/cockpit/practice-health         → Practice Health rail (Phase 2+)
```

Every rail keeps its own dedicated deep-dive page **and** contributes a
compact card to the Today feed. The rails don't replace the existing
per-company pages — they aggregate.

---

## 4. Zone-by-Zone Spec

### Zone 1 — **Today** (`/cockpit`)

The single unified inbox across every client the user has access to.
Grouped, filterable, actionable.

**Sections (top → bottom):**

1. **Greeting strip** — `Good morning, {first_name}. You have {N} things
   waiting.` + a `Filter by client` chip cluster + a `Sort by: urgency /
   client / age` dropdown.
2. **Attention Now** (red) — items that are blocking a close or past a
   client-facing deadline.
3. **Waiting on Client** (amber) — outstanding client-portal questions,
   missing W-9s, missing receipts.
4. **Ready for Review** (blue) — completed work needing your sign-off:
   agent findings, staff-completed reconciliations, sign-off checkpoints.
5. **Overnight Updates** (grey) — informational: agent runs completed,
   Plaid sync results, new transactions ingested.

**Card contract (every item):**
```json
{
  "id": "todo_...",
  "source": "portal|1099|receipts|agent|recon|signoff|anomaly|plaid",
  "company_id": "cmp_...",
  "company_name": "Emeral Coast Pools & Spa LLC",
  "urgency": "red|amber|blue|grey",
  "title": "3 answers needed to close August 2026",
  "subtitle": "Sent 4 days ago · No response yet",
  "action_label": "Resend & remind",
  "action_route": "/cockpit/requests?company=cmp_...&status=stale",
  "created_at": "2026-02-11T09:14:00Z",
  "count": 3
}
```

**Backend endpoint (new):**
`GET /api/cockpit/today` → `{items: [...], counts_by_urgency: {...}}`
- Aggregates across every company in the caller's `memberships`.
- Batched under the hood (one $facet aggregation over the relevant
  collections: `client_portal_requests`, `w9_requests`,
  `receipt_requests`, `agent_runs`, `reconciliations`, `close_periods`,
  `anomalies`, `plaid_syncs`).
- Cache TTL: 60s (Redis, tenant-scoped key).

**Testids:**
- `cockpit-today-page`
- `cockpit-today-filter-client`
- `cockpit-today-section-{red|amber|blue|grey}`
- `cockpit-today-card-{item.id}`
- `cockpit-today-action-{item.id}`

---

### Zone 2 — **Close Board** (`/cockpit/close`)

Kanban of every client, columns = close phases.

**Columns (fixed order):**
1. `Not started`
2. `Cleanup` (Cleanup Copilot in progress — Step 1/2/3)
3. `Reconciling` (bank + CC reconciliations running)
4. `Adjusting` (JE drafts pending review)
5. `Client review` (waiting on client sign-off)
6. `Ready to close` (all tie-outs green, awaiting principal lock)
7. `Closed` (period locked)

**Card contract:**
```json
{
  "company_id": "cmp_...",
  "company_name": "Emeral Coast Pools & Spa LLC",
  "brand_logo_url": "...",
  "period": "2026-08",
  "phase": "reconciling",
  "phase_pct": 62,
  "days_to_deadline": 4,
  "close_score": 78,
  "top_blockers": [
    {"kind": "unrec_txns", "label": "12 uncleared bank txns", "count": 12},
    {"kind": "portal_wait", "label": "2 client answers pending", "count": 2}
  ],
  "assigned_staff": [{"id":"usr_...", "name":"Sarah", "avatar_url":"..."}],
  "last_activity_at": "2026-02-11T04:22:00Z",
  "quick_actions": [
    {"kind":"run_reconcile", "label":"Run reconciliation copilot"},
    {"kind":"send_report",   "label":"Send monthly report"},
    {"kind":"ask_client",    "label":"Ask client 3 questions"}
  ]
}
```

**Drag-drop** advances the phase (writes `close_periods.phase`). Dropping
to `Ready to close` runs the tie-out check and blocks the drop with a
toast if any tie-out is red.

**Filters:**
- Deadline (this week / next week / overdue)
- Assigned staff
- Client type template
- Phase health (any red / any amber / all green)

**Backend endpoint (new):**
`GET /api/cockpit/close-board?period=YYYY-MM` →
`{cards: [...], summary: {by_phase: {...}, overdue_count: N}}`
- Reads from existing `close_periods` collection.
- Enriches each card via the new `_close_card` helper:
  - `phase_pct` from `close_periods.checkpoints` (leverages existing
    `_month_status` in `backend/routes/month_close.py` — do NOT
    duplicate the logic).
  - `close_score` = weighted composite (see § 5).
  - `top_blockers` from a shared blocker resolver (see § 5).

**Testids:**
- `cockpit-close-board-page`
- `cockpit-close-column-{phase}`
- `cockpit-close-card-{company_id}`
- `cockpit-close-card-{company_id}-action-{quick_action.kind}`

---

### Zone 3 — **Feature Rails** (left column of every Cockpit page)

Persistent secondary nav that lives inside `/cockpit/*`:

- 🏠 **Today**
- 🗓️ **Close**
- 📩 **Client Requests** (Phase 2)
- 🧾 **1099** (Phase 3, seasonally boosted Nov–Jan)
- 📊 **Reports** (Phase 4)
- 🤖 **Agents** (Phase 5)
- 💬 **Communications** (wraps existing module)
- 📈 **Practice Health** (Phase 2+)

Each rail:
- Renders its own dedicated page.
- Exposes an `unread_count` badge computed by the same batched aggregation
  that powers Today.
- Contributes cards into the Today feed (source-tagged).

**Testid:** `cockpit-rail-{key}`

---

### Zone 4 — **Practice Health** (`/cockpit/practice-health`, Phase 2+)

Firm-level KPIs on a single scrollable dashboard:

- **Books-on-time rate** — % of clients whose books closed by day 15 of
  the following month (trailing 6 months, sparkline).
- **Average close cycle time** — median days from month-end to `closed`
  status.
- **Client health score distribution** — histogram of client scores.
- **Realization by client** — hours-logged × billing-rate ÷ recurring fee.
- **Team utilization** — hours booked per staff, this week vs. capacity.

Data comes from a new `practice_health` aggregation route — deferred to
Phase 2. The Phase 1 shell will render this rail with a "Coming soon"
empty state so the IA is complete.

---

## 5. The Per-Client Close Workspace

Route: `/cockpit/close/{company_id}?period=YYYY-MM` (or the existing
`/accounting/month-close` continues to work and gets wrapped in the new
4-phase stepper — no url break).

**4-phase horizontal stepper across the top:**

| Phase | What we already have | What's new |
|---|---|---|
| **1 · Cleanup** | ✅ Full AI Cleanup Copilot (Steps 1 → 3C, this session's Step 3C fix included) | Just re-labels the existing surface as "Close · Cleanup" |
| **2 · Reconcile** | ✅ Solid: Veryfi statement OCR, auto-account resolver, tiered match candidates (`auto`/`suggest`/`manual`), `apply-matches`, `auto-clear`. Endpoint reference: `POST /api/companies/{cid}/reconciliations/match-statement`, `apply-matches`, `auto-clear`. | Wrap the existing recon page in a phase card. See § 8 for parked upgrade notes. |
| **3 · Adjust** | 🟡 Manual JE editor exists (`/accounting/journal-entries`) | **New:** AI JE Drafters (Phase 3 build) — depreciation, prepaid amort, accruals, deferred revenue, bad-debt allowance |
| **4 · Review & Sign-off** | 🟡 `_month_status` already computes checkpoint states (txns_reviewed, invoices, bills, recon, closed) | **New:** flux commentary auto-generation, anomaly sweep, client sign-off request, close-binder export |

**Close score (0–100)** — weighted composite surfaced in every card & the
per-client workspace header:

```
close_score = 
  0.25 * (1 if cleanup_open_count == 0 else 0)
+ 0.25 * (recon_cleared_pct)
+ 0.15 * (1 if all adjust_je_drafts_reviewed else 0)
+ 0.10 * (1 if client_signoff_received else 0)
+ 0.10 * (1 if invoices_reviewed else 0)
+ 0.10 * (1 if bills_reviewed else 0)
+ 0.05 * (1 - anomaly_count / max_anomalies_normalized)
```

Green ≥ 90, amber 60–89, red < 60. Only 100 unlocks the "Close & lock
period" button.

**Locking a period** already works via
`POST /api/companies/{cid}/month-close/{ym}/checkpoint {kind:"closed",
signed:true}` — we reuse it.

**Close Binder export (Phase 4 add):** one-click PDF/ZIP containing TB,
GL detail, all AI-drafted JEs (approved & rejected), reconciliation
reports, flux commentary, agent-run manifest. New endpoint:
`GET /api/companies/{cid}/close-binder/{ym}.zip`.

---

## 6. Cockpit Shell — Phase 1 Build Contract

**Scope of Phase 1 (this build):**
1. Sidebar entry `Cockpit` (position 0, above Home, with the target icon).
2. Route stubs at every `/cockpit/*` path from § 3 with a shared layout
   (`CockpitLayout.jsx`) that renders:
   - Left rail (§ 3 rail list, active-item highlight, unread badges)
   - Main content pane
   - Top strip with company-filter multi-select and "clear filter" button
3. **Today** fully populated (Zone 1).
4. **Close Board** fully populated (Zone 2, drag-drop + quick actions).
5. Every other rail = "Coming soon" with a real description so IA is
   complete and marketing screenshots look right.
6. Access gating (Cockpit hidden for single-company clients).

**Out of Phase 1 (deferred to later phases):**
- Client Request Portal build (Phase 2)
- 1099 Cockpit (Phase 3)
- AI JE Drafters (Phase 3)
- Advisor Reports Pack (Phase 4)
- Close Binder export (Phase 4)
- Agent Platform (Phase 5)
- Practice Health data (Phase 2+)

**Estimated effort:** 3–5 days for the shell + Today + Close Board.

---

## 7. Backend Contracts (Phase 1)

All routes prefixed with `/api`.

### 7.1 Today feed
```
GET /api/cockpit/today
  ?company_ids=comma,separated   (optional — defaults to all accessible)
  &urgency=red|amber|blue|grey    (optional filter)
  &limit=100

→ 200
{
  "items": [<Todo>...],
  "counts_by_urgency": {"red": 4, "amber": 12, "blue": 3, "grey": 27},
  "counts_by_source":   {"portal": 5, "recon": 8, ...}
}
```

### 7.2 Close Board
```
GET /api/cockpit/close-board?period=YYYY-MM
→ 200
{
  "period": "2026-02",
  "cards": [<CloseCard>...],
  "summary": {
    "by_phase":     {"cleanup": 3, "reconciling": 7, ...},
    "overdue_count": 2,
    "at_risk_count": 5
  }
}

POST /api/cockpit/close-board/advance
  body: {company_id, period, to_phase}
→ 200 {ok: true, card: <CloseCard>}
→ 409 {ok: false, blockers: [...]}   (drop rejected)
```

### 7.3 Access
```
GET /api/cockpit/accessible-companies
→ 200 {companies: [{id, name, brand_logo_url, tags: [...]}]}
```

All routes use `require_firm_or_pro(user)` — a new dependency that
returns `403` for role=client (single-company).

---

## 8. Reconciliation — Parked Audit Notes

_(Per user direction: bring to attention, do NOT change sequencing.)_

Current state (`backend/routes/reconciliation.py` + `Reconciliation.jsx`)
is **strong and shippable as Phase 2 of the close workspace**. It already
does:

- Veryfi OCR on statement PDF/CSV (`process_bank_statement`)
- Auto-detect target bank account from statement last-4 + bank name
  (prevents the "1000 Cash and Bank" mis-pick bug)
- Extract transactions from Veryfi output
- Tiered fuzzy match: `auto` / `suggest` / `manual` + `missing_from_statement`
- Auto-clear ledger txns via `apply-matches`
- Auto-bootstrap missing recons on first load
- Rebuild + unreconcile flows
- Statement-driven auto-fill of opening/closing balance & period dates

Upgrade opportunities to slot in **when we build Phase 2 (Reconcile) of
the close workspace, not before**:

1. **Statement-vs-ledger diff summary card** — headline "5 items don't
   tie" with click-to-fix (missing-from-ledger becomes proposed JE
   drafts, missing-from-statement becomes suggested un-clears).
2. **Reconciliation report as working paper** — auto-generate a signed
   PDF on completion that flows into the Close Binder.
3. **Multi-statement session** — CPA uploads Jan/Feb/Mar in one go;
   engine reconciles all three in sequence.
4. **Discrepancy narrative** — LLM-generated 2–3 sentence explanation of
   any residual difference between statement ending balance and ledger.
5. **Auto-clear thresholding** — expose the `auto` confidence cutoff as
   a per-firm setting (some firms want 100% match only, others accept
   date-off-by-1).

None of the above are blockers. Existing recon is production-quality.

---

## 9. Sequencing (Confirmed with User)

| Phase | Feature | Est |
|---|---|---|
| **1** | Cockpit shell + Today + Close Board | 3–5 days |
| **2** | Client Request Portal (+ blocker plumbing to Close Board) | 2 weeks |
| **3** | 1099 Cockpit + AI JE Drafters (Adjust phase) | 3 weeks |
| **4** | Advisor Reports Pack + Sign-off + Close Binder | 2 weeks |
| **5** | Agent Platform (runner, scheduler, template library, credits) | 3 weeks |

Total to full-vision: ~13–15 focused weeks. Every phase ships user-facing
value on its own.

---

## 10. Acceptance Criteria for Phase 1

**Must-have to call Phase 1 done:**

1. ✅ Pro/admin/superadmin users see `Cockpit` at the top of the sidebar.
2. ✅ Client-role users do NOT see `Cockpit` (feature-flag gated).
3. ✅ `/cockpit` renders `Today` with real data across all accessible
   companies (Attention Now / Waiting on Client / Ready for Review /
   Overnight Updates sections all populated from live collections).
4. ✅ Company-filter chip cluster + urgency filter both work.
5. ✅ `/cockpit/close` renders the kanban with real `close_periods` data.
6. ✅ Drag-and-drop advances phase; blocked drops surface a helpful
   error toast.
7. ✅ Each close card exposes ≥ 3 quick actions that deep-link into the
   correct per-company page with the right query params (e.g. "Run
   reconciliation copilot" → `/accounting/reconciliation?company=…`).
8. ✅ Every rail from § 3 exists as a route stub with either real
   content or a "Coming soon" state that describes the value.
9. ✅ All new endpoints tested with `pytest` in `/app/backend/tests/`.
10. ✅ Testing agent run passes for the full Cockpit flow.

**Nice-to-have (Phase 1.5):**
- Keyboard nav (`g t` = Today, `g c` = Close, etc.)
- Saved filter presets in Today
- Realtime badge counts via WebSocket (currently 60s poll)

---

## 11. Naming & Visual Notes

- **Sidebar label:** `Cockpit` (short, unambiguous, professional)
- **Icon:** `LayoutDashboard` from lucide-react, or the new "aperture"
  icon (`Aperture`) for a distinctive Cockpit feel — final call at
  build time.
- **Sub-header inside `/cockpit`:** `Today` (Superhuman-inspired daily
  framing).
- **Close Board sub-header:** `Close · {Month Year}` with a month picker
  and a `View: Kanban | List` toggle.

Design language stays consistent with existing shell — reuses
`CleanupCopilot` header pattern (donut + step badge motif) where it
makes sense in the Close card.
