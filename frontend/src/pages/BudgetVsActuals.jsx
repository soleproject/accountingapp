import { useEffect, useState, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { BarChart3, Loader2, Target } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * Budget vs Actuals report (Phase 4, Feb 2026).
 *
 * Renders a monthly variance grid for a selected budget. Variance is
 * pre-signed by the backend so "positive is always good" regardless
 * of whether the row is revenue or expense — the color-coding rule
 * is uniform.
 */
const MONTH_LABELS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

export default function BudgetVsActuals() {
  const { currentId, budgetsEnabled, refresh } = useCompany();
  const fmtMoney = useMoneyFmt();
  const [params, setParams] = useSearchParams();

  const [budgets, setBudgets] = useState([]);
  const [selected, setSelected] = useState(params.get("budget_id") || "");
  const [basis, setBasis] = useState(params.get("basis") || "accrual");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/budgets`)
       .then(r => {
          const rows = r.data?.budgets || [];
          setBudgets(rows);
          if (!selected && rows.length) {
            const first = rows[0].id;
            setSelected(first);
            const p = new URLSearchParams(params);
            p.set("budget_id", first);
            setParams(p, { replace: true });
          }
       })
       .catch(() => {});
    // eslint-disable-next-line
  }, [currentId]);

  useEffect(() => {
    if (!currentId || !selected) { setData(null); return; }
    setLoading(true);
    api.get(
      `/companies/${currentId}/reports/budget-vs-actuals?budget_id=${selected}&basis=${basis}`)
      .then(r => setData(r.data))
      .catch(e => toast.error(`Load failed: ${e.response?.data?.detail || e.message}`))
      .finally(() => setLoading(false));
  }, [currentId, selected, basis]);

  const onChangeBudget = (id) => {
    setSelected(id);
    const p = new URLSearchParams(params);
    p.set("budget_id", id);
    setParams(p);
  };
  const onChangeBasis = (b) => {
    setBasis(b);
    const p = new URLSearchParams(params);
    p.set("basis", b);
    setParams(p);
  };

  const turnOn = async () => {
    try {
      await api.patch(`/companies/${currentId}/features`, {
        budgets_enabled: true,
      });
      await refresh?.();
      toast.success("Budgets enabled");
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  if (!budgetsEnabled) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-4" data-testid="bva-disabled-empty">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-violet-50 text-violet-600">
          <Target size={26} />
        </div>
        <h2 className="text-xl font-semibold text-slate-900">Turn on Budgets to see this report</h2>
        <button onClick={turnOn}
                data-testid="bva-enable-budgets"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-violet-600 text-white text-sm hover:bg-violet-700">
          Enable Budgets
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-[1700px] space-y-4" data-testid="bva-page">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <BarChart3 size={22} className="text-violet-600" />
            Budget vs Actuals
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Compare monthly targets to what actually posted. Positive variance is always good.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 block">Budget</label>
            <select value={selected} onChange={(e) => onChangeBudget(e.target.value)}
                    data-testid="bva-budget-select"
                    className="border rounded px-2 py-1.5 text-sm bg-white min-w-[260px]">
              <option value="">Pick a budget…</option>
              {budgets.map(b => {
                const suffix = b.scope && b.scope !== "company"
                  ? ` · ${b.scope}: ${b.scope_ref_name || "—"}`
                  : "";
                return (
                  <option key={b.id} value={b.id}>
                    {b.name} · FY{b.fiscal_year}{suffix}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 block">Basis</label>
            <select value={basis} onChange={(e) => onChangeBasis(e.target.value)}
                    data-testid="bva-basis-select"
                    className="border rounded px-2 py-1.5 text-sm bg-white">
              <option value="accrual">Accrual</option>
              <option value="cash">Cash</option>
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border bg-white p-8 text-center text-slate-500 text-sm">
          <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
        </div>
      ) : !data ? (
        <div className="rounded-xl border bg-white p-8 text-center text-slate-500 text-sm">
          {budgets.length === 0
            ? <>No budgets yet. <Link to="/accounting/budgets" className="text-violet-600 hover:underline">Create one →</Link></>
            : "Pick a budget above to see variance."}
        </div>
      ) : (
        <>
          {data.budget?.scope && data.budget.scope !== "company" && (
            <div className={`rounded-lg border ${data.budget.scope === "class" ? "border-cyan-200 bg-cyan-50/60 text-cyan-900" : "border-emerald-200 bg-emerald-50/60 text-emerald-900"} px-3 py-2 text-xs flex items-center gap-2`}
                  data-testid="bva-scope-banner">
              <span className="font-semibold uppercase tracking-wider">{data.budget.scope}</span>
              <span>{data.budget.scope_ref_name || "—"}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-600 italic">
                Only postings tagged with this {data.budget.scope} count as actuals.
              </span>
            </div>
          )}
          <VarianceGrid data={data} fmtMoney={fmtMoney} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// The grid
// ---------------------------------------------------------------
function VarianceGrid({ data, fmtMoney }) {
  const varClass = (v) => {
    if (v === 0) return "text-slate-400";
    return v > 0 ? "text-emerald-700" : "text-rose-700";
  };
  const SECTIONS = [
    ["revenue",  "Revenue"],
    ["cogs",     "Cost of goods sold"],
    ["expenses", "Operating expenses"],
  ];

  return (
    <div className="rounded-xl border bg-white overflow-x-auto" data-testid="bva-grid">
      <table className="min-w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 border-b">
          <tr className="text-[10px] uppercase tracking-wider text-slate-500">
            <th className="text-left px-3 py-2 sticky left-0 bg-slate-50 z-10 min-w-[220px]">Account</th>
            <th className="text-center px-2 py-1 border-l" colSpan={3}>Total (FY)</th>
            {MONTH_LABELS.map(m => (
              <th key={m} className="text-center px-1 py-1 border-l min-w-[104px]">{m}</th>
            ))}
          </tr>
          <tr className="text-[9px] text-slate-400 bg-slate-50">
            <th />
            <th className="px-1 py-1 border-l text-right">Budget</th>
            <th className="px-1 py-1 text-right">Actual</th>
            <th className="px-1 py-1 text-right">Var</th>
            {MONTH_LABELS.map((label, i) => (
              <th key={label} className="border-l px-1 py-1">
                <div className="flex flex-col text-right leading-tight">
                  <span>Bud · Act</span>
                  <span>Variance</span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {SECTIONS.map(([key, label]) => (
            <SectionBlock key={key} sectionKey={key} label={label}
                           data={data[key]} fmtMoney={fmtMoney} varClass={varClass} />
          ))}
          {/* Net income row */}
          <tr className="bg-slate-100 border-t-2 border-slate-300 font-semibold">
            <td className="px-3 py-2 sticky left-0 bg-slate-100 text-slate-900">Net income</td>
            <td className="px-1 py-2 text-right font-mono-num border-l">{fmtMoney(data.net_income.budget)}</td>
            <td className="px-1 py-2 text-right font-mono-num">{fmtMoney(data.net_income.actual)}</td>
            <td className={`px-1 py-2 text-right font-mono-num font-bold ${varClass(data.net_income.variance)}`}>
              {fmtMoney(data.net_income.variance)}
            </td>
            {MONTH_LABELS.map((_, i) => (
              <td key={i} className="border-l px-1 py-2 text-[10px] text-slate-500 italic text-center">
                {/* monthly net income not surfaced individually — full-year only */}
                —
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SectionBlock({ sectionKey, label, data, fmtMoney, varClass }) {
  if (!data) return null;
  const rows = data.rows || [];
  const totals = data.totals || { total: {}, months: [] };

  return (
    <>
      <tr className="bg-slate-50/60">
        <td className="px-3 py-1.5 sticky left-0 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-600 font-semibold">
          {label}
        </td>
        <td className="px-1 py-1.5 text-right font-mono-num border-l text-slate-700">{fmtMoney(totals.total.budget)}</td>
        <td className="px-1 py-1.5 text-right font-mono-num text-slate-700">{fmtMoney(totals.total.actual)}</td>
        <td className={`px-1 py-1.5 text-right font-mono-num font-semibold ${varClass(totals.total.variance)}`}>
          {fmtMoney(totals.total.variance)}
        </td>
        {(totals.months || []).map((m, i) => (
          <td key={`totals-${i}`} className="border-l px-1 py-1 text-[10px] font-mono-num text-slate-700 bg-slate-100/40">
            <div className="flex flex-col text-right leading-tight">
              <span className="text-slate-500 text-[9px]">{fmtCompact(m.budget, fmtMoney)} · {fmtCompact(m.actual, fmtMoney)}</span>
              <span className={`${varClass(m.variance)} font-semibold`}>{fmtCompact(m.variance, fmtMoney)}</span>
            </div>
          </td>
        ))}
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={16} className="px-3 py-1.5 text-[10px] italic text-slate-400 text-center">
            No {label.toLowerCase()} activity in this budget or fiscal year.
          </td>
        </tr>
      ) : (
        rows.map(row => (
          <tr key={row.account_id} data-testid={`bva-row-${row.account_id}`}>
            <td className="px-3 py-1 sticky left-0 bg-white text-slate-800 truncate">
              <span className="text-slate-400 font-mono-num mr-1.5">{row.account_code}</span>
              {row.account_name}
            </td>
            <td className="px-1 py-1 text-right font-mono-num border-l text-slate-800">{fmtMoney(row.total.budget)}</td>
            <td className="px-1 py-1 text-right font-mono-num text-slate-800">{fmtMoney(row.total.actual)}</td>
            <td className={`px-1 py-1 text-right font-mono-num font-semibold ${varClass(row.total.variance)}`}>
              {fmtMoney(row.total.variance)}
            </td>
            {row.months.map(m => (
              <td key={m.period_key} className="border-l px-1 py-1 text-[10px] font-mono-num text-slate-700">
                <div className="flex flex-col text-right leading-tight">
                  <span className="text-slate-500 text-[9px]">{fmtCompact(m.budget, fmtMoney)} · {fmtCompact(m.actual, fmtMoney)}</span>
                  <span className={`${varClass(m.variance)} font-semibold`}>{fmtCompact(m.variance, fmtMoney)}</span>
                </div>
              </td>
            ))}
          </tr>
        ))
      )}
    </>
  );
}

// Compact money formatter that reuses the region-aware formatter but
// swallows the trailing `.00` when the value is a round dollar amount,
// keeping the 12-column grid readable.
function fmtCompact(n, fmt) {
  if (!n) return <span className="text-slate-300">—</span>;
  const s = fmt(n);
  return s.replace(/\.00$/, "");
}
