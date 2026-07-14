import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

export default function Contacts() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [creating, setCreating] = useState(false);
  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/contacts`);
    setItems(r.data.contacts || []);
  };
  useEffect(() => { load(); }, [currentId]);
  const del = async (id) => { if (confirm("Delete?")) { await api.delete(`/companies/${currentId}/contacts/${id}`); load(); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Contacts</h1>
          <p className="text-slate-500 text-sm mt-1">Customers &amp; vendors.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> New Contact
        </button>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr><th className="px-3 py-2 text-left">Name</th><th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Email</th><th className="px-3 py-2 text-left">Phone</th><th></th></tr>
          </thead>
          <tbody>
            {items.map(c => (
              <tr key={c.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2"><span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{c.type}</span></td>
                <td className="px-3 py-2 text-slate-500">{c.email}</td>
                <td className="px-3 py-2 text-slate-500">{c.phone}</td>
                <td className="px-3 py-2 text-right"><button onClick={() => del(c.id)} className="text-red-500 p-1"><Trash2 size={13} /></button></td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={5} className="text-center py-8 text-slate-500">No contacts.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <ContactModal currentId={currentId} onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function ContactModal({ currentId, onClose }) {
  const [f, setF] = useState({ name: "", type: "customer", email: "", phone: "", address: "" });
  const save = async () => { await api.post(`/companies/${currentId}/contacts`, f); toast.success("Contact saved"); onClose(); };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between"><h3 className="font-heading font-semibold">New Contact</h3><button onClick={onClose}><X size={16} /></button></div>
        <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-full border rounded px-2 py-1.5 text-sm" />
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="customer">Customer</option><option value="vendor">Vendor</option><option value="both">Both</option>
        </select>
        <input placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className="w-full border rounded px-2 py-1.5 text-sm" />
        <input placeholder="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="w-full border rounded px-2 py-1.5 text-sm" />
        <input placeholder="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} className="w-full border rounded px-2 py-1.5 text-sm" />
        <button data-testid={TID.saveBtn} onClick={save} disabled={!f.name} className="w-full py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50">Save</button>
      </div>
    </div>
  );
}
