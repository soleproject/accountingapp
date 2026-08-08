# SmartBooks — Changelog

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
