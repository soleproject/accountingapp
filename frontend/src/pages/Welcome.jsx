/**
 * Welcome — the "you just finished onboarding" landing page.
 *
 * The onboarding wizard hands off here (see `Onboarding.finish()`)
 * once `onboarding_complete` is set on the company. Two jobs:
 *
 *   1. Congratulate the owner and reassure them that background work
 *      is still happening (imports, AI-categorization, first close).
 *   2. Capture three lightweight compliance preferences that the AI
 *      needs a yes/no on to know how aggressively to flag things:
 *        - IRS documentation flagging (§274 substantiation etc)
 *        - Missing-receipt flagging
 *        - Liability payment splitting (principal/interest)
 *      Each preference is persisted to `company.compliance_flags`
 *      via the generic `PATCH /companies/{cid}` endpoint. Read side
 *      lives in the Transactions/Compliance pages — flags toggle the
 *      corresponding "needs review" chip strip.
 *
 * A "Take me to my books" button routes to `/dashboard` when done.
 * The page is idempotent — visiting again just re-loads the current
 * flag state; no re-persist required.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Sparkles, ShieldCheck, Receipt, Scissors, ArrowRight, Check, X, Loader2,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

const FLAG_ROWS = [
  {
    key: "flag_irs_docs",
    icon: ShieldCheck,
    title: "IRS Documentation",
    desc: "Flag transactions that need §274 substantiation (attendees, business purpose) — meals, gifts, entertainment, travel.",
  },
  {
    key: "flag_receipts",
    icon: Receipt,
    title: "Missing Receipts",
    desc: "Flag transactions that should have a receipt attached (typically anything over $75 or the audit-safe threshold you set).",
  },
  {
    key: "flag_split_liabilities",
    icon: Scissors,
    title: "Liability Payment Splits",
    desc: "Flag loan / credit-card payments that need to be split between principal and interest instead of expensed whole.",
  },
];

export default function Welcome() {
  const nav = useNavigate();
  const { current, currentId, refresh } = useCompany();

  // Local editable state — hydrated from `current.compliance_flags`
  // once the company doc is available. Defaults for a fresh company
  // are all `true` since most owners want the AI to catch these.
  const initial = useMemo(() => {
    const cf = current?.compliance_flags || {};
    return {
      flag_irs_docs:          cf.flag_irs_docs          ?? true,
      flag_receipts:          cf.flag_receipts          ?? true,
      flag_split_liabilities: cf.flag_split_liabilities ?? true,
    };
  }, [current]);
  const [flags, setFlags] = useState(initial);
  useEffect(() => { setFlags(initial); }, [initial]);

  const [saving, setSaving] = useState(false);

  const toggle = (key) => setFlags(cur => ({ ...cur, [key]: !cur[key] }));

  const proceed = async () => {
    if (!currentId) { nav("/dashboard"); return; }
    setSaving(true);
    try {
      await api.patch(`/companies/${currentId}`, { compliance_flags: flags });
      await refresh?.();
      toast.success("Preferences saved. Welcome to SmartBooks.");
      nav("/dashboard");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save preferences — try again?");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white flex items-start justify-center p-6 pt-14">
      <div className="w-full max-w-2xl" data-testid="welcome-page">
        {/* Header — matches the visual language of the onboarding
             wizard: subdued brand chip + a bold, human-sounding
             greeting. */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center">
            <Sparkles size={16} className="text-white" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Onboarding · Complete
            </div>
            <div className="text-2xl font-bold text-slate-900 leading-tight">
              Congratulations!
            </div>
          </div>
        </div>

        {/* Reassurance block */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-5" data-testid="welcome-reassurance">
          <p className="text-slate-800 leading-relaxed">
            Your books for <b>{current?.name || "your company"}</b> are all set up
            and I'm currently working in the background to get them finalized —
            importing transactions, running AI categorization, and flagging
            anything that needs your eyes.
          </p>
          <p className="text-slate-600 text-sm mt-3">
            While that runs, a few quick housekeeping questions so I know how
            aggressively to flag things going forward.
          </p>
        </div>

        {/* Toggles */}
        <div className="space-y-3 mb-6">
          {FLAG_ROWS.map(row => {
            const Icon = row.icon;
            const on = !!flags[row.key];
            return (
              <div
                key={row.key}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex items-start gap-4"
                data-testid={`welcome-flag-${row.key}`}
              >
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${on ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
                  <Icon size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-900 text-[15px]">
                    {row.title}
                  </div>
                  <div className="text-[13px] text-slate-600 mt-0.5 leading-relaxed">
                    {row.desc}
                  </div>
                </div>
                <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-[12px] shrink-0" role="tablist">
                  <button
                    type="button"
                    onClick={() => setFlags(cur => ({ ...cur, [row.key]: true }))}
                    className={`px-3 py-1.5 inline-flex items-center gap-1 transition ${on ? "bg-emerald-600 text-white font-semibold" : "text-slate-700 hover:bg-slate-50"}`}
                    aria-pressed={on}
                    data-testid={`welcome-flag-${row.key}-yes`}
                  >
                    <Check size={12} /> Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setFlags(cur => ({ ...cur, [row.key]: false }))}
                    className={`px-3 py-1.5 inline-flex items-center gap-1 transition border-l border-slate-300 ${!on ? "bg-slate-900 text-white font-semibold" : "text-slate-700 hover:bg-slate-50"}`}
                    aria-pressed={!on}
                    data-testid={`welcome-flag-${row.key}-no`}
                  >
                    <X size={12} /> No
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => nav("/dashboard")}
            className="text-sm text-slate-500 hover:text-slate-900 transition"
            data-testid="welcome-skip"
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={proceed}
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow disabled:opacity-60 disabled:cursor-not-allowed"
            data-testid="welcome-continue"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Take me to my books <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Note: the underlying `toggle` helper is left in place for
// completeness — the per-row buttons currently set state directly.
// Kept exported-adjacent so a future "single toggle switch" refactor
// (one control per row instead of Yes/No pair) is trivial.
export { FLAG_ROWS as WELCOME_FLAG_ROWS };
