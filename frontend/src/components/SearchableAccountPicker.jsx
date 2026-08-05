/**
 * SearchableAccountPicker — a combobox-style account picker with inline
 * "Add new" support. Drop-in replacement for the raw <select> chart-of-
 * account dropdowns scattered across the app (Items modal, invoice
 * lines, bill lines, etc.).
 *
 * Props:
 *   value: string | null            Currently selected account id
 *   onChange: (id: string | null) => void
 *   accounts: Account[]              Pre-filtered list to show
 *   allAccounts: Account[]           Full CoA (used to compute next code
 *                                    when creating a new one)
 *   placeholder?: string             "— Pick income account —" etc.
 *   kindLabel?: string               Used inside the "Add new …" button
 *                                    and the mini form title (e.g. "income")
 *   newDefaults: {                   Values applied when the user opens
 *     type: "asset"|"revenue"|"expense"|"cogs"|...
 *     detail_type?: string
 *     subtype?: string
 *   }
 *   currentId: string                Company id — needed for POST
 *   onCreated?: (acct) => void       Fires after successful creation so
 *                                    the parent can refresh its lists.
 *   testId?: string                  Base test id, e.g. "item-inventory-
 *                                    account".
 *   disabled?: boolean
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { ChevronDown, Plus, Search, Loader2, X } from "lucide-react";

// GAAP-standard code ranges — MUST match backend's _COA_CODE_RANGE
// and ChartOfAccounts.jsx CODE_RANGE.
const CODE_RANGE = {
  asset:     { start: 1000, end: 1999 },
  liability: { start: 2000, end: 2999 },
  equity:    { start: 3000, end: 3999 },
  revenue:   { start: 4000, end: 4999 },
  income:    { start: 4000, end: 4999 },  // legacy alias
  cogs:      { start: 5000, end: 5999 },
  expense:   { start: 6000, end: 9999 },
};

function nextCodeForType(type, accounts) {
  const range = CODE_RANGE[type] || CODE_RANGE.expense;
  const used = new Set(
    (accounts || [])
      .filter(a => a.type === type)
      .map(a => Number(a.code))
      .filter(n => Number.isFinite(n))
  );
  for (let n = range.start; n <= range.end; n += 10) {
    if (!used.has(n)) return String(n);
  }
  for (let n = range.start; n <= range.end; n += 1) {
    if (!used.has(n)) return String(n);
  }
  return String(range.end);
}

export default function SearchableAccountPicker({
  value, onChange,
  accounts = [], allAccounts = [],
  placeholder = "— Pick account —",
  kindLabel = "account",
  newDefaults = { type: "expense" },
  currentId,
  onCreated,
  testId = "acct-picker",
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  // Menu is rendered with `position: fixed` so it can escape any parent
  // `overflow: hidden` (bill/invoice tables, modal cards, etc.). We track
  // the trigger's bounding rect and re-measure on scroll/resize while
  // the menu is open.
  const [menuRect, setMenuRect] = useState(null);
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);

  const selected = useMemo(
    () => accounts.find(a => a.id === value) || allAccounts.find(a => a.id === value) || null,
    [accounts, allAccounts, value]
  );

  const filtered = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(a => {
      const name = (a.name || "").toLowerCase();
      const code = (a.code || "").toLowerCase();
      return name.includes(q) || code.includes(q);
    });
  }, [accounts, query]);

  // Close on outside click. The menu is portaled to document.body so it
  // lives OUTSIDE rootRef — check both refs before closing so clicks
  // inside the menu (option selection, search box, add-new) don't
  // dismiss it immediately.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      const inRoot = rootRef.current && rootRef.current.contains(e.target);
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      if (!inRoot && !inMenu) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Measure the trigger + track its position while the menu is open so
  // the fixed-position menu stays glued to the button through scroll,
  // resize, and layout shifts. Flip upward when there isn't enough room
  // below (viewport bottom close to the trigger) so the search box and
  // first options are never offscreen on short screens.
  useEffect(() => {
    if (!open) { setMenuRect(null); return; }
    // Approximate menu height: search bar (~34px) + up to 8 options
    // (28px each) + add-new button (~34px) + padding. Clamped so tall
    // menus don't shove themselves onto the trigger.
    const MENU_MAX_H = 340;
    const measure = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
      setMenuRect({
        left: r.left,
        // 4px gap on both sides; when flipping up we anchor to the
        // trigger's TOP and use `bottom` positioning instead.
        top: openUp ? undefined : r.bottom + 4,
        bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
        width: r.width,
        // Cap the popover so it can't exceed the space it has.
        maxHeight: Math.min(MENU_MAX_H, openUp ? spaceAbove - 8 : spaceBelow - 8),
      });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  // Focus the search input when opening.
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const pick = (id) => {
    onChange(id || null);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        data-testid={testId}
        className={`w-full border rounded px-2 py-1.5 text-sm bg-white flex items-center justify-between gap-2 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-500 ${open ? "ring-2 ring-slate-300" : ""}`}
      >
        <span className={`truncate text-left flex-1 ${selected ? "text-slate-800" : "text-slate-400"}`}>
          {selected ? `${selected.code ? selected.code + " · " : ""}${selected.name}` : placeholder}
        </span>
        <ChevronDown size={14} className="text-slate-400 shrink-0" />
      </button>

      {open && menuRect && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[80] bg-white border rounded-lg shadow-xl overflow-hidden flex flex-col"
          style={{
            left: menuRect.left,
            top: menuRect.top,
            bottom: menuRect.bottom,
            width: menuRect.width,
            minWidth: 260,
            maxHeight: menuRect.maxHeight,
          }}
          data-testid={`${testId}-menu`}
        >
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b bg-slate-50 shrink-0">
            <Search size={13} className="text-slate-400 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${kindLabel} accounts…`}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
              data-testid={`${testId}-search`}
            />
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-xs text-slate-400 text-center">
                No matches. Try a different search or add a new one below.
              </div>
            )}
            {filtered.map(a => (
              <button
                key={a.id}
                type="button"
                onClick={() => pick(a.id)}
                data-testid={`${testId}-opt-${a.id}`}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${a.id === value ? "bg-slate-100 font-medium" : ""}`}
              >
                <span className="text-slate-500 font-mono-num text-[11px] mr-2">{a.code || "—"}</span>
                {a.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            data-testid={`${testId}-add-new`}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border-t shrink-0"
          >
            <Plus size={12} /> Add new {kindLabel} account
          </button>
        </div>,
        document.body
      )}

      {showCreate && (
        <QuickCreateAccountModal
          kindLabel={kindLabel}
          newDefaults={newDefaults}
          allAccounts={allAccounts}
          currentId={currentId}
          onClose={() => setShowCreate(false)}
          onCreated={(acct) => {
            setShowCreate(false);
            setOpen(false);
            onChange(acct.id);
            onCreated && onCreated(acct);
          }}
        />
      )}
    </div>
  );
}


function QuickCreateAccountModal({ kindLabel, newDefaults, allAccounts, currentId, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(() => nextCodeForType(newDefaults.type, allAccounts));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const nm = name.trim();
    if (!nm) { toast.error("Name is required."); return; }
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/accounts`, {
        name: nm,
        code: code || nextCodeForType(newDefaults.type, allAccounts),
        type: newDefaults.type,
        subtype: newDefaults.subtype || "",
        detail_type: newDefaults.detail_type || "",
      });
      const acct = r.data?.account || { id: r.data?.id, name: nm, code, type: newDefaults.type, detail_type: newDefaults.detail_type };
      toast.success(`Account "${nm}" created`);
      onCreated(acct);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to create account");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5 space-y-3" data-testid="quick-create-account-modal">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold text-slate-800">New {kindLabel} account</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
                 autoFocus placeholder={`e.g. ${kindLabel === 'inventory' ? 'Inventory · Widgets' : kindLabel === 'COGS' ? 'COGS · Widgets' : 'Consulting income'}`}
                 className="w-full border rounded px-2 py-1.5 text-sm"
                 data-testid="quick-account-name" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Code</label>
          <input value={code} onChange={(e) => setCode(e.target.value)}
                 className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                 data-testid="quick-account-code" />
          <p className="text-[10px] text-slate-400 mt-1">Auto-suggested from the {kindLabel} range. Edit if you use a different numbering scheme.</p>
        </div>
        {newDefaults.detail_type && (
          <div className="text-[10px] text-slate-500 bg-slate-50 border rounded px-2 py-1.5">
            Sub-type: <b>{newDefaults.detail_type.replace(/_/g, " ")}</b> · Type: <b>{newDefaults.type}</b>
          </div>
        )}
        <button onClick={save} disabled={busy}
                data-testid="quick-account-save"
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60">
          {busy && <Loader2 size={13} className="animate-spin" />}
          Create account
        </button>
      </div>
    </div>
  );
}
