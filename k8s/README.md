# Axiom Ledger — Kubernetes deployment templates

These manifests are **reference-only** — they're not applied automatically by
the current Emergent preview environment. Copy them to your production K8s
cluster (EKS/GKE/AKS/DOKS) once you migrate off the managed preview.

## What's here

| File | Purpose |
|---|---|
| `backend-deployment.yaml`      | FastAPI API server. 2 replicas, autoscale 2 → 10. |
| `worker-deployment.yaml`       | Arq worker for background jobs. 1 replica, autoscale 1 → 8. |
| `redis-deployment.yaml`        | Redis 7 for the Arq queue. Single replica, persistent volume. |
| `hpa-worker.yaml`              | HorizontalPodAutoscaler for worker: scale on CPU + Redis queue depth. |
| `hpa-backend.yaml`             | HorizontalPodAutoscaler for backend: scale on CPU + request rate. |
| `metrics-service.yaml`         | ClusterIP service exposing Prometheus metrics for HPA. |

## Prereqs

1. **Metrics Server** — required for CPU-based HPA. Every managed K8s
   provider has a one-liner (`eksctl utils…`, `gcloud container clusters
   update…`, or the community chart).
2. **Prometheus Adapter** — only required for the custom-metric HPA on
   worker (Redis queue depth). If you want to skip it initially, use the
   CPU-only variant in `hpa-worker.yaml` (uncomment the "Simpler CPU-only"
   block, comment the queue-depth block).
3. **Secret** with the env vars from `backend/.env` (MONGO_URL, EMERGENT_LLM_KEY,
   PLAID_*, VERYFI_*, SENTRY_DSN, PUBLIC_BACKEND_URL, REDIS_URL).

## Rollout order

```
kubectl apply -f redis-deployment.yaml            # 1. queue first
kubectl apply -f backend-deployment.yaml          # 2. API pods
kubectl apply -f worker-deployment.yaml           # 3. workers
kubectl apply -f metrics-service.yaml             # 4. Prometheus targets
kubectl apply -f hpa-backend.yaml hpa-worker.yaml # 5. autoscalers
```

## Scale points (based on observed load)

| Metric | Threshold | Action |
|---|---|---|
| Worker CPU > 70% (5 min) | 5 min | +1 worker replica (auto via HPA) |
| Queue depth > 50 jobs | 2 min | +1 worker replica (custom metric HPA) |
| Backend p95 latency > 500ms | 5 min | +1 backend replica |
| Redis mem > 200 MB | manual | Investigate stuck jobs (nothing should stay in queue >10 min) |

## What to watch after go-live

- `sync_jobs` collection growth — TTL is 7d on `finished_at`, so steady-state
  should be a few thousand rows for 3k orgs.
- Sentry error rate on `worker.plaid_manual_sync` — spikes indicate Plaid
  rate-limiting or bank-side outages. Our `max_tries=3` gives 3 attempts
  automatically.
- Redis `evicted_keys` should always be 0. If it's not, bump memory.
