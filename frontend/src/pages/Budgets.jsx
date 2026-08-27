import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Target, Plus, Loader2, Trash2, Check, BarChart3 } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * Budgets list page (Phase 4, Feb 2026).
 *
 * A budget is a fiscal-year envelope of per-account monthly targets.
 * Users create the envelope here, then jump into `/accounting/budgets/:id`
 * to fill the spreadsheet.
 *
 * Gated by `features.budgets_enabled`. Deep-linking with the flag off
 * shows an inline "Enable Budgets" fallback.
 */
const STATUS_LABELS = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
};

export default function Budgets() {
  const { currentId, current, budgetsEnabled, refresh } = useCompany();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: `FY${new Date().getFullYear()} Plan`,
    fiscal_year: new Date().getFullYear(),
  });
  const nav = useNavigate();

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/budgets`);
      setRows(r.data?.budgets || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  const create = async () => {
    if (!form.name.trim() || !form.fiscal_year) return;
    setCreating(true);
    try {
      const r = await api.post(`/companies/${currentId}/budgets`, {
        name: form.name.trim(),
        fiscal_year: Number(form.fiscal_year),
      });
      toast.success("Budget created");
      nav(`/accounting/budgets/${r.data.budget.id}`);
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setCreating(false); }
  };

  const setStatus = async (row, status) => {
    try {
      await api.patch(
        `/companies/${currentId}/budgets/${row.id}`, { status });
      toast.success(`Marked ${STATUS_LABELS[status] || status}`);
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const hardDelete = async (row) => {
    if (!confirm(`Delete "${row.name}"? This removes all line targets.`)) return;
    try {
      await api.delete(`/companies/${currentId}/budgets/${row.id}`);
      toast.success("Deleted");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
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
      <div className="max-w-2xl mx-auto py-16 text-center space-y-4" data-testid="budgets-disabled-empty">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-violet-50 text-violet-600">
          <Target size={26} />
        </div>
        <h2 className="text-xl font-semibold text-slate-900">Budgets aren't enabled yet</h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          Turn on Budgets to set monthly targets per account and compare against actuals as the year rolls out.
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <button onClick={turnOn} data-testid="budgets-enable-btn"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-violet-600 text-white text-sm hover:bg-violet-700">
            <Check size={14} /> Enable Budgets
          </button>
          <button onClick={() => nav("/settings")}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-slate-200 bg-white text-slate-700 text-sm hover:bg-slate-50">
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6" data-testid="budgets-page">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <Target size={22} className="text-violet-600" />
            Budgets
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Set fiscal-year targets per account for <span className="font-medium">{current?.name}</span>. Track variance on the Budget vs Actuals report.
          </p>
        </div>
        <button onClick={() => nav("/reports/budget-vs-actuals")}
                data-testid="budgets-goto-variance"
                className="text-xs inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
          <BarChart3 size={13} /> Budget vs Actuals →
        </button>
      </div>

      {/* Quick-add */}
      <div className="rounded-xl border bg-white p-4 grid grid-cols-12 gap-2 items-end" data-testid="budget-create-form">
        <div className="col-span-6">
          <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">Budget name</label>
          <input value={form.name}
                  onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="FY26 Plan"
                  data-testid="budget-new-name"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500" />
        </div>
        <div className="col-span-3">
          <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1">Fiscal year</label>
          <input type="number" value={form.fiscal_year}
                  onChange={(e) => setForm(f => ({ ...f, fiscal_year: e.target.value }))}
                  data-testid="budget-new-year"
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500" />
        </div>
        <div className="col-span-3">
          <button onClick={create}
                    disabled={!form.name.trim() || !form.fiscal_year || creating}
                    data-testid="budget-create-btn"
                    className="w-full inline-flex items-center justify-center gap-1 px-3 py-2 rounded-md bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50">
            {creating ? <Loader2 size={14} className="animate-spin" /> : <><Plus size={14} /> New budget</>}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="px-4 py-2 grid grid-cols-12 gap-2 text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b">
          <div className="col-span-5">Name</div>
          <div className="col-span-2">Fiscal year</div>
          <div className="col-span-3">Status</div>
          <div className="col-span-2 text-right">Actions</div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-slate-500 text-sm">
            <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            No budgets yet — create your first one above.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map(r => (
              <li key={r.id}
                  className={`px-4 py-2.5 grid grid-cols-12 gap-2 items-center hover:bg-slate-50 ${r.status === "archived" ? "opacity-60" : ""}`}
                  data-testid={`budget-row-${r.id}`}>
                <button onClick={() => nav(`/accounting/budgets/${r.id}`)}
                        className="col-span-5 text-left min-w-0 hover:text-violet-700"
                        data-testid={`budget-open-${r.id}`}>
                  <div className="text-sm text-slate-900 truncate font-medium">{r.name}</div>
                </button>
                <div className="col-span-2 text-sm text-slate-700 font-mono-num">{r.fiscal_year}</div>
                <div className="col-span-3">
                  <select value={r.status}
                            onChange={(e) => setStatus(r, e.target.value)}
                            data-testid={`budget-status-${r.id}`}
                            className="text-xs border border-slate-200 rounded px-1.5 py-1 bg-white text-slate-700">
                    {Object.entries(STATUS_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2 flex justify-end gap-1">
                  <button onClick={() => nav(`/accounting/budgets/${r.id}`)}
                            data-testid={`budget-edit-${r.id}`}
                            className="text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                    Edit
                  </button>
                  <button onClick={() => hardDelete(r)}
                            data-testid={`budget-delete-${r.id}`}
                            className="p-1.5 rounded hover:bg-red-50 text-red-500"
                            title="Delete">
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
