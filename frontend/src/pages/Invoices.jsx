import { useEffect, useState } from "react";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

export default function Invoices() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [creating, setCreating] = useState(false);
  const load = async () => {
    if (!currentId) return;
    const [i, c] = await Promise.all([
      api.get(`/companies/${currentId}/invoices`),
      api.get(`/companies/${currentId}/contacts`),
    ]);
    setItems(i.data.invoices || []); setContacts(c.data.contacts || []);
  };
  useEffect(() => { load(); }, [currentId]);
  const del = async (id) => {
    if (!confirm("Delete?")) return;
    await api.delete(`/companies/${currentId}/invoices/${id}`);
    load();
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Invoices</h1>
          <p className="text-slate-500 text-sm mt-1">Money in · sent to customers.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> New Invoice
        </button>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Number</th>
              <th className="px-3 py-2 text-left">Customer</th>
              <th className="px-3 py-2 text-left">Issued</th>
              <th className="px-3 py-2 text-left">Due</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Balance</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map(inv => (
              <tr key={inv.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2 font-mono-num text-slate-600">{inv.number}</td>
                <td className="px-3 py-2">{inv.contact_name}</td>
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(inv.issue_date)}</td>
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(inv.due_date)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(inv.total)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(inv.balance_due)}</td>
                <td className="px-3 py-2"><span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{inv.status}</span></td>
                <td className="px-3 py-2 text-right"><button onClick={() => del(inv.id)} className="text-red-500 p-1"><Trash2 size={13} /></button></td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={8} className="text-center py-8 text-slate-500">No invoices.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <InvoiceModal contacts={contacts} currentId={currentId} onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function InvoiceModal({ contacts, currentId, onClose }) {
  const [contact, setContact] = useState("");
  const [issue, setIssue] = useState(new Date().toISOString().slice(0, 10));
  const [due, setDue] = useState(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  const [lines, setLines] = useState([{ description: "", quantity: 1, rate: 0, amount: 0 }]);
  const [tax, setTax] = useState(0);
  const upd = (i, patch) => setLines(lines.map((x, j) => j === i ? { ...x, ...patch, amount: (patch.quantity !== undefined ? patch.quantity : x.quantity) * (patch.rate !== undefined ? patch.rate : x.rate) } : x));
  const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0) + Number(tax);
  const save = async () => {
    const c = contacts.find(x => x.id === contact);
    await api.post(`/companies/${currentId}/invoices`, {
      contact_id: contact || null, contact_name: c?.name || "",
      issue_date: issue, due_date: due, line_items: lines, tax: Number(tax), status: "sent",
    });
    toast.success("Invoice created"); onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl p-5 space-y-3">
        <div className="flex items-center justify-between"><h3 className="font-heading font-semibold">New Invoice</h3><button onClick={onClose}><X size={16} /></button></div>
        <div className="grid grid-cols-3 gap-2">
          <select value={contact} onChange={(e) => setContact(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">Customer…</option>
            {contacts.filter(c => c.type === "customer").map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="date" value={issue} onChange={(e) => setIssue(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <input placeholder="Description" value={l.description} onChange={(e) => upd(i, { description: e.target.value })} className="col-span-5 border rounded px-2 py-1.5 text-sm" />
              <input type="number" value={l.quantity} onChange={(e) => upd(i, { quantity: Number(e.target.value) })} className="col-span-2 border rounded px-2 py-1.5 text-sm font-mono-num" />
              <input type="number" value={l.rate} onChange={(e) => upd(i, { rate: Number(e.target.value) })} className="col-span-2 border rounded px-2 py-1.5 text-sm font-mono-num" />
              <div className="col-span-2 py-1.5 text-right font-mono-num">{fmtMoney(l.amount)}</div>
              <button onClick={() => setLines(lines.filter((_, j) => j !== i))} className="col-span-1 text-red-500"><Trash2 size={13} /></button>
            </div>
          ))}
          <button onClick={() => setLines([...lines, { description: "", quantity: 1, rate: 0, amount: 0 }])}
                  className="text-xs text-slate-600 border border-dashed rounded px-2 py-1">+ Line</button>
        </div>
        <div className="flex justify-end gap-4 items-center border-t pt-3">
          <div className="text-sm">Tax: <input type="number" value={tax} onChange={(e) => setTax(e.target.value)} className="w-24 border rounded px-2 py-1 text-sm font-mono-num" /></div>
          <div className="text-lg font-mono-num font-semibold">Total: {fmtMoney(total)}</div>
          <button data-testid={TID.saveBtn} onClick={save} className="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">Save Invoice</button>
        </div>
      </div>
    </div>
  );
}
