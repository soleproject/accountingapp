import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Percent, Building2, Tag, Receipt, PlusCircle, X, Save, Pencil, Trash2, Plus, Split } from "lucide-react";
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
  const [editingPayment, setEditingPayment] = useState(null);
  const [deletingPayment, setDeletingPayment] = useState(null);

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

  const postDraft = async (p) => {
    try {
      const r = await api.post(`/companies/${currentId}/tax-payments/${p.id}/post`);
      toast.success(`Draft posted — JE created for ${new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(r.data.amount || 0)}`);
      refresh();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to post draft");
    }
  };

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
          cols={["Date", "Payable", "Bank", "Ref #", "Amount", ""]}
          rows={payments.map(p => [
            <span key={`d-${p.id}`}>
              {p.date}
              {p.status === "draft" && (
                <span className="ml-2 text-[10px] uppercase tracking-wider font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5">
                  Draft
                </span>
              )}
            </span>,
            (p.allocations && p.allocations.length > 1)
              ? `${p.allocations.length} agencies · ${(p.allocations || []).map(a => a.payable_account_name).filter(Boolean).slice(0, 2).join(", ")}${p.allocations.length > 2 ? "…" : ""}`
              : (p.payable_account_name || "—"),
            p.bank_account_name || "—",
            p.ref_number || "—",
            fmtMoney(p.amount || 0),
            <div className="flex items-center justify-end gap-1" key={`actions-${p.id}`}>
              {p.status === "draft" && (
                <button
                  onClick={() => postDraft(p)}
                  className="px-2 py-1 text-[11px] rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                  title="Post the draft — creates the JE and marks it posted"
                  data-testid={`tax-payment-post-${p.id}`}
                >Post now</button>
              )}
              <button
                onClick={() => setEditingPayment(p)}
                className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-indigo-700"
                title="Edit payment"
                data-testid={`tax-payment-edit-${p.id}`}
              ><Pencil size={13} /></button>
              <button
                onClick={() => setDeletingPayment(p)}
                className="p-1.5 rounded hover:bg-red-50 text-slate-500 hover:text-red-700"
                title="Delete payment"
                data-testid={`tax-payment-delete-${p.id}`}
              ><Trash2 size={13} /></button>
            </div>,
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
      {editingPayment && (
        <RecordPaymentDialog
          currentId={currentId}
          liability={liability}
          existing={editingPayment}
          onClose={() => setEditingPayment(null)}
          onSaved={() => { setEditingPayment(null); refresh(); }}
        />
      )}
      {deletingPayment && (
        <ConfirmDeletePayment
          currentId={currentId}
          payment={deletingPayment}
          onClose={() => setDeletingPayment(null)}
          onDeleted={() => { setDeletingPayment(null); refresh(); }}
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
export function RecordPaymentDialog({ currentId, liability, existing, onClose, onSaved }) {
  const isEdit = !!existing;
  const openBalances = (liability.accounts || [])
    .filter(a => Math.abs(a.balance) > 0.005);
  // When editing, ensure the payment's own payable is in the list even
  // if its remaining balance is now $0 (i.e. this WAS the payment that
  // zeroed it out).
  const editableBalances = useMemo(() => {
    if (!isEdit) return openBalances;
    if (openBalances.find(a => a.id === existing.payable_account_id)) return openBalances;
    return [
      { id: existing.payable_account_id, name: existing.payable_account_name || "(payable)", balance: existing.amount },
      ...openBalances,
    ];
    // eslint-disable-next-line
  }, [isEdit, liability]);

  const [payableId, setPayableId] = useState(existing?.payable_account_id || editableBalances[0]?.id || "");
  const [bankAccts, setBankAccts] = useState([]);
  const [bankId, setBankId] = useState(existing?.bank_account_id || "");
  const [amount, setAmount] = useState(
    existing ? Number(existing.amount || 0).toFixed(2)
             : (editableBalances[0]?.balance || 0).toFixed(2),
  );
  const [date, setDate] = useState(existing?.date || new Date().toISOString().slice(0, 10));
  const [ref, setRef] = useState(existing?.ref_number || "");
  const [memo, setMemo] = useState(existing?.memo || "");
  const [saving, setSaving] = useState(false);

  // Split-across-agencies mode. Auto-enable when the incoming payment
  // has more than one allocation, OR the user toggles it manually
  // during creation. Each row is `{payable_account_id, amount}`.
  const [split, setSplit] = useState(!!(existing?.allocations && existing.allocations.length > 1));
  const [allocs, setAllocs] = useState(() => {
    if (existing?.allocations && existing.allocations.length > 0) {
      return existing.allocations.map(a => ({
        payable_account_id: a.payable_account_id,
        amount: Number(a.amount || 0).toFixed(2),
      }));
    }
    return editableBalances.slice(0, 2).map(a => ({
      payable_account_id: a.id,
      amount: a.balance.toFixed(2),
    }));
  });
  const allocTotal = useMemo(
    () => allocs.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0),
    [allocs]
  );

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/accounts`).then(r => {
      const banks = (r.data.accounts || []).filter(
        a => a.type === "asset" &&
             /bank|check|cash|money/.test((a.name || "").toLowerCase())
      );
      const list = banks.length ? banks
        : (r.data.accounts || []).filter(a => a.type === "asset");
      setBankAccts(list);
      if (list.length && !bankId) setBankId(list[0].id);
    }).catch(() => {});
    // eslint-disable-next-line
  }, [currentId]);

  // Keep amount in sync when the user picks a different payable
  // (only on Create — editing preserves the historical amount).
  useEffect(() => {
    if (isEdit) return;
    const hit = editableBalances.find(a => a.id === payableId);
    if (hit) setAmount(hit.balance.toFixed(2));
    // eslint-disable-next-line
  }, [payableId]);

  const submit = async (asDraft = false) => {
    if (!bankId) { toast.error("Choose a bank/cash account"); return; }
    let payload;
    if (split) {
      // For drafts, permit rows with an agency but $0 amount so the pro
      // can lock the jurisdiction in first and fill dollars later.
      const clean = allocs
        .map(a => ({
          payable_account_id: a.payable_account_id,
          amount: parseFloat(a.amount),
        }))
        .filter(a => a.payable_account_id && (asDraft || (!isNaN(a.amount) && a.amount > 0)));
      if (clean.length < 1) {
        toast.error(asDraft ? "Pick at least one agency" : "Add at least one allocation with a positive amount");
        return;
      }
      const dupes = new Set();
      for (const a of clean) {
        if (dupes.has(a.payable_account_id)) {
          toast.error("Same agency listed twice — combine those rows");
          return;
        }
        dupes.add(a.payable_account_id);
      }
      payload = {
        bank_account_id: bankId, date, ref_number: ref, memo,
        allocations: clean,
      };
    } else {
      const amt = parseFloat(amount);
      if (!payableId) { toast.error("Choose a payable account"); return; }
      if (!asDraft && (isNaN(amt) || amt <= 0)) { toast.error("Amount must be positive"); return; }
      payload = {
        payable_account_id: payableId,
        bank_account_id: bankId,
        amount: asDraft ? (isNaN(amt) ? 0 : amt) : amt,
        date, ref_number: ref, memo,
      };
    }
    if (asDraft) payload.draft = true;
    setSaving(true);
    try {
      // Edit = reverse the old JE (via DELETE) then post a fresh one.
      if (isEdit) {
        await api.delete(`/companies/${currentId}/tax-payments/${existing.id}`);
      }
      await api.post(`/companies/${currentId}/tax-payments`, payload);
      toast.success(
        asDraft ? "Draft saved — post it when you're ready"
                : (isEdit ? "Sales tax payment updated" : "Sales tax payment recorded")
      );
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.detail || `Failed to ${asDraft ? "save draft" : (isEdit ? "update" : "record")} payment`);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className={`bg-white rounded-xl shadow-2xl w-full ${split ? "max-w-2xl" : "max-w-lg"} p-5 space-y-4`}
            data-testid="record-tax-payment-dialog">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h3 className="font-heading font-semibold text-lg">
              {isEdit ? "Edit Sales Tax Payment" : "Record Sales Tax Payment"}
            </h3>
            {editableBalances.length > 1 && (
              <button
                type="button"
                onClick={() => setSplit(v => !v)}
                className="mt-1 text-[11px] text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-1"
                data-testid="record-tax-payment-split-toggle"
              >
                <Split size={11} /> {split ? "Pay a single agency instead" : "Split across multiple agencies"}
              </button>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>

        {split ? (
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Paid from <span className="text-red-500">*</span></label>
              <select value={bankId} onChange={e => setBankId(e.target.value)}
                       className="w-full border rounded px-3 py-2 text-sm bg-white"
                       data-testid="record-tax-payment-bank">
                {bankAccts.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm" data-testid="record-tax-payment-alloc-table">
                <thead className="bg-slate-50 text-[11px] uppercase text-slate-500 border-b">
                  <tr>
                    <th className="px-3 py-2 text-left">Agency payable</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {allocs.map((a, i) => (
                    <tr key={i} className="border-b hover:bg-slate-50/60">
                      <td className="px-3 py-2">
                        <select
                          value={a.payable_account_id}
                          onChange={(e) => {
                            const v = e.target.value;
                            setAllocs(prev => prev.map((x, ix) => {
                              if (ix !== i) return x;
                              const bal = editableBalances.find(b => b.id === v);
                              return { payable_account_id: v, amount: bal ? bal.balance.toFixed(2) : x.amount };
                            }));
                          }}
                          className="w-full border rounded px-2 py-1 text-sm bg-white"
                          data-testid={`record-tax-payment-alloc-payable-${i}`}
                        >
                          <option value="">— Pick an agency —</option>
                          {editableBalances.map(b => (
                            <option key={b.id} value={b.id}>
                              {b.name} — {fmtMoney(b.balance)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number" step="0.01" min="0" value={a.amount}
                          onChange={(e) => setAllocs(prev => prev.map((x, ix) => ix === i ? { ...x, amount: e.target.value } : x))}
                          className="w-28 border rounded px-2 py-1 text-sm text-right font-mono-num"
                          data-testid={`record-tax-payment-alloc-amount-${i}`}
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        {allocs.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setAllocs(prev => prev.filter((_, ix) => ix !== i))}
                            className="p-1 text-slate-400 hover:text-red-600"
                            title="Remove"
                            data-testid={`record-tax-payment-alloc-remove-${i}`}
                          ><Trash2 size={13} /></button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t font-semibold">
                    <td className="px-3 py-2 text-xs uppercase text-slate-500">Total check amount</td>
                    <td className="px-3 py-2 text-right font-mono-num" data-testid="record-tax-payment-alloc-total">
                      {fmtMoney(allocTotal)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
              <div className="px-3 py-2 bg-slate-50/40 border-t flex items-center justify-between gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => {
                    // Suggest an unused agency, else fall back to a blank row.
                    const used = new Set(allocs.map(a => a.payable_account_id));
                    const next = editableBalances.find(b => !used.has(b.id));
                    setAllocs(prev => [...prev, next
                      ? { payable_account_id: next.id, amount: next.balance.toFixed(2) }
                      : { payable_account_id: "", amount: "" }]);
                  }}
                  className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-1"
                  data-testid="record-tax-payment-alloc-add"
                >
                  <Plus size={12} /> Add another agency
                </button>
                {editableBalances.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      // Pay off every open agency in full — one row per
                      // agency with open balance, amount = remaining
                      // liability. Zeroes out A/P sales tax in one shot.
                      setAllocs(editableBalances.map(b => ({
                        payable_account_id: b.id,
                        amount: b.balance.toFixed(2),
                      })));
                    }}
                    className="text-xs text-emerald-700 hover:text-emerald-900 hover:underline inline-flex items-center gap-1 font-medium"
                    data-testid="record-tax-payment-alloc-payoff-all"
                    title="Fill every allocation with its full remaining balance"
                  >
                    <Save size={12} /> Pay off all · {fmtMoney(editableBalances.reduce((s, b) => s + b.balance, 0))}
                  </button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Date</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
                        className="w-full border rounded px-3 py-2 text-sm"
                        data-testid="record-tax-payment-date" />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Ref # / Check #</label>
                <input value={ref} onChange={e => setRef(e.target.value)}
                        className="w-full border rounded px-3 py-2 text-sm"
                        placeholder="e.g. #4021"
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
          </div>
        ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Pay this liability <span className="text-red-500">*</span></label>
            <select value={payableId} onChange={e => setPayableId(e.target.value)}
                     className="w-full border rounded px-3 py-2 text-sm bg-white"
                     data-testid="record-tax-payment-payable">
              {editableBalances.length === 0 && <option value="">No open sales tax liabilities</option>}
              {editableBalances.map(a => (
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
        )}
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button
            onClick={() => submit(true)}
            disabled={saving || editableBalances.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-700 text-sm hover:bg-slate-50 disabled:opacity-50"
            data-testid="record-tax-payment-save-draft"
            title="Save without posting a JE — come back later to finish and post"
          >
            <Save size={13} /> Save as draft
          </button>
          <button onClick={() => submit(false)} disabled={saving || editableBalances.length === 0}
                   className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
                   data-testid="record-tax-payment-submit">
            <Save size={13} /> {saving ? "Saving…" : split ? `Record ${fmtMoney(allocTotal)}` : (isEdit ? "Save changes" : "Record payment")}
          </button>
        </div>
      </div>
    </div>
  );
}


function ConfirmDeletePayment({ currentId, payment, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const del = async () => {
    setBusy(true);
    try {
      await api.delete(`/companies/${currentId}/tax-payments/${payment.id}`);
      toast.success("Sales tax payment deleted");
      onDeleted();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to delete payment");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4"
           data-testid="confirm-delete-tax-payment">
        <div className="flex items-center justify-between border-b pb-3">
          <h3 className="font-heading font-semibold text-lg">Delete this payment?</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="text-sm text-slate-700 space-y-1">
          <p>This will reverse the journal entry and restore the sales tax liability.</p>
          <div className="mt-3 rounded-md border bg-slate-50 p-3 text-xs">
            <div><b>{payment.payable_account_name || "—"}</b> · {fmtMoney(payment.amount || 0)}</div>
            <div className="text-slate-500 mt-0.5">Date: {payment.date} · Paid from {payment.bank_account_name || "—"}</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button onClick={del} disabled={busy}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm disabled:opacity-50"
                  data-testid="confirm-delete-tax-payment-submit">
            <Trash2 size={13} /> {busy ? "Deleting…" : "Delete payment"}
          </button>
        </div>
      </div>
    </div>
  );
}
