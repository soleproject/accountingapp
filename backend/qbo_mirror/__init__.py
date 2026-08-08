"""QBO Mirror — bi-directional sync between our system and QBO.

Isolated module. NEVER imports from routes/ or writes to existing
collections' schemas. Consumes only:
  - `qbo_service.query_all` / `_get`   → read from QBO
  - `db.accounts` / `db.contacts` / `db.items` (read-only)
  - `db.mirror_config` / `db.mirror_log` (this module's own tables)

Phase 1a (this file's scope): DRY-RUN preview only. No writes to QBO
and no writes to local ledger tables. `engine.compute_diff()` emits a
report of what a live sync WOULD do."""
