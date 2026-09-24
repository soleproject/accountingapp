/**
 * WelcomeSummary — the "Great News!" celebration page.
 *
 * Handoff order at end-of-onboarding:
 *   Onboarding.finish()  →  /welcome  (housekeeping toggles)
 *                       →  /welcome/summary  (this page — celebrates
 *                          what the AI already did in the background)
 *                       →  /dashboard
 *
 * The stats come from `GET /companies/{cid}/onboarding/summary-stats`.
 * Zero values are hidden from the copy — brand-new companies won't
 * see "Reconciled 0 months" telling them nothing happened. The three
 * flag-gated counts (IRS docs, missing receipts, liability splits)
 * only surface if the corresponding `compliance_flags.*` toggle was
 * left ON on the previous page; the backend returns `null` for opted-
 * out flags so the frontend can distinguish "off" from "0 hits".
 */

import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Sparkles, ArrowRight, ShieldCheck, Receipt, Scissors,
  BadgeCheck, ArrowLeftRight, Landmark, CheckCircle2, Loader2,
  BookOpen, ClipboardCheck, MessageCircleQuestion, ArrowLeft, Clock,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useColumnBox } from "@/hooks/useColumnBox";

// Order and formatting of the celebratory bullet list. Each row is
// only rendered if `visible(stats)` returns true — that's how we hide
// zero counts and opted-out flag categories.
const ROWS = [
  {
    key: "categorized_transactions",
    icon: BadgeCheck,
    tone: "text-emerald-600 bg-emerald-50",
    format: (n) => (
      <><b>Categorized {n.toLocaleString()}</b> transaction{n === 1 ? "" : "s"}</>
    ),
    visible: (s) => (s.categorized_transactions ?? 0) > 0,
  },
  {
    key: "internal_transfers",
    icon: ArrowLeftRight,
    tone: "text-indigo-600 bg-indigo-50",
    format: (n) => (
      <>Found <b>{n.toLocaleString()}</b> internal transfer{n === 1 ? "" : "s"}</>
    ),
    visible: (s) => (s.internal_transfers ?? 0) > 0,
  },
  {
    key: "liability_accounts_created",
    icon: Landmark,
    tone: "text-amber-600 bg-amber-50",
    format: (n) => (
      <>Created <b>{n.toLocaleString()}</b> liability account{n === 1 ? "" : "s"}</>
    ),
    visible: (s) => (s.liability_accounts_created ?? 0) > 0,
  },
  {
    // Total accounts now on the books — this is the "your CoA is
    // ready" beat, so we include seeded + AI-created rows. Sits
    // right after the liability count so the eye reads "you got
    // N liability accounts, out of a total M" in the same rhythm.
    key: "chart_of_accounts_created",
    icon: BookOpen,
    tone: "text-teal-600 bg-teal-50",
    format: (n) => (
      <>Built out <b>{n.toLocaleString()}</b> chart-of-accounts entr{n === 1 ? "y" : "ies"}</>
    ),
    visible: (s) => (s.chart_of_accounts_created ?? 0) > 0,
  },
  {
    key: "reconciled_months",
    icon: CheckCircle2,
    tone: "text-cyan-600 bg-cyan-50",
    format: (n) => (
      <>Reconciled <b>{n.toLocaleString()}</b> month{n === 1 ? "" : "s"}</>
    ),
    visible: (s) => (s.reconciled_months ?? 0) > 0,
  },
  {
    // Raw completion count (a 3-account × 3-month backfill = 9 here,
    // vs 3 for `reconciled_months`). Keeps the "we did serious work"
    // beat visible even when someone only has one month covered
    // across many accounts.
    key: "reconciliations_completed",
    icon: ClipboardCheck,
    tone: "text-sky-600 bg-sky-50",
    format: (n) => (
      <>Completed <b>{n.toLocaleString()}</b> reconciliation{n === 1 ? "" : "s"}</>
    ),
    visible: (s) => (s.reconciliations_completed ?? 0) > 0,
  },
  {
    // Pending action — rendered with a warm amber tone so it reads
    // as "here's what's left for you" rather than another win. Copy
    // matches the CTA on the Review Books chat page so the two
    // surfaces feel like the same thread.
    key: "review_chat_remaining",
    icon: MessageCircleQuestion,
    tone: "text-rose-600 bg-rose-50",
    format: (n) => (
      <>
        <b>{n.toLocaleString()}</b> review-chat question{n === 1 ? "" : "s"} waiting for you
      </>
    ),
    visible: (s) => (s.review_chat_remaining ?? 0) > 0,
  },
  {
    key: "irs_flagged",
    icon: ShieldCheck,
    tone: "text-rose-600 bg-rose-50",
    format: (n) => (
      <>Flagged <b>{n.toLocaleString()}</b> transaction{n === 1 ? "" : "s"} needing IRS documentation</>
    ),
    // null = flag opted-out; hide either way if not > 0.
    visible: (s) => typeof s.irs_flagged === "number" && s.irs_flagged > 0,
  },
  {
    key: "receipts_missing",
    icon: Receipt,
    tone: "text-violet-600 bg-violet-50",
    format: (n) => (
      <>Flagged <b>{n.toLocaleString()}</b> transaction{n === 1 ? "" : "s"} missing a receipt</>
    ),
    visible: (s) => typeof s.receipts_missing === "number" && s.receipts_missing > 0,
  },
  {
    key: "liability_splits",
    icon: Scissors,
    tone: "text-orange-600 bg-orange-50",
    format: (n) => (
      <>Flagged <b>{n.toLocaleString()}</b> liability payment{n === 1 ? "" : "s"} that should be split</>
    ),
    visible: (s) => typeof s.liability_splits === "number" && s.liability_splits > 0,
  },
];

