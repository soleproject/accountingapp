/**
 * CheckinItemsTile
 *
 * Inline expandable content for the 4 Quick Check-in cards on the
 * Responsibilities panel (Liability Payments / Checks / Receipt
 * Follow-up / IRS Compliance). Each row is one open item from the
 * current `client_review_batches` doc — every action deep-links into
 * the same magic-link Quick Check-in flow the client sees, so a CPA
 * can preview exactly what's waiting on their client's response.
 */
import React from "react";
import { useMoneyFmt } from "@/lib/company";
import { CheckCircle2, ExternalLink } from "lucide-react";

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
}) {
  const fmtMoney = useMoneyFmt();
  // Redirect endpoint that 302s to `/client-review/{token}` for the
  // current open batch. Same URL PendingReviewCard uses. Opens in a
  // new tab so the CPA doesn't lose their place on the cockpit.
  const openUrl = `${process.env.REACT_APP_BACKEND_URL}/api/client-review/pending/${companyId}/open`;

  if (!items.length) {
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
          <span>{items.length} {bucketLabel} in the current check-in</span>
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
            {items.map((it, idx) => {
              const rowKey = it.id || it.source_id || idx;
              return (
                <tr key={rowKey} className="hover:bg-slate-50" data-testid={`checkin-item-row-${rowKey}`}>
                  <td className="px-3 py-2 text-slate-600 font-mono-num whitespace-nowrap">
                    {fmtDate(it.date)}
                  </td>
                  <td className="px-3 py-2 text-slate-900">
                    <div
                      className="truncate max-w-[420px]"
                      title={it.prompt || it.description || ""}
                    >
                      {it.description || it.prompt || "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono-num tabular-nums text-slate-900 whitespace-nowrap">
                    {it.amount !== null && it.amount !== undefined
                      ? fmtMoney(it.amount)
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <a
                      href={openUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-indigo-700 hover:text-indigo-900 inline-flex items-center gap-1"
                      data-testid={`checkin-item-open-${rowKey}`}
                    >
                      Answer <ExternalLink size={10} />
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
