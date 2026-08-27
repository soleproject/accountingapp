import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { LineChart, Loader2, ArrowRight } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * Estimates vs Actuals dashboard (Phase 3 report, Feb 2026).
 *
 * Per-project table of:
 *   Revenue side  : Estimated → Invoiced → Received → Remaining
 *   Cost side     : Committed (bills) → Paid → AP outstanding
 *   Net cash      : Received - Paid
 *
 * All numbers come from the stored `total` / `balance_due` fields on
 * project-linked invoices and bills — no ledger walk needed. Backend:
 * `GET /companies/{cid}/reports/estimates-vs-actuals`.
 */
export default function EstimatesVsActuals() {
  const { currentId, projectsEnabled, refresh } = useCompany();
  const fmtMoney = useMoneyFmt();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const nav = useNavigate();

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${currentId}/reports/estimates-vs-actuals` +
        `?include_completed=${includeCompleted ? 1 : 0}`,
      );
      setData(r.data);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ },
             [currentId, includeCompleted]);

  const turnOnProjects = async () => {
    try {
      await api.patch(`/companies/${currentId}/features`, {
        projects_enabled: true,
      });
      await refresh?.();
      toast.success("Projects enabled");
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  if (!projectsEnabled) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-4" data-testid="eva-disabled-empty">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-cyan-50 text-cyan-600">
          <LineChart size={26} />
        </div>
        <h2 className="text-xl font-semibold text-slate-900">Enable Projects to see Estimates vs Actuals</h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          This report reads project-linked invoices and bills. Turn on Projects to start using it.
        </p>
        <button onClick={turnOnProjects} data-testid="eva-enable-projects"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-600 text-white text-sm hover:bg-cyan-700">
          Enable Projects <ArrowRight size={14} />
        </button>
      </div>
    );
  }

  const rows = data?.projects || [];
  const totals = data?.totals;

  return (
    <div className="max-w-7xl space-y-6" data-testid="eva-page">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <LineChart size={22} className="text-cyan-600" />
            Estimates vs Actuals
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Commitment, paid, and remaining per project. Reads project-linked invoices and bills.
          </p>
        </div>
        <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={includeCompleted}
                  onChange={(e) => setIncludeCompleted(e.target.checked)}
                  data-testid="eva-include-completed" />
          Include completed
        </label>
      </div>

      {loading ? (
        <div className="rounded-xl border bg-white p-8 text-center text-slate-500 text-sm">
          <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border bg-white p-10 text-center text-slate-500 text-sm">
          No projects to report on yet.
          <div className="mt-2">
            <Link to="/accounting/projects" className="text-cyan-600 hover:underline">
              Create a project →
            </Link>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border bg-white overflow-x-auto">
          <table className="w-full text-sm" data-testid="eva-table">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b">
                <th className="text-left px-4 py-2.5">Project · Customer</th>
                <th className="text-right px-3 py-2.5" title="From projects.estimated_revenue">Estimated</th>
                <th className="text-right px-3 py-2.5" title="Sum of project-linked invoice totals">Invoiced</th>
                <th className="text-right px-3 py-2.5" title="Invoiced - AR outstanding">Received</th>
                <th className="text-right px-3 py-2.5" title="Estimate - Invoiced">Remaining</th>
                <th className="text-right px-3 py-2.5 border-l" title="Sum of project-linked bill totals">Committed</th>
                <th className="text-right px-3 py-2.5" title="Committed - AP outstanding">Paid</th>
                <th className="text-right px-3 py-2.5" title="Received - Paid">Net cash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-slate-50" data-testid={`eva-row-${r.id}`}>
                  <td className="px-4 py-2.5 min-w-[220px]">
                    <button onClick={() => nav("/accounting/projects")}
                              className="text-left hover:text-indigo-700 w-full">
                      <div className="font-medium text-slate-900 truncate">{r.name}</div>
                      <div className="text-xs text-slate-500 truncate">{r.contact_name || "—"}</div>
                    </button>
                  </td>
                  <MoneyCell v={r.estimated} muted={!r.estimated} />
                  <MoneyCell v={r.invoiced} />
                  <MoneyCell v={r.received} className="text-emerald-700" />
                  <MoneyCell v={r.remaining_est} muted={!r.remaining_est}
                              hint={r.pct_billed != null ? `${r.pct_billed}% billed` : ""} />
                  <MoneyCell v={r.committed} className="border-l" />
                  <MoneyCell v={r.paid_to_vendors} />
                  <MoneyCell v={r.net_cash}
                              className={r.net_cash >= 0 ? "text-emerald-700 font-semibold" : "text-rose-700 font-semibold"} />
                </tr>
              ))}
            </tbody>
            {totals && rows.length > 0 && (
              <tfoot>
                <tr className="bg-slate-50 font-semibold text-slate-900 border-t-2 border-slate-300">
                  <td className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-slate-600">Totals · {data.project_count}</td>
                  <MoneyCell v={totals.estimated} />
                  <MoneyCell v={totals.invoiced} />
                  <MoneyCell v={totals.received} className="text-emerald-700" />
                  <MoneyCell v={totals.remaining_est} />
                  <MoneyCell v={totals.committed} className="border-l" />
                  <MoneyCell v={totals.paid_to_vendors} />
                  <MoneyCell v={totals.received - totals.paid_to_vendors}
                              className={(totals.received - totals.paid_to_vendors) >= 0 ? "text-emerald-700" : "text-rose-700"} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

function MoneyCell({ v, className = "", muted = false, hint = "" }) {
  const fmt = useMoneyFmt();
  return (
    <td className={`px-3 py-2.5 text-right font-mono-num ${muted ? "text-slate-300" : "text-slate-800"} ${className}`}>
      {fmt(v || 0)}
      {hint && <div className="text-[10px] text-slate-400 mt-0.5">{hint}</div>}
    </td>
  );
}
