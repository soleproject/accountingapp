# Smart Categorization Mode — Deferred Build Spec

**Status:** Deferred. Not started. All architectural decisions captured below so a future session can pick it up cold.

**Owner conversation date:** Feb 2026

---

## Context

We already have two categorization modes:

- `standard` — deterministic cascade + gpt-4o-mini LLM fallback. Proven, stable. Uses per-company merchant cache, user rules, PFC resolver, global directory hints, contact resolver.
- `standard_plus` — Standard + aggressive post-hook that runs the 5K+ global vendor directory as an override on every LLM-categorized row. Great for cold-start companies; can be worse than Standard on companies with mature per-tenant customization or non-standard CoAs (see "Domino's in Insurance" bug — Feb 2026).

**Goal of Smart mode:** a third option that keeps Standard's per-tenant priority stack but adds targeted improvements (better merchant normalization, per-company few-shot, correction-driven cache upsert, richer prompt context, optional model swap) — all in an isolated pipeline that never touches Standard's code.

## Design principle

**Zero risk to Standard.** If Smart doesn't work out or performs below Standard, users flip a radio button back and lose nothing. Same principle that guided the original Standard+ build.

---

## Architecture

### New categorization_mode value

Extend the enum: `standard | standard_plus | smart`. Backend validator accepts the new value. Persisted in `db.companies.categorization_mode`.

### New module

`backend/smart_categorizer.py` — sibling of `standard_plus_categorizer.py`. Fully self-contained. Reads from `db.transactions`, writes only to rows tagged with `categorization_mode == "smart"`. Never imports from or mutates Standard's pipeline.

### Branching point

`sync_tasks._run_sync` and `statements.py` already branch on `categorization_mode` for the Standard+ post-hook. Add a third branch for `smart` that routes to the new pipeline instead of Standard's cascade.

### UI

`AIFirstControls.CategorizationModeToggle` gets a third radio option: **"Smart (Beta)"**. Same tri-state UX pros already know.

### Provenance stamping

Every row categorized by Smart gets a `categorization_source` value like:
- `smart_cache` — hit the per-company merchant cache
- `smart_contact_preferred` — hit the contact's historical preferred category
- `smart_directory` — matched the 5K+ global vendor directory
- `smart_llm_v2` — went to the LLM with the enriched prompt
- `smart_recurring` — matched a locked recurring pattern

Transactions page provenance dot gets a new color (teal is available).

---

## Features to build (from most-safe to most-experimental)

### Deterministic layer (pre-LLM)

1. **Better merchant normalization** — canonical stems folding variants:
   - `AMZN Mktp US*8F0K3` / `Amazon.com*ABC` / `AMZN Digital*7WW` / `AMAZON MKTPLACE` → `amazon`
   - Same for Starbucks, Uber, Walmart, Target, Shell, etc.
   - Single canonical stem = one cache key = massive cache hit rate improvement.

2. **Contact-preferred-category lookup** — new deterministic stage. After the contact resolver identifies a contact, check `db.transactions` for the last N (say 10) posted transactions with that `contact_id`. If ≥8/10 landed in the same account, use it. Skips LLM entirely for repeat vendors — no waiting for rules miner to fire.

3. **Aggressive global directory as last-check-before-LLM** — different from Standard+. Only fires when NOTHING above matched (not as a post-hook override). Never overrides a good tenant answer.

4. **Amount-bucket routing at first pass** — Home Depot $8 → office supplies, Home Depot $850 → construction. Standard+ already has bucket logic; Smart uses it in the first pass, not as an override.

### LLM prompt improvements

5. **Company-specific few-shot examples** — include the last 5–10 categorizations FROM THIS COMPANY of similar merchants, amount ranges, or accounts as few-shot in the system prompt. This is the biggest single accuracy improvement.

6. **Actual CoA in the prompt** — send the company's real chart of accounts (names + short descriptions) instead of generic template guidance. Eliminates the "wrong template code" bug class (Domino's in Insurance). ~1–2K extra tokens, negligible cost.

7. **Enriched structured context** — amount + sign + direction, bank account type, date + day-of-month, existing link status. Most of this already known at candidate-build time, just not sent to the LLM.

8. **Confidence calibration** — auto-post threshold ≥0.90 (was 0.75), needs_review 0.60–0.90, Uncategorized <0.60. Fewer false-positive auto-posts, review rows are the ones that matter.

### Post-LLM feedback loop

9. **Correction-driven cache upsert** — when a pro re-categorizes any transaction, immediately upsert `merchant_cache` for that company AND log the correction pair `(LLM said X, pro said Y, merchant Z, amount A)` into a new `categorization_corrections` collection. Feed the last 20 pairs as few-shot into future LLM calls.

10. **Cross-transaction consistency check** — every new categorized row: is this merchant's category consistent with the last N transactions from the same merchant on this company? Flag inconsistencies for review.

11. **Recurring-transaction locking** — detect same-amount + same-merchant + monthly-cadence patterns (rent, SaaS, phone, utilities, insurance) and lock the categorization deterministically.

### Model choice (optional, isolate as separate experiment)

12. **GPT-5.6 Luna** — configurable via `LLM_MODEL_SMART` env. Priced at $0.20/$1.20 per 1M tokens (30% more than gpt-4o-mini but full generation newer). Drop-in swap. **Keep Smart on gpt-4o-mini for the initial test** so we can isolate whether the wins come from pipeline changes vs model change.

---

## Testing plan

### Phase A — Isolated dev testing (zero risk)

