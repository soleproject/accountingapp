import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, ChevronLeft, Scale, Info } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * Book-to-Tax Adjustments — a SEPARATE report from the P&L.
 * Starts at book net income (straight from the Income Statement) and
 * adds back the non-deductible share of expense accounts whose tax
 * deductibility is < 100% (entertainment 0%, business meals 50%, …).
 * Backed by GET /api/companies/{cid}/reports/book-to-tax.
 */
const ytd = () => {
  const t = new Date();
  return { start: `${t.getFullYear()}-01-01`, end: t.toISOString().slice(0, 10) };
};

export default function BookToTaxReport() {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const [range, setRange] = useState(ytd);
  const [basis, setBasis] = useState("accrual");
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentId) return;
    setLoading(true);
    api.get(`/companies/${currentId}/reports/book-to-tax?start=${range.start}&end=${range.end}&basis=${basis}`)
      .then(r => setD(r.data)).catch(() => setD(null)).finally(() => setLoading(false));
  }, [currentId, range.start, range.end, basis]);

  const rows = d?.adjustments || [];
  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-5" data-testid="book-to-tax-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link to="/reports" className="text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1" data-testid="book-to-tax-back"><ChevronLeft size={12} /> Reports</Link>
          <h1 className="font-heading text-2xl font-bold text-slate-900 flex items-center gap-2 mt-1"><Scale size={22} className="text-violet-600" /> Book-to-Tax Adjustments</h1>
          <p className="text-sm text-slate-500 mt-1">{d?.company_name} · {range.start} → {range.end} · {basis}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <input type="date" value={range.start} onChange={e => setRange(r => ({ ...r, start: e.target.value }))} className="border rounded-md px-2 py-1.5" data-testid="book-to-tax-start" />
          <span className="text-slate-400">→</span>
          <input type="date" value={range.end} onChange={e => setRange(r => ({ ...r, end: e.target.value }))} className="border rounded-md px-2 py-1.5" data-testid="book-to-tax-end" />
          <select value={basis} onChange={e => setBasis(e.target.value)} className="border rounded-md px-2 py-1.5" data-testid="book-to-tax-basis">
            <option value="accrual">Accrual</option>
            <option value="cash">Cash</option>
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-4 py-3 text-xs text-violet-900 flex gap-2" data-testid="book-to-tax-note">
        <Info size={14} className="shrink-0 mt-0.5" />
        <span>This report does <b>not</b> change your Profit &amp; Loss. The P&amp;L keeps every expense at its full book amount; this view shows the preparer what gets added back for tax (Schedule M-1 style). Set an account's deductibility in the Chart of Accounts (edit row → Tax deductibility).</span>
      </div>

      {loading ? (
        <div className="py-16 text-center text-slate-400"><Loader2 className="animate-spin inline" /></div>
      ) : !d ? (
        <div className="py-16 text-center text-slate-400 text-sm">Couldn't load the report.</div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex justify-between px-4 py-3 bg-slate-50 border-b text-sm">
            <span className="font-semibold text-slate-800">Book net income (per Income Statement)</span>
            <span className="font-mono-num font-semibold" data-testid="book-to-tax-book-ni">{fmt(d.book_net_income)}</span>
          </div>
          <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-slate-500 border-b">Add back: non-deductible portion of expenses</div>
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-400 text-center" data-testid="book-to-tax-empty">No partially- or non-deductible expense activity in this period.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="border-b">
                  <th className="text-left px-4 py-2 font-medium">Account</th>
                  <th className="text-right px-3 py-2 font-medium">Book amount</th>
                  <th className="text-right px-3 py-2 font-medium">Deductible</th>
                  <th className="text-right px-4 py-2 font-medium">Add-back</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.account_id} className="border-b border-slate-100" data-testid={`book-to-tax-row-${r.code}`}>
                    <td className="px-4 py-2">
                      <span className="font-mono-num text-slate-400 mr-2">{r.code}</span>{r.name}
                      <span className={`ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 border ${r.deductible_pct === 0 ? "text-rose-700 bg-rose-50 border-rose-200" : "text-amber-700 bg-amber-50 border-amber-200"}`}>{r.deductible_pct}%</span>
                      {r.inferred && <span className="ml-1 text-[10px] text-slate-400" title="Deductibility inferred from the account name — set it explicitly in the Chart of Accounts to lock it in.">(inferred)</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono-num">{fmt(r.book_amount)}</td>
                    <td className="px-3 py-2 text-right font-mono-num text-slate-500">{fmt(r.deductible_amount)}</td>
                    <td className="px-4 py-2 text-right font-mono-num text-rose-700">{r.addback > 0 ? "+" : ""}{fmt(r.addback)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex justify-between px-4 py-2.5 border-t text-sm">
            <span className="text-slate-600">Total add-backs</span>
            <span className="font-mono-num text-rose-700" data-testid="book-to-tax-total-addback">{d.total_addback > 0 ? "+" : ""}{fmt(d.total_addback)}</span>
          </div>
          <div className="flex justify-between px-4 py-3 bg-slate-900 text-white text-sm">
            <span className="font-semibold">Estimated taxable net income</span>
            <span className="font-mono-num font-semibold" data-testid="book-to-tax-taxable-ni">{fmt(d.taxable_net_income)}</span>
          </div>
        </div>
      )}
      <p className="text-[11px] text-slate-400">Estimate only — other book/tax differences (depreciation methods, accrued vs paid items, owner compensation) are not included.</p>
    </div>
  );
}
