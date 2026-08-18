# SmartBooks — Scaling Cost Model (Feb 2026)

For CFO / investor conversations. All figures in USD/month unless noted. Ranges reflect low-adoption vs high-engagement scenarios at each tier.

---

## 1. Infrastructure + Variable Costs — Master Table

Ready to paste into Google Sheets / Excel. Line items are grouped so you can collapse categories in your finance model.

| Category | Line Item | 500 users (low) | 500 users (high) | 1,500 users (low) | 1,500 users (high) | 3,000 users (low) | 3,000 users (high) |
|---|---|---|---|---|---|---|---|
| Compute | Backend (Railway/Fly, replicas) | 150 | 250 | 400 | 700 | 900 | 1500 |
| Compute | Frontend hosting (Vercel/Netlify) | 20 | 40 | 60 | 120 | 150 | 250 |
| Database | MongoDB Atlas dedicated | 180 | 220 | 450 | 550 | 900 | 1300 |
| Database | Redis Cloud (cache + rate-limit) | 30 | 50 | 75 | 120 | 200 | 350 |
| Database | Automated backups + PITR | 20 | 40 | 60 | 100 | 120 | 200 |
| AI | LLM inference (OpenAI + Claude + Nano Banana) | 1000 | 2000 | 3000 | 6000 | 6000 | 12000 |
| AI | STT / voice (Whisper) | 20 | 60 | 60 | 200 | 150 | 500 |
| Integrations | Plaid (production) | 150 | 350 | 500 | 1100 | 1100 | 2300 |
| Integrations | Veryfi OCR | 100 | 250 | 400 | 800 | 900 | 1800 |
| Integrations | QuickBooks Online (free API, no cost) | 0 | 0 | 0 | 0 | 0 | 0 |
| Integrations | Stripe processing (pass-through) | 0 | 0 | 0 | 0 | 0 | 0 |
| Email/Comms | Resend transactional email | 20 | 35 | 50 | 90 | 150 | 250 |
| Email/Comms | Twilio SMS (optional) | 0 | 40 | 30 | 100 | 80 | 200 |
| Storage | Object storage (S3/R2) | 30 | 60 | 150 | 300 | 400 | 700 |
| Storage | CDN egress | 10 | 30 | 40 | 100 | 100 | 250 |
| Monitoring | Sentry (errors) | 30 | 50 | 80 | 150 | 150 | 300 |
| Monitoring | Datadog / Logtail (APM + logs) | 50 | 70 | 120 | 250 | 350 | 600 |
| Security | Vanta / Drata (SOC 2 tooling) | 0 | 0 | 0 | 200 | 500 | 800 |
| Security | Snyk / dep scanning | 0 | 30 | 30 | 60 | 60 | 120 |
| Support | Intercom / Help Scout | 0 | 100 | 100 | 300 | 300 | 700 |
| Support | Status page (Statuspage.io) | 0 | 30 | 30 | 60 | 60 | 120 |
| Ops | Domain, DNS, Cloudflare | 20 | 40 | 30 | 60 | 50 | 100 |
| Ops | Password manager, misc SaaS | 20 | 40 | 40 | 80 | 60 | 150 |
| **TOTAL** | | **1,850** | **3,835** | **5,705** | **11,540** | **12,680** | **24,690** |

### Per-user cost per tier

| Tier | Low $/user/mo | High $/user/mo |
|---|---|---|
| 500 | $3.70 | $7.67 |
| 1,500 | $3.80 | $7.69 |
| 3,000 | $4.23 | $8.23 |

Cost per user stays remarkably flat because AI + Plaid scale linearly. Infra base costs get *cheaper* per user, but variable per-user costs offset that.

---

## 2. AI Cost Forecasting — Deep Dive

AI is the single largest and most volatile line item. Understanding it in detail will save more money than any other optimisation.

### 2a. Cost per operation (Feb 2026 pricing via Emergent LLM key)

| Operation | Model used | Avg tokens (in/out) | Cost per call |
|---|---|---|---|
| Transaction categorisation | GPT-5.4 Mini | 600 / 80 | ~$0.001–0.002 |
| Batch categorise (10 txns) | GPT-5.4 Mini | 3,000 / 400 | ~$0.005–0.008 |
| Voice STT (10s clip) | Whisper | — | ~$0.001 |
| Voice intent parse | GPT-5.4 Mini | 400 / 50 | ~$0.0008 |
| Chat message (dashboard AI) | Claude Haiku 4.5 | 2,000 / 400 | ~$0.008–0.012 |
| Long-form insight report | Claude Sonnet 5 | 8,000 / 2,000 | ~$0.08–0.12 |
| QBO Verify (PDF → JSON extract) | Claude Sonnet 5 | 15,000 / 3,000 | ~$0.15–0.25 |
| Anomaly detection sweep | GPT-5.4 Mini | 4,000 / 300 | ~$0.006 |
| Onboarding interview | GPT-5.4 Mini | 3,000 / 800 | ~$0.008 |
| Contact/merchant match | GPT-5.4 Mini | 500 / 60 | ~$0.0009 |
| Image / receipt understanding | Gemini 3.5 Flash (Nano Banana) | 1 img / 200 | ~$0.003 |

