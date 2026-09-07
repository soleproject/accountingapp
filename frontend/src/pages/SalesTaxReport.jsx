import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, Printer, ChevronLeft, Percent } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * Sales Tax Report — taxable vs non-taxable sales for a chosen period.
 * Backed by GET /api/companies/{cid}/reports/sales-tax?start=…&end=…
 * (already returns `taxable_sales`, `nontaxable_sales`, collected, paid,
 * settled, net_liability, invoice count).
 *
 * Period presets snap `start`/`end` to canonical week/month/quarter/year
 * boundaries so tax filers land on the right window without hand-typing
 * dates.
 */
const PRESETS = [
  { key: "this_week",    label: "This week" },
  { key: "this_month",   label: "This month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "this_year",    label: "This year" },
  { key: "last_week",    label: "Last week" },
  { key: "last_month",   label: "Last month" },
  { key: "last_quarter", label: "Last quarter" },
  { key: "last_year",    label: "Last year" },
  { key: "custom",       label: "Custom range" },
];

function pad2(n) { return String(n).padStart(2, "0"); }
function iso(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }

/**
 * Resolve a preset key into a `{start, end}` ISO date pair. All boundaries
 * are inclusive. Weeks are Mon–Sun. Quarters follow the calendar
 * (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec). Years are Jan 1 – Dec 31.
 */
function rangeForPreset(key, todayIso) {
  const today = new Date(todayIso + "T00:00:00Z");
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();

  const startOfWeek = (dt) => {
    // Mon = 1 … Sun = 0 → shift Sunday to 7 for ISO week.
    const day = dt.getUTCDay() || 7;
    const s = new Date(dt);
    s.setUTCDate(dt.getUTCDate() - (day - 1));
    return s;
  };

  switch (key) {
    case "this_week": {
      const s = startOfWeek(today);
      const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6);
      return { start: iso(s), end: iso(e) };
    }
    case "last_week": {
      const s = startOfWeek(today); s.setUTCDate(s.getUTCDate() - 7);
      const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6);
      return { start: iso(s), end: iso(e) };
    }
    case "this_month":
      return { start: `${y}-${pad2(m + 1)}-01`, end: iso(new Date(Date.UTC(y, m + 1, 0))) };
    case "last_month": {
      const ly = m === 0 ? y - 1 : y;
      const lm = m === 0 ? 11 : m - 1;
      return { start: `${ly}-${pad2(lm + 1)}-01`, end: iso(new Date(Date.UTC(ly, lm + 1, 0))) };
    }
    case "this_quarter": {
      const q = Math.floor(m / 3);
      const s = new Date(Date.UTC(y, q * 3, 1));
      const e = new Date(Date.UTC(y, q * 3 + 3, 0));
      return { start: iso(s), end: iso(e) };
    }
    case "last_quarter": {
      const q = Math.floor(m / 3) - 1;
      const yy = q < 0 ? y - 1 : y;
      const qq = (q + 4) % 4;
      const s = new Date(Date.UTC(yy, qq * 3, 1));
      const e = new Date(Date.UTC(yy, qq * 3 + 3, 0));
      return { start: iso(s), end: iso(e) };
    }
    case "this_year":
      return { start: `${y}-01-01`, end: `${y}-12-31` };
    case "last_year":
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    default:
      return null;
  }
}

