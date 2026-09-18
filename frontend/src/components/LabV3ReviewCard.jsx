/**
 * LabV3ReviewCard — cockpit tile that surfaces the Lab v3 review queue.
 *
 * Only renders when the current company's `categorization_mode` is
 * `lab_v3`. Shows questions left + unconfirmed dollars + a progress
 * bar, and deep-links to the Review v2 · Lab page.
 *
 * Mounted on: ClientCockpit (`/cockpit/client`).
 */
import { Link } from "react-router-dom";
import { CheckCircle2, ClipboardCheck, Loader2 } from "lucide-react";
import { useLabV3ReviewCount, LAB_V3_REVIEW_ROUTE } from "../lib/labV3Review";

export default function LabV3ReviewCard({ companyId }) {
  const { loading, data } = useLabV3ReviewCount(companyId);

  // Not lab_v3 → hide the tile. Never show "0 review" noise for
  // Standard companies.
  if (!loading && !data?.is_lab_v3) return null;
  if (loading || !data) {
    return (
      <div className="rounded-xl border bg-white p-4 flex items-center gap-2 text-sm text-slate-500"
           data-testid="labv3-review-card-loading">
        <Loader2 size={14} className="animate-spin" /> Loading Lab v3 review…
      </div>
    );
  }

  const questions = data.questions_left;
  const dollars   = data.unconfirmed_dollars;
  const pct       = data.pct_confirmed;

  // All caught up — green mini-card.
  if (questions === 0) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex items-center gap-3"
           data-testid="labv3-review-card-clear">
        <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-emerald-700 font-semibold">
            Lab v3 review
          </div>
          <div className="text-sm font-semibold text-emerald-900">
            All questions answered · {pct}% confirmed by dollar
          </div>
        </div>
        <Link
          to={LAB_V3_REVIEW_ROUTE}
          className="text-[11px] px-2.5 py-1 rounded-md bg-white border border-emerald-300 hover:bg-emerald-100 text-emerald-800 font-semibold"
          data-testid="labv3-review-card-open-clear"
        >
          View log
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-white p-4"
         data-testid="labv3-review-card">
      <div className="flex items-start gap-3">
        <ClipboardCheck size={18} className="text-indigo-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Lab v3 · Client review
          </div>
          <div className="text-sm font-semibold text-slate-900">
            {questions.toLocaleString()} question{questions === 1 ? "" : "s"} · ${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} unconfirmed
          </div>
          <div className="mt-2 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {pct}% of book value confirmed
          </div>
        </div>
        <Link
          to={LAB_V3_REVIEW_ROUTE}
          className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-indigo-600 text-white text-[12px] font-semibold hover:bg-indigo-700"
          data-testid="labv3-review-card-open"
        >
          Start review
          <span className="ml-1 rounded-full bg-white/20 px-1.5 text-[10px] font-mono-num">
            {questions}
          </span>
        </Link>
      </div>
    </div>
  );
}
