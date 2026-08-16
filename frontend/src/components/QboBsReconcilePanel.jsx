import { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Loader2, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";

/**
 * QBO opening-balance reconciliation panel — superadmin only.
 *
 * One-click backfill for `_post_opening_balances_je` across every
 * QBO-connected company (or a single one when `companyId` is set).
 * Shows the resulting per-company line count + gross debits/credits
 * so a superadmin can spot-check that the JE balanced before + after
 * without having to shell into the DB.
 *
 * Feb 26 2026 — accompanies the delta-based opening-balance fix.
 */
export default function QboBsReconcilePanel({ companyId = null }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const body = companyId ? { company_id: companyId } : {};
      const r = await api.post(
        "/admin/qbo/opening-balances/backfill",
        body,
      );
      setResult(r.data);
      toast.success(
        `Reconciled ${r.data.companies_processed} compan${
          r.data.companies_processed === 1 ? "y" : "ies"
        } — ${r.data.total_lines_posted} opening lines posted`,
      );
    } catch (err) {
      const msg = err.response?.data?.detail || err.message;
      setError(msg);
      toast.error(`Reconciliation failed: ${msg}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      data-testid="qbo-bs-reconcile-panel"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            QBO Balance Sheet Reconciliation
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Re-runs the delta-based opening-balance JE on every
            QBO-connected company so Fixed Assets / Long-Term
            Liabilities / accounts with pre-migration opening
            balances tie to QBO's own report. Safe to run repeatedly
            — it's idempotent.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={running}
          data-testid="qbo-bs-reconcile-run"
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Reconciling…
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4" />
              Reconcile now
            </>
          )}
        </button>
      </div>

      {error && (
        <div
          className="mt-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          data-testid="qbo-bs-reconcile-error"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="mt-4" data-testid="qbo-bs-reconcile-result">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            {result.companies_processed} compan
            {result.companies_processed === 1 ? "y" : "ies"} processed
            &nbsp;·&nbsp;
            {result.total_lines_posted} opening lines posted
          </div>
          <div className="overflow-hidden rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Company</th>
                  <th className="px-3 py-2 text-right">Lines</th>
                  <th className="px-3 py-2 text-right">Gross DR</th>
                  <th className="px-3 py-2 text-right">Gross CR</th>
                  <th className="px-3 py-2 text-right">Balanced</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(result.results || []).map((row) => {
                  const dr = row.gross_debits ?? 0;
                  const cr = row.gross_credits ?? 0;
                  const balanced = Math.abs(dr - cr) < 0.005;
                  return (
                    <tr
                      key={row.company_id}
                      data-testid={`qbo-bs-reconcile-row-${row.company_id}`}
                    >
                      <td className="px-3 py-2 text-slate-800">
                        {row.company_name ||
                          row.company_id.slice(0, 8) + "…"}
                        {row.error && (
                          <div className="mt-0.5 text-xs text-red-600">
                            {row.error}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {row.line_count ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        ${dr.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        ${cr.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.error ? (
                          <span className="text-red-600">—</span>
                        ) : balanced ? (
                          <span className="text-emerald-700">✓</span>
                        ) : (
                          <span className="text-amber-700">Δ ≠ 0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
