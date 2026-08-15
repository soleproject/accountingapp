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
import { Calendar, History, CalendarClock } from "lucide-react";

const _pad = (n) => String(n).padStart(2, "0");
const _isoOf = (d) => `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
const _todayIso = () => _isoOf(new Date());
const _thisYearJan1 = () => `${new Date().getFullYear()}-01-01`;
const _maxLookbackIso = () => {
  const d = new Date();
  d.setDate(d.getDate() - 730);
  return _isoOf(d);
};

export default function PlaidStartDateModal({
  open, onOpenChange, onConfirm,
}) {
  // Three options, "This year" pre-selected per product decision.
  const [choice, setChoice] = useState("this_year");
  const [customDate, setCustomDate] = useState("");

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