export default function SalesTaxReport() {
  const { currentId } = useCompany();
  const fmtMoney = useMoneyFmt();
  const [params, setParams] = useSearchParams();

  const todayIso = new Date().toISOString().slice(0, 10);
  const [preset, setPreset] = useState(params.get("preset") || "this_month");
  const initialRange = useMemo(
    () => rangeForPreset(params.get("preset") || "this_month", todayIso) || { start: todayIso, end: todayIso },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [start, setStart] = useState(params.get("start") || initialRange.start);
  const [end, setEnd]     = useState(params.get("end")   || initialRange.end);
  const [data, setData]   = useState(null);
  const [loading, setLoading] = useState(false);

  // Re-snap dates when a non-custom preset changes.
  useEffect(() => {
    if (preset === "custom") return;
    const r = rangeForPreset(preset, todayIso);
    if (!r) return;
    setStart(r.start);
    setEnd(r.end);
  }, [preset, todayIso]);

  // Persist to URL so users can bookmark / share a specific slice.
  useEffect(() => {
    const p = new URLSearchParams(params);
    p.set("preset", preset);
    p.set("start", start);
    p.set("end", end);
    setParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, start, end]);

  // Fetch on any date change.
  useEffect(() => {
    if (!currentId || !start || !end) return;
    setLoading(true);
    api
      .get(`/companies/${currentId}/reports/sales-tax`, { params: { start, end } })
      .then(r => setData(r.data))
      .catch(e => {
        toast.error(e.response?.data?.detail || "Failed to load sales tax report");
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [currentId, start, end]);

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
  const totalSales = taxable + nontaxable;
  const taxablePct = totalSales > 0 ? (taxable / totalSales) * 100 : 0;
  const netLiability = data?.net_liability || 0;
  const effRate = taxable > 0 ? (collected / taxable) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 print:hidden">
        <div>
          <div className="text-xs text-slate-500 mb-1">
            <Link to="/reports" className="inline-flex items-center gap-1 hover:underline">
              <ChevronLeft size={12} /> Reports
            </Link>
          </div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Sales Tax Report</h1>
          <p className="text-slate-500 text-sm mt-1">Taxable vs. non-taxable sales · sales tax collected · net liability.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="border rounded px-2 py-1 text-sm bg-white"
            data-testid="sales-tax-preset"
          >
            {PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <label className="text-xs text-slate-500 inline-flex items-center gap-1">
            From
            <input
              type="date" value={start}
              onChange={(e) => { setStart(e.target.value); setPreset("custom"); }}
              className="border rounded px-2 py-1 text-sm"
              data-testid="sales-tax-start"
            />
          </label>
          <label className="text-xs text-slate-500 inline-flex items-center gap-1">
            To
            <input
              type="date" value={end}
              onChange={(e) => { setEnd(e.target.value); setPreset("custom"); }}
              className="border rounded px-2 py-1 text-sm"
              data-testid="sales-tax-end"
            />
          </label>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border bg-white text-xs hover:bg-slate-50"
            data-testid="sales-tax-print"
          >
            <Printer size={13} /> Print / PDF
          </button>
        </div>
      </div>

      {loading && (
        <div className="rounded-xl border bg-white p-8 text-center text-slate-500">
          <Loader2 className="inline animate-spin mr-2" size={16} /> Loading…
        </div>
      )}

      {!loading && data && (
        <>
          {/* Header card */}
          <div className="rounded-xl border bg-white p-5">
            <div className="flex items-baseline justify-between flex-wrap gap-2">
              <div>
                <div className="font-heading font-semibold text-lg">{data.company_name}</div>
                <div className="text-xs text-slate-500">
                  Sales Tax Report · <span className="font-mono-num">{data.period_start}</span> → <span className="font-mono-num">{data.period_end}</span>
                </div>
              </div>
              <div className="text-sm text-slate-600">
                Net liability:{" "}
                <span className={`font-mono-num font-semibold ${netLiability >= 0 ? "text-rose-700" : "text-emerald-700"}`}
                      data-testid="sales-tax-net-liability">
                  {fmtMoney(netLiability)}
                </span>
              </div>
            </div>
          </div>

          {/* Taxable vs Non-taxable sales — the star of this report */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-5" data-testid="sales-tax-taxable-card">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-emerald-700">Taxable sales</div>
              <div className="font-mono-num text-3xl font-bold text-emerald-800 mt-1">{fmtMoney(taxable)}</div>
              <div className="text-xs text-emerald-800/80 mt-1">
                {taxablePct.toFixed(1)}% of total · {data.invoices_count} invoice{data.invoices_count === 1 ? "" : "s"}
              </div>
            </div>
            <div className="rounded-xl border-2 border-slate-200 bg-slate-50 p-5" data-testid="sales-tax-nontaxable-card">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-600">Non-taxable sales</div>
              <div className="font-mono-num text-3xl font-bold text-slate-800 mt-1">{fmtMoney(nontaxable)}</div>
              <div className="text-xs text-slate-600 mt-1">
                {(100 - taxablePct).toFixed(1)}% of total
              </div>
            </div>
            <div className="rounded-xl border bg-white p-5" data-testid="sales-tax-total-card">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">Total sales</div>
              <div className="font-mono-num text-3xl font-bold text-slate-900 mt-1">{fmtMoney(totalSales)}</div>
              <div className="text-xs text-slate-500 mt-1">Sum of invoice subtotals in period</div>
            </div>
          </div>

          {/* Taxable share visual */}
          {totalSales > 0 && (
            <div className="rounded-xl border bg-white p-5">
              <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                <span>Taxable share of revenue</span>
                <span className="font-mono-num">{taxablePct.toFixed(1)}% taxable · {(100 - taxablePct).toFixed(1)}% non-taxable</span>
              </div>
              <div className="flex h-3 rounded-full overflow-hidden bg-slate-100">
                <div className="bg-emerald-500 transition-all" style={{ width: `${taxablePct}%` }} />
                <div className="bg-slate-400 transition-all" style={{ width: `${100 - taxablePct}%` }} />
              </div>
            </div>
          )}

          {/* Detail — the underlying tax mechanics */}
          <div className="rounded-xl border bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase text-slate-500 border-b">
                <tr>
                  <th className="px-3 py-2 text-left">Line</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                <DetailRow label="Taxable sales"    amount={taxable}    fmtMoney={fmtMoney} />
                <DetailRow label="Non-taxable sales" amount={nontaxable} fmtMoney={fmtMoney} />
                <DetailRow label="Total sales"      amount={totalSales} bold fmtMoney={fmtMoney} />
                <tr><td colSpan={2} className="border-t"></td></tr>
                <DetailRow label="Sales tax collected (invoiced)" amount={collected} fmtMoney={fmtMoney} />
                <DetailRow label="Sales tax received (paid portion of invoices)" amount={settled} fmtMoney={fmtMoney} muted />
                <DetailRow label="Sales tax paid on vendor bills" amount={paidPurch} fmtMoney={fmtMoney} />
                <tr className="bg-slate-100 border-t-2 border-slate-300 font-semibold">
                  <td className="px-3 py-2">Net sales tax liability</td>
                  <td className={`px-3 py-2 text-right font-mono-num ${netLiability >= 0 ? "text-rose-700" : "text-emerald-700"}`}>
                    {fmtMoney(netLiability)}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="px-4 py-3 border-t bg-slate-50/60 text-[11px] text-slate-500 inline-flex items-start gap-1.5">
              <Percent size={11} className="mt-0.5 flex-none" />
              <span>
                Effective sales-tax rate on taxable revenue: <b className="font-mono-num">{effRate.toFixed(2)}%</b>. Positive net liability means
                you've collected more than you paid — remit it. Negative means you paid more
                on inputs than you owe on outputs.
              </span>
            </div>
          </div>
        </>
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
