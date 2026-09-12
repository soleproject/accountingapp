# Ask-Client Email — Redesign Roadmap (from-scratch design)

**Status:** Discussion doc, not scheduled. Captured Feb 28, 2026 during a demo-prep audit of the AI ask-client scheduler.

**Owner ask (verbatim):** *"if you were to build this from scratch how would you change it? no coding only discussion"*

**Purpose:** Preserve the design thinking for the eventual v2 of the ask-client system so we don't relitigate this from scratch when we come back to it. This is the target-state architecture; the current system (see "How it works today" below) is a solid v1 but was built around a single signal (AI confidence) applied to a single unit (one txn) through a single channel (email) at a single cadence (hourly drip).

---

## How it works today (baseline, Feb 2026)

**Layer 1 — flagging (`categorizer.py`):** a txn gets `needs_review=true` if ANY of:
1. AI confidence < auto-post threshold (default 0.80, per-company configurable via `companies.auto_post_threshold`)
2. LLM's category couldn't be mapped to a real COA account
3. LLM picked a bank/cash 10xx asset account (rejected — would produce a self-cancelling JE)
4. **Meal-cap guard**: Meals/Dining/Entertainment expense > $150 (mis-tagged Uber/DoorDash catcher)
5. Internal bank-to-bank transfer (auto-flagged so a human pairs the legs)
6. Statement liability-paydown-guard (credit-card/loan paydowns must net against liability, not P&L)

**Layer 2 — email dispatch (`ai_ask_client_scheduler.py`):** sends when ALL:
- `needs_review=true`, `human_reviewed != true`, no existing `client_question_id`, `date >= today - 3 days`
- Pro's `ai_ask_client` pref is ON, client has an email, daily cap of 3/client-email not hit
- Business hours 6am–8pm America/New_York
- 72h cross-company signature cooldown on `(date, amount, counterparty)` clears
- One txn per company per hourly tick (most recent flagged wins)

**Real flaws of this design:**
- Coupling: "AI unsure" == "email client" — no cost/benefit weighing
- Drip pattern: max 3 emails/day, one per hour — worst of both worlds
- No client model (same treatment for every owner regardless of response habits)
- No learning loop from answers back into future asks (beyond payee resolution)
- Email-only channel
- Arbitrary 3-day freshness cutoff instead of close-anchored deadline
- Cross-company signature dedup is a compensating control for a duplicate-detection bug upstream in ingestion

---

## Target-state redesign — 12 changes

### 1. Replace "confidence < threshold" with a **decision impact score**
Confidence alone is the wrong trigger. Score every candidate on:
- **Materiality** — absolute $ + % of monthly volume
- **Tax impact delta** — spread between top-2 candidate categories (Meals-50% vs Office-100% is real; contract labor vs 1099 vendor is huge; two deductible-100% categories is nil)
- **Close-blocking flag** — does this txn's ambiguity prevent finalizing a period?
- **Confidence** — still a factor, just not *the* factor

Only the top-N scored txns are worth interrupting the client about. Everything else lands in a "review at close" bucket the CPA sweeps in batch.

### 2. Batch, don't drip
- **One digest per client, once per day (or their chosen cadence)**, with 1–8 grouped questions inside a single magic link
- **Vendor/trip/project grouping**: "You had 3 charges at Home Depot last week — were these all for the Miller kitchen job?" beats 3 separate emails
- **CPA batching option**: "Save these until Friday" for CPAs who prefer weekly digests

### 3. Client-adaptive routing
Learn per-client:
- **Channel preference** — response latency per channel; if a client answers SMS in 3 min and ignores email, SMS is default. Email is fallback.
- **Answer-rate throttling** — 10% responder over 30 days gets fewer + higher-priority asks; 95% responder can absorb more
- **Response-time expectation** — if median response is 5 days, don't panic and re-nudge at 24h; if median is 30 min, treat 24h as chronic

