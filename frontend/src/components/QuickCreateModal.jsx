import { useState } from "react";
import { X, Loader2 } from "lucide-react";

/**
 * Small in-place creator used by the Create Rule modal (and reusable
 * elsewhere) for spinning up a Class or a Tag without leaving the
 * current page. Renders a name field + Save button in a lightweight
 * overlay dialog.
 *
 * Props
 * -----
 * kind       "class" | "tag"                   — copy + endpoint suffix
 * currentId  string                            — company id
 * onClose    () => void                        — dismiss + cancel
 * onCreated  ({id, name}) => void              — parent applies + closes
 */
export default function QuickCreateModal({ kind, currentId, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const label   = kind === "class" ? "Class"   : "Tag";
  const path    = kind === "class" ? "classes" : "tags";

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true); setErr("");
    try {
      // Local import to avoid a top-level dep if this component is
      // rendered outside a page that already carries api.
      const { default: api } = await import("../lib/api");
      const r = await api.post(`/companies/${currentId}/${path}`, {
        name: name.trim(),
      });
      const id = r?.data?.id;
      if (!id) throw new Error("no id returned");
      onCreated({ id, name: name.trim() });
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to create");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h3 className="font-heading font-semibold">New {label}</h3>
          <button onClick={onClose}
                  data-testid={`quick-create-${kind}-close`}>
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder={`${label} name`}
            data-testid={`quick-create-${kind}-name`}
            className="w-full border rounded px-3 py-2 text-sm"
          />
          {err && (
            <div className="mt-2 text-xs text-rose-600" data-testid={`quick-create-${kind}-error`}>
              {err}
            </div>
          )}
        </div>
        <div className="px-5 py-3 flex items-center justify-end gap-2 border-t">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || !name.trim()}
            data-testid={`quick-create-${kind}-save`}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-70"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {busy ? "Creating…" : `Add ${label}`}
          </button>
        </div>
      </div>
    </div>
  );
}
