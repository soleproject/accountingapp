import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, Lock, RefreshCw, Loader2, ShieldCheck, ShieldAlert, Mail } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { FEATURE_COPY } from "@/lib/entitlements";

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

function Stat({ label, value, testid }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4" data-testid={testid}>
      <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500">{label}</div>
      <div className="text-2xl font-heading mt-1">{value}</div>
    </div>
  );
}

function Breakdown({ title, items, labelOf, testid }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4" data-testid={testid}>
      <div className="text-sm font-semibold mb-3">{title}</div>
      {items.length === 0 && <div className="text-xs text-slate-500">No shadow blocks in this window.</div>}
      <div className="space-y-2">
        {items.map((i) => (
          <div key={labelOf(i)} className="text-xs">
            <div className="flex justify-between"><span className="truncate">{labelOf(i)}</span><span className="font-mono-num text-slate-600">{i.count}</span></div>
            <div className="h-1.5 rounded bg-slate-100 mt-1"><div className="h-1.5 rounded bg-slate-900" style={{ width: `${(i.count / max) * 100}%` }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminEntitlements() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const sendDigest = async () => {
    setSending(true);
    try {
      const r = (await api.post("/cron/entitlement-digest/trigger?force=true")).data;
      if (r.sent) toast.success(`Digest sent to ${r.recipients} recipient${r.recipients === 1 ? "" : "s"} · ${r.blocks} block${r.blocks === 1 ? "" : "s"} in the last 24h`);
      else toast.error(`Digest not sent: ${r.error || r.skipped || "unknown"}`);
    } catch (e) { toast.error(e.response?.data?.detail || "Couldn't send digest"); }
    finally { setSending(false); }
  };

  const load = async () => {
    setLoading(true);
    try { setData((await api.get(`/admin/entitlements/events?days=${days}`)).data); }
    catch { setData(null); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = data?.totals || {};
  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-6" data-testid="admin-entitlements-page">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900" data-testid="admin-entitlements-back"><ChevronLeft size={16} /> Admin</Link>
        <h1 className="font-heading text-2xl flex-1">Plan gating · shadow events</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-9 rounded-lg border border-slate-300 px-2 text-sm" data-testid="admin-entitlements-days">
          {[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
        <button onClick={load} className="h-9 px-3 rounded-lg border border-slate-300 text-sm inline-flex items-center gap-1.5" data-testid="admin-entitlements-refresh">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
        </button>
        <button onClick={sendDigest} disabled={sending} className="h-9 px-3 rounded-lg bg-slate-900 text-white text-sm inline-flex items-center gap-1.5 disabled:opacity-60" data-testid="admin-entitlements-send-digest" title="Email the last-24h block digest to superadmins now">
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} Send digest now
        </button>
      </div>

      {data && (
        <div className={`rounded-xl border p-4 flex items-start gap-3 ${data.enforce ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`} data-testid="admin-entitlements-mode">
          {data.enforce ? <ShieldAlert className="text-rose-600 shrink-0" size={20} /> : <ShieldCheck className="text-amber-600 shrink-0" size={20} />}
          <div className="text-sm">
            <b>{data.enforce ? "ENFORCING" : "Shadow mode"}</b> — {data.enforce
              ? "feature gates return 402 and block users on lower plans."
              : "gates are evaluated and logged only; nobody is blocked. Review the rows below before flipping ENTITLEMENTS_ENFORCE=true."}
            {data.preview_switcher && <span className="ml-2 text-xs text-slate-600">(Preview switcher is on — rows with “enforced” count come from the Viewing-as pill.)</span>}
            <div className="text-xs text-slate-600 mt-1">A daily digest of real blocks (preview-pill tests excluded) is emailed to superadmins at 13:00 UTC — only when there is something to report.</div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Would-block events" value={t.shadow ?? "—"} testid="admin-entitlements-stat-shadow" />
        <Stat label="Companies affected" value={t.companies ?? "—"} testid="admin-entitlements-stat-companies" />
        <Stat label={data?.enforce ? "Blocked (enforced)" : "Preview / enforced hits"} value={t.enforced ?? "—"} testid="admin-entitlements-stat-enforced" />
        <Stat label="All events" value={t.events ?? "—"} testid="admin-entitlements-stat-events" />
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <Breakdown title="By feature" items={data?.by_feature || []} labelOf={(i) => `${FEATURE_COPY[i.feature]?.[0] || i.feature}${i.min_plan ? ` · needs ${data?.labels?.[i.min_plan] || i.min_plan}` : ""}`} testid="admin-entitlements-by-feature" />
        <Breakdown title="By current plan" items={data?.by_plan || []} labelOf={(i) => i.label} testid="admin-entitlements-by-plan" />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm" data-testid="admin-entitlements-table">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Company</th>
              <th className="text-left px-3 py-2">Feature</th>
              <th className="text-left px-3 py-2">On plan</th>
              <th className="text-left px-3 py-2">Needs</th>
              <th className="text-right px-3 py-2">Would block</th>
              <th className="text-right px-3 py-2">Users</th>
              <th className="text-left px-3 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((r) => (
              <tr key={`${r.company_id}-${r.feature}`} className="border-t border-slate-100" data-testid={`admin-entitlements-row-${r.company_id}-${r.feature}`}>
                <td className="px-3 py-2">
                  <div className="font-medium truncate max-w-[220px]">{r.company_name}</div>
                  <div className="text-[11px] text-slate-500">{r.payer || "self-pay"}{r.sub_status ? ` · ${r.sub_status}` : ""}</div>
                </td>
                <td className="px-3 py-2"><span className="inline-flex items-center gap-1"><Lock size={11} /> {FEATURE_COPY[r.feature]?.[0] || r.feature}</span>{r.limit != null && <span className="ml-1 text-[11px] text-slate-500">({r.used}/{r.limit})</span>}</td>
                <td className="px-3 py-2">{r.plan_label}</td>
                <td className="px-3 py-2">{r.min_plan ? (data?.labels?.[r.min_plan] || r.min_plan) : "—"}</td>
                <td className="px-3 py-2 text-right font-mono-num">{r.shadow}{r.enforced ? <span className="text-slate-400"> (+{r.enforced} preview)</span> : null}</td>
                <td className="px-3 py-2 text-right font-mono-num">{r.users}</td>
                <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{fmt(r.last_at)}</td>
              </tr>
            ))}
            {!loading && (data?.rows || []).length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500" data-testid="admin-entitlements-empty">No entitlement events recorded in the last {days} days.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
