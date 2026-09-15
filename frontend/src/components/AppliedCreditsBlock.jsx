import { useState } from "react";
import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import { Link2Off, Undo2 } from "lucide-react";

/**
 * AppliedCreditsBlock — shared UI for the "Applied credits" section
 * that renders on both the Bill Editor (Vendor Credits) and the
 * Invoice Editor (Credit Memos). One row per applied credit with an
 * Unlink button. Unlinking calls the backend unlink endpoint which
 * (a) reverses the balance_due decrement, (b) flips the doc's status
 * back to `open`/`partial`, (c) clears both sides of the link, and
 * (d) pulls the credit off the doc's audit trail. See
 * `routes/transactions.py` — `unlink_vendor_credit_from_bill` and
 * `unlink_credit_memo_from_invoice`.
 *
 * Props:
 *   credits: [{id, date, number, amount, contact_name, description}]
 *   kind:    "bill" | "invoice"
 *   docId:   parent bill / invoice ID
 *   currentId: company_id
 *   onUnlinked: () => refetch credits & totals after unlink
 */
export default function AppliedCreditsBlock({
  credits = [], kind, docId, currentId, onUnlinked,
}) {
  const fmtMoney = useMoneyFmt();
  const [busyId, setBusyId] = useState(null);

  const label     = kind === "bill" ? "Applied vendor credits"
                                     : "Applied credit memos";
  const singular  = kind === "bill" ? "vendor credit" : "credit memo";
  const endpoint  = kind === "bill"
    ? `/companies/${currentId}/bills/${docId}/unlink-credit`
    : `/companies/${currentId}/invoices/${docId}/unlink-credit-memo`;
  const total = credits.reduce((s, c) => s + Number(c.amount || 0), 0);

  const unlink = async (c) => {
    if (!window.confirm(
      `Unlink this ${singular}? The ${kind}'s balance_due will be restored ` +
      `by $${Number(c.amount || 0).toFixed(2)}.`
    )) return;
    setBusyId(c.id);
    try {
      await api.post(`${endpoint}/${c.id}`);
      toast.success(`${singular === "vendor credit" ? "Vendor credit" : "Credit memo"} unlinked. Balance restored.`);
      if (onUnlinked) await onUnlinked();
    } catch (e) {
      toast.error(e?.response?.data?.detail || `Failed to unlink ${singular}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="px-6 py-5 border-t bg-amber-50/30" data-testid="applied-credits-block">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <Undo2 className="h-4 w-4 text-amber-700" /> {label}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Non-cash credits reducing this {kind}'s balance. Unlink to
            restore the balance and free the credit for another {kind}.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
            Total applied
          </div>
          <div className="text-base font-semibold text-slate-900 tabular-nums">
            {fmtMoney(total)}
          </div>
        </div>
      </div>
      <ul className="space-y-2">
        {credits.map((c) => (
          <li key={c.id}
              className="flex items-center gap-3 bg-white rounded-lg ring-1 ring-slate-200 px-3 py-2 shadow-sm"
              data-testid={`applied-credit-row-${c.id}`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono-num text-slate-800 text-sm">
                  {c.number || c.id.slice(0, 8)}
                </span>
                <span className="text-slate-500 text-xs">{c.date}</span>
                {c.contact_name && (
                  <span className="text-slate-600 text-xs">
                    · {c.contact_name}
                  </span>
                )}
              </div>
              {c.description && (
                <div className="text-xs text-slate-500 truncate mt-0.5">
                  {c.description}
                </div>
              )}
            </div>
            <div className="font-semibold text-slate-900 tabular-nums">
              {fmtMoney(c.amount)}
            </div>
            <button
              type="button"
              onClick={() => unlink(c)}
              disabled={busyId === c.id}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md ring-1 ring-slate-300 text-slate-700 hover:ring-rose-400 hover:text-rose-700 disabled:opacity-50"
              data-testid={`applied-credit-unlink-${c.id}`}
            >
              <Link2Off className="h-3.5 w-3.5" />
              {busyId === c.id ? "Unlinking…" : "Unlink"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