### 2b. Monthly usage profile per user segment

Different user segments burn AI budget at wildly different rates. This is the number that matters:

| Segment | Description | Typical AI ops/mo | AI cost/user/mo |
|---|---|---|---|
| Free trial / dormant | Signed up, low activity | ~50 | $0.10–0.30 |
| Light client | 1 company, <200 txns/mo | ~800 | $1.20–2.00 |
| Standard client | 1 company, ~800 txns/mo | ~3,500 | $2.50–4.50 |
| Power client (heavy chat) | Uses insight reports, voice | ~6,000 | $5–9 |
| Pro (accountant, 10 clients) | Manages many books | ~25,000 | $15–30 |
| Pro power user (30 clients) | Firm-scale | ~60,000 | $35–70 |

### 2c. Mix assumption + forecast

Realistic assumed mix by tier:

| Segment | 500 users | 1,500 users | 3,000 users |
|---|---|---|---|
| Free trial / dormant (30%) | 150 | 450 | 900 |
| Light client (35%) | 175 | 525 | 1,050 |
| Standard client (20%) | 100 | 300 | 600 |
| Power client (8%) | 40 | 120 | 240 |
| Pro (5%) | 25 | 75 | 150 |
| Pro power user (2%) | 10 | 30 | 60 |

Multiplied by mid-point cost per segment:

| Tier | Est. AI $/mo (base) | Est. AI $/mo (+20% overhead) |
|---|---|---|
| 500 users | $1,290 | $1,548 |
| 1,500 users | $3,870 | $4,644 |
| 3,000 users | $7,740 | $9,288 |

The +20% overhead absorbs: retries, background jobs, prompt engineering iteration, and demo/marketing tokens.

### 2d. Levers to cut AI spend 30–60% without hurting UX

| Lever | Est. savings | Effort |
|---|---|---|
| Route classification through GPT-5.4 Mini not 5.6 | -35% | Already partly done — verify |
| Cache repeat classifications by (merchant + amount range) | -15% | Low; ~2 days work |
| Batch small ops (10 txns/call) instead of 1-at-a-time | -25% | Medium; touches categoriser |
| Use Claude Haiku 4.5 for chat (vs. Sonnet 5) except for reports | -20% | Low; single router change |
| Precompute nightly insight summaries so chat can quote them | -15% | Medium; background job |
| Rate-limit "AI Ask" per user per day (softcap = 20 msgs) | -8% | Trivial |
| Nano Banana only when user explicitly attaches image | -3% | Already done |

Stacked savings are not additive (they overlap) — realistic combined savings: **35–55% off the "no-optimisation" number**.

### 2e. Danger zones — what can spike your bill overnight

Real-world things that have burned other SaaS founders in 2025:

1. **Runaway retry loops** — a failing prompt that retries 5x and never caches the failure can 20x cost in an hour.
2. **Free-tier abuse** — bots signing up, running batch classifications on synthetic data. Solution: require email verification + credit card at signup.
3. **Long context growth** — every "AI Ask" message includes the whole prior conversation. Old conversations grow to 30k tokens. Cap or summarise.
4. **Superadmin impersonation** — testing a Pro user's 30-client book eats real AI budget. Add a `_dry_run` flag.
5. **Public demo endpoint** — the `/demo/uk` route you just built. If someone loops it, they burn tokens. Solution: demo visitor's AI calls should route to Haiku 4.5 with a hard daily cap.

### 2f. Emergent LLM Key — bill vs. actual cost

Emergent Universal Key adds no markup for LLMs (verify current terms). If you migrate off Emergent to direct OpenAI/Anthropic/Google:
- **Savings**: none on token costs, but you get provider-specific volume discounts at $10k+/mo.
- **Extra work**: three separate accounts + key rotation + billing + downtime handling.
- **Recommendation**: stay on Emergent until you're **>$5k/mo AI spend consistently**, then evaluate.

---

## 3. Legal, Compliance & Certifications

Non-negotiable spending as you grow. Timing matters — some certs take 6–12 months, so you need to start before you actually need them.

### 3a. UK — HMRC MTD Recognition

To sell to UK accountants and small businesses.

| Item | One-time | Annual | Timeline |
|---|---|---|---|
| HMRC Developer Hub sign-up | $0 | $0 | 1 day |
| Sandbox testing + recognition submission | $0 (internal time) | $0 | 4–8 weeks |
| iXBRL taxonomy license (Companies House filing) | $0 (open) | $0 | Ongoing |
| ICAEW / ACCA sponsor firm (recommended for credibility) | $0–500 | $500–2,000 | Optional |
| Solicitor review of terms of service (UK-specific) | $1,500–3,000 | $500 | 2–3 weeks |
| GDPR/UK-GDPR DPO service or fractional DPO | $0 | $2,400–6,000 | 4 weeks |
| **UK subtotal** | **$1,500–3,500** | **$3,400–8,500** | |

**Not a cost, but critical**: HMRC Recognition requires you to demonstrate the software with real practices. Budget internal engineering time (~40–80 hours) for their evaluation call + fixes.

