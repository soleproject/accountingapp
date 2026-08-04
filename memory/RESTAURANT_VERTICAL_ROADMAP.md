# Restaurant Vertical Roadmap

**Status:** Confirmed scope. No code yet. Ready to kick off implementation in a new session.
**Owner:** Michael (solo builder + AI agent)
**Target:** Rival Restaurant365 for the SMB / single-location + small multi-location segment.
**Pricing:** $150–350/month per location.

---

## 1. Product Strategy

### Positioning
- **Not competing with R365 head-on across all 20 modules.** Competing where R365 is weak: GAAP accuracy, UX, same-day setup, price.
- **Value prop:** "Restaurant365 quality accounting at 1/2 the price and 1/10 the setup time."
- **Target segment:** Independent restaurants (1–3 locations) + small groups (up to ~10 locations). NOT enterprise 100+ location chains (that's a different sales motion).

### Business Model
- **Restaurant tier:** $150–350/location/month depending on features (single POS = lower, multi-POS + labor + prime cost dashboards = higher).
- **Enterprise franchise pricing:** custom quote for groups above ~10 locations.
- **Free trial:** 30 days with full POS integration (proves value fast).

### Positioning vs. existing accounting product
- The base accounting product (CPA, attorney, consultant, retail) stays as-is.
- Restaurant is a **vertical toggle** on the same platform — same login, same superadmin, same white-label, same Pro-firm hierarchy.
- Restaurant customers can also use their accountant/CPA via existing Pro-firm relationships.

---

## 2. Architecture — The "Flip a Switch" Design

### 2.1 `vertical` field on `companies`
Every company gets one of:
- `"base"` (current default — CPA/attorney/consultant/service biz)
- `"retail"` (uses Tier 2 Inventory Module — already built)
- `"restaurant"` (new vertical — this roadmap)
- `"dental"`, `"real_estate"`, `"medical"`, `"legal"`, ... (future verticals)

### 2.2 `vertical_config` sub-document
Vertical-specific settings scoped to the company:
```
{
  pos_provider: "toast" | "clover" | "square" | "manual",
  default_location_id: "loc-xyz",
  tip_pool_policy: "individual" | "pooled" | "tip_credit",
  labor_target_pct: 30,
  food_cost_target_pct: 30,
  prime_cost_target_pct: 60,
  restaurant_type: "qsr" | "full_service" | "bar" | "coffee" | "food_truck" | "ghost_kitchen"
}
```

### 2.3 Feature flag registry
Central `FEATURE_FLAGS[vertical]` dict controlling:
- Sidebar/nav items visible
- Dashboard widgets shown
- Reports available
- Onboarding wizard branches
- API endpoints exposed (some restaurant endpoints 404 for base users)

### 2.4 What's shared across ALL verticals (code reuse)
- Ledger engine (`insert_je`, `ledger_transaction`, atomic writes)
- Bank reconciliation, Plaid sync, statement imports
- Base AR/AP schemas + workflows
- Reports foundations (BS, IS, GL, TB math)
- Tax mapping, close periods, audit log
- White-label, Stripe billing, superadmin, Pro-firm hierarchy
- AI categorization, Insights Chat, cleanup review, Veryfi OCR

### 2.5 What's restaurant-specific
- Restaurant CoA template (NRA standard 4-digit accounts)
- Multi-location primitives (already have `enterprises`, add `locations`)
- POS integrations (Toast, Clover, Square)
- Daily Sales Journal auto-generator
- Sales-category-aware reporting
- Recipes/BOM (P1)
- Prime Cost Dashboard
- Tips management (pool, credit, reporting)
- Labor tracking (P1)
- Restaurant-specific vendor list (Sysco, US Foods, PFG, Restaurant Depot)

---

## 3. Data Model Additions

### New collections
```
locations {
  id, company_id, name, address, timezone,
  pos_provider, pos_credentials_ref,
  opening_hours, sales_tax_rate, liquor_license,
  created_at, updated_at
}

pos_daily_summaries {
  id, location_id, company_id, date (YYYY-MM-DD),
  net_sales, gross_sales, discounts, comps, voids,
  sales_by_category: {food, beer, wine, liquor, non_alc, retail, other},
  payment_by_method: {cash, credit_card, debit, gift_card, ach, house_account},
  tips: {credit_card_tips, cash_tips, tips_pooled, tips_direct},
  labor: {hours, cost, employee_count},   // populated if POS has labor module
  sales_tax_collected,
  raw_pos_payload,   // full JSON from POS for audit
  journal_entry_id,  // link to auto-created JE
  reconciled_at, reconciled_by
}

recipes {              // P1 — not v1
  id, company_id, menu_item_id, name,
  ingredients: [{item_id, qty, unit, cost_at_time}]
}

pos_integrations {
  id, company_id, location_id, provider,
  oauth_token_ref, refresh_token_ref, expires_at,
  webhook_secret, last_sync_at, sync_status
}
```

### Existing collections — added fields
```
companies:
  + vertical: "restaurant"
  + vertical_config: {...}

enterprises (already exists — lean into it):
  + brand_type: "restaurant"
  + parent_brand: (nullable — for franchisor > franchisee hierarchy)
```

---

## 4. Feature Priority List

### P0 — v1 MVP (must ship together for a credible product)
1. `vertical` field + feature flag scaffold
2. `locations` collection + multi-location scoping across all reports
3. Restaurant CoA template (NRA standard) + onboarding wizard branch
4. **Square POS integration** (start here — easiest API, self-serve)
5. Manual Daily Sales Entry form (fallback for POS systems we don't yet support)
6. Daily Sales JE auto-generator (from either POS webhook or manual entry)
7. Sales-category-aware Income Statement (food/bev/liquor/retail breakout)
8. Prime Cost Dashboard (Food % + Labor % vs targets)
9. Tips management (pool tracking, tips payable liability, tip credit reporting)
10. Multi-location P&L consolidation (per-location + combined view)

### P1 — v1.5 (fast-follow after MVP launch)
11. **Clover POS integration**
12. **Toast POS integration** (parallel-track partner app from day 1)
13. Recipes/BOM linked to inventory items
14. Theoretical vs. actual food cost variance
15. Labor tracking (manual daily entry evolving to POS-integrated)
16. Restaurant-specific vendor OCR (Sysco/US Foods/PFG invoice parsing)
17. Cash management (safe counts, till reconciliation, deposit tracking)

### P2 — v2 (feature depth to widen the R365 gap)
18. Menu engineering (star/plow/puzzle/dog quadrant analysis)
19. Waste tracking + shrinkage reporting
20. Sales forecasting (ML-based)
21. Franchise royalty automation
22. Above-store analytics for multi-location groups (10+)

### P3 — DO NOT BUILD (partner instead)
- Employee scheduling → partner with 7shifts, HotSchedules, When I Work
- Time & attendance → partner with same
- Payroll → partner with Gusto, ADP (or use Emergent LLM key for calc engine v3+)

---

## 5. POS Integration Order

### Rationale for order
Chose Square first even though user's example was Toast — because Square has the easiest developer onboarding (self-serve OAuth, excellent sandbox, no partner approval) which lets us prove the daily-sales-JE flow end-to-end in weeks, not months. Toast requires a 2–4 week partner application; we file that on Day 1 but don't block on it.

### 5.1 Square (v1 — weeks 3–4)
- Public API, OAuth, developer.squareup.com
- Data pulled: orders, payments, refunds, tips, tenders, categories
- Sandbox: excellent, seed test data easily
- Approval: none — self-serve
- Complexity: LOW

### 5.2 Clover (v1.5 — weeks 7–8)
- Clover Developer Marketplace — self-serve app registration
- Data shape similar to Square
- Complexity: MEDIUM (their API has some quirks around merchant hierarchy)

### 5.3 Toast (v1.5 — weeks 9–12)
- Partner program required — file application day 1 of Sprint
- 2–4 week approval, requires business insurance, references
- Best API of the three once approved (biggest market share)
- Complexity: HIGH (approval delay, then implementation is straightforward)

### 5.4 Manual Daily Sales Entry
- Ships with v1 — needed for any POS we don't yet integrate with
- CSV import + web form
- Same daily-sales-JE generator, just fed by human instead of webhook

---

## 6. The Daily Sales Journal Entry (the killer feature)

Every day at ~4am local time per location, auto-post this JE:

```
DR Cash / Undeposited Funds        $X (from cash tender)
DR Credit Card Receivable           $X (from card tender)
DR Gift Card Redemptions            $X
DR Comp Expense                     $X (comps as expense)
DR Discount Expense                 $X
  CR Food Sales                          $X
  CR Beer Sales                          $X
  CR Wine Sales                          $X
  CR Liquor Sales                        $X
  CR Non-Alcoholic Beverage Sales        $X
  CR Retail Sales                        $X
  CR Gift Card Liability                 $X (sold, not yet redeemed)
  CR Sales Tax Payable                   $X
  CR Tips Payable — Cash                 $X
  CR Tips Payable — CC                   $X
```

**This one auto-generated JE per location per day IS 80% of restaurant accounting.**
Everything else (AP, payroll, reconciliation) uses the existing base system.

---

## 7. Multi-Location Design

- **Company** = one legal entity (e.g., "Michael's Restaurants LLC")
- **Location** = one physical restaurant (e.g., "Downtown store", "Airport store")
- **Enterprise** = brand/franchise group (e.g., "Michael's Restaurant Group" containing multiple Companies)

Reports scoping:
- Location-level P&L (default view for operators)
- Company-level P&L (consolidates multiple locations under one legal entity)
- Enterprise-level P&L (consolidates multiple companies under one brand — franchise use case)

Users get location-scoped permissions:
- Store manager → can only see their location
- Regional manager → sees multiple locations
- Owner → sees company and enterprise levels

---

## 8. Onboarding Wizard — Restaurant Branch

New question in existing wizard: **"What kind of business is this?"**

If user picks Restaurant:
1. Restaurant type? (QSR / Full Service / Bar / Coffee / Food Truck / Ghost Kitchen)
2. How many locations? (1 / 2–5 / 6+)
3. For each location: name, address, timezone
4. Which POS? (Square / Clover / Toast / Other / None yet)
   - If Square/Clover/Toast: OAuth handoff → sync last 90 days
   - If Other/None: skip to manual daily-sales-entry setup
5. Auto-seed NRA CoA (with option to customize)
6. Set targets: food cost %, labor %, prime cost %
7. Set tip policy: individual / pooled / tip credit
8. Ready → dashboard shows Prime Cost + Today's Sales

---

## 9. Implementation Timeline (realistic solo-builder + AI)

**Total: 10–12 weeks from Day 1 to public beta launch.**

### Weeks 1–2: Foundation (100% reusable across all future verticals)
- Add `vertical` field + `vertical_config` to companies
- Add `locations` collection + APIs
- Multi-location scoping on all existing reports
- Feature flag scaffold
- Onboarding wizard branch for restaurant

### Weeks 3–4: Square POS integration + Daily Sales JE
- Square OAuth flow, webhook handler, historical import
- Daily Sales JE auto-generator
- Sales-category-aware reporting
- Manual Daily Sales Entry form (fallback)

### Weeks 5–6: Restaurant essentials
- NRA CoA template + auto-seed on onboarding
- Prime Cost Dashboard (v1: manual labor entry, POS-fed food cost)
- Tips management (pool, credit, reporting)
- Multi-location P&L consolidation UI

### Week 7: Beta launch prep
- 3–5 real restaurant beta signups
- Onboard them personally, gather feedback
- Fix critical UX issues

### Weeks 8–9: Clover integration
- Clover OAuth + webhook
- Feature parity with Square integration

### Weeks 10–12: Toast integration
- (Toast partner application filed Day 1 — should be approved by now)
- Toast OAuth + webhook
- Feature parity with Square/Clover

### Post-launch: iterate based on beta feedback
- Recipes/BOM
- Labor tracking depth
- Vendor OCR tuning

---

## 10. Parallel Actions to Start Day 1

These run independently of code work — file NOW:

1. **Toast Partner Application** — apply at `pos.toasttab.com/partners`. Requires:
   - Business entity docs
   - E&O + cyber insurance ($1M minimum recommended)
   - Technical integration plan (I can help draft)
   - 2–4 week approval window

2. **Square Developer Account** — self-serve, 5 min at `developer.squareup.com`

3. **Clover Developer Marketplace** — self-serve at `docs.clover.com`

4. **Restaurant advisory list** — line up 3–5 restaurant owners willing to beta test in weeks 6–8. Ideal profile:
   - Independent (1–3 locations, not chain)
   - Currently using QuickBooks or Wave (unhappy with it) OR nothing at all
   - Willing to spend 30 min/week giving feedback for 2 months
   - In exchange: free lifetime access to restaurant tier

---

## 11. Risk & Open Questions

### Known risks
- **Toast approval could drag** — mitigation: Square + Clover carry the MVP without Toast
- **Restaurant accounting is subtle** — no domain expert on team. Mitigation: rely on NRA published standards, R365's public docs, and beta operator feedback loops
- **Multi-location adds complexity to existing reports** — must not break base accounting users. Mitigation: feature-flag every restaurant-only piece, extensive regression testing on base tenants
- **POS webhook reliability** — POS systems drop webhooks. Mitigation: nightly reconciliation sync as backup

### Open questions for future sessions
- Do we need SQL-style "franchise royalty" automation in v1, or defer to v2?
- Sales tax across multi-state locations — use TaxJar/Avalara or roll our own?
- Do we want to support pop-up/food truck locations that move addresses?
- Tips: how do we handle tip-out to bar/kitchen? (Not just tip pool)
- Bookkeeping close per location vs company — which is the atomic unit?

---

## 12. Next Session Kickoff Prompt

When starting the next Emergent chat to begin building this:

```
Continue Restaurant Vertical implementation. Read:
- /app/memory/PRD.md (full product context)
- /app/memory/RESTAURANT_VERTICAL_ROADMAP.md (this document)
- /app/memory/RAILWAY_REPLICA_SET_MIGRATION.md (recent infra state)

Start Week 1–2 work:
1. Add `vertical` field and `vertical_config` to companies collection
2. Create `locations` collection + CRUD APIs at /api/companies/{cid}/locations
3. Add multi-location scoping to reports (P&L, BS, GL) with 
   backwards-compatible behavior for base tenants
4. Create feature flag scaffold at /app/backend/vertical_features.py
5. Add "Business Type" step to onboarding wizard

Ship each item as its own PR-able commit. Full pytest coverage. 
Do NOT touch base-user code paths — everything must be additive.
```

---

**End of Roadmap. This document is the source of truth for the Restaurant Vertical build.**
