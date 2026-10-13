import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, ChevronLeft, FileText, Sparkles, Info } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * Tax Line Report — SEPARATE from the P&L. Regroups the period's posted
 * P&L balances by the federal return line each account is mapped to
 * (Schedule C / 1120-S in slice 1). Unmapped accounts are surfaced, never
 * silently dropped; non-deductible items land in "Not on return".
 */
const ytd = () => { const t = new Date(); return { start: `${t.getFullYear()}-01-01`, end: t.toISOString().slice(0, 10) }; };

export default function TaxLineReport() {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const [range, setRange] = useState(ytd);
  const [basis, setBasis] = useState("accrual");
  const [taxYear, setTaxYear] = useState(new Date().getFullYear());
  const [d, setD] = useState(null);
  const [cat, setCat] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!currentId) return;
    setLoading(true);
    Promise.all([
      api.get(`/companies/${currentId}/reports/tax-lines?start=${range.start}&end=${range.end}&basis=${basis}&tax_year=${taxYear}`),
      api.get(`/companies/${currentId}/tax-lines/catalog?tax_year=${taxYear}`),
    ]).then(([r, c]) => { setD(r.data); setCat(c.data); }).catch(() => setD(null)).finally(() => setLoading(false));
  }, [currentId, range.start, range.end, basis, taxYear]);
  useEffect(() => { load(); }, [load]);

  const suggest = async () => {
    setBusy(true);
    try { const r = await api.post(`/companies/${currentId}/tax-lines/suggest`); toast.success(`Mapped ${r.data.rule} by rule, ${r.data.ai} by AI · ${r.data.unmapped} still need you`); load(); }
    catch { toast.error("Couldn't suggest mappings"); } finally { setBusy(false); }
  };
  const setForm = async (form) => { await api.put(`/companies/${currentId}/tax-lines/form`, { form }); load(); };
  const mapAcct = async (aid, key) => {
    try { await api.put(`/companies/${currentId}/tax-lines/accounts/${aid}`, { tax_line_key: key || null }); load(); }
    catch { toast.error("Couldn't save mapping"); }
  };

  const keys = cat?.keys || [];
  const KeySelect = ({ value, aid }) => (
    <select value={value || ""} onChange={e => mapAcct(aid, e.target.value)} className="border rounded px-1.5 py-0.5 text-xs bg-white max-w-[260px]" data-testid={`tax-line-map-${aid}`}>
      <option value="">— Unmapped —</option>
      {keys.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
    </select>
  );

  const Section = ({ title, groups, total, testid }) => groups.length === 0 ? null : (
    <div data-testid={testid}>
      <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-slate-500 bg-slate-50 border-y">{title}</div>
      {groups.map(g => (
        <div key={g.key} className="border-b border-slate-100">
          <div className="flex items-center justify-between px-4 py-2 text-sm" data-testid={`tax-line-${g.key}`}>
            <span><span className="inline-block w-16 font-mono-num text-slate-500">Line {g.line}</span><span className="font-medium text-slate-800">{g.label}</span>
              {g.limit_pct && <span className="ml-2 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{g.limit_pct}% limit</span>}</span>
            <span className="font-mono-num font-semibold">{fmt(g.return_amount)}{g.limit_pct && <span className="text-slate-400 font-normal text-xs ml-2">(book {fmt(g.book_amount)})</span>}</span>
          </div>
          {g.accounts.map(a => (
            <div key={a.account_id} className="flex items-center justify-between pl-24 pr-4 py-1 text-xs text-slate-500">
              <span><span className="font-mono-num mr-2">{a.code}</span>{a.name}{a.source === "ai" && <span className="ml-1 text-[10px] text-violet-600" title="Mapped by AI — click to change">· AI</span>}</span>
              <span className="flex items-center gap-3"><span className="font-mono-num">{fmt(a.amount)}</span><KeySelect value={g.key} aid={a.account_id} /></span>
            </div>
          ))}
        </div>
      ))}
      <div className="flex justify-between px-4 py-2 text-sm font-semibold border-b"><span>Total {title.toLowerCase()}</span><span className="font-mono-num">{fmt(total)}</span></div>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5" data-testid="tax-line-report-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link to="/reports" className="text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1" data-testid="tax-line-back"><ChevronLeft size={12} /> Reports</Link>
          <h1 className="font-heading text-2xl font-bold text-slate-900 flex items-center gap-2 mt-1"><FileText size={22} className="text-emerald-600" /> Tax Line Report</h1>
          <p className="text-sm text-slate-500 mt-1">{d?.company_name} · {d?.business_type || "entity type not set"} · {range.start} → {range.end} · {basis}</p>
        </div>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <select value={cat?.form || ""} onChange={e => setForm(e.target.value)} className="border rounded-md px-2 py-1.5 bg-white" data-testid="tax-line-form" title="Tax form (from entity type — override here)">
            <option value="" disabled>Pick tax form…</option>
            {Object.entries(cat?.forms || {}).map(([k, v]) => <option key={k} value={k}>{v}{(cat?.supported_forms || []).includes(k) ? "" : " (coming soon)"}</option>)}
          </select>
          <select value={taxYear} onChange={e => setTaxYear(Number(e.target.value))} className="border rounded-md px-2 py-1.5 bg-white" data-testid="tax-line-year">
            {[2024, 2025, 2026].map(y => <option key={y} value={y}>Tax year {y}</option>)}
          </select>
          <input type="date" value={range.start} onChange={e => setRange(r => ({ ...r, start: e.target.value }))} className="border rounded-md px-2 py-1.5" data-testid="tax-line-start" />
          <input type="date" value={range.end} onChange={e => setRange(r => ({ ...r, end: e.target.value }))} className="border rounded-md px-2 py-1.5" data-testid="tax-line-end" />
          <select value={basis} onChange={e => setBasis(e.target.value)} className="border rounded-md px-2 py-1.5 bg-white" data-testid="tax-line-basis"><option value="accrual">Accrual</option><option value="cash">Cash</option></select>
          <button onClick={suggest} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs font-semibold disabled:opacity-50" data-testid="tax-line-suggest">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Map unmapped with AI
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-xs text-emerald-900 flex gap-2" data-testid="tax-line-note">
        <Info size={14} className="shrink-0 mt-0.5" />
        <span>Separate from your P&amp;L — nothing here changes the books. Lines follow <b>{d?.form_label || "the entity's federal form"}</b>, tax year {d?.catalog_year}{d?.params?.verified_on ? ` (verified ${d.params.verified_on})` : ""}. Federal only.</span>
      </div>

      {loading ? <div className="py-16 text-center text-slate-400"><Loader2 className="animate-spin inline" /></div>
      : !d ? <div className="py-16 text-center text-slate-400 text-sm">Couldn't load the report.</div>
      : !d.supported ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900" data-testid="tax-line-unsupported">
          {d.form ? <>Lines for <b>{d.form_label}</b> aren't published yet. Your mappings are saved and will populate automatically when they are.</> : <>No tax form could be inferred from the entity type — pick one above.</>}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <Section title="Income" groups={d.income} total={d.total_income} testid="tax-line-income" />
          <Section title="Cost of goods sold" groups={d.cogs} total={d.total_cogs} testid="tax-line-cogs" />
          <Section title="Deductions" groups={d.deductions} total={d.total_deductions} testid="tax-line-deductions" />
          <div className="flex justify-between px-4 py-3 bg-slate-900 text-white text-sm"><span className="font-semibold">Net per return lines</span><span className="font-mono-num font-semibold" data-testid="tax-line-return-net">{fmt(d.return_net)}</span></div>

          <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-rose-700 bg-rose-50 border-y border-rose-100 flex justify-between"><span>Unmapped — needs a decision ({d.unmapped.length})</span><span className="font-mono-num">{fmt(d.unmapped_total)}</span></div>
          {d.unmapped.length === 0 ? <div className="px-4 py-3 text-xs text-slate-400" data-testid="tax-line-unmapped-empty">All active accounts with activity are mapped.</div>
            : d.unmapped.map(a => (
              <div key={a.account_id} className="flex items-center justify-between px-4 py-1.5 text-xs border-b border-slate-100" data-testid={`tax-line-unmapped-${a.code}`}>
                <span><span className="font-mono-num text-slate-400 mr-2">{a.code}</span>{a.name}</span>
                <span className="flex items-center gap-3"><span className="font-mono-num">{fmt(a.amount)}</span><KeySelect value="" aid={a.account_id} /></span>
              </div>
            ))}

          <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-slate-500 bg-slate-50 border-y flex justify-between"><span>Not on return ({d.not_on_return.length})</span><span className="font-mono-num">{fmt(d.not_on_return_total)}</span></div>
          {d.not_on_return.map(a => (
            <div key={a.account_id} className="flex items-center justify-between px-4 py-1.5 text-xs text-slate-500 border-b border-slate-100" data-testid={`tax-line-nor-${a.code}`}>
              <span><span className="font-mono-num mr-2">{a.code}</span>{a.name} <span className="text-slate-400">· {keys.find(k => k.key === a.key)?.label}</span></span>
              <span className="flex items-center gap-3"><span className="font-mono-num">{fmt(a.amount)}</span><KeySelect value={a.key} aid={a.account_id} /></span>
            </div>
          ))}

          <div className="px-4 py-3 text-xs text-slate-600 bg-slate-50 border-t grid grid-cols-2 gap-x-6 gap-y-1" data-testid="tax-line-recon">
            <span>Book net income (P&amp;L)</span><span className="text-right font-mono-num">{fmt(d.book_net_income)}</span>
            <span>Not on return / unmapped / limits</span><span className="text-right font-mono-num">{fmt(d.return_net - d.book_net_income)}</span>
            <span className="font-semibold">Net per return lines</span><span className="text-right font-mono-num font-semibold">{fmt(d.return_net)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
