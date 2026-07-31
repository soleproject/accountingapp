import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";

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
export default function ItemPicker({ items, value, onPickItem, onChangeText, testId }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
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
              No matching items.{" "}
              <a href="/items" className="text-indigo-600 hover:underline">Manage catalog →</a>
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
                      <div className="text-sm font-medium text-slate-800 truncate">{it.name}</div>
                      {it.description && <div className="text-xs text-slate-500 truncate">{it.description}</div>}
                      {it.income_account_name && <div className="text-[10px] text-slate-400 mt-0.5">{it.income_account_name}</div>}
                    </div>
                    <div className="text-xs font-mono-num text-slate-700 whitespace-nowrap">${Number(it.price || 0).toFixed(2)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