### 4. Every ask carries the AI's guess with a one-tap confirm
Instead of "What was the $180 at Ruth's Chris for?" send:
> **We think this was a client dinner with Miller Kitchens ($180 · Ruth's Chris · Nov 4)**
> [✓ Confirm] [🍴 Meals — personal] [📎 Attach receipt & tell us more]

Confirmation = one tap. AI has a hypothesis; make the client an editor, not an author.

### 5. Differentiated copy per flag reason
Distinct templates instead of one-size-fits-all:
- **Structural flag** (meal > $150, transfer, 10xx) → "Quick sanity check, we think this fits X — confirm?"
- **Unknown vendor** → "We haven't seen this vendor before — what was it?"
- **New pattern** → "First charge > $2k with this vendor — same account as before or different job?"
- **Compliance** → "This might need a 1099 — do you have a W-9 for them?"

### 6. Closed learning loop, per client
When the client answers, update:
- **Client's merchant cache** — same merchant + same amount bucket → next time auto-post
- **Categorization prior** — this client uses Meals for actual client meals, not team lunches
- **Firm-wide rule library** (CPA-approved) — if 8 clients categorize Ruth's Chris the same way, propose a firm rule

Today's `contact_learning` does part of this for payee resolution, but NOT for the categorization decision.

### 7. Kill the 3-day lookback; anchor to close
- Ambiguous txns blocking current close → ask now
- Ambiguous txns affecting future period → queue for pre-close sweep, batched
- Ancient stragglers → CPA problem, not client problem

### 8. Client-side controls (not just CPA-side)
Client should own:
- **Quiet mode / vacation** ("don't ask me until Feb 15")
- **Standing rules** ("anything < $50 at 7-Eleven → Meals, don't ask again")
- **Channel & cadence prefs** (daily / weekly / SMS only / never Sundays)
- **Delegation** ("ask my assistant, not me")

Currently every one of these lives on the CPA side. Backwards — the person being interrupted should own the interruption budget.

### 9. Fix duplicate detection upstream
The 72h cross-company signature dedup is a compensating control for a Plaid/QBO/manual ingestion problem. Real fix: at import time, if `(date, amount, counterparty)` already exists in a sibling company owned by the same real user, mark as a probable duplicate and don't ingest twice. Dedup logic should not leak into the email scheduler.

### 10. Fold into Owner Digest Draft (still P0)
The unbuilt Owner Digest is the natural home. Weekly digest per owner:
- 🟡 4 transaction questions
- 📄 2 documents to sign
- 💵 1 outstanding invoice
- 📆 Quarterly estimate due in 8 days

Ask-client becomes a **section** in the digest, not a separate product.

### 11. Observability as a first-class feature
Track + expose:
- **Answer rate per client / per firm** — leading indicator of churn-risk relationships
- **Correction rate** — rising means categorizer needs retraining for that client
- **Time-to-resolve per ask** — median hours from send to categorized
- **$ deferred by unanswered asks** — how much is stuck in Uncategorized waiting for a human

None of this exists today.

### 12. Cost-aware asking
Each ask costs Resend + LLM tokens + client attention (the most expensive). If the top-2 candidate categories are both deductible expenses with tax impact delta < $2, DO NOT ASK. Book the best guess, flag for month-end review, move on.

---

## One-line summary

**Today:** "when the AI is unsure about a transaction, email the client."

**What we'd build:** "when a decision that only the client can make will materially change the books, ask them — in the channel they respond to, at the cadence they've chosen, batched with everything else waiting on them, with a preselected best guess so it's one tap to resolve."

The current system is basically Layer 1 (categorizer flagging) with a thin Layer 2 (email dispatch) bolted on. The redesign is really about building a real **Layer 2 — a client attention router** — on top of the same categorizer.

---

## Suggested build order (when we come back to this)

1. **Materiality-scored candidate picker** — new module `ai_ask_client_scoring.py` computing decision-impact score; scheduler picks top-N by score, not "first flagged in the lookback window"
2. **Owner Digest Draft container** (still P0) — build the digest surface first so ask-client has somewhere to live
3. **One-tap confirm affordance** on the magic-link page — hypothesis + 3 buttons
4. **Client-side prefs** — quiet mode, cadence, channel preference on the portal
5. **Answer-driven learning loop** — extend `contact_learning.py` to also learn categorization decisions, not just payee resolution
6. **Multi-channel dispatch** — SMS/WhatsApp/Slack behind the same "send this question" abstraction, email as fallback
7. **Observability dashboard** — answer rate, correction rate, time-to-resolve, $ deferred (surface on Practice Health page)
8. **Upstream dedup** — kill the compensating-control 72h cooldown by fixing ingestion-time duplicate detection

---

## Related open threads

- **Owner Digest Draft (P0)** — the natural container. Do this first; ask-client v2 can then plug in as a section.
- **Practice Health metrics** — the observability piece (#11) belongs here.
- **Smart Categorization Roadmap** (`SMART_CATEGORIZATION_ROADMAP.md`) — the categorizer half of the story.
- **Multi-pod stale cache in production (Redis)** — irrelevant to this design but blocks any per-client channel-preference cache we'd want to add.

## Files this redesign touches

- `/app/backend/ai_ask_client_scheduler.py` — replaces the drip loop with a scored digest queue
- `/app/backend/categorizer.py` — feeds the score, not the trigger
- `/app/backend/contact_learning.py` — extend to categorization decisions
- `/app/backend/email_dispatcher.py` — becomes a multi-channel dispatcher
- `/app/backend/routes/communications.py` — one-tap confirm affordance on the portal
- new: `/app/backend/ai_ask_client_scoring.py` — decision-impact scoring module
- new: portal client-side prefs UI (quiet mode / cadence / channel)
