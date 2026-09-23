/**
 * PricingPlans — post-payments onboarding step.
 *
 * Handoff order at end-of-onboarding:
 *   Onboarding.finish()  →  /welcome            (housekeeping toggles)
 *                       →  /welcome/payments    (Get Paid Faster wizard)
 *                       →  /welcome/pricing     (this page)
 *                       →  /welcome/summary     (celebrate & land)
 *
 * Visual language mirrors the "Get Paid Faster" step — same slate→white
 * ambient gradient, same rounded-3xl hero card, same eyebrow + bold
 * title header slot. Center card is glow-highlighted as MOST POPULAR
 * to nudge the plan we actually want people on.
 *
 * Billing cadence toggle lives at the top-right; default is ANNUAL so
 * the two-months-free savings show up in the first eyeful. Switching
 * to monthly recalculates each card's headline number in-place.
 */

import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Toaster } from "sonner";
import {
  Check, Star, ArrowRight, Crown,
} from "lucide-react";
import { useBranding } from "@/lib/branding";

// ─── Plan catalog ──────────────────────────────────────────────────
// One entry per tier. `monthly` is the sticker price when billed
// monthly; `annual` is the full-year charge for the same tier. The
// "effective monthly" number you see on the annual toggle is derived
// from `annual / 12` — never hardcoded, so a single number change to
// `annual` keeps the whole card in sync.
const PLANS = [
  {
    id:       "core",
    name:     "Core",
    tagline:  "Smarter accounting. Less work.",
    monthly:  38,
    annual:   380,
    seatCopy: "1 Company · 1 User + Accountant · 3 Connected Accounts",
    highlight: false,
    features: [
      { h: "Normal Accounting",
        b: "Everything a real ledger needs — accrual + cash." },
      { h: "AI Categorization",
        b: "Automatically categorizes transactions." },
      { h: "AI Revenue Recognition",
        b: "Identifies revenue transactions and helps ensure they're recorded correctly." },
      { h: "AI Internal Transfer Recognition",
        b: "Recognizes transfers between connected accounts to avoid duplicate income or expenses." },
      { h: "AI Contact Recognition",
        b: "Identifies the actual customer or vendor behind transactions, including payments through services like Zelle." },
    ],
    bestFor: "Small businesses that want straightforward accounting with AI automatically handling the repetitive work.",
  },
  {
    id:       "assistant",
    name:     "AI Assistant",
    tagline:  "Ask. Review. Get it done.",
    monthly:  79,
    annual:   790,
    seatCopy: "1 Company · 3 Users + Accountant · 6 Connected Accounts",
    highlight: false,
    features: [
      { h: "Everything in Core, plus", isSection: true },
      { h: "AI Review Chat",
        b: "Ask questions and review your books directly with your AI assistant." },
      { h: "AI Reconciliation",
        b: "Helps reconcile accounts and identify discrepancies." },
      { h: "AI Navigation",
        b: "Tell the AI where you want to go instead of searching through menus." },
      { h: "AI Commands",
        b: "Ask the AI to perform accounting tasks for you." },
      { h: "AI Receipt Processing",
        b: "Upload receipts and let AI extract and organize the accounting information." },
      { h: "AI Financial Outlook",
        b: "See a plain-English readout of where the business is trending." },
      { h: "Cash, Burn & Runway",
        b: "Track cash on hand, monthly burn, and how long the runway lasts." },
      { h: "Projections",
        b: "Forward-looking cash and P&L projections built from your data." },
    ],
    bestFor: "Businesses that want powerful AI tools to understand their finances, review their books, and get accounting work done faster.",
  },
  {
    id:       "bookkeeper",
    name:     "AI Bookkeeper",
    tagline:  "We handle the books. You run the business.",
    monthly:  99,
    annual:   990,
    seatCopy: "1 Company · 5 Users + Accountant · Unlimited Connected Accounts",
    highlight: true,
    features: [
      { h: "Everything in AI Assistant, plus", isSection: true },
      { h: "AI Proactive Check-ins",
        b: "Proactively reaches out when information, clarification, or action is needed." },
      { h: "AI Bookkeeper Review",
        b: "Reviews your books for potential errors, unusual activity, and accounting issues." },
      { h: "AI Month-End Close",
        b: "Runs a guided monthly close so the books are always current." },
      { h: "AI Accuracy Review",
        b: "Cross-checks entries against source data and flags anything off." },
      { h: "AI Anomaly Detection",
        b: "Surfaces unusual transactions before they become a mess later." },
      { h: "Liability AI",
        b: "Upload liability information and automatically split payments between principal, interest, insurance, escrow, and other components." },
      { h: "AI Bank Statement Processing",
        b: "Upload bank statements for AI-assisted processing and review." },
      { h: "Classes",
        b: "Track income and expenses across different areas of the business." },
      { h: "AI Automations",
        b: "Set-and-forget rules the AI executes when conditions are met." },
    ],
    bestFor: "Businesses that want the bookkeeping handled for them, with AI proactively managing, reviewing, and closing the books — and involving the business owner only when needed.",
  },
  {
    id:       "advanced",
    name:     "Advanced",
    tagline:  "More complexity. Still handled.",
    monthly:  149,
    annual:   1490,
    seatCopy: "1 Company · 5 Users + Accountant · Unlimited Connected Accounts",
    highlight: false,
    features: [
      { h: "Everything in AI Bookkeeper, plus", isSection: true },
      { h: "AI Bill Processing",
        b: "Scan and process bills with AI." },
      { h: "Advanced AI Financial Insights",
        b: "Deeper pattern analysis across trends, changes, and opportunities." },
      { h: "Advanced Forecasting",
        b: "Multi-scenario forecasting with what-if adjustments." },
      { h: "Budgeting",
        b: "Build and track budgets against actual performance." },
      { h: "Inventory",
        b: "Track inventory and its accounting impact." },
      { h: "Sales Tax Tracking",
        b: "Track sales tax collected and amounts owed." },
      { h: "Employee Reimbursement Tracking",
        b: "Track employee expenses and reimbursements." },
    ],
    bestFor: "Growing and more complex businesses that need advanced accounting, planning, inventory, sales tax, and operational financial tools.",
  },
];

