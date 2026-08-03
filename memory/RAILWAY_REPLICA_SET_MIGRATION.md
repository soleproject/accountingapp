# Railway MongoDB → 3-Node Replica Set Migration Plan

**Owner:** Platform / DevOps
**Status:** Draft — awaiting user go-ahead on backup verification & maintenance window
**Target:** Enable true `with_transaction()` atomicity for ledger writes (Bills, Assets, Opening Balance, Bill-Payments, JE reversals)
**Environment:** Railway Pro plan, `loving-elegance` project, `production` env, US West (California)

---

## 0. What we know from Railway today

Confirmed from screenshots (2026-02):

| Item | Value |
|------|-------|
| Railway plan | **Pro** (24 vCPU / 24 GB per-replica ceiling) |
| `accountingapp` service | 1 replica, US West, sliders maxed to Pro cap |
| `MongoDB` service | **mongo:8.0** single node (upgrade 8.3.7 available) |
| Mongo public endpoint | `tokaido.proxy.rlwy.net:33818 → :27017` |
| Backups tab | Exists on MongoDB service — details TBD (see §3) |
| Current `ledger_transaction()` | **No-op** (falls back gracefully, logs warning) |

> ⚠️ The 24 vCPU / 24 GB is the *ceiling*, not usage. Railway bills on actual consumption, so setting the cap high is safe. Ping Metrics → CPU/Mem tabs to see real usage. We assume ~2–4 vCPU / 4–8 GB actual for API today.

---

## 1. Uvicorn worker calibration (question **1f**)

With up to 24 vCPU / 24 GB available and single-node Mongo currently:

**Recommendation for now (single node, pre-migration):**
```
uvicorn server:app --workers 4 --host 0.0.0.0 --port $PORT
MONGO_MAX_POOL_SIZE=100      # per worker → 400 pool total
UVICORN_TIMEOUT_KEEP_ALIVE=30
```

**After Replica Set (3-node PSA) with 24 vCPU headroom:**
```
uvicorn server:app --workers 8 --host 0.0.0.0 --port $PORT
MONGO_MAX_POOL_SIZE=75       # per worker → 600 pool across 3 mongos
```

Rationale: Each Motor pool = 100 sockets ↔ Mongo `maxConns` default 65,536. 3-node PSA can handle 8 × 75 = 600 concurrent client sockets without breaking a sweat. Uvicorn workers should be `2 × cores + 1` up to memory limits — 8 workers × ~250 MB Python heap = 2 GB, well under 24 GB.

**Action:** Set `MONGO_MAX_POOL_SIZE=100` in Railway → accountingapp → Variables today. Keep `--workers 4` until we finish migration, then bump to 8.

---

## 2. Backup situation (question **2**) — INVESTIGATION NEEDED FROM YOU

Railway MongoDB template ships with two backup surfaces:

### 2a. Railway Volume Snapshots (default, always on)
- **What:** Whole-volume snapshot of `mongodb-volume` (the persistent disk holding `/data/db`)
- **Frequency:** Railway Pro = **daily automatic**, retained **7 days** (Pro tier default)
- **Restore path:** Railway Dashboard → MongoDB → Backups tab → *Restore snapshot* — spins up a new volume from the snapshot, downtime ~2–5 min
- **Caveat:** Volume snapshots are **crash-consistent**, NOT application-consistent. If Mongo is mid-write during snapshot, you may need to run `mongod --repair` on restore. In practice mongo:8.0 WiredTiger handles this fine 99% of the time.

### 2b. `mongodump` cron (recommended, NOT currently configured — assumption)
- No evidence in repo of a `mongodump` cron/CronJob service
- Recommendation: Add a Railway Cron Service running nightly:
  ```
  mongodump --uri="$MONGO_URL" --archive=/backups/$(date +%F).gz --gzip
  # then upload to Backblaze B2 / S3 / R2
  ```

### 2c. Point-in-Time-Restore (PITR)
- Requires oplog access → **only works after we convert to Replica Set** (§4)
- Once RS is live, we can run `mongodump --oplog` + apply `--oplogReplay` on restore

