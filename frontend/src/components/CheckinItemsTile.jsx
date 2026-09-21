/**
 * CheckinItemsTile
 *
 * Inline expandable content for the 4 Quick Check-in cards on the
 * Responsibilities panel (Liability Payments / Checks / Receipt
 * Follow-up / IRS Compliance). Each row is one open item from the
 * current `client_review_batches` doc; clicking "Answer" toggles a
 * type-specific inline form (see `CheckinAnswerForm`) that captures
 * the IRS-required fields + optional receipt without leaving the
 * cockpit. The magic-link Quick Check-in remains available as a
 * top-right "Open check-in" button for anything the inline form
 * intentionally doesn't cover (e.g. the full multi-line check
 * allocator).
 */
import React, { useState } from "react";
import { useMoneyFmt } from "@/lib/company";
import { CheckCircle2, ExternalLink, ChevronDown } from "lucide-react";
import CheckinAnswerForm from "@/components/CheckinAnswerForm";

const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch { return iso; }
};

export default function CheckinItemsTile({
  companyId,
  items = [],
  bucketLabel = "items",
  emptyLabel = "All caught up",
  onItemAnswered,
}) {
  const fmtMoney = useMoneyFmt();
  const [openItemId, setOpenItemId] = useState(null);
  // Rows that have been answered locally; used for a brief "fade out"
  // transition before the parent's next `load()` cycle drops them.
  const [answered, setAnswered] = useState(() => new Set());

  const openUrl = `${process.env.REACT_APP_BACKEND_URL}/api/client-review/pending/${companyId}/open`;

  const handleSubmitted = (itemId) => {
    setAnswered(prev => new Set(prev).add(itemId));
    setOpenItemId(null);
    // Give the row half a second to fade before asking parent to reload.
    setTimeout(() => onItemAnswered?.(itemId), 400);
  };

  const visibleItems = items.filter(it => !answered.has(it.id));

  if (!visibleItems.length) {
    return (
      <div
        className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50/40 p-4 text-center text-sm text-emerald-800 flex items-center justify-center gap-2"
        data-testid="checkin-items-tile-empty"
      >
        <CheckCircle2 size={14} /> {emptyLabel} — no {bucketLabel} waiting on the client.
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white overflow-hidden" data-testid="checkin-items-tile">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-slate-50 text-[11px] gap-2 flex-wrap">
        <div className="text-slate-600">
          <span>{visibleItems.length} {bucketLabel} in the current check-in</span>
        </div>
        <a
          href={openUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 font-medium"
          data-testid="checkin-items-tile-open-all"
        >
          Open check-in <ExternalLink size={10} />
        </a>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-500 bg-white border-b">
              <th className="text-left px-3 py-2 font-semibold">Date</th>
              <th className="text-left px-3 py-2 font-semibold">Detail</th>
              <th className="text-right px-3 py-2 font-semibold">Amount</th>
              <th className="text-right px-3 py-2 font-semibold w-[90px]"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleItems.map((it, idx) => {
              const rowKey = it.id || it.source_id || idx;
              const isOpen = openItemId === it.id;
              return (
                <React.Fragment key={rowKey}>
                  <tr
                    className={`hover:bg-slate-50 ${isOpen ? "bg-indigo-50/40" : ""}`}
                    data-testid={`checkin-item-row-${rowKey}`}
                  >
                    <td className="px-3 py-2 text-slate-600 font-mono-num whitespace-nowrap align-top">
                      {fmtDate(it.date)}
                    </td>
                    <td className="px-3 py-2 text-slate-900 align-top">
                      <div
                        className="truncate max-w-[420px]"
                        title={it.prompt || it.description || ""}
                      >
                        {it.description || it.prompt || "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono-num tabular-nums text-slate-900 whitespace-nowrap align-top">
                      {it.amount !== null && it.amount !== undefined
                        ? fmtMoney(it.amount)
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap align-top">
                      <button
                        type="button"
                        onClick={() => setOpenItemId(isOpen ? null : it.id)}
                        className={`text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded-md border transition-colors ${
                          isOpen
                            ? "bg-indigo-600 text-white border-indigo-600"
                            : "bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                        }`}
                        data-testid={`checkin-item-answer-${rowKey}`}
                      >
                        {isOpen ? "Hide" : "Answer"}
                        <ChevronDown
                          size={11}
                          className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr data-testid={`checkin-item-form-row-${rowKey}`}>
                      <td colSpan={4} className="px-3 pb-3 bg-indigo-50/30">
                        <CheckinAnswerForm
                          companyId={companyId}
                          item={it}
                          onCancel={() => setOpenItemId(null)}
                          onSubmitted={handleSubmitted}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