- New endpoint `POST /companies/{cid}/smart/dry-run` — runs Smart against the last N days of transactions but writes results to a shadow collection `transactions_smart_shadow`, never touches the real ledger.
- Diff report endpoint — shows agreement rate between Standard's answers and Smart's, plus a per-merchant breakdown of divergences.
- Backfill on a couple of existing test companies (Standard LLC, Sales Tax Tester LLC, Skyward Sparks) and manually eyeball the diffs.

### Phase B — Opt-in Beta (real ledger, opt-in companies only)

- Turn on `smart` mode for 1–2 friendly customer companies. Provenance dots make it obvious which stage handled each row.
- Compare user-correction rates over 30 days between the Smart companies and matched Standard-mode companies (same size, same industry).

### Phase C — Roll forward or roll back

- If Smart's user-correction rate is LOWER than Standard's on the same cohort → promote to default.
- If it's HIGHER (worse) → do nothing. Standard-mode companies were never touched. Smart users flip back to Standard with one radio click.

### The owner's actual test plan (Feb 2026 conversation)

Owner said: **"I will just create a new company and run it on Smart categorization."** Cold-start realistic test, single test company.

**Recommended cold-start test protocol:**
1. Create a new company, connect Plaid.
2. Let Smart categorize the first sync end-to-end. Eyeball accuracy.
3. Manually re-categorize 20–30 rows to seed the correction loop.
4. Trigger a manual sync (or wait for the next one).
5. Compare accuracy on the second sync — the "learn from corrections" pathway should light up.

**Model isolation decision:** Keep Smart on gpt-4o-mini for the first test. Isolate whether wins come from pipeline changes vs model. Swap to GPT-5.6 Luna later as a separate experiment.

---

## Safety nets (bake in from day one)

- **Never delete or overwrite a user-corrected row.** Smart's cascade always checks `human_reviewed == true` and skips those.
- **Every stage is provenance-stamped.** For any row we can see EXACTLY which stage produced the answer.
- **Kill-switch env var.** `SMART_MODE_ENABLED=false` bypasses the new pipeline entirely and silently routes those companies back to Standard. Zero-downtime rollback.
- **Idempotent + rerunnable.** Same guarantees as Standard+.
- **Emits `smart_run_summary` doc per batch** with counts by stage — dashboards the internals.

---

## Estimated build effort

Roughly **4–5 days of focused work** for a testable Beta, another **2–3 days** for the shadow/diff tooling.

Breakdown:
- Module scaffold + branching in sync/statements: **½ day**
- Better merchant normalization + contact-preferred lookup: **½ day**
- Prompt improvements (few-shot + CoA context): **½ day**
- Correction-driven cache upsert hook: **½ day**
- Cross-txn consistency check + recurring detection: **1 day**
- Dry-run + shadow collection + diff endpoint: **1 day**
- Frontend toggle + provenance color: **½ day**
- Test suite (target ~15–20 tests): **1 day**

Standard is untouched throughout.

---

## Open decisions when picking this up

1. **Name confirmation** — `smart` is the working name. Owner conversation didn't final-lock it. Alternatives considered: `adaptive`, `standard_v2`, `intelligent`, `context_aware`.
2. **Model choice at ship** — gpt-4o-mini (isolate variables) or GPT-5.6 Luna (bigger swing). Recommendation: gpt-4o-mini for the first test.
3. **Whether to also implement the "second-pass Accuracy Review" agent** — separate discussion in this session. Not part of Smart. Could be layered ON TOP of Smart as a Complete-tier feature after Smart lands.

---

## Related files (as of Feb 2026)

- `/app/backend/standard_plus_categorizer.py` — reference implementation of an isolated post-hook categorizer. Smart follows this pattern.
- `/app/backend/plaid_connect.py` — Plaid ingest path where the branching happens (see `categorize_and_insert_plaid_txns`).
- `/app/backend/sync_tasks.py` — `_run_sync` branches on `categorization_mode` for the Standard+ post-hook.
- `/app/backend/statements.py` — Veryfi/statement ingest path, mirrors the Plaid branching.
- `/app/backend/rules_miner.py` — per-company rules mining. Smart lowers the threshold from ≥10 hits @ ≥98% to ≥5 hits @ ≥95%.
- `/app/backend/merchant_cache.py` — per-company merchant cache. Smart adds correction-driven upsert.
- `/app/backend/global_vendor_rules.py` — the 5K+ vendor directory. Smart uses it as last-check-before-LLM, not as a post-hook override.
- `/app/backend/ai_service.py` — `categorize_transaction`. Smart uses a new function `categorize_transaction_smart` with the enriched prompt.
- `/app/frontend/src/components/AIFirstControls.jsx` — the categorization mode toggle. Add third "Smart (Beta)" radio.

---

## Do NOT touch when building Smart

- Anything in the Standard cascade path (`categorize_and_insert_plaid_txns` core logic).
- `standard_plus_categorizer.py` (its own users depend on current behavior).
- Any existing `categorization_source` provenance values (only ADD new ones prefixed with `smart_`).
- The `merchant_cache` schema in a breaking way — extend with new fields, don't rename.

---

## Cost expectations

Per company per month, at typical volume (~500 txns/mo):

| Model | Expected cost |
|---|---|
| gpt-4o-mini (same as Standard) | ~$0.05–$0.12 |
| GPT-5.6 Luna (if we swap later) | ~$0.06–$0.15 |

Enriched prompts add ~1–2K tokens per LLM call. Marginal cost impact.

If we later add a second-pass Accuracy Review agent on top of Smart (with Claude Sonnet 4.6, batched overnight), add another **~$0.10–$0.40/co/mo**. Gate on Complete-tier ($50/mo) — margin impact is <1%.
