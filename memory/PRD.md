# Axiom (Enterprise AI Accounting SaaS) — PRD

## Original problem statement
Build an enterprise-level AI accounting SaaS software. Features include manual/auto transaction management, AI categorization, Plaid/Veryfi integration, white-labeling, 3-tier branding cascade, Partner roles with scoped data, and QBO bi-directional sync. Complete 1:1 report parity (Accrual & Cash basis) between Axiom and QuickBooks Online, fixing mapping discrepancies, missing transaction types, and deploying a multi-company backfill to correct historical data drift.

## Personas
- **Superadmin** — platform owner (michael@bigsaas.ai, admin@axiom.ai)
- **Pro / Accountant** — firm CPA managing many client books (pro@axiom.ai)
- **Partner** — reseller with white-labeled sub-brand (partner@axiom.ai / AxiomPartners)
- **Client** — small-business owner viewing their own books (client@axiom.ai, client2@axiom.ai)
- **UK Demo user** — non-US persona (demo-uk@smartbooks.ai)

## Key Architectural Concepts
- **GL-as-source-of-truth**: For QBO-connected companies, `qbo_gl_lines` (raw QBO GL, dual-basis) drives every summary report for 1:1 parity. Legacy entities (`transactions/invoices/payments/bills`) only power drill-downs.
- **3-tier branding cascade**: Enterprise → Partner → Company overrides.
- **Preview → Prod hydration**: Real prod companies are cloned into preview with `id` suffix `-preview-clone` (Emeral Coast, BM QBO 2, Nicole Pettyjohn).

