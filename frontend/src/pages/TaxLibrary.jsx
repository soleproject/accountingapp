import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, X, Save, Percent } from "lucide-react";

/**
 * Tax Library — dedicated CRUD page under Accounting.
 *
 * Pros can rename or delete rates here without opening an invoice/bill.
 * Deletion is refused when the rate is still applied to any active
 * document (backend enforces).
 */
export default function TaxLibrary() {
  const { currentId } = useCompany();
  const [taxes, setTaxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null); // { id, name, rate }

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/taxes`);
      setTaxes(r.data.taxes || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not load taxes");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentId]);

  const remove = async (t) => {
    if (!window.confirm(`Delete tax "${t.name}"? This can't be undone.`)) return;
    try {
      await api.delete(`/companies/${currentId}/taxes/${t.id}`);
      toast.success(`Deleted "${t.name}"`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Delete failed");
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">Tax Library</h1>
          <p className="text-sm text-slate-500 mt-1">
            Manage the tax rates used on invoices and bills. Rename or delete rates without opening a document.
          </p>
        </div>
        <button
          data-testid="tax-library-new"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm shadow-sm"
        ><Plus size={14} /> New tax</button>
      </div>

      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading taxes…</div>
        ) : taxes.length === 0 ? (
          <div className="p-12 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center mb-3">
              <Percent className="text-indigo-500" size={20} />
            </div>
            <h3 className="font-heading font-semibold text-slate-800">No taxes yet</h3>
            <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
              Add rates like GST, HST, VAT, or your state sales tax so you can apply them per-line on invoices and bills.
            </p>
            <button
              onClick={() => setCreating(true)}
              className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm"
              data-testid="tax-library-empty-new"
            ><Plus size={14} /> Add your first tax</button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-right px-4 py-2">Rate</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {taxes.map((t) => (
                <tr key={t.id} data-testid={`tax-row-${t.id}`}>
                  <td className="px-4 py-3 font-medium text-slate-800">{t.name}</td>
                  <td className="px-4 py-3 text-right font-mono-num">{Number(t.rate).toFixed(2)}%</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => setEditing({ id: t.id, name: t.name, rate: String(t.rate) })}
                      className="p-1.5 rounded hover:bg-slate-100 text-slate-600"
                      title="Edit"
                      data-testid={`tax-edit-${t.id}`}
                    ><Pencil size={13} /></button>
                    <button
                      onClick={() => remove(t)}
                      className="p-1.5 rounded hover:bg-red-50 text-red-500"
                      title="Delete"
                      data-testid={`tax-delete-${t.id}`}
                    ><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <TaxDialog
          currentId={currentId}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}
      {editing && (
        <TaxDialog
          currentId={currentId}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function TaxDialog({ currentId, initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || "");
  const [rate, setRate] = useState(initial?.rate || "");
  const [saving, setSaving] = useState(false);
  const isEdit = !!initial;
  const submit = async () => {
    const clean = name.trim();
    const r = parseFloat(rate);
    if (!clean) { toast.error("Tax name is required"); return; }
    if (isNaN(r) || r < 0 || r > 100) { toast.error("Rate must be between 0 and 100"); return; }
    setSaving(true);
    try {
      if (isEdit) {
        await api.patch(`/companies/${currentId}/taxes/${initial.id}`, { name: clean, rate: r });
        toast.success(`Updated "${clean}"`);
      } else {
        await api.post(`/companies/${currentId}/taxes`, { name: clean, rate: r });
        toast.success(`Tax "${clean}" created`);
      }
      onSaved();
    } catch (e) { toast.error(e.response?.data?.detail || "Save failed"); }
    finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4" data-testid="tax-dialog">
        <div className="flex items-center justify-between border-b pb-3">
          <h3 className="font-heading font-semibold text-lg">{isEdit ? "Edit tax" : "Create a new tax"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Tax name <span className="text-red-500">*</span></label>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. GST"
              className="w-full border rounded px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
              data-testid="tax-dialog-name"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Tax rate <span className="text-red-500">*</span></label>
            <div className="relative">
              <input
                type="number" step="0.01" min="0" max="100" value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="0.00"
                className="w-full border rounded px-3 py-2 text-sm pr-8 focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
                data-testid="tax-dialog-rate"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button
            onClick={submit}
            disabled={saving || !name.trim() || rate === ""}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
            data-testid="tax-dialog-submit"
          ><Save size={13} /> {saving ? "Saving…" : (isEdit ? "Save changes" : "Create tax")}</button>
        </div>
      </div>
    </div>
  );
}