### **What we need YOU to do before touching prod:**
1. **Open Railway → MongoDB service → Backups tab** → screenshot everything you see
2. Confirm: "*Automatic backups: enabled*" and note retention days
3. **Test restore end-to-end** to a scratch service:
   - Railway → MongoDB → Backups → pick yesterday's snapshot → *Restore to new service*
   - Verify data appears via `mongosh` shell
   - Time it: how long from click to "connected & queryable"?
4. Report back the restore RTO (Recovery Time Objective) so we know our worst case

**Verdict:** Until you confirm snapshot + restore actually work, DO NOT run `rs.initiate()` on prod.

---

## 3. Rollback plan if `rs.initiate()` fails (question **1c**)

The migration is designed so the DB is restorable at every checkpoint:

### Checkpoint 1: Pre-migration snapshot (5 min before)
- Railway → MongoDB → Backups → *Take manual snapshot* → label `pre-replicaset-2026-02-XX`
- **This is your rollback anchor.** All following steps can be undone by restoring this snapshot.

### Checkpoint 2: Config change fails to persist
- If setting `--replSet rs0` in the mongo container start command fails or the service refuses to boot:
- Railway → MongoDB → Settings → Deployments → *Revert to previous deployment*
- Downtime: ~1 min. No data loss.

### Checkpoint 3: `rs.initiate()` returns error
- Common errors: `"already initialized"`, `"host not resolvable"`, `"authentication failed"`
- Action: Run `rs.status()` in `mongosh`. If `stateStr: "REMOVED"` or garbage state:
  ```js
  // Force reconfig back to single node
  cfg = rs.conf()
  cfg.members = [cfg.members[0]]  // keep only primary
  rs.reconfig(cfg, {force: true})
  ```
- If that fails: stop mongo, remove `--replSet` flag, restart. It becomes a standalone again. Data intact.

### Checkpoint 4: App can't connect after conversion
- Symptom: `pymongo.errors.ServerSelectionTimeoutError`
- Cause: connection string still points at single node instead of `mongodb://primary,secondary1,secondary2/?replicaSet=rs0`
- Rollback: revert `MONGO_URL` env var in `accountingapp` service to previous value → auto-redeploy → back online in ~30s
- Fix forward: update `MONGO_URL` to the multi-host RS URI (see §5)

### Nuclear option
- Restore the `pre-replicaset` snapshot from Checkpoint 1 → creates a fresh single-node Mongo → repoint `MONGO_URL` → done in ~10 min.

---

## 4. Downtime window (question **1d**)

Given your **15–30 min window OK**, the plan uses ~20 min:

| Step | Duration | User-visible impact |
|------|----------|---------------------|
| 1. Manual snapshot (pre-migration anchor) | 2 min | None |
| 2. Provision 2 new Mongo services (secondaries) | 3 min | None |
| 3. Set `--replSet rs0` on primary, restart | 1 min | **~30s API 502s** |
| 4. `rs.initiate()` on primary via console | <1 min | None |
| 5. `rs.add()` secondaries | 2 min | None |
| 6. Wait for initial sync `rs.status()` = SECONDARY | 5–10 min | None (still primary-only queries work) |
| 7. Update `MONGO_URL` on accountingapp → redeploy | 2 min | **~1 min API 502s** |
| 8. Verify `ledger_transaction()` works via smoke test | 2 min | None |
| **Total user-visible downtime** | | **~1.5 min hard, ~10 min "degraded reads"** |

**Recommended window:** Sunday 03:00 UTC (Saturday night US West). Post banner in-app 24h prior.

---

## 5. Full 3-node PSA (Primary-Secondary-Arbiter) setup (question **3c**)

You picked **c: Full 3-node PSA** — this gives production-grade HA with automatic failover.

### 5a. Architecture

