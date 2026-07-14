import { useEffect, useState } from "react";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

export default function Receipts() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [accts, setAccts] = useState([]);
  const [creating, setCreating] = useState(false);
  const load = async () => {
    if (!currentId) return;
    const [r, a] = await Promise.all([
      api.get(`/companies/${currentId}/receipts`),
      api.get(`/companies/${currentId}/accounts`),
    ]);
    setItems(r.data.receipts || []); setAccts(a.data.accounts || []);
  };
  useEffect(() => { load(); }, [currentId]);
  const del = async (id) => { if (confirm("Delete?")) { await api.delete(`/companies/${currentId}/receipts/${id}`); load(); } };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Receipts</h1>
          <p className="text-slate-500 text-sm mt-1">Cash / card expense receipts.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> New Receipt
        </button>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Merchant</th>
              <th className="px-3 py-2 text-left">Notes</th><th className="px-3 py-2 text-right">Amount</th><th></th></tr>
          </thead>
          <tbody>
            {items.map(r => (
              <tr key={r.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2 font-mono-num text-slate-500">{fmtDate(r.date)}</td>
                <td className="px-3 py-2">{r.merchant}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.notes}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.amount)}</td>
                <td className="px-3 py-2 text-right"><button onClick={() => del(r.id)} className="text-red-500 p-1"><Trash2 size={13} /></button></td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={5} className="text-center py-8 text-slate-500">No receipts.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <RecModal currentId={currentId} accts={accts} onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function RecModal({ currentId, accts, onClose }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [cat, setCat] = useState("");
  const [notes, setNotes] = useState("");
  const save = async () => {
    await api.post(`/companies/${currentId}/receipts`, {
      date, merchant, amount: parseFloat(amount), category_account_id: cat || null, notes,
    });
    toast.success("Receipt saved"); onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between"><h3 className="font-heading font-semibold">New Receipt</h3><button onClick={onClose}><X size={16} /></button></div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" />
        <input placeholder="Merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" />
        <input type="number" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm font-mono-num" />
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Category…</option>
          {accts.filter(a => a.type === "expense").map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
        </select>
        <input placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" />
        <button data-testid={TID.saveBtn} onClick={save} className="w-full py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
      </div>
    </div>
  );
}
