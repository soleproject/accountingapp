import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X, Plus, Save } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useCompany } from "@/lib/company";

/**
 * Combobox for invoice line "Description" field. Lets users pick from the
 * items catalog (auto-fills description + rate + income account) OR type
 * a free-form description like before. Falls back gracefully when the
 * catalog is empty.
 *
 * Props:
 *  - items:      array of {id,name,description,price,income_account_id,income_account_name}
 *  - value:      current description text
 *  - onPickItem: (item) => void — called when user clicks an item option
 *  - onChangeText: (text) => void — called when user types free-form
 *  - testId:     optional data-testid prefix
 */
export default function ItemPicker({ items, value, onPickItem, onChangeText, onItemCreated, onTaxCreated, usage = "sales", testId }) {
  const { currentId } = useCompany();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const active = (items || []).filter(i => i.active !== false);
    if (!needle) return active.slice(0, 50);
    return active
      .filter(i =>
        (i.name || "").toLowerCase().includes(needle) ||
        (i.description || "").toLowerCase().includes(needle) ||
        (i.income_account_name || "").toLowerCase().includes(needle) ||
        (i.sku || "").toLowerCase().includes(needle)
      )
      .slice(0, 50);
  }, [q, items]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const pick = (it) => {
    onPickItem?.(it);
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-1 border rounded px-2 py-1.5 text-sm bg-white">
        <input
          value={value || ""}
          onChange={(e) => onChangeText?.(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Description or pick item…"
          className="flex-1 min-w-0 outline-none bg-transparent"
          data-testid={testId ? `${testId}-input` : undefined}
        />
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="p-0.5 rounded hover:bg-slate-100 text-slate-400"
          title="Pick item"
          data-testid={testId ? `${testId}-open` : undefined}
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 rounded-lg border bg-white shadow-xl max-h-72 overflow-auto"
             data-testid={testId ? `${testId}-menu` : undefined}>
          <div className="flex items-center gap-1 px-2 py-1.5 border-b bg-slate-50 text-xs">
            <Search size={12} className="text-slate-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search items…"
              className="flex-1 min-w-0 outline-none bg-transparent"
            />
            {q && (
              <button type="button" onClick={() => setQ("")} className="text-slate-400 hover:text-slate-600">
                <X size={12} />
              </button>
            )}
          </div>
          {!filtered.length ? (
            <div className="px-3 py-4 text-xs text-slate-400 text-center">
              No matching items.
            </div>
          ) : (
            <ul className="divide-y">
              {filtered.map(it => (
                <li key={it.id}>
                  <button
                    type="button"
                    onClick={() => pick(it)}
                    className="w-full text-left px-3 py-2 hover:bg-indigo-50 flex items-start justify-between gap-3"
                    data-testid={testId ? `${testId}-opt-${it.id}` : undefined}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate inline-flex items-center gap-1.5">
                        {it.name}
                        {it.track_inventory && (
                          <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-sky-100 text-sky-800 border border-sky-200" title={`Tracked · QOH ${it.quantity_on_hand ?? 0}`}>
                            Stock {it.quantity_on_hand ?? 0}
                          </span>
                        )}
                      </div>
                      {it.description && <div className="text-xs text-slate-500 truncate">{it.description}</div>}
                      {it.income_account_name && <div className="text-[10px] text-slate-400 mt-0.5">{it.income_account_name}</div>}
                    </div>
                    <div className="text-xs font-mono-num text-slate-700 whitespace-nowrap">${Number(it.price || 0).toFixed(2)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => { setCreating(true); setOpen(false); }}
            className="w-full border-t px-3 py-2 text-xs text-indigo-600 hover:bg-indigo-50 inline-flex items-center gap-1.5"
            data-testid={testId ? `${testId}-add-new` : "item-picker-add-new"}
          >
            <Plus size={12} /> Add new item
            {q.trim() && <span className="text-slate-500">— "{q}"</span>}
          </button>
        </div>
      )}
      {creating && (
        <CreateItemDialog
          currentId={currentId}
          defaultName={q}
          usage={usage}
          onTaxCreated={onTaxCreated}
          onClose={() => setCreating(false)}
          onCreated={(it) => {
            setCreating(false);
            setQ("");
            onItemCreated && onItemCreated(it);
            onPickItem && onPickItem(it);
          }}
        />
      )}
    </div>
  );
}

function CreateItemDialog({ currentId, defaultName, usage, onClose, onCreated, onTaxCreated }) {
  const [name, setName] = useState(defaultName || "");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [taxRateId, setTaxRateId] = useState("");
  const [taxRates, setTaxRates] = useState([]);
  const [showCreateTax, setShowCreateTax] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load available sales taxes so the pro can attach one to the
  // new item OR create a fresh one on the fly.
  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/taxes`)
      .then(r => setTaxRates(r.data?.taxes || []))
      .catch(() => setTaxRates([]));
  }, [currentId]);

  const submit = async () => {
    if (!name.trim()) { toast.error("Item name is required"); return; }
    setSaving(true);
    try {
      const r = await api.post(`/companies/${currentId}/items`, {
        name: name.trim(),
        description: description.trim(),
        price: parseFloat(price) || 0,
        usage,
        tax_rate_id: taxRateId || null,
      });
      toast.success(`Added ${name.trim()}`);
      const created = r.data?.item || {
        id: r.data?.id,
        name: name.trim(),
        description: description.trim(),
        price: parseFloat(price) || 0,
        usage,
        tax_rate_id: taxRateId || null,
      };
      onCreated(created);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to create item");
    } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4" data-testid="item-create-dialog">
        <div className="flex items-center justify-between border-b pb-3">
          <h3 className="font-heading font-semibold text-lg">Add new item</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Name <span className="text-red-500">*</span></label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                   className="w-full border rounded px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
                   data-testid="item-create-name" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
                   className="w-full border rounded px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Price</label>
            <input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)}
                   placeholder="0.00"
                   className="w-full border rounded px-3 py-2 text-sm font-mono-num text-right"
                   data-testid="item-create-price" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
              Sales tax <span className="text-slate-400 normal-case">(optional)</span>
            </label>
            <select
              value={taxRateId}
              onChange={(e) => {
                if (e.target.value === "__new__") {
                  // Pop the Create Tax dialog on top of this item
                  // modal — never navigates. Selection reverts to
                  // the previously-chosen value.
                  setShowCreateTax(true);
                  return;
                }
                setTaxRateId(e.target.value);
              }}
              data-testid="item-create-tax-rate"
              className="w-full border rounded px-3 py-2 text-sm bg-white"
            >
              <option value="">— None (taxable at line level) —</option>
              {taxRates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} · {Number(t.rate || 0).toFixed(3)}%
                </option>
              ))}
              <option value="__new__">+ Create a new tax…</option>
            </select>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-3 border-t">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button onClick={submit} disabled={saving || !name.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
                  data-testid="item-create-submit">
            <Save size={13} /> {saving ? "Saving…" : "Create item"}
          </button>
        </div>
      </div>
      {showCreateTax && (
        <QuickCreateTaxDialog
          currentId={currentId}
          onClose={() => setShowCreateTax(false)}
          onCreated={(t) => {
            if (!t || !t.id) { setShowCreateTax(false); return; }
            setTaxRates(prev => {
              const rest = prev.filter(x => x.id !== t.id);
              return [t, ...rest];
            });
            setTaxRateId(t.id);
            // Propagate the fresh tax up so the parent editor's
            // taxes[] array knows about it — this lets the invoice
            // line correctly look it up after the item is chosen.
            onTaxCreated && onTaxCreated(t);
            setShowCreateTax(false);
          }}
        />
      )}
    </div>
  );
}


function QuickCreateTaxDialog({ onClose, onCreated, currentId }) {
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const clean = name.trim();
    const r = parseFloat(rate);
    if (!clean) { toast.error("Tax name is required"); return; }
    if (isNaN(r) || r < 0 || r > 100) { toast.error("Rate must be between 0 and 100"); return; }
    setSaving(true);
    try {
      const resp = await api.post(`/companies/${currentId}/taxes`, { name: clean, rate: r });
      toast.success(`Tax "${clean}" created`);
      onCreated(resp.data?.tax || { id: resp.data?.id, name: clean, rate: r });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to create tax");
    } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4" data-testid="item-quick-create-tax-dialog">
        <div className="flex items-center justify-between border-b pb-3">
          <h3 className="font-heading font-semibold text-lg">Create a new tax</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">
              Tax name <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. GST"
              className="w-full border rounded px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
              data-testid="item-quick-create-tax-name"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">
              Tax rate <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                type="number" step="0.01" min="0" max="100"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="0.00"
                className="w-full border rounded px-3 py-2 text-sm pr-8 focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
                data-testid="item-quick-create-tax-rate"
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
            className="px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
            data-testid="item-quick-create-tax-submit"
          >{saving ? "Saving…" : "Create tax"}</button>
        </div>
      </div>
    </div>
  );
}
