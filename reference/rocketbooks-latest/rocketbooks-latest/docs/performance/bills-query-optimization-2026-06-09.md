# Bills Query Optimization Timing Log — 2026-06-09

## Context
RocketSuite `/bills` is currently in fast-loading mode after the Cloudflare Workers 1101 stabilization work. This log records the before/after timing evidence for restoring the Bills screen with optimized queries.

## Before baseline — current production fast shell

Commit deployed at baseline: `c87e078 fix: stabilize worker protected route renders`
Route: `https://app.rocketsuite.ai/bills`
Auth: minted Supabase session for existing admin test user; secret cookie values not recorded.

### Authenticated HTTP timing — 7 runs

| Run | HTTP | Seconds | Bytes | Bad markers | Bills marker |
|---:|---:|---:|---:|---|---|
| 1 | 200 | 1.278548 | 33823 | none | yes |
| 2 | 200 | 0.998454 | 33823 | none | yes |
| 3 | 200 | 1.178309 | 33823 | none | yes |
| 4 | 200 | 0.791038 | 33823 | none | yes |
| 5 | 200 | 1.361676 | 33823 | none | yes |
| 6 | 200 | 0.733324 | 33823 | none | yes |
| 7 | 200 | 0.640342 | 33823 | none | yes |

- Min: 0.640342s
- Max: 1.361676s
- Average: 0.997384s
- Median: 0.998454s

### Authenticated headless Chromium timing — 5 runs

| Run | Seconds | Title | Bad markers | Bills marker |
|---:|---:|---|---|---|
| 1 | 3.493 | RocketSuite | none | yes |
| 2 | 1.204 | RocketSuite | none | yes |
| 3 | 0.777 | RocketSuite | none | yes |
| 4 | 0.784 | RocketSuite | none | yes |
| 5 | 0.769 | RocketSuite | none | yes |

- Min: 0.769s
- Max: 3.493s
- Average: 1.4054s
- Median: 0.784s

## After timing — optimized Bills screen

Final deployed Worker version: `793e6fe3-95b1-4f00-b299-9e9ecf0a60b8`
Implementation: restored the Bills list/table and A/P aging with one bounded SQL round-trip. The query now computes line totals, applied payments, open balances, aging buckets, paid-this-month totals, filtered count, and current page rows in SQL instead of pulling all open bills and all payment applications into JavaScript.

### Authenticated HTTP timing — 7 runs

| Run | HTTP | Seconds | Bytes | Bad markers | Bills marker | Table marker |
|---:|---:|---:|---:|---|---|---|
| 1 | 200 | 1.405699 | 176536 | none | yes | yes |
| 2 | 200 | 2.986698 | 176536 | none | yes | yes |
| 3 | 200 | 1.423049 | 176450 | none | yes | yes |
| 4 | 200 | 1.145976 | 176536 | none | yes | yes |
| 5 | 200 | 0.798302 | 176536 | none | yes | yes |
| 6 | 200 | 0.822773 | 176536 | none | yes | yes |
| 7 | 200 | 0.772243 | 176536 | none | yes | yes |

- Min: 0.772243s
- Max: 2.986698s
- Average: 1.336391s
- Median: 1.145976s

### Authenticated headless Chromium timing — 5 runs

| Run | Seconds | Title | Bad markers | Bills marker |
|---:|---:|---|---|---|
| 1 | 1.497 | RocketSuite | none | yes |
| 2 | 1.096 | RocketSuite | none | yes |
| 3 | 0.833 | RocketSuite | none | yes |
| 4 | 0.809 | RocketSuite | none | yes |
| 5 | 0.766 | RocketSuite | none | yes |

- Min: 0.766s
- Max: 1.497s
- Average: 1.0002s
- Median: 0.833s

### Browser content proof

The rendered browser body included:

- `Bills`
- `31 matches · Page 1 of 1`
- `OUTSTANDING`
- `A/P AGING`
- table headers: `DATE`, `DUE`, `NUMBER`, `VENDOR`, `STATUS`, `OUTSTANDING`, `MEMO`
- vendor rows such as `AT&T`, `Robertson & Associates`, `Norton Lumber and Building Materials`

No `Error 1101`, `Worker threw exception`, `Application error`, or `Internal Server Error` markers appeared in HTTP or browser runs.

Final post-deploy browser proof on Worker `793e6fe3-95b1-4f00-b299-9e9ecf0a60b8`: `/bills` rendered in 1.982s with title `RocketSuite`, Bills marker present, A/P aging/table marker present, and no bad markers.

## Before/after comparison

Important context: the before baseline was the temporary fast shell, not the old heavy all-row Bills implementation. After optimization, the page serves the full Bills table and A/P summary again, so the response body is much larger.

| Test | Before median | After median | Notes |
|---|---:|---:|---|
| Authenticated HTTP | 0.998454s | 1.145976s | After page includes full Bills table and A/P summary; no 1101s. |
| Authenticated browser | 0.784s | 0.833s | After page renders real Bills content; no 1101s. |

Result: restored the functional Bills screen with stable load times close to the placeholder shell and no Cloudflare 1101 regressions.
