/**
 * PlaidStartDateModal — pre-Link chooser for how far back to pull
 * transactions. Shows three options:
 *
 *   1. This year — start_date = Jan 1 of the current calendar year.
 *      Pre-selected by default (per user decision Feb 2026 — most
 *      users starting fresh on Axiom benefit from a lighter import).
 *   2. As far back as possible — start_date = today − 730 days
 *      (Plaid's cap; some banks return less but that's fine).
 *   3. Custom — a native date picker with guardrails:
 *        • no future dates
 *        • no dates > 730 days ago (Plaid can't retrieve them)
 *
 * On confirm, calls `onConfirm(iso_date | null)`. `null` means "no
 * cutoff — pull everything Plaid returns" (option 2 emits the
 * explicit 730-day date; only used as the fallback if the modal is
 * cancelled without picking).
 */
import { useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Calendar, History, CalendarClock, AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const _pad = (n) => String(n).padStart(2, "0");
const _isoOf = (d) => `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
const _todayIso = () => _isoOf(new Date());
const _thisYearJan1 = () => `${new Date().getFullYear()}-01-01`;
const _maxLookbackIso = () => {
  const d = new Date();
  d.setDate(d.getDate() - 730);
  return _isoOf(d);
};

// Nuke Plaid Link's session cookies on the plaid.com origin. Loads
// their public logout endpoint in an off-screen iframe → Plaid clears
// its own returning-user state → next Link open forces the full
// "search + login" flow instead of "Continue with previously linked
// institution". Belt-and-suspenders on top of the backend nonce; safe
// to call unconditionally.
const _resetPlaidSession = () => new Promise((resolve) => {
  try {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-9999px";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.border = "0";
    iframe.src = "https://cdn.plaid.com/link/logout";
    iframe.onload = () => {
      setTimeout(() => {
        try { document.body.removeChild(iframe); } catch { /* noop */ }
        resolve();
      }, 300);
    };
    // Fallback in case the iframe never loads (network/blocker).
    setTimeout(() => {
      try { document.body.removeChild(iframe); } catch { /* noop */ }
      resolve();
    }, 2500);
    document.body.appendChild(iframe);
  } catch {
    resolve();
  }
});

export default function PlaidStartDateModal({
  open, onOpenChange, onConfirm,
  companyName,   // optional — shown in the "who am I linking?" banner
  companyOwner,  // optional — owner/client email for extra disambiguation
}) {
  // Three options, "This year" pre-selected per product decision.
  const [choice, setChoice] = useState("this_year");
  const [customDate, setCustomDate] = useState("");
  const [resetting, setResetting] = useState(false);

  const bounds = useMemo(() => ({
    min: _maxLookbackIso(),
    max: _todayIso(),
  }), []);

  const resolveDate = () => {
    if (choice === "this_year") return _thisYearJan1();
    if (choice === "max") return _maxLookbackIso();
    if (choice === "custom" && customDate) return customDate;
    return null;  // no valid selection
  };

  const submit = () => {
    const iso = resolveDate();
    if (!iso) return; // custom picked but no date typed — button disabled
    onConfirm?.(iso);
    onOpenChange?.(false);
  };

  const handleResetSession = async () => {
    setResetting(true);
    try {
      await _resetPlaidSession();
      toast.success("Plaid session cleared — next open will start fresh.");
    } finally {
      setResetting(false);
    }
  };

  const options = [
    {
      key: "this_year",
      icon: CalendarClock,
      title: "This year",
      subtitle: `From January 1, ${new Date().getFullYear()}`,
      hint: "Recommended — lighter import, faster review.",
    },
    {
      key: "max",
      icon: History,
      title: "As far back as possible",
      subtitle: "Up to 24 months (Plaid's maximum)",
      hint: "Best for full historical bookkeeping.",
    },
    {
      key: "custom",
      icon: Calendar,
      title: "Custom start date",
      subtitle: "Pick any date within the last 24 months",
      hint: "For a specific fiscal year, business launch date, etc.",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="plaid-start-date-modal"
        className="max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>How far back should we pull transactions?</DialogTitle>
          <DialogDescription>
            Pick a starting date. Plaid can return up to 24 months of history,
            but you don&apos;t have to import all of it — a lighter start means
            fewer transactions to review.
          </DialogDescription>
        </DialogHeader>

        {companyName && (
          <div
            data-testid="plaid-link-target-banner"
            className="rounded-lg border-2 border-amber-300 bg-amber-50 px-3 py-2.5 flex items-start gap-2.5"
          >
            <AlertTriangle size={16} className="text-amber-700 mt-0.5 shrink-0" />
            <div className="text-xs text-amber-900 leading-snug flex-1">
              <div>
                You&apos;re about to link bank credentials for{" "}
                <b className="text-amber-950">{companyName}</b>
                {companyOwner && (
                  <span className="text-amber-800"> · owned by {companyOwner}</span>
                )}
                .
              </div>
              <div className="mt-1 text-amber-800">
                Confirm the bank credentials you&apos;re about to enter belong to
                <b> this client</b>, not a previous one. If Plaid opens with a
                &ldquo;continue with previously linked bank&rdquo; screen for a
                different client, cancel and use{" "}
                <button
                  type="button"
                  disabled={resetting}
                  onClick={handleResetSession}
                  className="inline-flex items-center gap-1 underline decoration-amber-500 decoration-2 hover:text-amber-950 disabled:opacity-60"
                  data-testid="plaid-reset-session"
                >
                  <RefreshCw size={11} className={resetting ? "animate-spin" : ""} />
                  Reset Plaid session
                </button>
                {" "}before retrying.
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2 py-2">
          {options.map((opt) => {
            const Icon = opt.icon;
            const selected = choice === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                data-testid={`plaid-start-option-${opt.key}`}
                onClick={() => setChoice(opt.key)}
                className={[
                  "w-full text-left rounded-lg border-2 p-3 transition-all",
                  selected
                    ? "border-emerald-500 bg-emerald-50/60 shadow-sm"
                    : "border-slate-200 bg-white hover:border-slate-300",
                ].join(" ")}
                aria-pressed={selected}
              >
                <div className="flex items-start gap-3">
                  <Icon
                    size={18}
                    className={selected ? "text-emerald-700 mt-0.5" : "text-slate-500 mt-0.5"}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-slate-900">
                      {opt.title}
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">
                      {opt.subtitle}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      {opt.hint}
                    </div>
                    {opt.key === "custom" && selected && (
                      <input
                        data-testid="plaid-start-custom-date"
                        type="date"
                        min={bounds.min}
                        max={bounds.max}
                        value={customDate}
                        onChange={(e) => setCustomDate(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-2 px-2 py-1.5 border border-slate-300 rounded-md text-sm w-48"
                      />
                    )}
                  </div>
                  {selected && (
                    <span className="text-xs font-medium text-emerald-700 shrink-0">
                      Selected
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <button
            data-testid="plaid-start-cancel"
            onClick={() => onOpenChange?.(false)}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
          >
            Cancel
          </button>
          <button
            data-testid="plaid-start-continue"
            onClick={submit}
            disabled={choice === "custom" && !customDate}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            Continue to Plaid
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
