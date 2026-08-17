# Phase 0 PRD — UK Region Foundation

**Owner**: Engineering
**Timeline**: 1 week (5 working days)
**Status**: Proposed — awaiting approval to begin
**Visible to users**: **No** (all changes gated behind a feature flag; existing US behavior unchanged)

---

## 1. Goal

Lay the plumbing that lets a single Axiom company be *either* US or UK
without breaking anything the US product already does. Phase 0 ships
zero user-visible changes; it makes Phases 1–3 possible.

**Definition of done**: Every existing company is `region: "US"` and
behaves exactly as it does today. The codebase has a `region` field,
a currency/date formatter that reads it, and a `t()` translation
helper that returns US strings until we start populating UK ones.
No production endpoint response shape changes.

---

## 2. Non-goals (Phase 0)

- No UK Chart of Accounts yet (Phase 1)
- No terminology swaps yet (Phase 1)
- No VAT engine (Phase 2)
- No HMRC APIs (Phase 2)
- No user-visible UI to pick region — every company created in Phase 0
  is still `"US"`. The company-creation UI dropdown ships in Phase 1.

---

## 3. Data model changes

### 3.1 `companies` collection — three new fields

| Field | Type | Default | Purpose |
|---|---|---|---|
| `region` | `"US" \| "UK"` | `"US"` | The single switch that gates every jurisdictional behavior. |
| `currency` | `"USD" \| "GBP"` | `"USD"` | Display + report currency. Derived from `region` at create-time; stored independently so a future US company invoicing in GBP is possible. |
| `date_format` | `"MM/DD/YYYY" \| "DD/MM/YYYY"` | `"MM/DD/YYYY"` | Display preference. Same derived-then-stored pattern. |

**Backfill migration** (one-shot script, `scripts/backfill_region.py`):
```
db.companies.update_many(
    {"region": {"$exists": False}},
    {"$set": {"region": "US", "currency": "USD",
              "date_format": "MM/DD/YYYY"}},
)
```
Idempotent — safe to run multiple times.

### 3.2 `feature_flags` collection — new

Minimal, single-purpose collection so we can flip UK visibility
without redeploying:

```
{
    "id": <uuid>,
    "key": "regions.uk_enabled",
    "enabled": false,
    "scope": "global" | "company",
    "company_id": null | "<cid>",
    "updated_at": <iso>,
    "updated_by": "<user_id>",
}
```

- Global flag `regions.uk_enabled = false` in Phase 0 (nothing UK-specific renders anywhere).
- Per-company override lets us dogfood on one test company before global launch.
- Read-through cache in `infra.py` keeps the check ~free (10-second TTL).

---

## 4. Backend touchpoints (exact files & line ranges)

### 4.1 New files

| Path | Purpose |
|---|---|
| `/app/backend/regions.py` | Central registry: `REGIONS = {"US": {...}, "UK": {...}}` with defaults for currency, date_format, and (Phase 1) CoA template name. |
| `/app/backend/feature_flags.py` | `async def is_enabled(key: str, company_id: str \| None = None) -> bool`. Reads `feature_flags` collection with a 10-second in-process cache. |
| `/app/backend/scripts/backfill_region.py` | One-shot migration described in §3.1. Prints count-changed. |
| `/app/backend/tests/test_region_defaults.py` | Pytest: new company defaults to US; explicit `region="UK"` persists; backfill script is idempotent; feature flag read is cached. |

### 4.2 Modified files

| Path | Line range | Change |
|---|---|---|
| `/app/backend/models.py` | `CompanyCreate` @ line 34 | Add optional `region: Optional[Literal["US","UK"]] = None`. Backend derives currency + date_format from region if omitted. |
| `/app/backend/routes/companies.py` | `create_company` @ lines 99–142 | On insert, set `region`, `currency`, `date_format`. Region defaults to `"US"` if `inp.region` is None. |
| `/app/backend/routes/companies.py` | `list_companies` @ lines 78–96 | Include `region`, `currency`, `date_format` in the enriched row so the frontend gets them without a second call. |
| `/app/backend/server.py` | Startup hook @ line 86 | Add a single `create_index("key", unique=True)` on `feature_flags`. |

### 4.3 Explicitly NOT changed in Phase 0

- `reports.py` — untouched. It returns raw numbers; presentation is a frontend concern.
- `qbo_service.py`, `plaid_service.py`, all US tax code — untouched.
- `seed.py::DEFAULT_COA` — untouched. UK CoA arrives in Phase 1.
- All existing endpoints — response shapes are additive only (new fields on `companies` payloads), which is backwards-compatible with the current frontend.

---

## 5. Frontend touchpoints (exact files & functions)

### 5.1 New files

