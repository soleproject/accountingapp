/**
 * PayrollLiabilitiesTile
 *
 * Inline expandable content for the "Paying Payroll liabilities" row on
 * the Client Cockpit Responsibilities panel. Surfaces the outstanding
 * aging from `/api/companies/{cid}/payroll/liabilities` so a CPA can
 * see IRS + state amounts owed alongside AR and AP without opening a
 * separate module.
 *
 * Layout mirrors SalesTaxTile:
 *   - three top KPIs (Owed / Paid / Outstanding)
 *   - by-agency table (IRS, state SIT, SUTA, benefit vendors, etc.)
 *   - by-state chips
 *   - "Open Payroll" deep link
 *
 * Cadence note: payroll liabilities are perpetual, not month-scoped —
 * federal 941 deposits are semi-weekly or monthly, FUTA is quarterly,
 * 401(k) is 7 days. We show the full outstanding balance across all
 * finalized runs, not the current month, so nothing goes missing.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw, ExternalLink, AlertCircle } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";

export default function PayrollLiabilitiesTile({
  companyId, returnPath, returnLabel,
}) {
  const fmtMoney = useMoneyFmt();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const buildHref = (base) => {
    if (!base) return "#";
    if (!returnPath) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}return_to=${encodeURIComponent(returnPath)}&return_label=${encodeURIComponent(returnLabel || "")}`;
  };

  const load = async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/payroll/liabilities`);
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load payroll liabilities");
    } finally { setBusy(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [companyId]);

  if (busy && !data) {
    return (
      <div className="py-6 flex items-center justify-center text-slate-400">
        <Loader2 className="animate-spin" size={16} />
      </div>
    );
  }
  if (!data) return null;

  const t = data.totals || {};
  const owed = Number(t.owed || 0);
  const paid = Number(t.paid || 0);
  const outstanding = Number(t.outstanding || 0);
  const byAgency = (data.by_agency || []).filter(a => Number(a.outstanding || 0) > 0.005);
  const byState  = (data.by_state  || []).filter(s => Number(s.outstanding || 0) > 0.005);

  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-3"
      data-testid="payroll-liabilities-tile"
    >
      {/* Header — stacks on mobile, side-by-side on desktop */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-amber-900/70 font-semibold">
            Payroll liabilities · outstanding
          </div>
          <div className="text-[11px] text-amber-900/60">
            Federal 941, FUTA, state SIT/SUTA, 401(k), and benefit remittances
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={load} disabled={busy}
            data-testid="payroll-liab-refresh"
            className="text-[11px] px-2 py-1 rounded border border-amber-300 bg-white hover:bg-amber-50 inline-flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
          <Link
            to={buildHref("/accounting/payroll")}
            data-testid="payroll-liab-open"
            className="text-[11px] px-2 py-1 rounded bg-amber-700 text-white hover:bg-amber-800 inline-flex items-center gap-1"
          >
            Open Payroll <ExternalLink size={10} />
          </Link>
        </div>
      </div>

      {/* KPIs — stack on mobile so long money values (e.g. $12,345.67)
          don't get clipped in a 3-col grid at 390px. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="rounded-md bg-white border border-amber-200 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Owed</div>
          <div className="text-lg font-mono-num font-semibold text-slate-900"
               data-testid="payroll-liab-owed">
            {fmtMoney(owed)}
          </div>
        </div>
        <div className="rounded-md bg-white border border-amber-200 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Paid</div>
          <div className="text-lg font-mono-num font-semibold text-slate-900"
               data-testid="payroll-liab-paid">
            {fmtMoney(paid)}
          </div>
        </div>
        <div className="rounded-md bg-white border border-amber-300 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-amber-800/80">Outstanding</div>
          <div className={`text-lg font-mono-num font-semibold ${outstanding > 0.005 ? "text-amber-900" : "text-emerald-700"}`}
               data-testid="payroll-liab-outstanding">
            {fmtMoney(outstanding)}
          </div>
        </div>
      </div>

      {/* By-agency table */}
      {byAgency.length > 0 ? (
        <div className="rounded-md bg-white border border-amber-200 overflow-hidden">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-slate-500 bg-slate-50 border-b border-amber-200">
            By agency / recipient
          </div>
          <table className="w-full text-xs">
            <tbody>
              {byAgency.map((a, i) => (
                <tr key={a.agency + i} className="border-t border-slate-100 first:border-t-0"
                    data-testid={`payroll-liab-agency-${(a.agency || "unknown").replace(/\s+/g, "-").toLowerCase()}`}>
                  <td className="px-3 py-1.5 text-slate-800">{a.agency || "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono-num text-slate-900">
                    {fmtMoney(a.outstanding)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : outstanding > 0.005 ? (
        // Fallback: aggregate exists but agency breakdown is empty
        // (only happens on simple-mode stubs that skipped tax codes).
        <div className="rounded-md bg-white border border-amber-200 px-3 py-2 text-xs text-slate-600 inline-flex items-center gap-2">
          <AlertCircle size={14} className="text-amber-700" />
          {fmtMoney(outstanding)} outstanding without an agency/state tag —
          <Link to={buildHref("/accounting/payroll")}
                className="text-amber-800 hover:underline"
                data-testid="payroll-liab-code-hint">
            code your line items to see the breakdown
          </Link>.
        </div>
      ) : (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
          All payroll liabilities are settled.
        </div>
      )}

      {/* By-state chips */}
      {byState.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-500 mr-1">By state</span>
          {byState.map((s, i) => (
            <span key={s.state + i}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-amber-300 text-slate-800"
                  data-testid={`payroll-liab-state-${(s.state || "unknown").toLowerCase()}`}>
              {s.state}: <b className="font-mono-num">{fmtMoney(s.outstanding)}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
