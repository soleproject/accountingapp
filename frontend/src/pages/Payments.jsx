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

  const applyTxn = (t) => {
    if (!t) { setSourceTxnId(""); return; }
    setSourceTxnId(t.id);
    setDate(t.date || date);
    setAmount(String(Math.abs(Number(t.amount || 0))));
    // Contact from txn if present, else exact-name match on merchant.
    if (t.contact_id) {
      setContact(t.contact_id);
    } else if (t.merchant) {
      const c = contacts.find(x => (x.name || "").toLowerCase() === (t.merchant || "").toLowerCase());
      if (c) setContact(c.id);
    }
    // Infer method from txn keywords — bank imports usually stamp
    // description strings like "ACH Debit", "Wire IN", "Check 4021".
    const blob = `${t.description || ""} ${t.merchant || ""} ${t.memo || ""}`.toLowerCase();
    const inferred =
      /\bach\b|\bautopay|automated clearing/.test(blob) ? "ach"
      : /\bwire\b/.test(blob) ? "wire"
      : /\bcheck\b|\bchk\b/.test(blob) ? "check"
      : /\bcard\b|visa|mastercard|amex|discover|\bpos\b/.test(blob) ? "credit_card"
      : /\bcash\b/.test(blob) ? "cash"
      : null;
    if (inferred) setMethod(inferred);
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

        {/* Transaction picker — sits ABOVE the date so a match cascades
            downstream field auto-fills. Custom dropdown, not native
            <datalist>, so the option label is what the user sees. */}
        <TransactionPicker
          transactions={transactions}
          kind={kind}
          contacts={contacts}
          selectedId={sourceTxnId}
          onPick={applyTxn}
        />

        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
               className="w-full border rounded px-2 py-1.5 text-sm"
               data-testid="payment-modal-date" />
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
        <select value={method} onChange={(e) => setMethod(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm bg-white">
          <option value="check">Check</option>
          <option value="ach">ACH Transfer</option>
          <option value="credit_card">Credit card</option>
          <option value="wire">Wire transfer</option>
          <option value="cash">Cash</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="other">Other</option>
        </select>
        <button data-testid={TID.saveBtn} onClick={save}
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
      </div>
    </div>
  );
}

/**
 * TransactionPicker — searchable dropdown scoped to bank transactions
 * matching the pane sign (money-in for invoices, money-out for bills).
 * Rows show only date · amount · contact (or merchant fallback).
 */
function TransactionPicker({ transactions, kind, contacts, selectedId, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const contactName = (t) => t.contact_name
    || (t.contact_id ? (contacts.find(c => c.id === t.contact_id)?.name || "") : "")
    || t.merchant
    || t.description
    || "—";
  const rows = (transactions || [])
    .filter(t => !t.linked_payment_id || t.id === selectedId)
    .filter(t => kind === "invoice" ? Number(t.amount) > 0 : Number(t.amount) < 0)
    .filter(t => {
      if (!q.trim()) return true;
      const s = q.toLowerCase();
      return (t.date || "").includes(s)
          || String(Math.abs(Number(t.amount || 0))).includes(s)
          || contactName(t).toLowerCase().includes(s);
    })
    .slice(0, 200);
  const picked = transactions.find(t => t.id === selectedId);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between border rounded px-2 py-1.5 text-sm text-left ${
          selectedId ? "border-emerald-400 bg-emerald-50" : "bg-white"
        }`}
        data-testid="payment-modal-txn-search"
      >
        <span className={selectedId ? "text-slate-800" : "text-slate-400"}>
          {picked
            ? `${picked.date} · $${Math.abs(Number(picked.amount || 0)).toFixed(2)} · ${contactName(picked)}`
            : "Search bank transaction (optional)…"}
        </span>
        <span className="text-slate-400 text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {selectedId && (
        <button
          type="button"
          onClick={() => { onPick(null); setQ(""); }}
          className="absolute right-8 top-1/2 -translate-y-1/2 text-[11px] text-slate-500 hover:underline"
          data-testid="payment-modal-txn-clear"
        >clear</button>
      )}
      {open && (
        <div className="absolute z-10 top-full left-0 right-0 mt-1 border rounded-md bg-white shadow-lg max-h-72 overflow-y-auto">
          <div className="p-1.5 border-b bg-slate-50 sticky top-0">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by date, amount, or contact…"
              className="w-full border rounded px-2 py-1 text-xs"
              data-testid="payment-modal-txn-filter"
            />
          </div>
          {rows.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-slate-400">No matching transactions.</div>
          ) : (
            <ul className="divide-y">
              {rows.map(t => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => { onPick(t); setOpen(false); setQ(""); }}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-sm text-left hover:bg-slate-50 ${
                      t.id === selectedId ? "bg-emerald-50" : ""
                    }`}
                    data-testid={`payment-modal-txn-option-${t.id}`}
                  >
                    <span className="text-slate-500 font-mono-num w-20 shrink-0">{t.date}</span>
                    <span className={`font-mono-num w-20 shrink-0 text-right ${Number(t.amount) < 0 ? "text-red-600" : "text-emerald-700"}`}>
                      ${Math.abs(Number(t.amount || 0)).toFixed(2)}
                    </span>
                    <span className="flex-1 truncate text-slate-700">{contactName(t)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