| Path | Purpose |
|---|---|
| `/app/frontend/src/lib/regions.js` | `export const REGIONS = { US: {...}, UK: {...} }` with currency symbol, currency code, locale, date format. |
| `/app/frontend/src/lib/i18n.js` | `t(key, region)` helper. Reads from a static map (`STRINGS[region][key]`). Falls back to US string if key missing for region. Zero runtime deps. |
| `/app/frontend/src/lib/featureFlags.js` | `useFeatureFlag(key)` hook. Loads all flags for the current user on login, caches in memory. |

### 5.2 Modified files

| Path | Function / lines | Change |
|---|---|---|
| `/app/frontend/src/lib/api.js` | `fmtMoney` @ lines 34–37 | Accept optional `region` param; look up symbol + locale from `REGIONS`. Default remains US so every existing call site keeps working. Signature: `fmtMoney(n, region = "US")`. |
| `/app/frontend/src/lib/api.js` | `fmtDate` @ lines 39–53 | Accept optional `region` param; pick date format tokens from `REGIONS`. Default remains US. |
| `/app/frontend/src/lib/company.js` | `useCompany()` hook | Expose `region`, `currency`, `date_format` from the current company alongside `currentId`. |

### 5.3 Explicitly NOT changed in Phase 0

- No screens are re-wired to pass `region` into `fmtMoney`. That's a
  Phase 1 sweep. Phase 0 just makes the *signature* region-aware so
  Phase 1 is a mechanical find-and-replace.
- No visible strings change. `t()` exists but every call site returns
  the US string in Phase 0.
- No new UI on Company Settings or the Create-Company modal.

---

## 6. Rollout & safety

1. **Merge behind flag.** `regions.uk_enabled = false` at global scope. Nothing UK-related executes.
2. **Backfill.** Run `scripts/backfill_region.py`. Verify count-changed matches `db.companies.count()`.
3. **Verify US regression.** Full pytest suite + one manual e2e login + Balance Sheet render on the preview.
4. **Ship.** Deploy to production. Zero user-visible change; every US company continues to behave identically.

**Rollback plan**: Revert the deploy. The three new company fields are ignored by the previous code (extra fields don't break Pydantic reads with `extra="ignore"`, and Mongo doesn't care). The backfill migration itself is not reverted — leaving `region: "US"` on every doc is a no-op.

---

## 7. Acceptance criteria (Phase 0 sign-off)

- [ ] `db.companies.count_documents({"region": {"$exists": True}})` equals total company count after backfill.
- [ ] Creating a new company through the existing UI produces a doc with `region: "US"`, `currency: "USD"`, `date_format: "MM/DD/YYYY"`.
- [ ] Full pytest suite green.
- [ ] `fmtMoney(1234.5)` and `fmtMoney(1234.5, "US")` return the identical string (`"$1,234.50"`) — no regression for callers that omit the region argument.
- [ ] `t("balance_sheet")` returns `"Balance Sheet"` even when `regions.uk_enabled = true`, because the UK string map is still empty in Phase 0.
- [ ] Superadmin can flip `regions.uk_enabled` globally via a Mongo write; the flag reads through in < 10 seconds cluster-wide.
- [ ] No production endpoint's response shape *removes* any field; only new optional fields are added.

---

## 8. Effort estimate

| Task | Hours |
|---|---|
| Data model + backfill + tests (§3, §4.1, §4.2) | 6 |
| `regions.py` + `i18n.js` + `featureFlags.js` scaffolding (§4.1, §5.1) | 6 |
| Region-aware `fmtMoney` / `fmtDate` (§5.2) | 3 |
| `useCompany()` context expansion + `list_companies` payload (§5.2, §4.2) | 3 |
| Regression testing + testing-agent-v3 run | 6 |
| Deploy + prod smoke test | 2 |
| **Total** | **~26 hrs (3–4 dev-days, buffer to 1 week)** |

---

## 9. What Phase 1 unlocks (preview)

Once Phase 0 lands, Phase 1 (2 weeks) becomes purely additive:
- Populate `STRINGS.UK` in `i18n.js`
- Add a `UK_COA` block to `seed.py` and branch on `region` in `create_company`
- Add the region dropdown to the New Company modal
- Add a company-settings toggle (superadmin-visible only, until we're confident)
- Sweep every `fmtMoney(x)` → `fmtMoney(x, region)` via ESLint codemod
- Flip `regions.uk_enabled = true` for beta UK customers

Zero more schema migrations needed after Phase 0.

---

## 10. Open questions for you

1. **Where should the region dropdown live in Phase 1?** — inside the existing New Company modal (simpler), or as a separate onboarding step (more prominent, better UK-first experience)? My vote: existing modal, sensible-default US, small "Region" pill on Company Settings for later changes.
2. **Currency mismatch policy** — if a UK company invoices a US customer in USD, do we store the invoice in GBP with FX conversion, or in USD and translate on report? Xero does the latter. Recommend we follow suit but confirm with a UK accountant in Phase 1.
3. **Testing plan for HMRC readiness (Phase 2)** — do you already have UK accountants who could be design partners for the MTD sandbox certification, or should I include finding them as a Phase 1 deliverable?
