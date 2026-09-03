import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Percent, Building2, Tag, Receipt, PlusCircle, X, Save } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import TaxLibrary from "@/pages/TaxLibrary";

// Sales Tax Center — unifies Rates, Agencies, Codes, and Payments in a
// single destination. Rates CRUD (New / Edit / Delete / Import CSV)
// now lives INLINE inside the Rates tab (Feb 2026) — the former
// stand-alone Tax Library page redirects here. Payments tab now
// reads the ledger-backed `/tax-payments` endpoint and offers a
// "Record Sales Tax Payment" flow that DR's the payable / CR's the bank.
export default function SalesTax() {
  const { currentId } = useCompany();
  const [tab, setTab] = useState("rates");
  const [rates, setRates] = useState([]);
  const [payments, setPayments] = useState([]);
  const [liability, setLiability] = useState({ accounts: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [recordingPayment, setRecordingPayment] = useState(false);

  const refresh = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const [r, p, l] = await Promise.all([
        api.get(`/companies/${currentId}/taxes`).catch(() => ({ data: { taxes: [] } })),
        api.get(`/companies/${currentId}/tax-payments`).catch(() => ({ data: { payments: [] } })),
        api.get(`/companies/${currentId}/tax-liability`).catch(() => ({ data: { accounts: [], total: 0 } })),
      ]);
      setRates(r.data.taxes || []);
      setPayments(p.data.payments || []);
      setLiability(l.data || { accounts: [], total: 0 });
    } finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [currentId]);

  // Roll agencies up from tax_rates (each rate carries `agency_name`).
  const agencies = useMemo(() => {
    const map = new Map();
    rates.forEach((r) => {
      const name = r.agency_name || "—";
      const cur = map.get(name) || { name, rate_count: 0, total_rate: 0 };
      cur.rate_count += 1;
      cur.total_rate += Number(r.rate || 0);
      map.set(name, cur);
    });
    return Array.from(map.values());
  }, [rates]);

  return (
    <div className="space-y-4" data-testid="sales-tax-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            Sales Tax Center
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Rates, agencies, codes, and payments — sales tax and other tax rates in one place.
          </p>
        </div>
        {liability.total > 0 && (
          <button
            onClick={() => setRecordingPayment(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm shadow-sm"
            data-testid="sales-tax-record-payment"
          >
            <PlusCircle size={14} /> Record Sales Tax Payment
          </button>
        )}
      </div>

      {/* Liability strip — always visible when there's an open balance,
          gives pros an at-a-glance view of what they owe each agency. */}
      {liability.accounts.length > 0 && liability.total > 0.005 && (
        <div className="rounded-xl border bg-emerald-50/40 p-3 flex items-center justify-between"
              data-testid="sales-tax-liability-strip">
          <div className="text-sm">
            <span className="font-medium text-slate-700">Sales Tax Payable </span>
            <span className="text-slate-500">
              — {liability.accounts.filter(a => Math.abs(a.balance) > 0.005).length} agency account{liability.accounts.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="text-lg font-heading font-semibold text-emerald-700 tabular-nums">
            {fmtMoney(liability.total)}
          </div>
        </div>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Percent} label="Tax Rates" value={rates.length} tint="amber" />
        <StatCard icon={Building2} label="Agencies" value={agencies.length} tint="indigo" />
        <StatCard icon={Tag} label="Tax Codes"
                   value={"—"} tint="slate"
                   hint="Populated via QBO import" />
        <StatCard icon={Receipt} label="Sales Tax Payments" value={payments.length} tint="emerald" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {[
          ["rates",    "Rates",     Percent],
          ["agencies", "Agencies",  Building2],
          ["codes",    "Codes",     Tag],
          ["payments", "Payments",  Receipt],
        ].map(([k, l, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
                   className={`inline-flex items-center gap-1.5 px-3 py-2
                              text-sm border-b-2 -mb-px ${
                     tab === k
                       ? "border-indigo-600 text-indigo-600 font-medium"
                       : "border-transparent text-slate-500 hover:text-slate-700"
                   }`}
                   data-testid={`sales-tax-tab-${k}`}>
            <Icon className="w-4 h-4" /> {l}
          </button>
        ))}
      </div>

      {/* Panels */}
      {tab === "rates" && (
        <TaxLibrary embedded />
      )}
      {tab === "agencies" && (
        <SimpleTable
          cols={["Agency", "Rate Count", "Combined Rate"]}
          rows={agencies.map(a => [
            a.name, a.rate_count, `${a.total_rate.toFixed(3)}%`,
          ])}
          empty="No agencies. Agencies are inferred from imported rates."
          loading={loading}
        />
      )}
      {tab === "codes" && (
        <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
          Tax Codes are populated on QBO migration. When available they
          appear here as combinations of rates by jurisdiction.
        </div>
      )}
      {tab === "payments" && (
        <SimpleTable
          cols={["Date", "Payable", "Bank", "Ref #", "Amount"]}
          rows={payments.map(p => [
            p.date,
            p.payable_account_name || "—",
            p.bank_account_name || "—",
            p.ref_number || "—",
            fmtMoney(p.amount || 0),
          ])}
          empty="No sales tax payments yet. Click Record Sales Tax Payment above once you owe an agency to draw down the liability."
          loading={loading}
          rightAlignLast
        />
      )}

      {recordingPayment && (
        <RecordPaymentDialog
          currentId={currentId}
          liability={liability}
          onClose={() => setRecordingPayment(false)}
          onSaved={() => { setRecordingPayment(false); refresh(); }}
        />
      )}
    </div>
  );
}


function fmtMoney(v) {
  return `$${Number(v || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}


function StatCard({ icon: Icon, label, value, tint, hint }) {
  const tints = {
    amber: "bg-amber-100 text-amber-600",
    indigo: "bg-indigo-100 text-indigo-600",
    emerald: "bg-emerald-100 text-emerald-600",
    slate: "bg-slate-100 text-slate-500",
  };
  return (
    <div className="rounded-xl border bg-white p-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tints[tint]}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-lg font-semibold">{value}</div>
        {hint && <div className="text-[10px] text-slate-400 leading-tight">{hint}</div>}
      </div>
    </div>
  );
}


function SimpleTable({ cols, rows, empty, loading, rightAlignLast }) {
  return (
    <div className="rounded-xl border bg-white overflow-hidden">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            {cols.map((c, i) => (
              <th key={i}
                   className={`px-4 py-2.5 font-medium uppercase text-[11px] tracking-wide ${
                     rightAlignLast && i === cols.length - 1 ? "text-right" : "text-left"
                   }`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={cols.length} className="px-4 py-6 text-center text-slate-400">Loading…</td></tr>
          )}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={cols.length} className="px-4 py-10 text-center text-slate-500 text-sm">{empty}</td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="border-t hover:bg-slate-50">
              {r.map((v, j) => (
                <td key={j}
                     className={`px-4 py-2 ${
                       rightAlignLast && j === r.length - 1
                         ? "text-right font-mono tabular-nums" : ""
                     }`}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


/**
 * RecordPaymentDialog — DR Sales Tax Payable / CR Bank.
 *
 * Pre-selects the largest-balance payable account so the pro can hit
 * Save in two clicks when they're paying the primary agency they owe.
 */
function RecordPaymentDialog({ currentId, liability, onClose, onSaved }) {
  const openBalances = (liability.accounts || [])
    .filter(a => Math.abs(a.balance) > 0.005);
  const [payableId, setPayableId] = useState(openBalances[0]?.id || "");
  const [bankAccts, setBankAccts] = useState([]);
  const [bankId, setBankId] = useState("");
  const [amount, setAmount] = useState(
    (openBalances[0]?.balance || 0).toFixed(2),
  );
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [ref, setRef] = useState("");
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/accounts`).then(r => {
      const banks = (r.data.accounts || []).filter(
        a => a.type === "asset" &&
             /bank|check|cash|money/.test((a.name || "").toLowerCase())
      );
      // Fallback to all asset accounts if regex missed.
      const list = banks.length ? banks
        : (r.data.accounts || []).filter(a => a.type === "asset");
      setBankAccts(list);
      if (list.length && !bankId) setBankId(list[0].id);
    }).catch(() => {});
    // eslint-disable-next-line
  }, [currentId]);

  // Keep amount in sync when the user picks a different payable.
  useEffect(() => {
    const hit = openBalances.find(a => a.id === payableId);
    if (hit) setAmount(hit.balance.toFixed(2));
    // eslint-disable-next-line
  }, [payableId]);

  const submit = async () => {
    const amt = parseFloat(amount);
    if (!payableId) { toast.error("Choose a payable account"); return; }
    if (!bankId) { toast.error("Choose a bank/cash account"); return; }
    if (isNaN(amt) || amt <= 0) { toast.error("Amount must be positive"); return; }
    setSaving(true);
    try {
      await api.post(`/companies/${currentId}/tax-payments`, {
        payable_account_id: payableId,
        bank_account_id: bankId,
        amount: amt, date, ref_number: ref, memo,
      });
      toast.success("Sales tax payment recorded");
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to record payment");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-4"
            data-testid="record-tax-payment-dialog">
        <div className="flex items-center justify-between border-b pb-3">
          <h3 className="font-heading font-semibold text-lg">Record Sales Tax Payment</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Pay this liability <span className="text-red-500">*</span></label>
            <select value={payableId} onChange={e => setPayableId(e.target.value)}
                     className="w-full border rounded px-3 py-2 text-sm bg-white"
                     data-testid="record-tax-payment-payable">
              {openBalances.length === 0 && <option value="">No open sales tax liabilities</option>}
              {openBalances.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name} — {fmtMoney(a.balance)}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Paid from <span className="text-red-500">*</span></label>
            <select value={bankId} onChange={e => setBankId(e.target.value)}
                     className="w-full border rounded px-3 py-2 text-sm bg-white"
                     data-testid="record-tax-payment-bank">
              {bankAccts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Amount <span className="text-red-500">*</span></label>
            <input type="number" step="0.01" min="0" value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                    data-testid="record-tax-payment-amount" />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                    data-testid="record-tax-payment-date" />
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Ref # / Check #</label>
            <input value={ref} onChange={e => setRef(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                    placeholder="e.g. #4021 or CA-BOE-2026Q1"
                    data-testid="record-tax-payment-ref" />
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Memo</label>
            <input value={memo} onChange={e => setMemo(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                    placeholder="Free text — appears on the JE"
                    data-testid="record-tax-payment-memo" />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button onClick={submit} disabled={saving || openBalances.length === 0}
                   className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
                   data-testid="record-tax-payment-submit">
            <Save size={13} /> {saving ? "Saving…" : "Record payment"}
          </button>
        </div>
      </div>
    </div>
  );
}
