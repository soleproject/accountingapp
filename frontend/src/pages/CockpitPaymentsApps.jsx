/**
 * CockpitPaymentsApps — firm-wide list of "Get Paid Faster" payments
 * applications across every client the current Pro can access.
 *
 * Data comes from `GET /api/pro/payments-apps` (membership-scoped);
 * rows are bucketed into "In progress" (draft) and "Submitted", each
 * sorted most-recent-first. Clicking a row switches the active
 * company and jumps into `/welcome/payments`, which auto-lands the
 * user on the first incomplete step of the wizard.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, CreditCard, Search } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

function StatusPill({ status }) {
  const draft = status === "draft";
  return (
    <span className={`inline-block text-[10px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded ${
      draft
        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
        : "bg-slate-100 text-slate-600 border border-slate-200"
    }`}>
      {draft ? "Draft" : "Submitted"}
    </span>
  );
}

function Row({ it, onOpen }) {
  const pct = Math.round(it.pct || 0);
  const draft = it.status === "draft";
  const when = (draft ? it.updated_at : (it.submitted_at || it.updated_at)) || "";
  const whenLabel = when
    ? new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "";
  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50" data-testid={`payments-app-row-${it.company_id}`}>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-slate-900 truncate">{it.company_name}</div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="inline-block w-40 h-1.5 bg-slate-200 rounded overflow-hidden">
            <span
              className={`block h-full transition-all ${draft ? "bg-emerald-500" : "bg-slate-500"}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="text-[11px] text-slate-500">{pct}% complete</span>
          {draft && it.ownership_pct != null && (
            <span className={`text-[11px] ${it.ownership_pct >= 80 ? "text-emerald-600" : "text-amber-600"}`}>
              · {Math.round(it.ownership_pct)}% ownership
            </span>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <StatusPill status={it.status} />
        {whenLabel && <div className="text-[11px] text-slate-400 mt-1">{whenLabel}</div>}
      </div>
      <button
        type="button"
        onClick={() => onOpen(it.company_id)}
        className="text-[12px] px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-semibold shrink-0"
        data-testid={`payments-app-open-${it.company_id}`}
      >
        Open
      </button>
    </li>
  );
}

export default function CockpitPaymentsApps() {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState("");
  const { switchCompany } = useCompany();
  const navigate = useNavigate();

  useEffect(() => {
    let cancel = false;
    api.get("/pro/payments-apps")
      .then((r) => { if (!cancel) setItems(r.data?.items || []); })
      .catch(() => { if (!cancel) setItems([]); });
    return () => { cancel = true; };
  }, []);

  const openApp = (cid) => {
    if (switchCompany) switchCompany(cid);
    navigate("/welcome/payments");
  };

  const filtered = useMemo(() => {
    if (!items) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((i) => (i.company_name || "").toLowerCase().includes(needle));
  }, [items, q]);

  const drafts    = filtered.filter((i) => i.status === "draft");
  const submitted = filtered.filter((i) => i.status === "submitted");

  return (
    <div className="min-h-screen bg-slate-50" data-testid="cockpit-payments-apps-page">
      <div className="max-w-[1100px] mx-auto px-6 py-6 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.15em] font-semibold text-slate-500">
              <CreditCard size={13} /> Pro Cockpit
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">Payments applications</h1>
            <p className="text-[13px] text-slate-500 mt-1 max-w-2xl">
              Every client's "Get Paid Faster" application — drafts you can nudge and submitted apps
              waiting on the processor. Click Open to jump into a client's wizard.
            </p>
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search clients…"
              className="pl-7 pr-3 py-1.5 text-[13px] rounded-md border border-slate-300 bg-white focus:border-slate-500 focus:ring-1 focus:ring-slate-500 outline-none w-64"
              data-testid="payments-apps-search"
            />
          </div>
        </div>

        {items === null ? (
          <div className="py-24 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center shadow-sm">
            <div className="text-[14px] font-semibold text-slate-900">No payments applications yet</div>
            <div className="text-[12px] text-slate-500 mt-1">
              Once a client starts a "Get Paid Faster" application, it'll show up here.
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Summary chips */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-[12px] font-semibold px-2.5 py-1">
                {drafts.length} in progress
              </div>
              <div className="rounded-full bg-slate-100 border border-slate-200 text-slate-600 text-[12px] font-semibold px-2.5 py-1">
                {submitted.length} submitted
              </div>
              {q && (
                <div className="text-[12px] text-slate-500">
                  · filtered from {items.length} total
                </div>
              )}
            </div>

            {/* In-progress bucket */}
            {drafts.length > 0 && (
              <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden" data-testid="payments-apps-drafts">
                <div className="px-4 py-2.5 bg-emerald-50/50 border-b border-slate-200 text-[11px] uppercase tracking-widest text-emerald-700 font-semibold">
                  In progress ({drafts.length})
                </div>
                <ul className="divide-y divide-slate-100">
                  {drafts.map((it) => <Row key={it.company_id} it={it} onOpen={openApp} />)}
                </ul>
              </section>
            )}

            {/* Submitted bucket */}
            {submitted.length > 0 && (
              <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden" data-testid="payments-apps-submitted">
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-widest text-slate-500 font-semibold">
                  Submitted ({submitted.length})
                </div>
                <ul className="divide-y divide-slate-100">
                  {submitted.map((it) => <Row key={it.company_id} it={it} onOpen={openApp} />)}
                </ul>
              </section>
            )}

            {filtered.length === 0 && (
              <div className="text-[13px] text-slate-500 italic text-center py-6">
                No applications match "{q}".
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