### 3b. SOC 2 (for larger US customers, enterprise, and any accounting firm > 20 seats)

The industry standard. Enterprise customers *will* ask for this once you get past 1,000 users.

| Item | Cost | Timeline |
|---|---|---|
| Vanta or Drata (compliance automation platform) | $9,000–15,000/year | Immediate on subscribe |
| SOC 2 Type I audit (point-in-time) | $12,000–20,000 one-time | 3–4 months |
| SOC 2 Type II audit (12-month observation) | $25,000–45,000 annually | Starts after Type I |
| Penetration test (annual, required for Type II) | $6,000–12,000 | 2 weeks |
| Employee security training (KnowBe4 or similar) | $3,000–8,000/year | Ongoing |
| Legal review of policies (privacy, incident response, DPA) | $3,000–8,000 one-time | 3 weeks |
| **SOC 2 first-year cost** | **$58,000–108,000** | **9–12 months** |
| **SOC 2 recurring (year 2+)** | **$43,000–80,000/year** | Ongoing |

**Realistic timing**: start Vanta at ~750 paid users. Complete Type I by 1,500 users. Complete Type II by 2,500–3,000 users.

### 3c. Other US compliance (money-adjacent SaaS)

Accounting software is not a regulated financial institution, but you hold sensitive financial data, so:

| Item | Cost | When |
|---|---|---|
| Business insurance — E&O / Cyber Liability | $3,000–8,000/year | Day 1 |
| PCI DSS SAQ-A (Stripe handles most) | $0 | If using Stripe hosted checkout |
| CCPA + State privacy law compliance (privacy policy updates) | $2,000–5,000 one-time | Before US launch |
| Delaware C-Corp + annual franchise tax | $400–2,000/year | Ongoing |
| Registered agent | $150–300/year | Ongoing |
| Trademark filings (US + UK) | $1,500–3,500 one-time | Before major marketing |
| **US subtotal** | **$5,000–15,000 first year, $6,000–15,000 recurring** | |

### 3d. ISO 27001 (only if you go seriously into UK/EU enterprise)

Optional but expected by many UK enterprises. Overlaps ~70% with SOC 2 so you can do both together.

| Item | Cost | Timeline |
|---|---|---|
| ISO 27001 gap assessment | $8,000–15,000 | Included in Vanta if you upgrade |
| ISO 27001 certification audit | $20,000–35,000 initial | 6 months after Vanta start |
| Recertification audit (every 3 years) | $15,000–25,000 | Cadence |
| Annual surveillance audit | $8,000–12,000/year | Ongoing |

**Recommendation**: skip ISO 27001 until you have 3+ enterprise UK clients asking for it in RFPs.

### 3e. Total compliance & legal by tier

| Tier | First-year additional cost | Recurring/year | When to start |
|---|---|---|---|
| 500 users | $6,500–18,500 | $9,000–23,000 | Business insurance + basic legal only |
| 1,500 users | $20,000–45,000 | $15,000–35,000 | Add Vanta + SOC 2 Type I |
| 3,000 users | $65,000–125,000 | $55,000–100,000 | Full SOC 2 Type II + HMRC MTD + UK GDPR |

### 3f. Compliance ROI

You don't spend compliance money to save money — you spend it to unlock revenue:

- **SOC 2 Type II** unlocks enterprise deals (>50-seat firms). Average enterprise contract in accounting SaaS is $2,500–8,000/mo. **Two enterprise closes pay for a full year of SOC 2.**
- **HMRC Recognition** unlocks the entire UK sole-trader + Ltd market — that's ~5.5M businesses under MTD ITSA by April 2026.
- **GDPR + UK-GDPR compliance** is table stakes; not having it doesn't lose you customers but a single breach without it is existentially expensive.

---

## 4. Grand-Total All-In Cost by Tier

| Tier | Monthly infra | Monthly compliance amortised | **Total/mo** | **Total/year** |
|---|---|---|---|---|
| 500 users | $1,850–3,835 | ~$750–1,900 | **$2,600–5,735** | **$31k–69k** |
| 1,500 users | $5,705–11,540 | ~$1,650–3,750 | **$7,355–15,290** | **$88k–184k** |
| 3,000 users | $12,680–24,690 | ~$5,450–10,400 | **$18,130–35,090** | **$217k–421k** |

Compliance is amortised over 12 months (first-year cost + ongoing recurring, divided by 12).

## 5. Revenue implied by 4× gross margin

To hit healthy SaaS margins:

| Tier | Total cost/mo | ARPU needed (4× margin) | Total MRR |
|---|---|---|---|
| 500 users | ~$4,000 | **~$32/user/mo** | $16,000 |
| 1,500 users | ~$11,000 | **~$29/user/mo** | $44,000 |
| 3,000 users | ~$26,000 | **~$34/user/mo** | $103,000 |

**Bottom line**: at $30–50/user/mo (comfortably below QBO/Xero), you clear healthy margins even at the high-cost end. Your unit economics work.

---

*Last updated: Feb 2026 — refresh quarterly as LLM pricing and infra tiers change.*
