import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Link2 } from "lucide-react";
import { toast } from "sonner";

export default function Payments() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [bills, setBills] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [creating, setCreating] = useState(false);
  const load = async () => {
    if (!currentId) return;
    const [p, i, b, c, t] = await Promise.all([
      api.get(`/companies/${currentId}/payments`),
      api.get(`/companies/${currentId}/invoices`),
      api.get(`/companies/${currentId}/bills`),
      api.get(`/companies/${currentId}/contacts`),
      api.get(`/companies/${currentId}/transactions?limit=500`),
    ]);
    setItems(p.data.payments || []); setInvoices(i.data.invoices || []);
    setBills(b.data.bills || []); setContacts(c.data.contacts || []);
    setTransactions(t.data.transactions || []);
  };
  useEffect(() => { load(); }, [currentId]);
  const del = async (id) => { if (confirm("Delete?")) { await api.delete(`/companies/${currentId}/payments/${id}`); load(); } };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Payments</h1>
          <p className="text-slate-500 text-sm mt-1">Received &amp; sent · linked to invoices or bills.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> Record Payment
        </button>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Contact</th>
              <th className="px-3 py-2 text-left">Method</th><th className="px-3 py-2 text-left">Linked</th>
              <th className="px-3 py-2 text-right">Amount</th><th></th></tr>
          </thead>
          <tbody>
            {items.map(p => {
              const linkedDoc = p.linked_invoice_id
                ? (invoices.find(i => i.id === p.linked_invoice_id))
                : (p.linked_bill_id ? bills.find(b => b.id === p.linked_bill_id) : null);
              const linkedLabel = p.linked_invoice_id
                ? (linkedDoc ? `Invoice ${linkedDoc.number}` : "Invoice")
                : (p.linked_bill_id ? (linkedDoc ? `Bill ${linkedDoc.number}` : "Bill") : "—");
              const linkedHref = p.linked_invoice_id ? "/invoices" : (p.linked_bill_id ? "/bills" : null);
              return (
              <tr key={p.id} className="border-b hover:bg-slate-50" data-testid={`payment-row-${p.id}`}>
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(p.date)}</td>
                <td className="px-3 py-2">{p.contact_name}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{p.method}</td>
                <td className="px-3 py-2 text-xs">
                  {linkedHref ? (
                    <Link to={linkedHref} className="text-indigo-600 hover:underline" data-testid={`payment-linked-${p.id}`}>{linkedLabel}</Link>
                  ) : linkedLabel}
                </td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(p.amount)}</td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    {p.source_transaction_id && (
                      <Link
                        to={`/accounting/transactions?open=${p.source_transaction_id}`}
                        data-testid={`payment-source-txn-${p.id}`}
                        title="View originating transaction"
                        className="p-1 rounded hover:bg-indigo-100 text-indigo-600"
                      ><Link2 size={13} /></Link>
                    )}
                    <button onClick={() => del(p.id)} className="text-red-500 p-1"><Trash2 size={13} /></button>
                  </div>
                </td>
              </tr>
            );})}
            {!items.length && <tr><td colSpan={6} className="text-center py-8 text-slate-500">No payments.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <PaymentModal currentId={currentId} contacts={contacts} invoices={invoices} bills={bills} transactions={transactions} onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function PaymentModal({ currentId, contacts, invoices, bills, transactions = [], onClose }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("invoice");
  const [linkedId, setLinkedId] = useState("");
  const [contact, setContact] = useState("");
  const [method, setMethod] = useState("check");
  const [sourceTxnId, setSourceTxnId] = useState("");
  const [txnQuery, setTxnQuery] = useState("");

  // Only surface unpaid/unlinked-ish transactions. Kind flips sign:
  //   invoice-payment (money IN)  → positive amounts
  //   bill-payment    (money OUT) → negative amounts
  const filteredTxns = (transactions || [])
    .filter(t => !t.linked_payment_id)
    .filter(t => kind === "invoice" ? Number(t.amount) > 0 : Number(t.amount) < 0)
    .filter(t => {
      if (!txnQuery.trim()) return true;
      const q = txnQuery.toLowerCase();
      return (t.merchant || "").toLowerCase().includes(q)
          || (t.description || "").toLowerCase().includes(q)
          || (t.date || "").includes(q);
    })
    .slice(0, 100); // datalist perf cap

  // Applying a txn auto-fills amount + date and stamps source_transaction_id.
  const applyTxn = (tid) => {
    setSourceTxnId(tid);
    if (!tid) return;
    const t = transactions.find(x => x.id === tid);
    if (!t) return;
    setAmount(String(Math.abs(Number(t.amount || 0))));
    setDate(t.date || date);
    // Match a contact by exact name if we have one — friendlier for the user.
    const c = contacts.find(x =>
      (x.name || "").toLowerCase() === (t.merchant || "").toLowerCase());
    if (c) setContact(c.id);
  };

  const save = async () => {
    const c = contacts.find(x => x.id === contact);
    await api.post(`/companies/${currentId}/payments`, {
      date, amount: parseFloat(amount),
      contact_id: contact || null, contact_name: c?.name || "",
      method,
      linked_invoice_id: kind === "invoice" ? linkedId || null : null,
      linked_bill_id: kind === "bill" ? linkedId || null : null,
      source_transaction_id: sourceTxnId || null,
    });
    toast.success("Payment recorded"); onClose();
  };
  const list = kind === "invoice" ? invoices : bills;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3" data-testid="payment-modal">
        <div className="flex items-center justify-between"><h3 className="font-heading font-semibold">Record Payment</h3><button onClick={onClose}><X size={16} /></button></div>
        <div className="flex gap-2">
          <button onClick={() => { setKind("invoice"); setSourceTxnId(""); }}
                  className={`flex-1 py-1.5 rounded ${kind === "invoice" ? "bg-slate-900 text-white" : "border"}`}>For Invoice</button>
          <button onClick={() => { setKind("bill"); setSourceTxnId(""); }}
                  className={`flex-1 py-1.5 rounded ${kind === "bill" ? "bg-slate-900 text-white" : "border"}`}>For Bill</button>
        </div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
               className="w-full border rounded px-2 py-1.5 text-sm" data-testid="payment-modal-date" />

        {/* Transaction picker — search + native <datalist> combo. */}
        <div className="space-y-1">
          <input
            list="payment-txn-options"
            value={txnQuery}
            onChange={(e) => {
              const v = e.target.value;
              setTxnQuery(v);
              // Datalist option "value" strings look like "<id>::<label>".
              // Detect an actual pick vs freeform typing.
              const picked = filteredTxns.find(t => `${t.id}::${_txnLabel(t)}` === v);
              if (picked) applyTxn(picked.id);
              else if (!v) setSourceTxnId("");
            }}
            placeholder={sourceTxnId ? "Transaction linked ✓ (type to change)" : "Search bank transaction (optional)…"}
            className={`w-full border rounded px-2 py-1.5 text-sm ${sourceTxnId ? "border-emerald-400 bg-emerald-50" : ""}`}
            data-testid="payment-modal-txn-search"
          />
          <datalist id="payment-txn-options">
            {filteredTxns.map(t => (
              <option key={t.id} value={`${t.id}::${_txnLabel(t)}`}>{_txnLabel(t)}</option>
            ))}
          </datalist>
          {sourceTxnId && (
            <button
              type="button"
              onClick={() => { setSourceTxnId(""); setTxnQuery(""); }}
              className="text-[11px] text-slate-500 hover:underline"
              data-testid="payment-modal-txn-clear"
            >Clear linked transaction</button>
          )}
        </div>

        <input type="number" step="0.01" placeholder="Amount" value={amount}
               onChange={(e) => setAmount(e.target.value)}
               className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
               data-testid="payment-modal-amount" />
        <select value={contact} onChange={(e) => setContact(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Contact…</option>
          {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={linkedId} onChange={(e) => setLinkedId(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Link to {kind}…</option>
          {list.map(x => <option key={x.id} value={x.id}>{x.number} · {fmtMoney(x.balance_due || x.total)}</option>)}
        </select>
        <input placeholder="Method" value={method} onChange={(e) => setMethod(e.target.value)}
               className="w-full border rounded px-2 py-1.5 text-sm" />
        <button data-testid={TID.saveBtn} onClick={save}
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
      </div>
    </div>
  );
}

function _txnLabel(t) {
  const amt = Math.abs(Number(t.amount || 0)).toFixed(2);
  const who = t.merchant || t.description || "—";
  return `${t.date || ""} · ${who} · $${amt}`;
}
