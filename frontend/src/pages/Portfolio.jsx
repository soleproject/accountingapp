import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Wallet, ArrowDownToLine, ArrowUpFromLine, TrendingUp, AlertTriangle, ArrowRight, Building2 } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

const PERIODS = [["ytd", "YTD"], ["this_month", "This month"], ["last_month", "Last month"], ["ttm", "Trailing 12"]];
const COLS = [
  ["name", "Company", "left"], ["cash", "Cash", "right"], ["ar", "A/R", "right"], ["ap", "A/P", "right"],
  ["revenue", "Revenue", "right"], ["expenses", "Expenses", "right"], ["net_income", "Net income", "right"], ["attention", "Attention", "right"],
];

function Stat({ icon: Icon, label, value, sub, tone = "", testid }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4" data-testid={testid}>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold text-slate-500"><Icon size={12} /> {label}</div>
      <div className={`font-mono-num text-2xl mt-1 ${tone}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function Portfolio() {
  const nav = useNavigate();
  const { switchCompany } = useCompany();
  const fmtMoney = useMoneyFmt();
  const [period, setPeriod] = useState("ytd");
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState({ key: "cash", dir: -1 });

  useEffect(() => {
    setLoading(true);
    api.get(`/portfolio?period=${period}`).then((r) => setD(r.data)).catch(() => setD({ companies: [], totals: {} })).finally(() => setLoading(false));
  }, [period]);

  const money = (v) => (v == null ? "—" : fmtMoney(Number(v)));
  const attn = (r) => (r.needs_review || 0) + (r.overdue_invoices || 0) + (r.overdue_bills || 0) + (r.unreconciled || 0);
  const rows = useMemo(() => {
    const list = [...(d?.companies || [])];
    list.sort((a, b) => {
      const va = sort.key === "attention" ? attn(a) : a[sort.key], vb = sort.key === "attention" ? attn(b) : b[sort.key];
      if (typeof va === "string" || typeof vb === "string") return String(va || "").localeCompare(String(vb || "")) * sort.dir;
      return ((va ?? -Infinity) - (vb ?? -Infinity)) * sort.dir;
    });
    return list;
  }, [d, sort]);

  const open = (cid, path = "/dashboard") => { switchCompany(cid); nav(path); };
  const t = d?.totals || {};
  const net = Number(t.net_income || 0);

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6" data-testid="portfolio-page">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[240px]">
          <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500 inline-flex items-center gap-1.5"><Building2 size={12} /> Portfolio</div>
          <h1 className="font-heading text-3xl mt-1">All my businesses</h1>
          <p className="text-sm text-slate-500 mt-1">{d?.count ?? "—"} companies · {d?.period_label || ""}{d?.mixed_basis ? " · mixed cash/accrual basis — P&L totals are indicative" : ""}</p>
        </div>
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1" data-testid="portfolio-period">
          {PERIODS.map(([k, l]) => (
            <button key={k} onClick={() => setPeriod(k)} className={`h-8 px-3 rounded-lg text-xs font-semibold transition-colors ${period === k ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`} data-testid={`portfolio-period-${k}`}>{l}</button>
          ))}
        </div>
      </div>

      {d && !d.eligible && !loading && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm" data-testid="portfolio-ineligible">
          The portfolio view appears once you have two or more companies under your login. Add another from <button onClick={() => nav("/my-businesses")} className="underline font-semibold">My Businesses</button>.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={Wallet} label="Cash on hand" value={loading ? "…" : money(t.cash)} testid="portfolio-total-cash" />
        <Stat icon={ArrowDownToLine} label="Outstanding A/R" value={loading ? "…" : money(t.ar)} sub={t.ar_overdue ? `${money(t.ar_overdue)} overdue` : null} testid="portfolio-total-ar" />
        <Stat icon={ArrowUpFromLine} label="Outstanding A/P" value={loading ? "…" : money(t.ap)} sub={t.ap_overdue ? `${money(t.ap_overdue)} overdue` : null} testid="portfolio-total-ap" />
        <Stat icon={TrendingUp} label={`Net income · ${d?.period_label || ""}`} value={loading ? "…" : money(t.net_income)} tone={net < 0 ? "text-rose-600" : "text-emerald-700"}
              sub={loading ? null : `${money(t.revenue)} revenue · ${money(t.expenses)} expenses`} testid="portfolio-total-net" />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]" data-testid="portfolio-table">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <tr>
              {COLS.map(([k, l, align]) => (
                <th key={k} className={`px-3 py-2 text-${align} cursor-pointer select-none hover:text-slate-900`} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : (k === "name" ? 1 : -1) }))} data-testid={`portfolio-sort-${k}`}>
                  {l}{sort.key === k ? (sort.dir > 0 ? " ↑" : " ↓") : ""}
                </th>
              ))}
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500"><Loader2 size={16} className="inline animate-spin mr-2" />Rolling up {d?.count || ""} companies…</td></tr>}
            {!loading && rows.map((r) => {
              const a = attn(r);
              const ni = Number(r.net_income ?? 0);
              return (
                <tr key={r.company_id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => open(r.company_id)} data-testid={`portfolio-row-${r.company_id}`}>
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-[11px] text-slate-500">{r.business_type || "—"} · {r.basis}{!r.onboarding_complete ? " · onboarding" : ""}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono-num">{money(r.cash)}</td>
                  <td className="px-3 py-2.5 text-right font-mono-num">{money(r.ar)}{r.ar_overdue ? <div className="text-[11px] text-rose-600">{money(r.ar_overdue)} overdue</div> : null}</td>
                  <td className="px-3 py-2.5 text-right font-mono-num">{money(r.ap)}{r.ap_overdue ? <div className="text-[11px] text-rose-600">{money(r.ap_overdue)} overdue</div> : null}</td>
                  <td className="px-3 py-2.5 text-right font-mono-num">{money(r.revenue)}</td>
                  <td className="px-3 py-2.5 text-right font-mono-num">{money(r.expenses)}</td>
                  <td className={`px-3 py-2.5 text-right font-mono-num font-semibold ${ni < 0 ? "text-rose-600" : "text-emerald-700"}`}>{money(r.net_income)}</td>
                  <td className="px-3 py-2.5 text-right">
                    {a > 0 ? (
                      <button onClick={(e) => { e.stopPropagation(); open(r.company_id, "/accounting/transactions?filter=unapproved"); }} className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-semibold" title={`${r.needs_review} to review · ${r.overdue_invoices} overdue invoices · ${r.overdue_bills} overdue bills · ${r.unreconciled} unreconciled`} data-testid={`portfolio-attention-${r.company_id}`}>
                        <AlertTriangle size={11} /> {a}
                      </button>
                    ) : <span className="text-xs text-emerald-700 font-semibold">All clear</span>}
                  </td>
                  <td className="px-2 py-2.5 text-slate-400"><ArrowRight size={14} /></td>
                </tr>
              );
            })}
          </tbody>
          {!loading && rows.length > 1 && (
            <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold">
              <tr data-testid="portfolio-totals-row">
                <td className="px-3 py-2.5">Total</td>
                <td className="px-3 py-2.5 text-right font-mono-num">{money(t.cash)}</td>
                <td className="px-3 py-2.5 text-right font-mono-num">{money(t.ar)}</td>
                <td className="px-3 py-2.5 text-right font-mono-num">{money(t.ap)}</td>
                <td className="px-3 py-2.5 text-right font-mono-num">{money(t.revenue)}</td>
                <td className="px-3 py-2.5 text-right font-mono-num">{money(t.expenses)}</td>
                <td className={`px-3 py-2.5 text-right font-mono-num ${net < 0 ? "text-rose-600" : "text-emerald-700"}`}>{money(t.net_income)}</td>
                <td className="px-3 py-2.5 text-right">{t.attention || 0}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
