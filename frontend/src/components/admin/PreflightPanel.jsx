import { useEffect, useState } from "react";
import { Loader2, AlertTriangle, Pencil, SlidersHorizontal } from "lucide-react";
import { api } from "@/lib/api";
import { PlanOverride } from "@/components/admin/PlanOverride";

const OUTCOME = {
  gated: ["Will be gated", "bg-amber-100 text-amber-800"],
  core_fallback: ["Canceled → Core", "bg-rose-100 text-rose-800"],
  trial: ["Trial · full access", "bg-sky-100 text-sky-800"],
  all_access: ["Full access", "bg-emerald-100 text-emerald-800"],
};
const q = (v) => (v == null ? "∞" : v);

export function PreflightPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null); // null | { cid: string|null }
  const load = () => api.get("/admin/entitlements/preflight").then((r) => setD(r.data)).catch((e) => setErr(e.response?.data?.detail || "Couldn't load preflight"));
  useEffect(() => { load(); }, []);

  return (
    <div className="rounded-xl border border-slate-200 bg-white" data-testid="admin-entitlements-preflight">
      <div className="p-4 border-b border-slate-100 flex items-start gap-3">
        <div className="flex-1">
          <div className="text-sm font-semibold">Pre-flight · companies with a paid plan on file</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {d ? <>
              <b data-testid="preflight-gated">{d.gated}</b> would be gated · <b data-testid="preflight-over">{d.over_quota}</b> over a seat/account cap (grandfathered) · {d.no_plan} of {d.total_companies} companies have no plan → full access
            </> : err || "Loading…"}
          </div>
        </div>
        <button onClick={() => setEdit(edit ? null : { cid: null })} className="h-8 px-3 rounded-lg border border-slate-300 text-xs font-semibold inline-flex items-center gap-1.5" data-testid="preflight-override-toggle">
          <SlidersHorizontal size={13} /> Set plan for testing
        </button>
      </div>
      {edit && <div className="p-3 border-b border-slate-100"><PlanOverride key={edit.cid || "new"} initialCompanyId={edit.cid} onSaved={() => { setEdit(null); load(); }} onClose={() => setEdit(null)} /></div>}
      {!d && !err && <div className="p-6 text-slate-500 text-sm inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Checking every company…</div>}
      {d && d.rows.length === 0 && <div className="p-6 text-sm text-slate-500" data-testid="preflight-empty">No company has a paid plan recorded yet — enforcement would change nothing today.</div>}
      {d && d.rows.length > 0 && (
        <table className="w-full text-sm" data-testid="preflight-table">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Company</th>
              <th className="text-left px-3 py-2">Plan on file</th>
              <th className="text-left px-3 py-2">Payer · status</th>
              <th className="text-left px-3 py-2">Users</th>
              <th className="text-left px-3 py-2">Bank accts</th>
              <th className="text-left px-3 py-2">After flip</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => {
              const [label, cls] = OUTCOME[r.outcome];
              const uOver = r.over.includes("users"), aOver = r.over.includes("connected_accounts");
              return (
                <tr key={r.company_id} className="border-t border-slate-100" data-testid={`preflight-row-${r.company_id}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium truncate max-w-[220px]">{r.name}</div>
                    <div className="text-[11px] text-slate-500 truncate max-w-[220px]">{r.owner_email || "—"}</div>
                  </td>
                  <td className="px-3 py-2">{r.plan_label}{!r.has_stripe_sub && <span className="ml-1 text-[10px] text-slate-400" title="No Stripe subscription id on file — plan was set manually or inferred">manual</span>}</td>
                  <td className="px-3 py-2 text-slate-600">{r.payer || "—"}{r.sub_status ? ` · ${r.sub_status}` : ""}{r.grace && <span className="ml-1 text-[10px] text-amber-700">grace</span>}</td>
                  <td className={`px-3 py-2 font-mono-num ${uOver ? "text-rose-700 font-semibold" : ""}`}>{r.usage.users} / {q(r.quotas?.users)}{uOver && <AlertTriangle size={11} className="inline ml-1" />}</td>
                  <td className={`px-3 py-2 font-mono-num ${aOver ? "text-rose-700 font-semibold" : ""}`}>{r.usage.connected_accounts} / {q(r.quotas?.connected_accounts)}{aOver && <AlertTriangle size={11} className="inline ml-1" />}</td>
                  <td className="px-3 py-2"><span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span></td>
                  <td className="px-2 py-2 text-right">
                    <button onClick={() => setEdit({ cid: r.company_id })} className="text-slate-400 hover:text-slate-900" title="Change plan / payer / status" data-testid={`preflight-edit-${r.company_id}`}><Pencil size={13} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
