import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Check } from "lucide-react";
import { api } from "@/lib/api";

const inp = "w-full h-8 rounded border border-slate-400 bg-white px-2 text-sm text-slate-700 outline-none focus:border-[#1E88E5]";

export const ExpenseCategoriesModal = ({ onClose, onSaved }) => {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/practice/expenses/categories").then(r => setRows(r.data.map(c => ({ ...c, key: c.code + c.name })))).catch(() => { toast.error("Could not load categories"); onClose(); }); }, [onClose]);
  const add = () => setRows(r => [{ name: "", code: "", key: `new-${Date.now()}`, isNew: true }, ...r]);
  const edit = (key, k, v) => setRows(r => r.map(c => c.key === key ? { ...c, [k]: v } : c));
  const del = (key) => setRows(r => r.filter(c => c.key !== key));
  const save = async () => {
    if (rows.some(c => !c.name.trim())) return toast.error("Every category needs a name.");
    setBusy(true);
    try { const r = await api.put("/practice/expenses/categories", { categories: rows.map(({ name, code }) => ({ name, code })) }); toast.success("Categories saved."); onSaved?.(r.data); onClose(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Could not save"); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-start justify-center overflow-y-auto p-2" data-testid="practice-expense-categories-modal">
      <div className="w-full rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> Expense Categories</span>
          <button type="button" onClick={onClose} data-testid="practice-exp-cats-close"><X size={16} /></button>
        </div>
        <div className="p-4">
          <div className="flex gap-1.5 mb-3">
            <button type="button" onClick={add} className="inline-flex items-center gap-1 rounded bg-[#1E88E5] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#1976D2]" data-testid="practice-exp-cats-add"><Plus size={13} /> Add New Category</button>
            <button type="button" onClick={save} disabled={busy} className="inline-flex items-center gap-1 rounded bg-[#1E88E5] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#1976D2] disabled:opacity-60" data-testid="practice-exp-cats-save"><Check size={13} /> Save</button>
          </div>
          <table className="w-full text-sm text-slate-700">
            <thead><tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500"><th className="py-2 w-1/2">Category Name</th><th className="py-2 w-[30%]">Category Code</th><th className="py-2">Actions</th></tr></thead>
            <tbody>
              {(rows || []).map(c => (
                <tr key={c.key} className="align-middle" data-testid={`practice-exp-cat-row-${c.key}`}>
                  <td className="py-1 pr-6">{c.isNew ? <input autoFocus value={c.name} onChange={e => edit(c.key, "name", e.target.value)} className={inp} placeholder="Category name" data-testid="practice-exp-cat-name-input" /> : <span className="block py-1.5">{c.name}</span>}</td>
                  <td className="py-1 pr-6">{c.isNew ? <input value={c.code} onChange={e => edit(c.key, "code", e.target.value)} className={`${inp} w-40`} placeholder="Code" data-testid="practice-exp-cat-code-input" /> : <span className="block py-1.5">{c.code}</span>}</td>
                  <td className="py-1"><button type="button" onClick={() => del(c.key)} className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50" data-testid={`practice-exp-cat-delete-${c.key}`}><X size={11} /> Delete</button></td>
                </tr>
              ))}
              {rows && rows.length === 0 && <tr><td colSpan={3} className="py-6 text-center text-slate-500">No categories. Click Add New Category.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