## What's Implemented (as of 2026-02)
- **Class-Sliced Reports + QBO Class Read-Sync (2026-02)** — Two Phase 2 follow-ups shipped together.
   • **Class filter chip on Reports**: P&L / BS / Cash Flow endpoints now accept `?class_id=<id>` and slice their signed-balance query through the same class filter the rollup uses. Backend: `compute_income_statement` / `compute_balance_sheet` / `compute_cash_flow` gained an optional `class_id` kwarg threaded down to `_signed_balances` (transactions layer) and native cash-flow txn query. Cache key includes class so switching classes doesn't blow the un-filtered cache. Frontend: `ReportView.jsx` adds a "Class" select next to the basis toggle, only rendered when `features.classes_enabled` AND the current report is one of the three — with a "clear" affordance and URL param persistence via `useSearchParams`.
   • **QBO Class Read-Sync**: `_flatten_lines` and `map_journal_entry` now capture `ClassRef` on every imported line as `qbo_class_id` + `qbo_class_name`. New module `qbo_class_sync.py` runs a two-pass resolver: (1) walks every doc under a company and mints an Axiom `classes` row per unique QBO class (case-insensitive name match to adopt existing manual rows, `source="qbo"` + `qbo_id` stamped), (2) stamps `class_id` on the parent doc (first-line rule, matches QBO's own P&L-by-class rollup) and per-line on `journal_entries.lines[i].class_id`. Auto-runs at the end of `run_migration()` — silent, non-blocking. Manual re-trigger via `POST /api/companies/{cid}/classes/sync-qbo` for companies migrated pre-Feb-2026.
   • Regression: 7 new pytest scenarios (4 QBO class sync + 3 class-sliced reports) in `tests/test_qbo_class_sync.py` and `tests/test_class_sliced_reports.py`. All 19 advanced-features tests pass end-to-end.
- **Advanced Features — Phase 2: Classes UI (2026-02)** — First user-visible advanced feature. Backend: `PATCH /api/companies/{cid}/features` for flag flips, full `classes` CRUD (`GET/POST/PATCH/DELETE /api/companies/{cid}/classes[/{id}]`) with case-insensitive name uniqueness, 1-level parent nesting cap, soft-delete + guarded hard-delete (blocks when any txn / JE line / doc references the class), and `TransactionUpdate.class_id` (+ project/phase) with empty-string-clears-to-null semantics. Frontend: (1) new **Advanced Features** tab in Settings with per-flag toggle rows + coming-soon states for Projects & Budgets, (2) new `/accounting/classes` page with quick-add, inline rename, archive/restore, hard-delete, and a "Classes aren't enabled yet" empty-state on deep-link, (3) new "Classes" sidebar entry gated by `features.classes_enabled` via the existing `advancedOnly`-style filter, (4) per-txn class dropdown inside the rollup drawer (only rendered when the flag is on — zero clutter for companies that don't use classes). `useCompany()` now exposes `classesEnabled` / `projectsEnabled` / `budgetsEnabled` boolean shortcuts. Regression: 5 pytest scenarios in `tests/test_classes_crud.py`.
- **Advanced Features Foundation — Phase 1 (2026-02)** — Invisible foundation for Classes / Projects / Budgets. `companies.features` sub-doc with three OFF-by-default flags (`classes_enabled`, `projects_enabled`, `budgets_enabled`). New collections skeleton: `classes`, `projects`, `project_phases`, `budgets`, `budget_lines`. All nullable FKs (`class_id`, `project_id`, `phase_id`, plus `qbo_legacy_tags` for 2028-sunset Tags capture) added to `transactions`, `invoices`, `bills`, `payments`, `receipts`, `estimates`, and `journal_entries.lines`. Sparse indexes on every FK, plus a unique `(budget_id, account_id, period_key)` index. `reports.py::_signed_balances` gains optional `class_id` / `project_id` filters (default None → zero query cost change). Startup hook backfills `features` on legacy companies. See `/app/backend/advanced_features.py` for the full taxonomy. Regression: 7 pytest scenarios in `tests/test_advanced_features_phase1.py`.
- **Industry Template Switch + Safe CoA Cleanup (2026-02)** — During onboarding a user can switch industry templates and the CoA now adjusts safely.
   • `POST /api/companies/{cid}/industry-template` extended: `dry_run=true` returns `{would_add, would_remove, blocked_remove}`; `confirm_cleanup=true` seeds new + removes old.
   • Every seeded account is stamped `seeded_by_industry=<slug>` so future switches can distinguish template-seeded rows from manually-added ones. Codes in the new template that pre-existed unstamped get back-filled on save.
   • Removal is strictly scoped: only accounts stamped for the OLD industry AND absent from the NEW template AND unreferenced by any transaction/JE line/rule. Manually-added and referenced accounts are always preserved (returned in `blocked_remove`).
   • Company doc gains `industry_selected_at` timestamp alongside `industry_template`.
   • Frontend `IndustryTemplatePicker` shows a confirmation modal listing add/remove/kept before committing. Additive path unchanged when there is no prior template.
   • Regression tests: 4 scenarios (first pick stamps, switch removes industry-only, in-use accounts blocked, manual accounts never touched) in `tests/test_industry_template_switch.py`.
- **Global Contact Directory shipped (2026-02)** — Curated 5,221 well-known merchants across 15 verticals via Claude, merged with specificity-wins conflict resolution (258 conflicts auto-resolved), and integrated as a new tier in the Standard+ cascade. Data lives at `/app/data/global_directory/merged/global_contact_directory.json`. New module `backend/global_contact_directory.py` loads 19,896 aliases into memory at boot for O(1) lookup with prefix support for memo-suffix noise (e.g., `STARBUCKS #1234 SEATTLE WA` → Starbucks). `contact_resolver.py::resolve_contact` and `resolve_contacts_batch` now check the directory on tenant-miss, mint contacts under CANONICAL names (dedupes "Starbucks Coffee" vs "Starbucks"), and attach `logo_url` (Clearbit) + `linked_semantic` at creation. `plaid_connect.py` stamps `category_hint_semantic` + `category_hint_source` on the txn. `standard_plus_categorizer.py` reads the hint as Stage 2 of the cascade — placed AFTER the 485 hand-tuned Global Vendor Rules (rule wins on Home Depot/Kroger/etc. where the hand-tune is more SMB-appropriate) but BEFORE Plaid PFC (broad tail coverage). Provenance UI dot: violet for `standard_plus_directory`. 53 regression tests pass including rule-beats-directory and directory-fires-when-no-rule.
- **AI-First (Beta) Retired (2026-02)** — Removed the failed AI-First pipeline. Zero companies were on `ai_first` mode at removal. Deleted `ai_first_categorizer.py`, `test_ai_first_clustering.py`, and the `/companies/{cid}/ai-first/categorize-batch` endpoint. Tightened the categorization-mode validator to accept only `standard | standard_plus`. Removed AI-First branches from `sync_tasks.py` and `statements.py`. Removed the AI-First radio option from Settings. Historical rows tagged `categorization_source == "ai_first*"` still render on the Transactions page with a neutral "(legacy — retired)" provenance label so no data appears broken. Defensive DB sweep normalized any `categorization_mode: ai_first` companies to `standard` (0 affected). End-to-end verified: `POST /categorization-mode {"mode":"ai_first"}` → HTTP 400, `standard_plus` → HTTP 200, old endpoint → HTTP 404.
- **Standard+ Phase 2e — Name-First Semantic Resolution (2026-02)** — P0 fix for the "Domino's in Insurance" bug. Standard Plus LLC had a non-standard CoA where `6400 = Insurance` (not Meals). The old code-first resolver blindly translated semantic "meals" → code 6400 via the generic template map, landing Domino's in Insurance. Rewrote resolution to **name-first**: `SEMANTIC_TO_NAME_PATTERNS` (28 semantic keys, ordered most-specific-first) is scanned against the company's actual CoA account names; only when no name pattern matches does it fall back to code-based lookup. New helper `global_vendor_rules.resolve_semantic_to_account(semantic, accounts, template)` returns the actual account dict. `standard_plus_categorizer.py` now calls this instead of the old `code_to_acct[match["account_code"]]` lookup. 8 new regression tests in `tests/test_standard_plus.py::TestSemanticNameFallback` including the exact Domino's-on-swapped-CoA scenario. All 38 Standard+ tests pass.

- **Plaid Delayed Backfill Poller (2026-08-26)** — Fixes a P0 where freshly-linked Plaid items sometimes stalled at ~30 days of history despite `days_requested=730` being sent correctly on the link token. Root cause: Plaid's `/transactions/sync` returns only the currently-cached window at connect time (~30 days), and in the newer sync-mode webhook flow the follow-up `SYNC_UPDATES_AVAILABLE` webhook that carries the backfill may fire once or not at all. Fix: after `/onboarding/plaid/import` succeeds, enqueue a self-scheduling `plaid_delayed_backfill_sync` task that re-runs `_run_sync` at +30s, +2m, +5m, +15m, +30m per item. Stops early when we've reached the requested `import_start_date` floor OR a real `HISTORICAL_UPDATE` webhook stamps `historical_update_received: True`. Final attempt sends `trigger="HISTORICAL_UPDATE"` so opening-balance JEs still land even when Plaid never fires the webhook. Regression tests in `tests/test_plaid_delayed_backfill.py`. Recovered stuck company AI First 2 LLC from 89 → 1980 txns (18 months) via manual replay.
- **AI-First Speed Bundle + Cluster Categorization (2026-08-26)** — Rebuilt `ai_first_categorizer.py` around Puzzle's cluster-then-propagate pattern PLUS the three highest-ROI performance dials.
- **Standard+ Beta Categorization Pipeline (2026-08-26)** — Third categorization mode alongside Standard and AI-First. Approach borrowed directly from Puzzle/Ramp/Brex: deterministic Global Vendor Rules layered over the untouched Standard cascade.
- **Standard+ Phase 2 — Plaid PFC → Semantic Fallback (2026-08-26)** — Extended Standard+ cascade with a second stage that reads Plaid's Personal Finance Category taxonomy (~104 canonical categories that Plaid attaches to every transaction).
- **Standard+ Phase 2b — Amount-Bucket Rules (2026-08-26)** — Closed the last real accuracy gap between Standard+ and Standard on ambiguous merchants. Same design pattern as AI-First's clustering: rules can now declare per-bucket (`s` / `m` / `l` / `xl`) semantic + confidence overrides, so `$8 Costco → Meals @ 0.75` and `$850 Costco → Supplies @ 0.75` are treated as different categorization decisions with zero LLM cost.
- **Standard+ Phase 2c — Tenant Priority Guard (2026-08-26)** — Fixed a correctness bug where the Global 485 rules could silently clobber per-tenant customizations. Now Standard+'s post-hook checks each row's `ai_source` and skips override when Standard already applied a customer-specific rule (`ai_source == "rule"`) or a hit from the customer's own merchant memory (`ai_source == "memory"`). Priority stack now enforced: `Tenant Custom > Tenant Rules Miner > Tenant Merchant Cache > Global 485 > Plaid PFC > LLM`. New `skipped_tenant_priority` stat exposed on the API response. Regression tests in `tests/test_standard_plus.py::TestTenantPriorityGuard` (3 tests: rule wins, memory wins, LLM-sourced overridable). Standard LLC benchmark unchanged (zero rows had tenant-priority sources to begin with).
- **Standard+ Phase 2d — Retroactive Re-categorize UI (2026-08-26)** — When a user flips a company to Standard+ mode, they can now retroactively apply the Global Rules + PFC fallback to every existing transaction with one click. Prior to this, flipping the mode toggle only affected new incoming rows.
- **Provenance Dots on Transactions (2026-08-26)** — Layer 1 of the Rule Provenance UX. Small 4px colored dot beside each transaction's category on the Transactions page indicating which tier of the cascade decided the answer. Hover tooltip shows the full breakdown: source label · matched pattern · semantic key · amount bucket · confidence.
   • Color mapping: emerald = tenant's own decision, blue = Standard+ Global Rule, cyan = Plaid PFC, amber = LLM guess, gray = unknown.
   • **Toggled off by default** via new `companies.show_categorization_source_badges` field (Settings → "Show categorization source badges" checkbox). Advanced-CPA UX — hidden from end-users who prefer clean books until they opt in.
   • Reads both new-style (`categorization_source`) and legacy (`ai_source`) fields so all three categorization modes (Standard / AI-First / Standard+) render correctly.
   • Backend: `show_categorization_source_badges` added to `_ALLOWED_UPDATE_FIELDS` on `PATCH /companies/{cid}`. Curl-verified round-trip.
   • Files: `frontend/src/components/ProvenanceDot.jsx` (new), `AIFirstControls.jsx` (added toggle component), `Transactions.jsx` (added conditional render + flag fetch on mount).


   • Backend: `POST /companies/{cid}/standard-plus/apply-rules` now accepts `{"all": true}` and internally fetches every txn ID for the company (no need for the frontend to pre-fetch and post a 2,000-item array).
   • Frontend: new `StandardPlusApplyButton` component in `AIFirstControls.jsx` — only visible when mode == `standard_plus`. Confirmation modal explains behavior (idempotent, tenant-priority-safe). Toast on success reports scanned/overridden/rule/PFC/preserved counts.
   • Curl-verified on Standard LLC: 1,983 scanned, 1,824 matched (1,129 rule + 695 PFC), 1,803 overridden, 0 tenant priority conflicts.




   • **Buckets** (mirror AI-First): `<$50` = s, `$50-500` = m, `$500-5000` = l, `$5000+` = xl. `amount_bucket()` helper uses `abs(amount)` so refunds bucket correctly.
   • **21 merchants upgraded** to amount-aware: Walmart, Wal-Mart, Costco (whse/wholesale/generic), Sam's Club, BJs, Target, Amazon.com, Amazon Marketplace, AMZN MKTP, Home Depot, Lowe's/Lowes, Best Buy, Apple Store, 7-Eleven, Wawa, Sheetz, Circle K, CVS Pharmacy (both spellings), Walgreens, Rite Aid, Duane Reade.
   • **Live benchmark** on Standard LLC's 1,983 rows: 417 rows now resolved by amount-aware rules; deterministic backing steady at 91%; needs_review dropped slightly (1,401 → 1,384) as some buckets resolve above the 0.75 trust threshold; zero LLM cost added.
   • Every categorization now stamps `rule_matched` + `bucket` for auditability — CPA can see exactly which cell of the rule table drove the decision.
   • Regression tests in `tests/test_standard_plus.py::TestAmountBucketRules` (8 tests: small→meals, large→supplies, Home Depot construction override, absolute-value bucketing, no-amount fallback, gas station split, bucket cutoff parity with AI-First).


   • **`pfc_semantic_map.py`** — maps every Plaid PFC detailed key (FOOD_AND_DRINK_COFFEE, TRAVEL_LODGING, LOAN_PAYMENTS_CREDIT_CARD_PAYMENT, etc.) to the same semantic keys used by Global Vendor Rules. Template-aware resolution via `resolve_semantic` gives industry-specific account codes for free.
   • **Confidence tiering**: Plaid's `confidence_level` field → 0-1 float (VERY_HIGH→0.90, HIGH→0.85, MEDIUM→0.70, LOW→0.55, UNKNOWN→0.65). Feeds the same tri-state gate used elsewhere.
   • **Priority in cascade**: Merchant rule beats PFC (rules are more specific and higher-confidence). Only rows where Global Rules didn't match consult PFC.
   • **Ingest plumbing**: `plaid_connect.categorize_and_insert_plaid_txns` now also persists `pfc_confidence_level` on each txn (already had `pfc_detailed` + `pfc_primary`) so the fallback stage sees Plaid's actual confidence.
   • **Live benchmark** on Standard LLC's 1,983 rows: coverage jumped from **56% → 91% deterministic backing** (1,108 rule matches + 695 PFC matches = 1,803 rows). Uncategorized still at 90 rows (5%) — same as before because PFC doesn't reduce uncategorized further, it just replaces Standard's category with a more precise one on more rows. Zero LLM calls added.
   • Regression tests in `tests/test_standard_plus.py::TestPfcFallback` (6 tests: PFC resolution, confidence mapping, unmapped PFC skip, rule-beats-PFC ordering, PFC-fallback end-to-end).
   • Phase 3 backlog: MCC code cross-reference, industry-specific rule variants (Home Depot → COGS for construction), vector-similarity fallback (Mongo Atlas Vector Search).


   • **`global_vendor_rules.py`** — v1 draft of 485 curated US merchants (coffee, QSR, sit-down, delivery, rideshare, airlines, hotels, rental cars, gas stations, big-box, home improvement, grocery, pharmacy, office/tech, SaaS, payroll, payment processors, credit-card issuers, bank fees, telecom, utilities, insurance, mortgage/car loans, advertising, marketplace fees, shipping, gov/taxes, streaming, gyms, ACH keywords). Semantic-key indirection (`meals`, `software_saas`, `utilities`, `loan_payment`, etc.) → per-template account-code mapping so the same rule works across generic / professional_services / restaurant / ecommerce / construction.
   • **`standard_plus_categorizer.py`** — post-hook that runs after Standard's cascade completes on inserted rows. Tri-state confidence gate identical to AI-First: `≥0.75` apply + `needs_review=False`, `0.50–0.75` apply + `needs_review=True`, `<0.50` don't override (Standard's answer stands). Contact/AI-confidence/reasoning from Standard preserved.
   • **Routing**: three-value `categorization_mode` (`standard` | `ai_first` | `standard_plus`). Standard cascade code path is 100% untouched. Post-hooks branch in `sync_tasks._run_sync` (Plaid path) + `statements.py` (statement path) mirror each other.
   • **Frontend**: `AIFirstControls.CategorizationModeToggle` extended to a third option; `POST /companies/{cid}/categorization-mode` accepts `standard_plus`; `POST /companies/{cid}/standard-plus/apply-rules` for retroactive re-categorization; `GET /global-vendor-rules/stats` for coverage metadata.
   • **Live benchmark** on Standard LLC's 1,983 real BofA rows: 1,108 overridden by rules (56% coverage), Uncategorized dropped 201 → 90 (-55%), runtime <2 seconds, cost $0. Decisively beats both Standard alone and AI-First on every real metric.
   • Regression tests in `tests/test_standard_plus.py` (13 tests: match ordering, tri-state confidence, template fallback, missing merchant handling, override behavior).
   • Phase 2 backlog: Plaid PFC → CoA mapping, MCC code cross-reference, industry-specific rule variants, vector-similarity fallback (Mongo Atlas Vector Search).


   • **Cluster-based propagation**: Group by `(canonical_merchant, amount_bucket, direction)`. Only ONE representative per cluster hits the LLM; results propagate to every sibling above `_PROPAGATE_MIN_CONFIDENCE = 0.75`, else the cluster is flagged needs_review together. Amount buckets prevent Costco-food-court-vs-bulk-supplies cross-contamination; ACH/wires/checks are forced to solo clusters. Real benchmark on AI First 2 LLC's 1591 rows: **3.0x compression** (1591 → 537 clusters).
   • **`_LLM_CONCURRENCY = 24`** (was 8) via `asyncio.Semaphore` — 3x wave-count reduction.
   • **`_REPS_PER_LLM_CALL = 60`** (was 30) — 2x fewer round-trips per chunk.
   • **Anthropic prompt caching** via LiteLLM structured system-block with `cache_control: ephemeral` on the CoA + contacts + few-shots (easily >1,024 tokens). Live-verified: **46% latency drop** on cache-hit calls, matching Anthropic's documented ~50%. Universal-key routing preserved via emergentintegrations' `initial_messages` pass-through.
   • Combined impact on the AI First 2 LLC 1591-row scenario: **~60 min serial → <60 seconds** (60x+ speedup) with no accuracy compromise. Standard-mode pipeline untouched.
   • Regression tests: 14 new unit tests in `tests/test_ai_first_clustering.py` cover canonicalization, amount bucketing, cluster grouping, high/low-confidence propagation, and unclusterable-solo handling.

- **Plaid Backfill Poller — Durable + Semaphore-Safe (2026-08-26)** — Replaced the initial (buggy) `plaid_delayed_backfill_sync` job-queue task with a two-part scheduler:
   • `schedule_plaid_backfill_poll(company_id, item_id, attempt)` persists `next_backfill_poll_at` + `next_backfill_poll_attempt` on the `plaid_items` doc, then spawns a fire-and-forget `asyncio.create_task` timer. Sleeps happen OUTSIDE the job-queue semaphore — critical at scale, because holding one of the 20 per-pod slots while sleeping 30 min would cause priority inversion at 1,000+ concurrent onboardings.
   • `reconcile_pending_backfill_polls()` scans the plaid_items collection at backend startup and re-arms every pending timer with the correct remaining delay. Sparse index on `next_backfill_poll_at` keeps the scan O(pending) even with 1M items.
   • The actual sync work still routes through `enqueue_job("plaid_manual_sync", …)` so the sync semaphore protects real work only.
   • Chain: +30s / +2m / +5m / +15m / +30m. Stops early on `historical_update_received: True` or when the requested `import_start_date` floor is reached. Final attempt stamps `webhook_code="HISTORICAL_UPDATE"` so opening-balance JEs still land when Plaid never fires its own webhook.
   • Regression tests in `tests/test_plaid_delayed_backfill.py` (4 tests: persist+timer, past-max no-op, reconciler re-arm, malformed date resilience).




- **Multi-Account Combined Statement Fan-Out (2026-08-25)** — A single Veryfi bank-statement that lists MULTIPLE accounts on one PDF (Wells Fargo Combined, Amex Blue + Gold, Chase Checking + Savings, etc.) is now handled correctly.
   • Detection: When `veryfi_data.accounts[]` has 2+ entries and no explicit `account_id` was pinned, `_process_veryfi_result` fans out to `_fan_out_multi_account` instead of flattening.
   • Per-account child rows: The current import becomes a PARENT (`is_multi_account=True`, `is_multi=True`) and each account gets its own child `statement_imports` row with a synthetic single-account sub-doc via `veryfi_service.iter_statement_accounts`. Each child runs the full existing pipeline unchanged — resolver, OCR guards (Layers 1–4), Layer 3 reconcile against its OWN per-account totals, OBE JE, auto-recon, categorization.
   • New helper: `veryfi_service.iter_statement_accounts(veryfi_doc)` returns `[{account_ref, lines}]` — one entry per account, or a single entry for legacy/single-account shapes. Regression tests in `tests/test_multi_account_statement.py`.
   • UI: Parent renders with a `multi · N` badge and children indent with `↳` — same visual treatment as the splitter parent/child rows.

- **Veryfi Multi-Statement Splitter (2026-08-25)** — Support for combined-PDF or `.zip` bank-statement uploads via Veryfi's `/api/v8/partner/bank-statements-set` async endpoint.
   • UI: `☐ This file contains multiple separate statements` checkbox in the pre-check modal (default OFF, auto-ON for `.zip`). Copy explicitly warns NOT to use for combined-account statements — those are auto-handled by the new fan-out.
   • Backend: `statements.upload_statement_multi()` posts to splitter, creates a parent `statement_imports` row with `status='splitting'`. Returns immediately.
   • Webhook: `POST /api/webhooks/veryfi/bank-statement-set` (public, HMAC-SHA256 verified via `VERYFI_CLIENT_SECRET`) fetches each child `document_id` and runs `_process_veryfi_result()` per child. Children of the splitter can themselves be multi-account statements and fan out again automatically.
   • Refactor: Extracted post-Veryfi logic in `upload_statement()` into `_process_veryfi_result()` so sync + splitter + multi-account paths all share the same pipeline.


- Phase 2 hybrid QBO migration with dual-basis GL pull (`qbo_gl_lines`).
- Report engine reads directly from GL for QBO companies; legacy `_signed_balances` for native/Plaid.
- Superadmin GL Lab (`/admin/qbo-gl-lab`) for parity spot-checks.
- Date-range preset picker across P&L, BS, Cash Flow, GL.
- QBO Reconciliation panel with CSV export + auto-refresh.
- Full backfill endpoint (`POST /api/admin/qbo/full-backfill`) with per-company parity output.
- **Preview DB cleanup (2026-08-23)** — purged 945 test companies + 248 orphan users + 22 test enterprises. Backups in `/app/backups/`.
- **Native document JE posting (2026-08-23)** — `posting_service.py` now auto-posts double-entry JEs on:
   invoice create/update/delete, bill create/update/delete, payment (in/out) create/update/delete,
   sales receipt create/update/delete, estimate → invoice conversion, and PO → bill conversion.
   Cascade helpers in `link_cascade.py` and `transactions.py::_reverse_and_delete_payment` also
   reverse the JE so orphan ledger legs can't survive a cascade delete. Reports engine gated on
   `posted: True` to prevent double-counting. Native Accrual Balance Sheet now balances
   (Assets = L + E) end-to-end. Includes:
   - Type-scoped `_resolve_account` (was accidentally matching "Sales Tax Payable" for revenue).
   - Cash-basis filter for `auto_accrual` JEs (invoice-at-issue only recognizes on accrual).
   - `auto_cash` tag on receipt JEs so cash-basis P&L still surfaces sales receipts.
   - QBO-sourced docs defensively skip local JE posting (they use the GL / synthesis path).
   - Backfill script `scripts/backfill_document_jes.py` re-postable across all doc types.
- **QBO Recon 5-column overlay (2026-08-23)** — Reconciliation panel on BS + P&L now
   renders `Line | Official QBO | Imported QBO | + Native | Our Report | Δ vs QBO`.
   Backend adds an `imported_only=true` query param on the report endpoints that returns
   the GL-only slice. Legend cards show 3 trust KPIs (migration parity / native
   adjustments / unattributed drift) + filter toggles (All rows / Migration drift only /
   Native adjustments only). CSV export mirrors all 5 columns. Verified on
   Test QBO 431 LLC: `Imported = Official` (green ✓ across every row), `+Native = +$50k`
   on A/R fully attributes the drift, `Unattributed = $0`.
- **QBO + Native additive overlay (2026-08-23)** — `_signed_balances` on QBO-connected
   companies now layers native activity (invoices/bills/JEs/txns created in Axiom
   post-migration) on top of `qbo_gl_lines`. `_superseded_by_gl_ids` prevents double
   counting for docs that have been mirrored back to QBO. `_open_ar_ap` filters
   `source='qbo'` when GL data exists. Every doc counts exactly once in exactly one lane.
- **Deposit guard + UF safety net (2026-08-23)** — `merchant_cache.categorize_with_cache`
   force-routes every positive-amount Plaid txn to `4999 Uncategorized Income` (with
   `needs_review=true`) unless a deterministic rule matches (Interest, Bank Fee reversal).
   The LLM is never asked to guess an income account. Belt-and-suspenders post-LLM override
   refuses any account whose `detail_type=money_in_transit` for a bank-feed txn. Historical
   sweep on Plaid Test LLC re-routed 8 mis-categorized DDA→DDA deposits to 4999; UF is no
   longer negative and BS now balances. Rules Miner also blocks learning rules that target
   `4999 / 6999 / money_in_transit` so bad historical patterns can't get codified.
- **Balance Sheet parent drill-down fix (2026-08-25)** — `reports.compute_account_detail`
   now walks `parent_account_id → id` breadth-first to include every descendant sub-account
   in the transaction query. Clicking a parent row on the BS ("Business Checking +1 sub")
   surfaces the roll-up transactions instead of showing an empty "No transactions" page.
   Sub-account clicks still stay scoped to their own id (no upward leak). Regression test
   at `tests/test_account_drilldown_parent_sub.py`.

## Explicitly Declined (do not resurface without user approval)
- **Multi-account fan-out for combined statements** (server-side PDF page-range splitter,
   "Option 2" from the Aug 25 discussion). User accepts that combined statements Veryfi
   can't split automatically will be handled by manual pre-upload PDF splitting.
- **False-RECONCILED status bug** (auto-recon marking as RECONCILED when |diff|>$0.01).
   Known behavior; not fixing.
- **Layer 6 OCR defense** (detect `account_numbers` plural mismatch and refuse auto-recon).
   Not building; workflow is manual PDF split when Veryfi conflates accounts.

## Prioritized Backlog

### P0 — In progress
- (none active)

### P0 — Awaits user action
- (none — Emeral Coast re-auth dropped 2026-08-23; parity gap accepted as-is on prod)

### P1
- QBO Piece 2: AI Merchant → Contact match (removes "?" placeholders)
- Recon panel label alias map (Advertising ↔ Advertising & Marketing)
- Enterprise WL self-service toggle
- PDF export on QBO Reconciliation panel
- Real-time inbound webhooks for QBO (Phase 4)
- `_signed_balances` rewrite to Mongo `$group` aggregation
- AI rule confidence sort on Rules page (sort miner rules by `mined_confidence` DESC)
- **Runtime Rules Precedence** — wire `db.rules` into `merchant_cache.categorize_with_cache` as Step 0 (before static merchant_rules → cache → PFC → LLM), so user-created rules from the Rules page apply to incoming Plaid txns instead of only retroactively via `apply_to_existing`. ~20-line change + Mongo index on `(company_id, match_type, match_value)`. Discovered 2026-08-23 during rules-flow audit.

### P2
- Dead OAuth orphans cleanup (`qbo_connections` for deleted companies)
- Set-Password page design polish (lockup / accent color)
- Restaurant Vertical foundation (locations, multi-loc reports, feature flags)

### P3 / Backlog
- QBO Attachable file downloads
- Background auto-pull polling
- Native `.IIF` QBD import
- Transaction CSV import in Transactions page (paused)

## Preview Cleanup Scripts (2026-08-23)
- `/app/backend/scripts/purge_test_companies.py` — deletes non-protected companies + child rows across 52 collections
- `/app/backend/scripts/purge_orphan_users_enterprises.py` — initial orphan cleanup
- `/app/backend/scripts/purge_final_pass.py` — email-pattern-based user purge (STOP backend before running to avoid Firm Books auto-reseed loop from `enterprises.py:307`)

## Notes for Future Prod Cleanup
Before running any cleanup on prod, add to protected set:
- Enterprises: **CypherPro, Aquila Tax Services, ProactiveBooks**
- Partners: **Partner, ScarlettBooks**
- All companies inside them + their users
