/**
 * MerchantReviewList — table view of payments applications filtered
 * by a URL segment (`awaiting` | `approved` | `declined`). Powered
 * by GET /api/underwriter/apps; client-side filter/search.
 *
 * Row click → dedicated detail page at /admin/merchant-review/apps/:cid.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ShieldCheck, Search, Loader2, ArrowUpDown, Users, FileText, Percent,
} from "lucide-react";
import { api } from "@/lib/api";

const STATUS_LABEL = {
  submitted: { text: "Awaiting review", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  approved:  { text: "Approved",        cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  declined:  { text: "Declined",        cls: "bg-rose-50 text-rose-700 border-rose-200" },
};

// URL segment → DB status. `awaiting` is a UI-only alias for `submitted`
// because "awaiting review" reads better in navigation.
const SEG_TO_STATUS = { awaiting: "submitted", approved: "approved", declined: "declined" };

function StatusPill({ status }) {
  const s = STATUS_LABEL[status] || STATUS_LABEL.submitted;
  return (
    <span className={`inline-block text-[10px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded border ${s.cls}`}>
      {s.text}
    </span>
  );
}

export default function MerchantReviewList() {
  const { bucket } = useParams();   // "awaiting" | "approved" | "declined"
  const status = SEG_TO_STATUS[bucket] || "submitted";
  const [items, setItems] = useState(null);
  const [q, setQ] = useState("");
  const nav = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get("/underwriter/apps");
        setItems(r.data?.items || []);
      } catch (e) {
        toast.error(e?.response?.data?.detail || "Couldn't load applications");
        setItems([]);
      }
    })();
  }, []);

  const rows = useMemo(() => {
    if (!items) return [];
    const needle = q.trim().toLowerCase();
    return items
      .filter((i) => i.status === status)
      .filter((i) => !needle || (i.company_name || "").toLowerCase().includes(needle) || (i.dba || "").toLowerCase().includes(needle));
  }, [items, status, q]);

  const title = {
    submitted: { h: "Awaiting Review", sub: "Applications the merchant has submitted — approve or decline to move them along." },
    approved:  { h: "Approved",        sub: "Merchants who are live and accepting payments through the gateway." },
    declined:  { h: "Declined",        sub: "Applications turned down. Reconsider any of these to re-approve." },
  }[status];

  return (
    <div className="min-h-screen bg-slate-50" data-testid="merchant-review-list">
      <div className="max-w-[1300px] mx-auto px-6 py-6">
        <div className="flex items-baseline justify-between gap-4 flex-wrap mb-4">
          <div>
            <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.15em] font-semibold text-slate-500">
              <ShieldCheck size={13} /> Underwriter Portal
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">{title.h}</h1>
            <p className="text-[13px] text-slate-500 mt-1">{title.sub}</p>
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by legal name or DBA…"
              className="pl-7 pr-3 py-1.5 text-[13px] rounded-md border border-slate-300 bg-white w-72"
              data-testid="mr-list-search"
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          {items === null ? (
            <div className="p-12 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center text-[13px] text-slate-500">
              {q ? `No applications match "${q}".` : `No ${title.h.toLowerCase()} applications yet.`}
            </div>
          ) : (
            <table className="w-full text-[13px]" data-testid="mr-list-table">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                  <th className="text-left px-4 py-2.5">
                    <span className="inline-flex items-center gap-1"><ArrowUpDown size={10} /> Business</span>
                  </th>
                  <th className="text-left px-4 py-2.5">DBA</th>
                  <th className="text-left px-4 py-2.5">Submitted</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-right px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => (
                  <tr
                    key={it.company_id}
                    onClick={() => nav(`/admin/merchant-review/apps/${it.company_id}`)}
                    className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                    data-testid={`mr-list-row-${it.company_id}`}
                  >
                    <td className="px-4 py-3 font-semibold text-slate-900">{it.company_name}</td>
                    <td className="px-4 py-3 text-slate-600">{it.dba || <span className="text-slate-300">—</span>}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {it.submitted_at ? new Date(it.submitted_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"}
                    </td>
                    <td className="px-4 py-3"><StatusPill status={it.status} /></td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-slate-400 text-[12px]">Open →</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {items !== null && (
          <div className="mt-3 text-[11px] text-slate-500">
            Showing {rows.length} {rows.length === 1 ? "application" : "applications"}
            {q && ` (filtered from ${items.filter(i => i.status === status).length} total)`}
          </div>
        )}
      </div>
    </div>
  );
}