```
                  ┌──────────────┐
                  │ accountingapp│  (--workers 8)
                  │  MONGO_URL=  │
                  └──────┬───────┘
       ┌─────────────────┼─────────────────┐
       ▼                 ▼                 ▼
┌────────────┐    ┌────────────┐    ┌────────────┐
│ mongo-p    │◄──►│ mongo-s1   │◄──►│ mongo-s2   │
│ PRIMARY    │    │ SECONDARY  │    │ SECONDARY  │
│ US-West    │    │ US-East    │    │ US-West    │
│ 27017      │    │ 27017      │    │ 27017      │
└─────┬──────┘    └─────┬──────┘    └─────┬──────┘
      │                 │                 │
   ┌──▼───┐         ┌───▼──┐         ┌────▼──┐
   │vol-p │         │vol-s1│         │vol-s2 │
   └──────┘         └──────┘         └───────┘
```

> **Note:** True PSA (Primary-Secondary-Arbiter) uses an *arbiter* (voting-only, no data). MongoDB **strongly discourages** PSA in production because a majority-write concern loses durability if any data node is down. We recommend **PSS (Primary-Secondary-Secondary)** — 3 real data nodes. Cost is ~3x single node but you get true HA and durable majority writes.
>
> If cost is a hard constraint, we can do **PSA** (1 real secondary + 1 tiny arbiter container, ~2.1x cost) — but this compromises `w:majority` durability guarantees. **Recommendation: PSS.**

### 5b. Cost estimate (Railway Pro pricing, Feb 2026)

Railway Pro bills on usage: **$0.000463/vCPU-min + $0.000231/GB-min** ≈ **$20/vCPU/mo + $10/GB/mo** at 100% utilization.

Realistic prod usage per Mongo node: **1 vCPU / 2 GB steady + spikes to 2 vCPU / 4 GB**:

| Setup | Nodes | Est. monthly cost |
|-------|-------|-------------------|
| Current (single node) | 1 × (1v/2G avg) | **~$40/mo** |
| PSA (1P + 1S + 1 arbiter) | 2 × (1v/2G) + 1 × (0.25v/0.5G) | **~$90/mo** |
| **PSS (recommended)** | 3 × (1v/2G) | **~$120/mo** |
| PSS across 2 regions | 3 × (1v/2G) + inter-region egress | **~$140/mo** |

**Volumes:** Add ~$0.25/GB/mo × data-size × 3 (each node has full copy). For a 20 GB DB → ~$15/mo extra.

**Bottom line: PSS ≈ $135/mo total for Mongo layer.** Cheaper than Atlas M10 ($57/mo) but with more ops burden. If you'd prefer to punt ops entirely, **Atlas M10 dedicated** is a valid alternative and includes managed backups + PITR out of the box.

### 5c. Provisioning steps (Railway console)

**Step 1: Take pre-migration snapshot**
- MongoDB service → Backups → *Manual Snapshot* → label `pre-rs-YYYY-MM-DD`

**Step 2: Provision 2 secondary services**
For each of `mongo-s1`, `mongo-s2`:
```
Railway → New → Empty Service → Deploy Image → mongo:8.0
Add persistent volume (20 GB, mount /data/db)
Variables:
  MONGO_INITDB_ROOT_USERNAME=<same as primary>
  MONGO_INITDB_ROOT_PASSWORD=<same as primary>
Start command:
  mongod --replSet rs0 --bind_ip_all --keyFile /etc/mongo-keyfile --auth
```

**Step 3: Generate & distribute keyfile** (required for auth in replica set)
```bash
# Generate once, upload to all 3 services as a Railway Config file or Secret volume
openssl rand -base64 756 > mongo-keyfile
chmod 400 mongo-keyfile
```
Mount at `/etc/mongo-keyfile` on all three services.

**Step 4: Update primary's start command**
```
mongod --replSet rs0 --bind_ip_all --keyFile /etc/mongo-keyfile --auth
```
Redeploy. ~30s downtime.