export default function WelcomeSummary() {
  const nav = useNavigate();
  const { current, currentId } = useCompany();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  // Column measurer for the sticky Back / Next-step footer — same
  // pattern used by `/welcome` and `/welcome/payments` so this final
  // onboarding step has the same nav rhythm as the ones before it.
  const { columnRef, colBox } = useColumnBox([loading, currentId]);

  useEffect(() => {
    if (!currentId) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/onboarding/summary-stats`);
        if (!cancelled) setStats(r.data || {});
      } catch (e) {
        if (!cancelled) toast.error(e?.response?.data?.detail || "Couldn't load your summary — heading in anyway.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  const visibleRows = stats ? ROWS.filter(r => r.visible(stats)) : [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white flex items-start justify-center p-6 pt-14">
      <div className="w-full max-w-2xl pb-24" ref={columnRef} data-testid="welcome-summary-page">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center">
            <Sparkles size={16} className="text-white" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Onboarding · Complete
            </div>
            <div className="text-2xl font-bold text-slate-900 leading-tight">
              Great News!
            </div>
          </div>
        </div>

        {/* Motivational pitch — this is the "you're almost there" beat
            that sits above the accomplishments card. Two paragraphs:
            first sells the finish line (5 minutes → done), second
            reframes the pending review-chat questions as the last
            mile toward books that are actually correct. Uses a soft
            emerald wash so it reads as encouraging, not administrative. */}
        <div
          className="rounded-xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-teal-50/60 p-5 shadow-sm mb-5"
          data-testid="welcome-summary-pitch"
        >
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-white/70 border border-emerald-100 flex items-center justify-center shrink-0">
              <Clock size={18} className="text-emerald-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-slate-900 leading-relaxed font-semibold">
                You're about <span className="text-emerald-700">5 minutes</span> away from having <b>{current?.name || "your books"}</b>'s books completely done.
              </p>
              <p className="text-slate-700 leading-relaxed mt-2 text-[15px]">
                While I was going through everything, a few small questions
                came up that only you can answer. Once you clear those, your
                books won't just be <b>done</b> — they'll be <b>correct,
                accurate, and something you can be proud of</b>.
              </p>
            </div>
          </div>
        </div>

        {/* Accomplishments card */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-6" data-testid="welcome-summary-card">
          <p className="text-slate-800 leading-relaxed mb-4 font-semibold">
            Look at what you've already accomplished:
          </p>

          {loading ? (
            <div className="flex items-center justify-center py-8 text-slate-400" data-testid="welcome-summary-loading">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="text-slate-500 text-sm italic" data-testid="welcome-summary-empty">
              I'm still working on the first pass — nothing to celebrate yet, but everything's queued up. You can head into your books now and I'll keep going in the background.
            </div>
          ) : (
            <ul className="space-y-3">
              {visibleRows.map((row) => {
                const Icon = row.icon;
                const n = stats[row.key];
                return (
                  <li
                    key={row.key}
                    className="flex items-start gap-3"
                    data-testid={`welcome-summary-row-${row.key}`}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${row.tone}`}>
                      <Icon size={16} />
                    </div>
                    <div className="text-slate-800 text-[15px] leading-relaxed pt-1">
                      {row.format(n)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Fixed viewport-bottom Back / Next-step footer — matches the
          rhythm of `/welcome` and `/welcome/payments`. Back returns
          to the pricing step (previous in the flow); Next step drops
          the user into the dashboard, which is the true landing
          surface for their books. */}
      <div
        style={{
          position: "fixed",
          bottom: 16,
          left: colBox.left,
          width: colBox.width,
          visibility: colBox.ready ? "visible" : "hidden",
        }}
        className="z-30 flex items-center justify-center gap-3 pointer-events-none"
        data-testid="welcome-summary-sticky-footer"
      >
        <div className="flex items-center justify-center gap-3 pointer-events-auto">
          <button
            type="button"
            onClick={() => nav("/welcome/pricing")}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white border border-slate-200 shadow-sm text-sm text-slate-600 hover:text-slate-900 hover:border-slate-300"
            data-testid="welcome-summary-back"
          >
            <ArrowLeft size={14} /> Back
          </button>
          <button
            type="button"
            onClick={() => nav("/dashboard")}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-md"
            data-testid="welcome-summary-continue"
          >
            Next step <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
