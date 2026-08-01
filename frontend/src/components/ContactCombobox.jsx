import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { ChevronDown, Plus, X, Check, Save } from "lucide-react";

/**
 * ContactCombobox — searchable dropdown for customer/vendor pickers.
 * Renders as a compact combobox with a filter input, a scrollable list
 * of matching contacts, and a "+ Add new customer/vendor" action at
 * the bottom that opens an inline create modal. Used on the invoice
 * editor (customer) and bill editor (vendor).
 *
 * Props:
 *   contacts     — full list already fetched by parent
 *   value        — currently selected contact id ("" = none)
 *   onChange(id) — fired when user picks (or clears) a contact
 *   onCreated(c) — fired after a new contact is created; parent should
 *                  append it to its contacts state
 *   type         — "customer" | "vendor" (drives filtering + create-form default)
 *   currentId    — company id (used for the create POST)
 *   testId       — root data-testid prefix
 */
export default function ContactCombobox({
  contacts, value, onChange, onCreated, type = "customer", currentId,
  testId = "contact-combobox", placeholder,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const rootRef = useRef(null);

  // Filter to matching type ("both" always shows up), then apply search.
  const rows = useMemo(() => {
    const scoped = contacts.filter(c => c.type === type || c.type === "both");
    if (!q.trim()) return scoped;
    const needle = q.toLowerCase();
    return scoped.filter(c =>
      (c.name || "").toLowerCase().includes(needle)
      || (c.email || "").toLowerCase().includes(needle)
      || (c.phone || "").toLowerCase().includes(needle));
  }, [contacts, type, q]);

  // Close on outside-click so the combobox behaves like a real menu.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const picked = contacts.find(c => c.id === value);
  const emptyLabel = placeholder || `Choose ${type}…`;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between border rounded px-3 py-2 text-sm text-left bg-white hover:border-slate-300"
        data-testid={testId}
      >
        <span className={picked ? "text-slate-800" : "text-slate-400"}>
          {picked ? picked.name : emptyLabel}
        </span>
        <ChevronDown size={14} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-white shadow-lg max-h-72 overflow-hidden flex flex-col"
             data-testid={`${testId}-dropdown`}>
          <div className="p-1.5 border-b bg-slate-50">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${type}s…`}
              className="w-full border rounded px-2 py-1 text-xs"
              data-testid={`${testId}-filter`}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-slate-400">
                {q ? `No ${type}s match "${q}".` : `No ${type}s yet.`}
              </div>
            ) : (
              <ul className="divide-y">
                {rows.map(c => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => { onChange(c.id); setOpen(false); setQ(""); }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2 ${
                        c.id === value ? "bg-emerald-50" : ""
                      }`}
                      data-testid={`${testId}-option-${c.id}`}
                    >
                      {c.id === value && <Check size={12} className="text-emerald-600" />}
                      <span className="flex-1 truncate">
                        <span className="text-slate-800">{c.name}</span>
                        {c.email && <span className="text-[11px] text-slate-400 ml-2">{c.email}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={() => { setCreating(true); setOpen(false); }}
            className="border-t px-3 py-2 text-xs text-indigo-600 hover:bg-indigo-50 inline-flex items-center gap-1.5"
            data-testid={`${testId}-add`}
          >
            <Plus size={12} /> Add new {type}
            {q.trim() && <span className="text-slate-500">— "{q}"</span>}
          </button>
        </div>
      )}
      {creating && (
        <CreateContactDialog
          currentId={currentId}
          defaultName={q}
          defaultType={type}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setQ("");
            onCreated && onCreated(c);
            onChange(c.id);
          }}
        />
      )}
    </div>
  );
}

function CreateContactDialog({ currentId, defaultName, defaultType, onClose, onCreated }) {
  const [name, setName] = useState(defaultName || "");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [type, setType] = useState(defaultType);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    try {
      const r = await api.post(`/companies/${currentId}/contacts`, {
        name: name.trim(), email: email.trim(), phone: phone.trim(), type,
      });
      toast.success(`Added ${name.trim()}`);
      // Backend returns `{contact: {...}}` for create.
      onCreated(r.data.contact || r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to create");
    } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4" data-testid="contact-create-dialog">
        <div className="flex items-center justify-between border-b pb-3">
          <h3 className="font-heading font-semibold text-lg">Add new {type}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Name <span className="text-red-500">*</span></label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                   className="w-full border rounded px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
                   data-testid="contact-create-name" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                   className="w-full border rounded px-3 py-2 text-sm"
                   data-testid="contact-create-email" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)}
                   className="w-full border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm bg-white">
              <option value="customer">Customer</option>
              <option value="vendor">Vendor</option>
              <option value="both">Both</option>
            </select>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button onClick={submit} disabled={saving || !name.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
                  data-testid="contact-create-submit">
            <Save size={13} /> {saving ? "Saving…" : `Create ${type}`}
          </button>
        </div>
      </div>
    </div>
  );
}
