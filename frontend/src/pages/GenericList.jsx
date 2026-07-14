import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

export default function GenericList({ path, title, fields }) {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [creating, setCreating] = useState(false);
  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/${path}`);
    setItems(r.data.items || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, path]);
  const del = async (id) => { if (confirm("Delete?")) { await api.delete(`/companies/${currentId}/${path}/${id}`); load(); } };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-3xl font-bold tracking-tight">{title}</h1>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> Add {title.slice(0, -1)}
        </button>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>{fields.map(f => <th key={f.k} className="px-3 py-2 text-left">{f.l}</th>)}<th></th></tr>
          </thead>
          <tbody>
            {items.map(x => (
              <tr key={x.id} className="border-b hover:bg-slate-50">
                {fields.map(f => (
                  <td key={f.k} className={`px-3 py-2 ${f.t === "number" ? "font-mono-num" : ""}`}>{x[f.k] ?? ""}</td>
                ))}
                <td className="px-3 py-2 text-right"><button onClick={() => del(x.id)} className="text-red-500 p-1"><Trash2 size={13} /></button></td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={fields.length + 1} className="text-center py-8 text-slate-500">No records.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <GenericModal path={path} title={title} fields={fields} currentId={currentId} onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function GenericModal({ path, title, fields, currentId, onClose }) {
  const [data, setData] = useState({});
  const save = async () => {
    await api.post(`/companies/${currentId}/${path}`, data);
    toast.success(`${title.slice(0, -1)} saved`); onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between"><h3 className="font-heading font-semibold">New {title.slice(0, -1)}</h3><button onClick={onClose}><X size={16} /></button></div>
        {fields.map(f => (
          <div key={f.k}>
            <label className="text-xs uppercase text-slate-500">{f.l}</label>
            <input type={f.t || "text"} value={data[f.k] || ""}
                   onChange={(e) => setData({ ...data, [f.k]: f.t === "number" ? Number(e.target.value) : e.target.value })}
                   className={`w-full mt-1 border rounded px-2 py-1.5 text-sm ${f.t === "number" ? "font-mono-num" : ""}`} />
          </div>
        ))}
        <button data-testid={TID.saveBtn} onClick={save} className="w-full py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
      </div>
    </div>
  );
}
