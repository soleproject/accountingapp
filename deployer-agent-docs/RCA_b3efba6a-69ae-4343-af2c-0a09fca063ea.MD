# RCA — "Couldn't load transactions." toast on /accounting/transactions (app.smartbookssoftware.ai)

## Status: BLOCKED — wrong environment. RCA could not be performed against the deployment that actually serves `app.smartbookssoftware.ai`.

## Problem statement (as reported)
- On the Transactions page, when superadmin `michael@bigsaas.ai` (impersonating client Michelle Sardeson, company "C2C Connect, LLC") approves a transaction, a red toast "Couldn't load transactions." appears. Toast fires when ANY of 4 GETs rejects non-429: `/api/companies/{cid}/transactions`, `/accounts`, `/invoices`, `/bills`.
- Window: Nov 6, 2026 ~23:40 – Nov 7 00:10 UTC. Suspected 5xx / timeout / 429 (slowapi 600/min keyed by remote addr, all users share ingress IP) / ingress 502-504 / CORS.
- Requested: identify failing endpoint + status/latency/traceback for company C2C Connect; pod restart/OOM/timeout; 429s; ingress CORS/502/504.

## What I am scoped to
- Deployment: `aifinance-hub-6` (deployment_id `d78b7971-2d09-4d6b-b40f-b6972cb6da30`), active run `b3efba6a-69ae-4343-af2c-0a09fca063ea`, template fastapi_react_mongo_shadcn, cloudflare frontend, tier_0, default URL `https://aifinance-hub-6.emergent.host`.

## Why the RCA is blocked — evidence that this is NOT the production env serving app.smartbookssoftware.ai
1. **No custom domain attached.** `list_domains` returns an empty list. `app.smartbookssoftware.ai` is not registered on this deployment, so this deployment is not the one serving that hostname.
2. **The target company does not exist in this deployment's database.** The active run's resolved DB is `aifinance-hub-6-test_database`. Searching `companies` for /C2C Connect/i → 0 docs. The collection holds only **11 companies**, mostly test fixtures (Bright Beans Coffee, NextGen LLC, 419/659/707 LLC, several `TEST_*`). No "C2C Connect, LLC".
3. **No company here has ~1,100 transactions.** Total `transactions` = 2268 across 5 company_ids. The company_ids present do not include a C2C Connect; one orphan company_id (`2f8153a1-…`) referenced by transactions has only 2 transactions and no matching company doc.
4. **User identity mismatch.** `michael@bigsaas.ai` does exist here, but as name "Michael Giorgi", role `client` — not the reported superadmin impersonating Michelle Sardeson. No user matching michelle/sardeson/smartbooks.
5. **No matching live traffic.** Last 24h of backend logs (Loki) show ONLY internal `GET /health` probes (127.0.0.1). A clean query excluding health probes and matching `companies|429|Too Many|Traceback|Internal Server|rate` returned **0 lines**. There is no `/api/companies/*/transactions` user traffic, no 429s, and no 5xx on this deployment.

## Conclusion
I cannot answer questions (1)-(4) because the backend logs, pod events, rate-limiter activity, and database on THIS deployment do not correspond to the environment where the incident occurred. `app.smartbookssoftware.ai` is served by a different deployment/job that this agent is not scoped to.

Additional note: the incident window (Nov 6–7, 2026) may also be outside the ~24h log-retention window of the log tooling even on the correct deployment, so the RCA should be run promptly after the next recurrence, or against whatever longer-retention logging the real production env has.

## Required next step (so a real RCA can be done)
Re-scope the RCA to the deployment that actually serves `app.smartbookssoftware.ai`:
- In the Deployment panel, confirm which deployment/job the custom domain `app.smartbookssoftware.ai` is attached to (it is NOT `aifinance-hub-6` / `d78b7971`).
- Re-trigger this RCA against that deployment's run so backend logs, pod events, slowapi 429s, ingress 502/504, and the C2C Connect company data (cid) are all reachable.

## What a correct-environment RCA should then check (unchanged from the request)
- Backend logs for the 4 GETs for the real C2C Connect cid in the window: status codes, latency, Python traceback.
- `get_pod_events` for OOMKilled / restarts / probe kills around the window (tier_0 memory ceiling vs. a 996-row credit-card account query).
- slowapi 600/min counter keyed by remote address — whether the shared ingress IP trips 429 under concurrent approve+reload bursts.
- Ingress 502/504 / CORS on `/api/companies/*/transactions`.