**Step 5: Initiate the replica set (from primary's `mongosh` console)**
```js
rs.initiate({
  _id: "rs0",
  members: [
    { _id: 0, host: "mongo.railway.internal:27017", priority: 2 },
    { _id: 1, host: "mongo-s1.railway.internal:27017", priority: 1 },
    { _id: 2, host: "mongo-s2.railway.internal:27017", priority: 1 }
  ]
})
```
> Railway private DNS uses `<service-name>.railway.internal`. Confirm each service's internal hostname in Networking tab before running.

**Step 6: Verify**
```js
rs.status()   // all 3 members: PRIMARY / SECONDARY / SECONDARY
rs.printReplicationInfo()   // oplog window > 24h
```

**Step 7: Update app connection string**
```
MONGO_URL=mongodb://user:pass@mongo.railway.internal:27017,mongo-s1.railway.internal:27017,mongo-s2.railway.internal:27017/?replicaSet=rs0&authSource=admin&retryWrites=true&w=majority
```
Set in `accountingapp` → Variables. Railway auto-redeploys.

**Step 8: Smoke test**
```bash
# Verify session support (should NOT log "TRANSACTIONS_NOT_SUPPORTED" warning anymore)
curl -X POST $API/api/admin/test-transaction -H "Auth: ..."
# Should return {"transaction_supported": true, "commit_time_ms": <int>}
```

---

## 6. What lands in code AFTER migration succeeds

Once `rs.status()` shows all 3 nodes healthy and app reconnects on the RS URI:

1. **Add real `session=` threading** to:
   - `POST /api/bills` — wrap AP-account ensure + JE insert + bill insert in one txn
   - `POST /api/assets` — wrap fixed-asset ensure + depreciation schedule + JE
   - `POST /api/opening-balance` — wrap equity account ensure + all opening JEs
   - `POST /api/bill-payments` — wrap payment + AP reversal + JE
   - Contact upsert race → wrap or catch `DuplicateKeyError`

2. **Remove the "TRANSACTIONS_NOT_SUPPORTED" warning** from `db.py::ledger_transaction()` — it should now actually commit.

3. **Add integration test** `test_ledger_atomicity.py`:
   - Force-fail mid-write → assert zero orphan docs
   - Race two concurrent contact upserts → assert single doc

4. **Update `/api/admin/ledger-integrity`** to run on all secondaries via `readPreference=secondaryPreferred` to offload the scan.

---

## 7. Decision checkpoint — need YOU to confirm before we execute

Please reply with:

- [ ] **Backup restore drill completed** (§2 step 3) — RTO measured: ___ min
- [ ] **Maintenance window scheduled** — Date/time: _______ UTC
- [ ] **PSS vs PSA** — I recommend PSS. Confirm: PSS ✅ / PSA ⚠️
- [ ] **`MONGO_MAX_POOL_SIZE=100` set** on accountingapp Variables (safe to do now, no downtime)
- [ ] **Approve `--workers 4` today**, bump to `--workers 8` post-migration
- [ ] **Cost confirmed** — ~$135/mo total Mongo layer OK, OR switch to Atlas M10 ($57/mo managed)

Once ✅ across the board, I'll execute §5c and the code changes in §6.

---

## Appendix A: Alternative — MongoDB Atlas M10

If you want to skip Railway RS ops entirely:
- **Cost:** $57/mo (M10 shared cluster, includes 3-node RS, PITR backups, monitoring)
- **Setup:** 15 min
- **Pros:** Managed backups, PITR out of box, no keyfile juggling, better monitoring
- **Cons:** Additional egress cost when app in Railway calls Atlas cross-cloud (~$0.02/GB)
- **Migration path:** `mongodump` from Railway → `mongorestore` to Atlas → repoint `MONGO_URL` → done

For 600–1200 tenant scale, **Atlas M10 is honestly the boring, correct answer** and saves ~$80/mo vs self-managed PSS. Only reason to stay on Railway Mongo: single-vendor billing simplicity.

## Appendix B: Live-migration zero-downtime alternative

If 1.5 min downtime is too much:
1. Set up PSS as documented, but with primary priority 0 (so it can't be primary yet)
2. Wait for initial sync
3. Step down current primary → new PSS primary auto-elects
4. Update app `MONGO_URL` → PSS RS URI (rolling deploy, no downtime with 2+ workers)
5. Retire old single node
Requires ~2h and careful orchestration. Not recommended unless downtime is truly unacceptable.
