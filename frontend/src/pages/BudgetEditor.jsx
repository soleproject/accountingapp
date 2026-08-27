import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeft, ChevronRight, Loader2, Save, Wand2, BarChart3, Target,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * Budget spreadsheet editor (Phase 4, Feb 2026).
 *
 * Layout: rows = P&L accounts grouped by section (Revenue · COGS ·
 * Expenses), columns = 12 months + Total. Cell edits are staged
 * locally then bulk-upserted via PUT /budgets/{id}/lines on Save.
 *
 * Wave-style pattern — feels like a spreadsheet, saves as one
 * network round-trip. `Prefill from prior year` calls a dedicated
 * backend endpoint that reads the P&L actuals for FY-1.
 */
const MONTH_LABELS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];
const SECTION_ORDER = ["revenue", "cogs", "expense"];
const SECTION_LABEL = { revenue: "Revenue", cogs: "Cost of goods sold", expense: "Operating expenses" };

export default function BudgetEditor() {
  const { budgetId } = useParams();
  const nav = useNavigate();
  const { currentId, budgetsEnabled } = useCompany();
  const fmtMoney = useMoneyFmt();

  const [budget, setBudget] = useState(null);
  const [accounts, setAccounts] = useState([]);
  // Local staged edits: { [account_id]: { [period_key]: number } }
  const [cells, setCells] = useState({});
  const [dirty, setDirty] = useState(new Set()); // keys "aid|pk"
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [showPrefill, setShowPrefill] = useState(false);
  const [growth, setGrowth] = useState(0);

  const months = useMemo(() => {
    if (!budget) return [];
    const fy = budget.fiscal_year;
    return Array.from({ length: 12 }, (_, i) =>
      `${fy}-${String(i + 1).padStart(2, "0")}`);
  }, [budget]);

  // -----------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------
  const load = async () => {
    if (!currentId || !budgetId) return;
    setLoading(true);
    try {
      const [b, a] = await Promise.all([
        api.get(`/companies/${currentId}/budgets/${budgetId}`),
        api.get(`/companies/${currentId}/accounts`),
      ]);
      setBudget(b.data?.budget || null);
      setAccounts(a.data?.accounts || []);
      // Rehydrate cell map from persisted lines.
      const seed = {};
      for (const l of (b.data?.lines || [])) {
        seed[l.account_id] = seed[l.account_id] || {};
        seed[l.account_id][l.period_key] = Number(l.amount || 0);
      }
      setCells(seed);
      setDirty(new Set());
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, budgetId]);

  // -----------------------------------------------------------------
  // Cell mutation
  // -----------------------------------------------------------------
  const setCell = (aid, pk, val) => {
    setCells(prev => ({
      ...prev,
      [aid]: { ...(prev[aid] || {}), [pk]: val },
    }));
    setDirty(prev => new Set(prev).add(`${aid}|${pk}`));
  };
  const parseAmt = (v) => {
    if (v === "" || v == null) return 0;
    const n = Number(String(v).replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  // Fill an entire row with the same value.
  const fillRow = (aid, val) => {
    const n = parseAmt(val);
    setCells(prev => {
      const row = { ...(prev[aid] || {}) };
      months.forEach(pk => { row[pk] = n; });
      return { ...prev, [aid]: row };
    });
    setDirty(prev => {
      const next = new Set(prev);
      months.forEach(pk => next.add(`${aid}|${pk}`));
      return next;
    });
  };

  // -----------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------
  const save = async () => {
    if (dirty.size === 0) { toast.info("No changes"); return; }
    setSaving(true);
    try {
      const lines = [];
      for (const key of dirty) {
        const [aid, pk] = key.split("|");
        const amount = parseAmt(cells[aid]?.[pk] ?? 0);
        lines.push({ account_id: aid, period_key: pk, amount });
      }
      const r = await api.put(
        `/companies/${currentId}/budgets/${budgetId}/lines`,
        { lines });
      toast.success(`Saved · ${r.data.upserted} updated, ${r.data.cleared} cleared`);
      setDirty(new Set());
    } catch (e) {
      toast.error(`Save failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  const doPrefill = async () => {
    setPrefilling(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/budgets/${budgetId}/prefill`,
        { growth_pct: Number(growth) || 0 });
      toast.success(`Pre-filled ${r.data.seeded} cells from FY${r.data.prior_year}${growth ? ` +${growth}%` : ""}`);
      setShowPrefill(false);
      await load();
    } catch (e) {
      toast.error(`Prefill failed: ${e.response?.data?.detail || e.message}`);
    } finally { setPrefilling(false); }
  };

  // -----------------------------------------------------------------
  // Section-grouped accounts
  // -----------------------------------------------------------------
  const grouped = useMemo(() => {
    const g = { revenue: [], cogs: [], expense: [] };
    for (const a of accounts) {
      const t = (a.type || "").toLowerCase();
      if (t === "revenue" || t === "income") g.revenue.push(a);
      else if (t === "cogs") g.cogs.push(a);
      else if (t === "expense") g.expense.push(a);
    }
    for (const s of SECTION_ORDER) {
      g[s].sort((x, y) => String(x.code || "").localeCompare(String(y.code || "")));
    }
    return g;
  }, [accounts]);

  const rowTotal = (aid) => {
    const r = cells[aid] || {};
    let t = 0;
    for (const pk of months) t += parseAmt(r[pk]);
    return t;
  };
  const monthTotal = (aids, pk) => {
    let t = 0;
    for (const aid of aids) t += parseAmt((cells[aid] || {})[pk]);
    return t;
  };
  const sectionTotal = (aids) => {
    let t = 0;
    for (const aid of aids) t += rowTotal(aid);
    return t;
  };

  if (!budgetsEnabled) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-3" data-testid="budget-editor-disabled">
        <Target size={26} className="mx-auto text-slate-400" />
        <h2 className="text-lg font-semibold text-slate-900">Budgets aren't enabled</h2>
        <Link to="/settings" className="text-violet-600 hover:underline text-sm">Enable in Settings →</Link>
      </div>
    );
  }

  return (
    <div className="max-w-[1600px] space-y-4" data-testid="budget-editor">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-slate-500" data-testid="budget-editor-breadcrumb">
        <Link to="/accounting/budgets" className="hover:text-slate-800 inline-flex items-center gap-1">
          <ArrowLeft size={12} /> Budgets
        </Link>
        <ChevronRight size={12} />
        <span className="text-slate-900 font-medium truncate">
          {budget?.name || (loading ? "Loading…" : "Budget")}
        </span>
      </div>

      {loading || !budget ? (
        <div className="rounded-xl border bg-white p-8 text-center text-slate-500 text-sm">
          <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500">Budget · FY{budget.fiscal_year}</div>
              <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">{budget.name}</h1>
              <div className="text-sm text-slate-500 mt-0.5 capitalize flex items-center gap-2">
                <span>{budget.status}</span>
                {budget.scope && budget.scope !== "company" ? (
                  <span className={`text-[10px] uppercase tracking-wider ${budget.scope === "class" ? "text-cyan-700 bg-cyan-50 border-cyan-200" : "text-emerald-700 bg-emerald-50 border-emerald-200"} border rounded px-1.5 py-0.5 normal-case`}
                        data-testid="budget-editor-scope-pill">
                    <span className="opacity-70 uppercase tracking-wider">{budget.scope}:</span> {budget.scope_ref_name || "—"}
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-wider text-slate-500 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5"
                        data-testid="budget-editor-scope-pill">
                    Company-wide
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-2 items-center">
              <button onClick={() => setShowPrefill(true)}
                        data-testid="budget-prefill-btn"
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 text-sm hover:bg-slate-50">
                <Wand2 size={13} /> Prefill from prior year
              </button>
              <button onClick={() => nav(`/reports/budget-vs-actuals?budget_id=${budgetId}`)}
                        data-testid="budget-view-variance"
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 text-sm hover:bg-slate-50">
                <BarChart3 size={13} /> Variance report
              </button>
              <button onClick={save}
                        disabled={saving || dirty.size === 0}
                        data-testid="budget-save-btn"
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-violet-600 text-white text-sm hover:bg-violet-700 disabled:opacity-50">
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save{dirty.size > 0 && ` (${dirty.size})`}
              </button>
            </div>
          </div>

          {/* Spreadsheet */}
          <div className="rounded-xl border bg-white overflow-x-auto" data-testid="budget-spreadsheet">
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 border-b">
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="text-left px-3 py-2 sticky left-0 bg-slate-50 z-10 min-w-[220px]">Account</th>
                  {MONTH_LABELS.map(m => (
                    <th key={m} className="text-right px-2 py-2 min-w-[92px]">{m}</th>
                  ))}
                  <th className="text-right px-3 py-2 border-l bg-slate-100 min-w-[110px]">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {SECTION_ORDER.map(section => {
                  const aids = grouped[section].map(a => a.id);
                  return (
                    <FragmentSection
                      key={section}
                      section={section}
                      aids={aids}
                      grouped={grouped}
                      months={months}
                      cells={cells}
                      dirty={dirty}
                      setCell={setCell}
                      fillRow={fillRow}
                      rowTotal={rowTotal}
                      monthTotal={monthTotal}
                      sectionTotal={sectionTotal}
                      fmtMoney={fmtMoney}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-[11px] text-slate-500 italic">
            Tip: press Enter in any cell to copy that value across the whole year.
          </div>
        </>
      )}

      {/* Prefill modal */}
      {showPrefill && (        <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4"
              onClick={() => !prefilling && setShowPrefill(false)}>
          <div className="max-w-md w-full rounded-xl bg-white p-5 space-y-3 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
                data-testid="budget-prefill-modal">
            <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
              <Wand2 size={14} className="text-violet-600" /> Prefill from prior-year actuals
            </div>
            <p className="text-xs text-slate-600">
              This will populate every monthly cell for FY{budget.fiscal_year} with the actual amount recognized
              in the same month of FY{budget.fiscal_year - 1}
              {budget.scope && budget.scope !== "company"
                ? ` — filtered to activity tagged with ${budget.scope} "${budget.scope_ref_name}"`
                : ""}.
              Existing budget values will be overwritten.
            </p>
            <div>
              <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">Growth uplift %</label>
              <input type="number" value={growth} step="0.5"
                      onChange={(e) => setGrowth(e.target.value)}
                      data-testid="budget-prefill-growth"
                      placeholder="0"
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500" />
              <div className="text-[10px] text-slate-500 mt-1">
                Optional. Applied compounded — e.g. 5 means every value is × 1.05.
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowPrefill(false)}
                        disabled={prefilling}
                        className="text-xs px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-700">
                Cancel
              </button>
              <button onClick={doPrefill}
                        disabled={prefilling}
                        data-testid="budget-prefill-confirm"
                        className="text-xs px-3 py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1">
                {prefilling ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                Prefill
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Section fragment — keeps React key hygiene with siblings in a
// grouped table body (header row + data rows + total row all live
// under the same section key).
// ---------------------------------------------------------------
function FragmentSection({
  section, aids, grouped, months, cells, dirty,
  setCell, fillRow, rowTotal, monthTotal, sectionTotal, fmtMoney,
}) {
  return (
    <>
      <tr className="bg-slate-50/60">
        <td className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-600 font-semibold sticky left-0 bg-slate-50/95">
          {SECTION_LABEL[section]}
        </td>
        {MONTH_LABELS.map((label, i) => (
          <td key={`${section}-hdr-${label}`} className="px-2 py-1.5 text-right text-[10px] text-slate-400 font-mono-num">
            {fmtMoney(monthTotal(aids, months[i]))}
          </td>
        ))}
        <td className="px-3 py-1.5 text-right text-[10px] text-slate-700 font-mono-num border-l bg-slate-100 font-semibold">
          {fmtMoney(sectionTotal(aids))}
        </td>
      </tr>
      {grouped[section].length === 0 ? (
        <tr>
          <td colSpan={14} className="px-3 py-2 text-[11px] italic text-slate-400 text-center">
            No {SECTION_LABEL[section].toLowerCase()} accounts in your chart of accounts.
          </td>
        </tr>
      ) : (
        grouped[section].map(a => {
          const total = rowTotal(a.id);
          return (
            <tr key={a.id} data-testid={`budget-row-${a.id}`} className="hover:bg-slate-50/40">
              <td className="px-3 py-1 sticky left-0 bg-white text-slate-800 truncate">
                <span className="text-slate-400 font-mono-num mr-1.5">{a.code}</span>
                {a.name}
              </td>
              {months.map(pk => {
                const key = `${a.id}|${pk}`;
                const val = cells[a.id]?.[pk] ?? "";
                return (
                  <td key={pk} className={`px-1 py-0.5 ${dirty.has(key) ? "bg-violet-50" : ""}`}>
                    <input
                      type="text" inputMode="decimal"
                      value={val === 0 ? "" : val}
                      onChange={(e) => setCell(a.id, pk, e.target.value === "" ? "" : Number(e.target.value.replace(/[$,]/g, "")) || 0)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          fillRow(a.id, e.currentTarget.value);
                        }
                      }}
                      data-testid={`budget-cell-${a.id}-${pk}`}
                      placeholder="0"
                      className="w-full text-right px-1.5 py-1 text-xs font-mono-num rounded border border-transparent hover:border-slate-200 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-200 bg-transparent"
                    />
                  </td>
                );
              })}
              <td className="px-3 py-1 text-right font-mono-num text-slate-800 border-l bg-slate-50/60 font-semibold">
                {total > 0 ? fmtMoney(total) : <span className="text-slate-300">—</span>}
              </td>
            </tr>
          );
        })
      )}
    </>
  );
}