// Currency helper — pinned to en-US since the app's revenue side is
// USD-first. Uses cents when the number has a fractional part, whole
// dollars otherwise so headline numbers stay clean ($38, not $38.00).
const money = (n) => {
  const rounded = Math.round(n * 100) / 100;
  const hasCents = Math.abs(rounded % 1) > 0.001;
  return `$${rounded.toLocaleString("en-US", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
};


export default function PricingPlans() {
  const nav = useNavigate();
  // Read the current pro/firm branding so we can pin the firm logo
  // in the top-left corner (this page sits OUTSIDE the shared Layout
  // which normally shows the logo in the sidebar). Falls through
  // gracefully when a firm hasn't uploaded a logo yet.
  const { branding } = useBranding() || {};
  const logos = branding?.logos || {};
  const logoUrl = logos.logo_light || logos.icon_light
                  || branding?.logo_data_url || null;

  // Annual is the recommended default — it's the plan we WANT people
  // on (better retention, cheaper to serve monthly infra). Sits atop
  // page so the two-months-free savings show up in the first eyeful.
  const [cadence, setCadence] = useState("annual"); // "monthly" | "annual"

  // Feature detail toggle — the sub-line under each bullet (e.g.
  // "Ask questions and review your books directly with your AI
  // bookkeeper.") gets noisy when scanned side-by-side. Default is
  // OFF so the cards read like a comparison surface first; the pill
  // to the right of the cadence toggle expands them for readers who
  // want the full pitch.
  const [showDetail, setShowDetail] = useState(false);

  // Cross-plan continue → summary. Actual plan-selection persistence
  // is intentionally not wired here yet — this page is currently a
  // presentation step; the "Continue" button hands off to the
  // celebration screen. Plan-selection persistence can be plumbed
  // once billing lands.
  const onContinue = () => nav("/welcome/summary");
  const onSkip     = () => nav("/welcome/summary");

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white p-6 pt-14" data-testid="pricing-plans-page">
      {/* Local toaster — this page sits OUTSIDE the shared Layout so
          the global <Toaster/> in Layout isn't mounted here. Without
          this local copy, any sonner toast() call from this page (or
          a child) would silently no-op. */}
      <Toaster richColors position="top-center" />

      {/* Top-left firm logo — pinned so a chrome-less page still
          carries the brand mark. Falls back to nothing when no logo
          is on file (rather than a bare "Firm" placeholder). */}
      {logoUrl && (
        <img
          src={logoUrl}
          alt="Firm logo"
          className="fixed top-5 left-6 h-9 w-auto max-w-[180px] object-contain z-10"
          data-testid="pricing-firm-logo"
        />
      )}

      <div className="max-w-[1500px] mx-auto">

        {/* Centered marketing header — crown, headline, feature-chip
            row, and cadence toggle stack on the same axis. Replaces
            the old eyebrow/title/toggle grid so the whole page reads
            like a landing surface, not an admin panel step. `current`
            (company) is intentionally NOT rendered here; a signed-in
            trial starter doesn't need to be reminded which company
            they're setting up mid-onboarding. */}
        <div className="flex flex-col items-center text-center mb-10">
          <div
            className="mb-4 w-11 h-11 rounded-full inline-flex items-center justify-center bg-gradient-to-br from-amber-100 to-amber-50 border border-amber-200 shadow-sm"
            data-testid="pricing-crown"
          >
            <Crown size={20} className="text-amber-500" fill="currentColor" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
            Select a plan to start your 7-day free trial
          </h1>

          {/* Feature pills — soft chips that surface the "why it's
              safe to click" signals without cluttering the plan cards
              themselves. Wrap gracefully at narrower breakpoints. */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {[
              "7-day free trial",
              "98% Auto-categorization",
              "Full service accounting option (via partners)",
              "Cancel anytime",
            ].map((chip) => (
              <span
                key={chip}
                className="inline-flex items-center rounded-full border border-slate-200 bg-white/80 px-3.5 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm"
                data-testid={`pricing-chip-${chip.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'')}`}
              >
                {chip}
              </span>
            ))}
          </div>

          {/* Cadence toggle — centered below chips. The "2 Months
              Free" chip inside the annual pill replaces the old
              separate "Annual billing: Get 2 months free" ribbon so
              this header stays a single tight column. The
              detail-toggle pill sits to its right so both live in
              one visual axis. */}
          <div className="mt-5 flex items-center justify-center gap-3">
            <CadenceToggle cadence={cadence} onChange={setCadence} />
            <button
              type="button"
              onClick={() => setShowDetail((v) => !v)}
              aria-pressed={showDetail}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition border-2 border-slate-900 shadow-sm ${
                showDetail
                  ? "bg-emerald-700 text-white hover:bg-emerald-800"
                  : "bg-emerald-500 text-white hover:bg-emerald-600"
              }`}
              data-testid="pricing-detail-toggle"
            >
              {showDetail ? "Hide Detail" : "Show Detail"}
            </button>
          </div>
        </div>

        {/* Plan grid — 1-column on mobile, 3-column at ≥lg. Middle
            card scales up 2% at ≥lg so the eye lands there first. */}
        {/* Plan grid — 1-column on mobile, 2-column at md, 4-column
            at ≥lg so the four plans stay in a single row on any
            reasonable desktop viewport. AI Bookkeeper card scales up
            2% at ≥lg so the eye lands there first. */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-5 items-stretch">
          {PLANS.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              cadence={cadence}
              showDetail={showDetail}
              onSelect={onContinue}
            />
          ))}
        </div>

        {/* Continue / Skip footer — same rhythm as the payments page. */}
        <div className="mt-8 flex items-center justify-between">
          <button
            type="button"
            onClick={onSkip}
            className="text-sm text-slate-500 hover:text-slate-800 underline underline-offset-4 decoration-slate-300"
            data-testid="pricing-skip"
          >
            Not right now
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="group inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-slate-900 text-white text-sm font-semibold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-transform"
            data-testid="pricing-continue"
          >
            Continue
            <ArrowRight size={14} className="group-hover:translate-x-0.5 transition-transform" />
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * CadenceToggle — top-right pill that flips between Monthly & Annual
 * billing. A tiny "Save 2 months" chip on the annual side signals the
 * discount without overloading the header.
 */
