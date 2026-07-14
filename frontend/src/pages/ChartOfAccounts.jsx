import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

const TYPES = ["asset", "liability", "equity", "revenue", "expense"];

export default function ChartOfAccounts() {
  const { currentId } = useCompany();
  const [accts, setAccts] = useState([]);
  const [creating, setCreating] = useState(false);
  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/accounts`);
    setAccts(r.data.accounts || []);
  };
  useEffect(() => { load(); }, [currentId]);

  const del = async (id) => {
    if (!confirm("Delete account?")) return;
    await api.delete(`/companies/${currentId}/accounts/${id}`);
    load();
  };

  const grouped = TYPES.map(t => ({ type: t, items: accts.filter(a => a.type === t) }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Chart of Accounts</h1>
          <p className="text-slate-500 text-sm mt-1">GAAP-organized accounts. Add or edit anything.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> New Account
        </button>
      </div>
      <div className="space-y-4">
        {grouped.map(g => (
          <div key={g.type} className="rounded-xl border bg-white overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 border-b text-xs uppercase tracking-widest text-slate-600 font-semibold">
              {g.type}s · {g.items.length}
            </div>
            <div>
              {g.items.map(a => (
                <div key={a.id} className="grid grid-cols-12 gap-3 px-4 py-2 border-b border-slate-100 items-center hover:bg-slate-50">
                  <div className="col-span-2 font-mono-num text-slate-500 text-sm">{a.code}</div>
                  <div className="col-span-7 text-sm">{a.name}</div>
                  <div className="col-span-2 text-xs text-slate-500">{a.subtype}</div>
                  <div className="col-span-1 text-right">
                    <button onClick={() => del(a.id)} className="text-red-500 hover:bg-red-50 rounded p-1"
                            data-testid={TID.deleteBtn}><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {creating && <CreateAccount currentId={currentId} onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function CreateAccount({ currentId, onClose }) {
  const [code, setCode] = useState(""); const [name, setName] = useState("");
  const [type, setType] = useState("expense"); const [subtype, setSubtype] = useState("operating_expense");
  const save = async () => {
    await api.post(`/companies/${currentId}/accounts`, { code, name, type, subtype });
    toast.success("Account created"); onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <h3 className="font-heading font-semibold">New Account</h3>
        <input placeholder="Code (e.g. 6250)" value={code} onChange={(e) => setCode(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm font-mono-num" />
        <input placeholder="Account name" value={name} onChange={(e) => setName(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm" />
        <select value={type} onChange={(e) => setType(e.target.value)} className="w-full border rounded px-3 py-2 text-sm">
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="Subtype" value={subtype} onChange={(e) => setSubtype(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm" />
        <div className="flex gap-2">
          <button data-testid={TID.saveBtn} onClick={save} className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
          <button data-testid={TID.cancelBtn} onClick={onClose} className="flex-1 py-2 rounded-md border text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
