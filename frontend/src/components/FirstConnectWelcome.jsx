import { useEffect, useState } from "react";
import { Sparkles, Loader2, CheckCircle2 } from "lucide-react";
import { TID } from "@/constants/testIds";

/**
 * Warm handshake for first-time Plaid connects. Renders a full-width card
 * across the top of the Dashboard while the initial HISTORICAL_UPDATE webhook
 * is still importing the ~1,700-row backlog.
 *
 * Show rules:
 *   • an active sync_jobs row exists (status.status === "syncing"), AND
 *   • the company still has fewer than 500 txns.
 * Hide rules (auto):
 *   • total_txns crosses 500  ➜ we clearly have the bulk of the history
 *   • pill flips syncing → idle  ➜ sync just completed
 *
 * We also honor a per-company sessionStorage flag so the user can dismiss it
 * mid-way and never see it again this session for that company.
 */
export default function FirstConnectWelcome({ status, companyId, companyName }) {
  const totalTxns = status?.total_txns || 0;
  const target = status?.target;
  const percent = status?.percent;
  const stage = status?.stage;

  const key = companyId ? `axiom.welcome.dismissed.${companyId}` : null;
  const [dismissed, setDismissed] = useState(() => {
    if (!key) return false;
    try { return sessionStorage.getItem(key) === "1"; } catch { return false; }
  });
  // Reset dismissal when the company changes so the overlay can appear
  // for the next new connect in the same session.
  useEffect(() => {
    if (!key) return;
    try { setDismissed(sessionStorage.getItem(key) === "1"); } catch { setDismissed(false); }
  }, [key]);

  // Also auto-dismiss (persist) once we cross the "clearly landed" threshold.
  // This prevents flash-back on later polls that briefly reset status.
  useEffect(() => {
    if (!key) return;
    if (totalTxns >= 500 || status?.status === "idle") {
      try { sessionStorage.setItem(key, "1"); } catch { /* ignore */ }
    }
  }, [key, totalTxns, status?.status]);

  if (dismissed) return null;
  const isSyncing = status?.status === "syncing";
  const isFirstConnect = isSyncing && totalTxns < 500;
  if (!isFirstConnect) return null;

  const stageLabel =
    stage === "downloading" ? "Downloading transactions from your bank"
    : stage === "categorizing" ? "Categorizing transactions with AI"
    : "Setting up your books";

  return (
    <div
      data-testid={TID.firstConnectWelcome}
      className="relative overflow-hidden rounded-2xl border border-emerald-200/60 bg-gradient-to-br from-emerald-50 via-white to-sky-50 shadow-sm"
    >
      {/* Subtle animated shimmer for warmth */}
      <div className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent animate-[shimmer_2.4s_ease-in-out_infinite]" />
      <div className="relative flex items-start gap-4 p-5 md:p-6">
        <div className="flex-shrink-0 mt-0.5 h-10 w-10 rounded-xl bg-emerald-600/10 border border-emerald-600/20 grid place-items-center">
          <Sparkles size={18} className="text-emerald-700" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-heading text-lg font-semibold text-slate-900">
              Welcome{companyName ? `, ${companyName}` : ""} — we're setting up your books
            </h3>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
              <Loader2 size={10} className="animate-spin" /> importing
            </span>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            We're pulling your last <span className="font-semibold">24 months</span> of transaction history from your bank and running each one through our AI categorizer. This usually takes about <span className="font-semibold">60–90 seconds</span> — you can safely wait here, dashboard tiles will fill in as data lands.
          </p>

          {/* Progress line */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-slate-600 mb-1.5">
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin text-emerald-700" />
                <span className="font-medium">{stageLabel}</span>
              </span>
              <span className="font-mono-num text-slate-500">
                {target
                  ? <>{(status.imported ?? 0).toLocaleString()} <span className="text-slate-400">of ~{target.toLocaleString()}</span></>
                  : <>{totalTxns.toLocaleString()} so far</>
                }
                {percent != null && <span className="ml-1.5 text-emerald-700">· {percent}%</span>}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-emerald-100 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-emerald-600 transition-all duration-500 ease-out"
                style={{
                  width: percent != null ? `${Math.max(4, Math.min(percent, 100))}%`
                                        : target ? `${Math.max(4, Math.min(((status.imported ?? 0) / target) * 100, 100))}%`
                                        : "8%",
                }}
              />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-slate-600">
            <StepBadge label="Bank connected" done />
            <StepBadge label="Downloading history" done={stage !== "downloading"} active={stage === "downloading"} />
            <StepBadge label="AI categorizing" done={false} active={stage === "categorizing"} />
          </div>
        </div>

        <button
          data-testid={TID.firstConnectDismiss}
          onClick={() => {
            setDismissed(true);
            if (key) { try { sessionStorage.setItem(key, "1"); } catch { /* ignore */ } }
          }}
          className="flex-shrink-0 text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2"
        >
          hide
        </button>
      </div>
    </div>
  );
}

function StepBadge({ label, done, active }) {
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${
      done ? "bg-emerald-50 border-emerald-200 text-emerald-700"
      : active ? "bg-amber-50 border-amber-200 text-amber-800"
      : "bg-slate-50 border-slate-200 text-slate-500"
    }`}>
      {done
        ? <CheckCircle2 size={12} />
        : active ? <Loader2 size={12} className="animate-spin" />
        : <span className="h-3 w-3 rounded-full border border-slate-300" />
      }
      <span className="font-medium">{label}</span>
    </div>
  );
}
