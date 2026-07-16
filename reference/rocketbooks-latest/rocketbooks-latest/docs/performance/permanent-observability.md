# Permanent performance observability

RocketSuite emits privacy-safe `RS_PERF_EVENT` records for sampled requests. Staging enables 100% application sampling; production remains disabled until `RS_PERF_OBSERVABILITY=1` is explicitly configured.

## Correlation and phases

Every matched request receives an opaque UUID in `X-RocketSuite-Request-Id`. The same ID is propagated through request headers and used by:

- `request_start`
- `middleware_auth`
- `supabase_auth`
- `page_session_validation`
- `organization_resolution`
- `workspace_resolution`
- `database_execution` for queries using `timeDb`
- `deferred_api_completion` for dashboard, billing, settings, and transaction landing APIs
- `browser_visible_completion` after the browser paints two animation frames

Events include only route classes, stable operation labels, durations, outcome classes, build/commit identifiers, Cloudflare colo, and an isolate-first-request flag. They exclude SQL, query parameters, cookies, credentials, email addresses, raw user/org IDs, and raw database errors.

## Configuration

- `RS_PERF_OBSERVABILITY=1`: enable application events.
- `RS_PERF_SAMPLE_RATE=0..1`: deterministic request sampling rate.
- Cloudflare `observability.logs.persist=true`: retain Worker logs for dashboard queries.
- Production Cloudflare log retention is configured, but custom application events remain off until the application flag is enabled.

## Query and summarize

Filter retained Cloudflare logs by `RS_PERF_EVENT`. Export newline-delimited JSON and summarize it:

```bash
node scripts/perf/summarize-observability.mjs < exported-worker-logs.jsonl
```

The summary reports count, p50, p95, p99, maximum, outcomes, and an alert flag by route class and phase. The initial visible-completion alert threshold is p95 above 5,000 ms; any non-`ok` outcome also alerts.

## Verification

```bash
npm run typecheck
npx tsx tests/permanent-performance-observability.test.ts
npx tsx tests/middleware-public-bypass.test.ts
npx tsx tests/login-path-latency.test.ts
npx tsx tests/browser-login-resilience.test.ts
npm run build
```

For staging, verify that the login response exposes `X-RocketSuite-Request-Id` and `Server-Timing`, then confirm retained Worker logs contain correlated middleware and browser-visible events for that request.

## Known boundary

`postgres.js` lazily acquires a Hyperdrive/Postgres connection during query execution. `database_execution` therefore includes connection acquisition and query execution; it does not claim a separate acquisition duration that the driver cannot expose reliably. Pool exhaustion and timeout outcomes are classified separately.
