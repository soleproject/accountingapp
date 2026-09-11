/**
 * SalesTaxTile
 *
 * Inline expandable content for the "Paying Sales tax" row on the
 * Responsibilities panel. Compact mirror of `/reports/sales-tax-report`
 * — same numbers, same bars, same detail table, plus a "Pay Sales Tax"
 * action when there's a positive liability.
 *
 * The panel drives us with a YYYY-MM `period`; we translate that to
 * inclusive `start` / `end` ISO dates for the underlying report.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Percent, Wallet, RefreshCw, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";
import { RecordPaymentDialog } from "@/pages/SalesTax";

function pad2(n) { return String(n).padStart(2, "0"); }

/** Convert "YYYY-MM" into inclusive month bounds. */
function monthBounds(period) {
  const [y, m] = (period || "").split("-").map(Number);
  if (!y || !m) return null;
  const start = `${y}-${pad2(m)}-01`;
  const endD = new Date(Date.UTC(y, m, 0));
  const end = `${endD.getUTCFullYear()}-${pad2(endD.getUTCMonth() + 1)}-${pad2(endD.getUTCDate())}`;
  return { start, end };
}

export default function SalesTaxTile({ companyId, period, returnPath, returnLabel }) {
  const fmtMoney = useMoneyFmt();
  const bounds = useMemo(() => monthBounds(period), [period]);

  const [data, setData] = useState(null);
  const [liability, setLiability] = useState({ accounts: [], total: 0 });
  const [busy, setBusy] = useState(false);
  const [recordingPayment, setRecordingPayment] = useState(false);

  const buildHref = (base) => {
    if (!base) return "#";
    if (!returnPath) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}return_to=${encodeURIComponent(returnPath)}&return_label=${encodeURIComponent(returnLabel || "")}`;
  };

  const load = async () => {
    if (!companyId || !bounds) return;
    setBusy(true);
    try {
      const [r, l] = await Promise.all([
        api.get(`/companies/${companyId}/reports/sales-tax`, { params: bounds }),
        api.get(`/companies/${companyId}/tax-liability`).catch(() => ({ data: { accounts: [], total: 0 } })),
      ]);
      setData(r.data);
      setLiability(l.data || { accounts: [], total: 0 });
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load sales tax report");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [companyId, period]);

  const rowMap = useMemo(() => {
    const out = {};
    for (const r of (data?.rows || [])) out[r.label] = r.amount;
    return out;
  }, [data]);

  const taxable    = rowMap["Taxable sales"] || 0;
  const nontaxable = rowMap["Non-taxable sales"] || 0;
  const collected  = rowMap["Sales tax collected (invoiced)"] || 0;
  const settled    = rowMap["Sales tax collected & received"] || 0;
  const paidPurch  = rowMap["Sales tax paid on purchases"] || 0;
  const remitted   = rowMap["Sales tax payments remitted"] || 0;
  const totalSales = taxable + nontaxable;
  const taxablePct = totalSales > 0 ? (taxable / totalSales) * 100 : 0;
  const netLiability = data?.net_liability || 0;
  const effRate = taxable > 0 ? (collected / taxable) * 100 : 0;

  const deepLink = bounds
    ? `/reports/sales-tax-report?preset=custom&start=${bounds.start}&end=${bounds.end}`
    : "/reports/sales-tax-report";

  if (busy && !data) {
    return (
      <div className="rounded-lg border bg-white p-4 flex items-center justify-center text-slate-400" data-testid="sales-tax-tile-loading">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white overflow-hidden" data-testid="sales-tax-tile">
      {/* Header — period + refresh + Pay */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-slate-50 text-[11px] gap-2 flex-wrap">
        <div className="text-slate-600">
          {data ? (
            <span>
              <span className="font-mono-num">{data.period_start}</span> → <span className="font-mono-num">{data.period_end}</span>
              <span className="mx-1.5 text-slate-300">·</span>
              Net liability:{" "}
              <b className={`font-mono-num ${netLiability >= 0 ? "text-rose-700" : "text-emerald-700"}`} data-testid="sales-tax-tile-net">
                {fmtMoney(netLiability)}
              </b>
            </span>
          ) : "—"}
        </div>
        <div className="flex items-center gap-2">
          {liability.total > 0.005 && (
            <button
              onClick={() => setRecordingPayment(true)}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white"
              data-testid="sales-tax-tile-pay-btn"
              title={`Record a sales-tax payment — you owe ${fmtMoney(liability.total)}`}
            >
              <Wallet size={11} /> Pay Sales Tax
            </button>
          )}
          <button
            onClick={load}
            disabled={busy}
            className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-40"
            data-testid="sales-tax-tile-refresh"
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {data && (
        <>
          {/* Taxable / Non-taxable / Total cards — smaller mirror of the full report */}
          <div className="p-3 grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="rounded-lg border-2 border-emerald-200 bg-emerald-50 p-3" data-testid="sales-tax-tile-taxable">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-emerald-700">Taxable sales</div>
              <div className="font-mono-num text-xl font-bold text-emerald-800 mt-0.5">{fmtMoney(taxable)}</div>
              <div className="text-[10px] text-emerald-800/80 mt-0.5">
                {taxablePct.toFixed(1)}% of total · {data.invoices_count} invoice{data.invoices_count === 1 ? "" : "s"}
              </div>
            </div>
            <div className="rounded-lg border-2 border-slate-200 bg-slate-50 p-3" data-testid="sales-tax-tile-nontaxable">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-600">Non-taxable sales</div>
              <div className="font-mono-num text-xl font-bold text-slate-800 mt-0.5">{fmtMoney(nontaxable)}</div>
              <div className="text-[10px] text-slate-600 mt-0.5">{(100 - taxablePct).toFixed(1)}% of total</div>
            </div>
            <div className="rounded-lg border bg-white p-3" data-testid="sales-tax-tile-total">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">Total sales</div>
              <div className="font-mono-num text-xl font-bold text-slate-900 mt-0.5">{fmtMoney(totalSales)}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">Sum of invoice subtotals in period</div>
            </div>
          </div>

          {/* Taxable share bar */}
          {totalSales > 0 && (
            <div className="px-3 pb-3">
              <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                <span>Taxable share of revenue</span>
                <span className="font-mono-num">{taxablePct.toFixed(1)}% taxable · {(100 - taxablePct).toFixed(1)}% non-taxable</span>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden bg-slate-100">
                <div className="bg-emerald-500 transition-all" style={{ width: `${taxablePct}%` }} />
                <div className="bg-slate-400 transition-all" style={{ width: `${100 - taxablePct}%` }} />
              </div>
            </div>
          )}

          {/* Detail table */}
          <div className="border-t">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 border-b">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Line</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                <DetailRow label="Taxable sales" amount={taxable} fmtMoney={fmtMoney} />
                <DetailRow label="Non-taxable sales" amount={nontaxable} fmtMoney={fmtMoney} />
                <DetailRow label="Total sales" amount={totalSales} bold fmtMoney={fmtMoney} />
                <tr><td colSpan={2} className="border-t"></td></tr>
                <DetailRow label="Sales tax collected (invoiced)" amount={collected} fmtMoney={fmtMoney} />
                <DetailRow label="Sales tax received (paid portion of invoices)" amount={settled} fmtMoney={fmtMoney} muted />
                <DetailRow label="Sales tax paid on vendor bills" amount={paidPurch} fmtMoney={fmtMoney} />
                <DetailRow label="Sales tax payments remitted to agency" amount={remitted} fmtMoney={fmtMoney} />
                <tr className="bg-slate-100 border-t-2 border-slate-300 font-semibold">
                  <td className="px-3 py-2">Net sales tax liability</td>
                  <td className={`px-3 py-2 text-right font-mono-num ${netLiability >= 0 ? "text-rose-700" : "text-emerald-700"}`}>
                    {fmtMoney(netLiability)}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="px-3 py-2 border-t bg-slate-50/60 text-[11px] text-slate-500 flex items-start gap-1.5">
              <Percent size={11} className="mt-0.5 flex-none" />
              <span>
                Effective sales-tax rate on taxable revenue:{" "}
                <b className="font-mono-num">{effRate.toFixed(2)}%</b>. Positive net liability means you've collected more than you paid — remit it. Negative means you paid more on inputs than you owe on outputs.
              </span>
            </div>
          </div>
        </>
      )}

      <div className="px-3 py-2 border-t bg-slate-50 text-right">
        <Link
          to={buildHref(deepLink)}
          className="text-[11px] text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          data-testid="sales-tax-tile-open-report"
        >
          Open full Sales Tax Report <ExternalLink size={10} />
        </Link>
      </div>

      {recordingPayment && (
        <RecordPaymentDialog
          currentId={companyId}
          liability={liability}
          onClose={() => setRecordingPayment(false)}
          onSaved={() => {
            setRecordingPayment(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function DetailRow({ label, amount, bold, muted, fmtMoney }) {
  return (
    <tr className="border-b hover:bg-slate-50">
      <td className={`px-3 py-2 ${bold ? "font-semibold text-slate-900" : muted ? "text-slate-500 pl-6" : "text-slate-700"}`}>{label}</td>
      <td className={`px-3 py-2 text-right font-mono-num ${bold ? "font-semibold" : muted ? "text-slate-500" : ""}`}>{fmtMoney(amount)}</td>
    </tr>
  );
}
