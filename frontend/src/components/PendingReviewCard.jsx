import React, { useEffect, useState } from "react";
import { ArrowRight, ClipboardCheck, Calendar, Clock } from "lucide-react";
import { api } from "@/lib/api";

/**
 * PendingReviewCard — top-of-page nudge shown to a client (or the pro
 * viewing the client's own screen) when there's an open batch review
 * session waiting for them. Renders `null` when nothing is pending —
 * safe to drop on any page as a passive header slot.
 *
 * Mounted on Overview (`/dashboard`), To Do (`/accounting/todo`), and
 * Client Cockpit (`/cockpit/client`). Same component, same data
 * source, three surfaces.
 */
export default function PendingReviewCard({ companyId }) {
  const [state, setState] = useState({ loading: true, data: null });

  useEffect(() => {
    let cancelled = false;
    if (!companyId) {
      setState({ loading: false, data: null });
      return () => {};
    }
    (async () => {
      try {
        const r = await api.get(
          `/client-review/pending/${companyId}`
        );
        if (!cancelled) setState({ loading: false, data: r.data });
      } catch {
        if (!cancelled) setState({ loading: false, data: null });
      }
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  if (state.loading || !state.data?.has_pending) return null;
  const d = state.data;

  // Distinct copy for scheduled vs open — scheduled means the client
  // already picked a time; we're just reminding them the batch is
  // still there.
  const isScheduled = d.status === "scheduled" && d.scheduled_for;
  const remaining = d.item_count || 0;
  const timeLabel = isScheduled ? fmtWhen(d.scheduled_for) : null;
  const daysLeft = d.expires_at
    ? Math.max(0, Math.round((new Date(d.expires_at) - Date.now()) / 86400000))
    : null;

  const openUrl = `${process.env.REACT_APP_BACKEND_URL}/api/client-review/pending/${companyId}/open`;

  return (
    <div
      className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 flex items-center gap-3 shadow-sm"
      data-testid="pending-review-card"
    >
      <div className="shrink-0 w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center">
        <ClipboardCheck size={16} className="text-amber-800" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-heading text-slate-900">
          {isScheduled
            ? `Your review is scheduled — ${remaining} question${remaining === 1 ? "" : "s"}`
            : `${remaining} question${remaining === 1 ? "" : "s"} waiting for you`}
        </div>
        <div className="mt-0.5 text-[11px] text-slate-600 flex items-center gap-2 flex-wrap">
          {isScheduled ? (
            <>
              <Calendar size={11} className="text-slate-500" />
              <span>{timeLabel}</span>
            </>
          ) : (
            <>
              <Clock size={11} className="text-slate-500" />
              <span>Takes about {Math.max(2, remaining * 0.5).toFixed(0)} minutes</span>
            </>
          )}
          {daysLeft !== null && daysLeft <= 3 && (
            <span className="text-rose-700 font-semibold">
              · {daysLeft === 0 ? "expires today" : `${daysLeft}d left`}
            </span>
          )}
        </div>
      </div>
      <a
        href={openUrl}
        className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
        data-testid="pending-review-open"
      >
        Answer now <ArrowRight size={12} />
      </a>
    </div>
  );
}

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMs = d - now;
  if (diffMs < 0) return "any time now";
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);
  if (days === 0 && hours === 0) return "in less than an hour";
  if (days === 0) return `in ${hours}h`;
  if (days === 1) {
    return `tomorrow at ${d.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit"
    })}`;
  }
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}
