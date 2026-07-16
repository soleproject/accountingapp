# Rocket Suite SaaS Performance Budgets

Rocket Suite performance decisions should be made like a large SaaS company: fast by default, measured continuously, and safe under growth. Working is not enough; core pages must feel instant.

## Page budgets

| Surface | Target p50 | Target p95 | Hard fail / escalation |
|---|---:|---:|---:|
| Authenticated dashboard/list page HTTP | <= 350ms | <= 800ms | > 1.5s p95 |
| Heavy accounting/report page HTTP | <= 600ms | <= 1.2s | > 2.5s p95 |
| Browser primary content ready | <= 900ms | <= 1.8s | > 3.0s p95 |
| Individual DB operation | <= 100ms | <= 250ms | > 750ms unless documented |
| Total DB time per page render | <= 300ms | <= 800ms | > 1.5s |
| DB round trips per page render | <= 5 | <= 8 | > 12 without explicit review |
| Background job enqueue response | <= 150ms | <= 400ms | job work blocks request path |

## Design rules

1. No unbounded UI list queries. Every table/list must have an explicit limit and pagination strategy.
2. Prefer keyset/cursor pagination for high-volume lists; offset pagination is acceptable only for small bounded sets.
3. Dashboard metrics should be precomputed, cached, or rolled up once data volume grows. Avoid live multi-table rollups on every render.
4. Tenant-scoped filters must be leftmost in composite indexes: `organization_id`, `user_id`, `enterprise_id`, or equivalent.
5. Search using `ILIKE '%term%'` requires trigram/full-text support or a dedicated search service.
6. AI/PDF/accounting reconciliation work should run as background jobs with status/progress; it should not block page render.
7. Every performance fix must record before/after evidence: route timings, DB timing labels, query plans, and deployment notes.
8. New hot DB paths must use stable timing labels through `timeDb()`.
9. Logs must stay sanitized: no SQL parameters, cookies, emails, account names, transaction descriptions, customer text, or secrets.

## PR gate for performance-sensitive changes

A PR is performance-sensitive if it touches:

- dashboard/list/report pages;
- Drizzle/SQL query shape;
- database schema or migrations;
- AI usage, accounting, Plaid/QBO, invoices/bills, journal entries, transactions, contacts;
- background jobs or cron routes.

Performance-sensitive PRs must include:

- affected routes/screens;
- expected row-count assumptions;
- timing labels added or reused;
- before/after route timing if behavior changes;
- `EXPLAIN (ANALYZE, BUFFERS)` for new/changed hot SQL where feasible;
- index rationale or explanation why no index is needed;
- rollback plan for migrations.

## Production rollout rules for indexes

- Use `CREATE INDEX CONCURRENTLY` for production indexes.
- Do not run concurrent index migrations inside a transaction.
- Use low `lock_timeout` and monitor lock waits.
- Split broad index plans into small batches.
- Capture `pg_stat_user_indexes` usage after rollout.
- Drop unused/regressive indexes only with evidence.

## Current priority screens

1. `/enterprise/dashboard`
2. `/transactions`
3. `/super-admin/ai-usage`
4. `/enterprise/clients`
5. `/enterprise/communications`
6. Bills/invoices/journal-entry/accounting reports
7. Plaid/reconciliation flows that read raw transactions
