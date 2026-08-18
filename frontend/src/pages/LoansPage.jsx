import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { Plus, ChevronDown, ChevronRight, Percent, Calendar, DollarSign, Trash2, Download, Send } from "lucide-react";
import { toast } from "sonner";

/**
 * Loans register with a click-to-expand amortization preview.
 *
 * Loan rows sourced from `/api/companies/{cid}/loans`. Clicking a row
 * toggles a mini amortization schedule computed entirely client-side
 * (deterministic fixed-payment amortization). No round-trip needed —
 * schedules recompute instantly as pros scan the register.
 */
export default function LoansPage() {
  const fmtMoney = useMoneyFmt();
  const { currentId } = useCompany();
  const [loans, setLoans] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!currentId) return;
    try {
      const r = await api.get(`/companies/${currentId}/loans`);
      setLoans(r.data?.loans || r.data?.items || []);
    } catch { setLoans([]); }
  };
  useEffect(() => { load(); }, [currentId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Loans</h1>
          <p className="text-slate-500 text-sm mt-1">Lender, principal, rate, term · click any row to preview the amortization schedule.</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
          data-testid="loans-add-btn"
        >
          <Plus size={13} /> Add Loan
        </button>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 border-b">
            <tr>
              <th className="w-6 px-3 py-2"></th>
              <th className="px-3 py-2 text-left">Lender</th>
              <th className="px-3 py-2 text-right">Principal</th>
              <th className="px-3 py-2 text-right">Interest Rate %</th>
              <th className="px-3 py-2 text-right">Term (months)</th>
              <th className="px-3 py-2 text-right">Est. Monthly Pmt</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loans.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-slate-500">No loans yet — create one from Chart of Accounts (Loan and Line of Credit sub-type) or click Add Loan.</td></tr>
            )}
            {loans.map(l => {
              const monthlyPmt = calcMonthlyPayment(l.principal, l.rate, l.term_months);
              const isOpen = expandedId === l.id;
              return (
                <>
                  <tr
                    key={l.id}
                    onClick={() => setExpandedId(isOpen ? null : l.id)}
                    className="border-b hover:bg-indigo-50/40 cursor-pointer"
                    data-testid={`loan-row-${l.id}`}
                  >
                    <td className="px-3 py-2">
                      {isOpen ? <ChevronDown size={13} className="text-slate-500" /> : <ChevronRight size={13} className="text-slate-500" />}
                    </td>
                    <td className="px-3 py-2 font-heading font-medium">{l.lender || "—"}</td>
                    <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(l.principal || 0)}</td>
                    <td className="px-3 py-2 text-right font-mono-num">{l.rate != null ? Number(l.rate).toFixed(3) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono-num">{l.term_months || "—"}</td>
                    <td className="px-3 py-2 text-right font-mono-num font-semibold text-slate-900">
                      {monthlyPmt != null ? fmtMoney(monthlyPmt) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); if (confirm(`Delete loan for ${l.lender || 'this lender'}?`)) { api.delete(`/companies/${currentId}/loans/${l.id}`).then(load); } }}
                        className="p-1 rounded text-red-500 hover:bg-red-50"
                        data-testid={`loan-delete-${l.id}`}
                        title="Delete loan"
                      ><Trash2 size={13} /></button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${l.id}-schedule`} className="bg-slate-50/50" data-testid={`loan-amortization-${l.id}`}>
                      <td colSpan={7} className="p-4">
                        <AmortizationPreview loan={l} currentId={currentId} onPaymentRecorded={load} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      {creating && (
        <QuickLoanModal
          currentId={currentId}
          onClose={(reload) => { setCreating(false); if (reload) load(); }}
        />
      )}
    </div>
  );
}

// Standard fixed-payment amortization formula. Returns null when any
// input is missing — table cells then show "—" instead of NaN.
function calcMonthlyPayment(principal, ratePct, termMonths) {
  const P = Number(principal || 0);
  const n = Number(termMonths || 0);
  if (P <= 0 || n <= 0) return null;
  const r = Number(ratePct || 0) / 100 / 12;
  if (r === 0) return P / n; // zero-interest edge case
  return P * (r / (1 - Math.pow(1 + r, -n)));
}

function AmortizationPreview({ loan, currentId, onPaymentRecorded }) {

  const fmtMoney = useMoneyFmt();
  const paidCount = Number(loan.payments_made || 0);
  const [cashAccts, setCashAccts] = useState([]);
  const [recording, setRecording] = useState(false);
  const [showPmtForm, setShowPmtForm] = useState(false);
  const [pmtDate, setPmtDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [pmtCashId, setPmtCashId] = useState("");

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/accounts`).then(r => {
      const list = (r.data?.accounts || r.data?.items || []).filter(
        a => a.type === "asset" && (
          (a.detail_type === "cash_and_bank") ||
          /cash|checking|savings|bank/i.test(a.name || "")
        )
      );
      setCashAccts(list);
      if (list[0] && !pmtCashId) setPmtCashId(list[0].id);
    });
  }, [currentId]);

  const rows = useMemo(() => {
    const P = Number(loan.principal || 0);
    const n = Number(loan.term_months || 0);
    if (P <= 0 || n <= 0) return [];
    const r = Number(loan.rate || 0) / 100 / 12;
    const pmt = calcMonthlyPayment(P, loan.rate, n);
    let balance = P;
    const arr = [];
    for (let i = 1; i <= n; i++) {
      const interest = balance * r;
      const principal = pmt - interest;
      balance -= principal;
      arr.push({
        num: i, payment: pmt, interest, principal,
        balance: Math.max(0, balance),
      });
    }
    return arr;
  }, [loan.principal, loan.rate, loan.term_months]);

  const downloadCsv = () => {
    if (rows.length === 0) return;
    const header = ["Payment #", "Payment", "Interest", "Principal", "Balance"];
    const csv = [
      [`Loan: ${loan.lender || ""}`],
      [`Principal: ${loan.principal}`, `Rate: ${loan.rate}%`, `Term: ${loan.term_months} months`],
      [],
      header,
      ...rows.map(r => [r.num, r.payment.toFixed(2), r.interest.toFixed(2), r.principal.toFixed(2), r.balance.toFixed(2)]),
    ].map(cols => cols.map(c => String(c).includes(",") ? `"${c}"` : c).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `amortization-${(loan.lender || "loan").replace(/\s+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Amortization schedule downloaded");
  };

  const recordPayment = async () => {
    if (!pmtCashId) { toast.error("Pick a cash account."); return; }
    if (!pmtDate) { toast.error("Payment date is required."); return; }
    setRecording(true);
    try {
      const r = await api.post(`/companies/${currentId}/loans/${loan.id}/record-payment`, {
        payment_date: pmtDate,
        cash_account_id: pmtCashId,
      });
      const d = r.data;
      toast.success(`Payment #${d.payment_number} posted · Interest ${fmtMoney(d.interest)} + Principal ${fmtMoney(d.principal)}`);
      setShowPmtForm(false);
      onPaymentRecorded?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not record payment");
    } finally {
      setRecording(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="text-xs text-slate-500 italic px-3 py-2">
        Add a principal, interest rate, and term to see the amortization schedule.
      </div>
    );
  }

  const shown = rows.length <= 12
    ? rows.map(r => ({ ...r, __kind: "row" }))
    : [
        ...rows.slice(0, 6).map(r => ({ ...r, __kind: "row" })),
        { __kind: "spacer", skipped: rows.length - 9 },
        ...rows.slice(-3).map(r => ({ ...r, __kind: "row" })),
      ];

  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  const totalPayments = rows.reduce((s, r) => s + r.payment, 0);
  const nextPaymentNum = paidCount + 1;

  return (
    <div className="rounded-lg border border-slate-200 bg-white" data-testid="loan-amortization-preview">
      <div className="px-3 py-2 border-b bg-indigo-50/60 grid grid-cols-4 gap-3 text-[11px] text-slate-600 items-end">
        <div>
          <div className="flex items-center gap-1"><Percent size={10} /> Rate</div>
          <div className="font-mono-num font-semibold text-slate-900">{Number(loan.rate || 0).toFixed(3)}% / yr</div>
        </div>
        <div>
          <div className="flex items-center gap-1"><Calendar size={10} /> Term</div>
          <div className="font-mono-num font-semibold text-slate-900">
            {loan.term_months} months
            {paidCount > 0 && <span className="text-emerald-700 ml-1">· {paidCount} paid</span>}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1"><DollarSign size={10} /> Total Interest</div>
          <div className="font-mono-num font-semibold text-slate-900">{fmtMoney(totalInterest)}</div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={downloadCsv}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 text-xs hover:bg-white"
            data-testid={`loan-download-csv-${loan.id}`}
            title="Download schedule as CSV"
          ><Download size={11} /> CSV</button>
          {paidCount < rows.length && (
            <button
              onClick={() => setShowPmtForm(v => !v)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-indigo-600 text-white text-xs hover:bg-indigo-500"
              data-testid={`loan-record-pmt-${loan.id}`}
            ><Send size={11} /> Record Payment #{nextPaymentNum}</button>
          )}
        </div>
      </div>
      {showPmtForm && (
        <div className="px-3 py-2 border-b bg-emerald-50/40 flex flex-wrap items-end gap-2 text-xs" data-testid={`loan-pmt-form-${loan.id}`}>
          <div>
            <label className="block text-[10px] text-slate-600 mb-0.5">Payment date</label>
            <input type="date" value={pmtDate} onChange={(e) => setPmtDate(e.target.value)}
                   className="border rounded px-2 py-1 text-xs font-mono-num" />
          </div>
          <div>
            <label className="block text-[10px] text-slate-600 mb-0.5">Cash account</label>
            <select value={pmtCashId} onChange={(e) => setPmtCashId(e.target.value)}
                    className="border rounded px-2 py-1 text-xs bg-white min-w-[180px]"
                    data-testid={`loan-pmt-cash-${loan.id}`}>
              <option value="">— pick one —</option>
              {cashAccts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select>
          </div>
          <button onClick={recordPayment} disabled={recording}
                  className="px-3 py-1.5 rounded bg-slate-900 text-white text-xs disabled:opacity-50"
                  data-testid={`loan-pmt-post-${loan.id}`}>
            {recording ? "Posting…" : "Post Journal Entry"}
          </button>
          <button onClick={() => setShowPmtForm(false)} className="px-3 py-1.5 rounded border text-xs">Cancel</button>
        </div>
      )}
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 border-b">
          <tr>
            <th className="px-3 py-1.5 text-left">#</th>
            <th className="px-3 py-1.5 text-right">Payment</th>
            <th className="px-3 py-1.5 text-right">Interest</th>
            <th className="px-3 py-1.5 text-right">Principal</th>
            <th className="px-3 py-1.5 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r, idx) => r.__kind === "spacer" ? (
            <tr key={`spacer-${idx}`} className="border-b border-dashed">
              <td colSpan={5} className="text-center py-1.5 text-slate-400 italic">
                … {r.skipped} more payments hidden …
              </td>
            </tr>
          ) : (
            <tr key={r.num} className={`border-b border-slate-100 ${r.num <= paidCount ? "bg-emerald-50/40" : ""}`}>
              <td className="px-3 py-1.5 font-mono-num text-slate-500">
                {r.num}
                {r.num <= paidCount && <span className="ml-1 text-[9px] text-emerald-700 uppercase font-semibold">paid</span>}
              </td>
              <td className="px-3 py-1.5 text-right font-mono-num">{fmtMoney(r.payment)}</td>
              <td className="px-3 py-1.5 text-right font-mono-num text-rose-700">{fmtMoney(r.interest)}</td>
              <td className="px-3 py-1.5 text-right font-mono-num text-emerald-700">{fmtMoney(r.principal)}</td>
              <td className="px-3 py-1.5 text-right font-mono-num font-semibold text-slate-900">{fmtMoney(r.balance)}</td>
            </tr>
          ))}
          <tr className="bg-slate-50 border-t-2">
            <td className="px-3 py-1.5 font-semibold text-slate-700">Total</td>
            <td className="px-3 py-1.5 text-right font-mono-num font-semibold">{fmtMoney(totalPayments)}</td>
            <td className="px-3 py-1.5 text-right font-mono-num font-semibold text-rose-700">{fmtMoney(totalInterest)}</td>
            <td className="px-3 py-1.5 text-right font-mono-num font-semibold text-emerald-700">{fmtMoney(Number(loan.principal || 0))}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function QuickLoanModal({ currentId, onClose }) {
  const [lender, setLender] = useState("");
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("");
  const [termMonths, setTermMonths] = useState("");
  const save = async () => {
    if (!lender.trim() || !principal) { toast.error("Lender and principal are required."); return; }
    try {
      await api.post(`/companies/${currentId}/loans`, {
        lender: lender.trim(),
        principal: Number(principal),
        rate: rate ? Number(rate) : null,
        term_months: termMonths ? Number(termMonths) : null,
      });
      toast.success("Loan added"); onClose(true);
    } catch (e) { toast.error(e.response?.data?.detail || "Could not add loan"); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <h3 className="font-heading font-semibold">Add Loan</h3>
        <input placeholder="Lender (e.g. Wells Fargo)" value={lender} onChange={(e) => setLender(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm" data-testid="loan-modal-lender" />
        <div className="grid grid-cols-2 gap-2">
          <input type="number" placeholder="Principal" value={principal} onChange={(e) => setPrincipal(e.target.value)}
                 className="w-full border rounded px-3 py-2 text-sm font-mono-num" data-testid="loan-modal-principal" />
          <input type="number" step="0.001" placeholder="Rate %" value={rate} onChange={(e) => setRate(e.target.value)}
                 className="w-full border rounded px-3 py-2 text-sm font-mono-num" data-testid="loan-modal-rate" />
        </div>
        <input type="number" placeholder="Term (months)" value={termMonths} onChange={(e) => setTermMonths(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm font-mono-num" data-testid="loan-modal-term" />
        <div className="flex gap-2">
          <button onClick={save} className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm" data-testid="loan-modal-save">Save</button>
          <button onClick={() => onClose(false)} className="flex-1 py-2 rounded-md border text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