function CadenceToggle({ cadence, onChange }) {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-full bg-slate-100 border border-slate-200 p-1"
      role="tablist"
      data-testid="pricing-cadence-toggle"
    >
      <button
        type="button"
        role="tab"
        aria-selected={cadence === "monthly"}
        onClick={() => onChange("monthly")}
        className={`px-4 py-1.5 rounded-full text-sm font-semibold transition ${
          cadence === "monthly"
            ? "bg-white text-slate-900 shadow-sm"
            : "text-slate-500 hover:text-slate-700"
        }`}
        data-testid="pricing-cadence-monthly"
      >
        Monthly
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={cadence === "annual"}
        onClick={() => onChange("annual")}
        className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold transition ${
          cadence === "annual"
            ? "bg-white text-slate-900 shadow-sm"
            : "text-slate-500 hover:text-slate-700"
        }`}
        data-testid="pricing-cadence-annual"
      >
        Annual
        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${
          cadence === "annual"
            ? "bg-emerald-100 text-emerald-700"
            : "bg-emerald-50 text-emerald-600"
        }`}>
          2 Months Free
        </span>
      </button>
    </div>
  );
}


/**
 * PlanCard — one tier. Middle card gets the popular treatment:
 *   * emerald→indigo gradient ring around the outside
 *   * "Most Popular" badge floating above the top edge
 *   * slight scale bump at ≥lg so the eye lands there first
 *   * dark card body with white text
 */
