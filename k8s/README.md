# Axiom Ledger — Kubernetes deployment templates

These manifests are **reference-only** — they're not applied automatically by
the current Emergent preview environment. Copy them to your production K8s
cluster (EKS/GKE/AKS/DOKS) once you migrate off the managed preview.

## Architecture (Feb 2026 — post arq→asyncio migration)

Background sync jobs no longer run in a separate worker process; they now
execute inside the FastAPI event loop via `asyncio.create_task` and are
capped by `MAX_CONCURRENT_SYNCS` (default 20, prod override 40). Redis is
still used, but only for two secondary roles: (a) the multi-pod
`RedisReportCache` and (b) slowapi rate-limiter storage. Neither is on the
critical path — a Redis outage degrades gracefully to per-pod in-process
storage.

## What's here

| File | Purpose |
|---|---|
| `backend-deployment.yaml`      | FastAPI API server. 3 replicas, autoscale 3 → 12. Runs Plaid syncs in-process. |
| `redis-deployment.yaml`        | Redis 7 — cross-pod report cache + rate-limiter storage. Not on the critical path. |
| `hpa-backend.yaml`             | HorizontalPodAutoscaler for backend: 70% CPU / 80% memory targets. |

## Sizing for 3,000 users

| Knob | Default | 3k value |
|---|---|---|
| Backend replicas (HPA min) | 2 | **3** |
| Backend replicas (HPA max) | 10 | **12** |
| `MAX_CONCURRENT_SYNCS` per pod | 20 | **40** |
| `MONGO_MAX_POOL_SIZE` per pod | 100 | **200** |
| Total concurrent Plaid syncs | 20 | **120** (40 × 3 pods min) |
| Total Mongo pool | 100 | **600** (Atlas M30 comfortably absorbs) |

## Prereqs

1. **Metrics Server** — required for CPU-based HPA. Every managed K8s
   provider has a one-liner (`eksctl utils…`, `gcloud container clusters
   update…`, or the community chart).
2. **Secret** with env vars from `backend/.env`: `MONGO_URL`, `DB_NAME`,
   `REDIS_URL` (points at the redis-deployment service), `PLAID_CLIENT_ID`,
   `PLAID_SECRET`, `PLAID_ENV`, `VERYFI_*`, `EMERGENT_LLM_KEY`, `SENTRY_DSN`,
   `PUBLIC_BACKEND_URL`, `JWT_SECRET`.
3. **Ingress** in front of `axiom-backend` Service.

## Rollout order

```
kubectl apply -f redis-deployment.yaml     # 1. cache + rate-limiter store
kubectl apply -f backend-deployment.yaml   # 2. API pods (sync tasks live inline)
kubectl apply -f hpa-backend.yaml          # 3. autoscaler
```

## Scale points (based on observed load)

| Metric | Threshold | Action |
|---|---|---|
| Backend CPU > 70% (5 min avg) | HPA scales up by 2 pods |
| Backend p95 latency > 500 ms | Investigate slow queries; scale up if CPU is also high |
| `sync_jobs` queued+running > 100 for > 2 min | Raise `MAX_CONCURRENT_SYNCS` or add pods |
| Redis mem > 400 MB | Bump `maxmemory` in `redis-deployment.yaml`; check `evicted_keys` |
| Anthropic `429`s | Learning-cache miss rate is high — investigate cache hit ratio |

## Graceful shutdown

The backend deployment sets `terminationGracePeriodSeconds: 60` and a 5 s
`preStop sleep`. When a pod is drained, K8s stops sending it new requests,
uvicorn finishes in-flight requests, and any in-flight `asyncio.create_task`
sync jobs get up to 55 s to finish. Survivors are marked failed by the
next pod's `reconcile_stuck_jobs()` — the user just re-clicks Re-sync;
Plaid dedupe keeps this safe.

## What to watch after go-live

- `sync_jobs` collection growth — TTL is 7 d on `finished_at`, so
  steady-state should be a few thousand rows for 3 k orgs.
- Sentry error rate on `sync_tasks.plaid_manual_sync` — spikes indicate
  Plaid rate-limiting or bank-side outages.
- Redis `evicted_keys` — non-zero is fine (cache LRU), but a sustained
  high rate means bump `--maxmemory`.
- Emergent LLM key daily spend — one abusive tenant can drain the shared
  budget. Consider per-tenant caps once you cross 500 users.
