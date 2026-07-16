# Rocket Suite Query Review Checklist

Use this checklist for every performance-sensitive Rocket Suite PR.

## Tenancy and bounds

- [ ] Query is scoped by `organization_id`, `user_id`, `enterprise_id`, or an equivalent tenancy key as early as possible.
- [ ] UI list queries have an explicit `limit`.
- [ ] High-volume lists use keyset/cursor pagination or have a documented reason for offset pagination.
- [ ] Counts are necessary; if not, removed, cached, approximated, or combined.
- [ ] Query selects only needed columns and avoids large JSON/text fields unless required.

## Index support

- [ ] Filter + sort order is backed by a left-to-right composite index.
- [ ] Join keys on child tables have supporting indexes.
- [ ] Partial indexes match the exact query predicate when used.
- [ ] `ILIKE '%term%'` has trigram/full-text support or an approved alternative.
- [ ] New index has a named query/screen rationale.

## Query shape

- [ ] No N+1 query loop.
- [ ] No per-row external API/AI call in the page render path.
- [ ] No live dashboard rollup across many tables unless proven fast at expected row counts.
- [ ] No function on indexed columns in WHERE/ORDER BY unless expression index exists.
- [ ] Raw SQL is parameterized through Drizzle `sql` placeholders, not string concatenation.

## Evidence

- [ ] Added/reused stable `timeDb()` label for hot operations.
- [ ] Baseline timing captured before change if route existed.
- [ ] After timing captured with p50/p95 or repeated runs.
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` captured for hot SQL where feasible.
- [ ] Migration rollout/rollback plan documented.
- [ ] `npm run typecheck` passed.
- [ ] Targeted eslint passed on modified files.

## Red flags requiring senior review

- [ ] New unbounded `.select()` in a page render.
- [ ] New dashboard aggregation over append-only tables.
- [ ] New search across user-entered text without search index.
- [ ] New production index migration without `CONCURRENTLY`.
- [ ] New blocking AI/PDF/accounting work in request path.
- [ ] Any route p95 expected to exceed the budgets in `docs/performance/saas-performance-budgets.md`.