function PlanCard({ plan, cadence, showDetail, onSelect }) {
  const headlinePrice = useMemo(() => {
    return cadence === "annual" ? plan.annual / 12 : plan.monthly;
  }, [cadence, plan]);

  const popular = plan.highlight;

  return (
    <div
      className={`relative flex flex-col rounded-3xl shadow-lg transition-transform ${
        popular
          ? "lg:scale-[1.02] bg-slate-900 text-white border border-emerald-400/40 shadow-emerald-900/30"
          : "bg-white text-slate-900 border border-slate-200"
      }`}
      data-testid={`pricing-card-${plan.id}`}
    >
      {popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <div className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1 shadow-lg">
            <Star size={10} fill="currentColor" /> Most Popular
          </div>
        </div>
      )}

      <div className="p-6 sm:p-7">
        <div className={`text-lg font-bold ${popular ? "text-white" : "text-slate-900"}`}>
          {plan.name}
        </div>
        <div className={`text-sm mt-1 ${popular ? "text-emerald-100/80" : "text-slate-500"}`}>
          {plan.tagline}
        </div>

        {/* Price block. Two lines so the headline number stays huge
            and the secondary billing detail sits underneath. */}
        <div className="mt-5 flex items-end gap-1.5">
          <span className={`text-4xl font-extrabold tracking-tight tabular-nums ${
            popular ? "text-white" : "text-slate-900"
          }`}>
            {money(headlinePrice)}
          </span>
          <span className={`pb-1 text-sm font-medium ${
            popular ? "text-emerald-100/70" : "text-slate-500"
          }`}>
            /mo
          </span>
        </div>
        <div className={`mt-1 text-xs ${popular ? "text-emerald-100/60" : "text-slate-500"}`}>
          {cadence === "annual" ? (
            <>Billed <b>{money(plan.annual)}</b>/year · 2 months free</>
          ) : (
            <>Billed monthly · switch to annual anytime</>
          )}
        </div>

        {/* Primary CTA */}
        <button
          type="button"
          onClick={() => onSelect(plan)}
          className={`mt-5 w-full inline-flex items-center justify-center gap-2 rounded-full py-2.5 text-sm font-bold shadow-md hover:shadow-lg hover:scale-[1.01] transition-transform ${
            popular
              ? "bg-gradient-to-r from-emerald-500 to-teal-500 text-white"
              : "bg-slate-900 text-white"
          }`}
          data-testid={`pricing-select-${plan.id}`}
        >
          Choose {plan.name}
          <ArrowRight size={13} />
        </button>
      </div>

      {/* Feature list — dark rule between price block and features
          so the eye reads them as a separate scan surface. */}
      <div className={`px-6 sm:px-7 pb-6 sm:pb-7 border-t ${
        popular ? "border-white/10" : "border-slate-100"
      } pt-5 flex-1 flex flex-col`}>
        <ul className="space-y-3">
          {plan.features.map((f, i) => {
            if (f.isSection) {
              return (
                <li key={i} className={`text-[11px] uppercase tracking-widest font-bold ${
                  popular ? "text-emerald-200" : "text-emerald-700"
                }`}>
                  {f.h}
                </li>
              );
            }
            return (
              <li key={i} className="flex items-start gap-2.5">
                <div className={`mt-0.5 shrink-0 w-4 h-4 rounded-full inline-flex items-center justify-center ${
                  popular ? "bg-emerald-400/20 text-emerald-300"
                          : "bg-emerald-100 text-emerald-600"
                }`}>
                  <Check size={11} strokeWidth={3} />
                </div>
                <div>
                  <div className={`text-sm font-semibold ${popular ? "text-white" : "text-slate-800"}`}>
                    {f.h}
                  </div>
                  {f.b && showDetail && (
                    <div className={`text-[12px] leading-relaxed mt-0.5 ${
                      popular ? "text-emerald-100/75" : "text-slate-500"
                    }`}>
                      {f.b}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {/* "Best for" footer — a soft italic tag that gives users a
            gut check without turning the card into a wall of copy. */}
        <div className={`mt-5 pt-4 border-t text-[12px] italic leading-relaxed ${
          popular
            ? "border-white/10 text-emerald-100/70"
            : "border-slate-100 text-slate-500"
        }`}>
          <b className="not-italic">Best for:</b> {plan.bestFor}
        </div>

        {/* Seat allowance — pinned to the bottom via `mt-auto` so it
            sits at the same y-position across all three cards even
            when feature lists differ in length. */}
        <div className={`mt-auto pt-5 text-[11px] uppercase tracking-widest font-semibold text-center ${
          popular ? "text-emerald-100/70" : "text-slate-500"
        }`}
        data-testid={`pricing-seat-copy-${plan.id}`}>
          {plan.seatCopy}
        </div>
      </div>
    </div>
  );
}



