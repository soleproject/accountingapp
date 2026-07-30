import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, Plus, ChevronDown, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

/**
 * AccountPicker — searchable combobox for picking a chart-of-accounts
 * row, with an inline "+ Add new" flow that hits the idempotent
 * `POST /companies/{cid}/accounts/ensure` endpoint so the CPA never has
 * to leave the review page to create a missing category.
 *
 * Props:
 *   value          — currently-selected account id
 *   accounts       — full list of accounts (id, code, name, type)
 *   onChange(id)   — fires after a pick OR after a successful add
 *   companyId      — needed for the /accounts/ensure call
 *   isOverridden   — cosmetic flag; render trigger with the amber tint
 *                    when the CPA has changed away from the AI pick
 */
export default function AccountPicker({ value, accounts, onChange, companyId, isOverridden, testId }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [addMode, setAddMode] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("expense");
  // Sub-account parent — pick an existing top-level same-type account
  // to nest the new one under (e.g. Utilities → Electric). Left blank
  // = top-level.
  const [newParentId, setNewParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  const searchRef = useRef(null);

  // Selected label for the trigger.
  const selected = accounts.find(a => a.id === value);
  const label = selected ? `${selected.code} · ${selected.name}` : "— pick a category —";

  // Filtered + type-grouped results — substring match on code OR name.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = accounts.filter(a =>
      !needle ||
      String(a.code || "").toLowerCase().includes(needle) ||
      String(a.name || "").toLowerCase().includes(needle),
    );
    const groups = {};
    for (const a of rows) {
      const k = (a.type || "other").toLowerCase();
      (groups[k] = groups[k] || []).push(a);
    }
    // Stable type order.
    const order = ["expense", "cogs", "revenue", "asset", "liability", "equity", "other"];
    return order.filter(k => groups[k]?.length).map(k => ({ type: k, items: groups[k] }));
  }, [accounts, q]);

  // Close on outside click. Popover is portaled to document.body so
  // check both rootRef (trigger area) and popRef (popover) — a click
  // inside either should keep the picker open.
  const popRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false); setAddMode(false); setQ("");
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Auto-focus the search when we open.
  useEffect(() => {
    if (open && !addMode) setTimeout(() => searchRef.current?.focus(), 20);
  }, [open, addMode]);

  const submitNew = async () => {
    const name = newName.trim();
    if (!name || !companyId) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${companyId}/accounts/ensure`, {
        name,
        type: newType,
        parent_account_id: newParentId || null,
      });
      const newId = r.data?.id;
      if (newId) onChange?.(newId);
      // Reset then close so the trigger repaints with the new label.
      setAddMode(false); setNewName(""); setNewParentId(""); setQ(""); setOpen(false);
      // Kick a refresh so `accounts` upstream repopulates.
      window.dispatchEvent(new CustomEvent("axiom:action", { detail: { kind: "accounts:changed", at: Date.now() } }));
    } catch {
      /* keep the form open on failure so the CPA can retry */
    } finally {
      setBusy(false);
    }
  };

  // Eligible parents for the "Sub-account of" picker: same type, top-
  // level only. Recomputed as the CPA switches the type dropdown.
  const eligibleParents = useMemo(() => {
    return (accounts || [])
      .filter(a => a.type === newType && !a.parent_account_id)
      .sort((x, y) => String(x.code).localeCompare(String(y.code)));
  }, [accounts, newType]);

  // Compute the popover's viewport-anchored position each time it opens
  // (or the window is resized/scrolled). Portal-rendered popovers sidestep
  // any ancestor `overflow: hidden` / stacking-context clipping — critical
  // inside modals like Add-manual-transaction where the picker would
  // otherwise render behind the modal backdrop.
  const [popRect, setPopRect] = useState({ top: 0, left: 0, width: 0 });
  const triggerRef = useRef(null);
  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setPopRect({
        top: r.bottom + 4,
        left: r.left,
        width: Math.max(r.width, 320),
      });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1 max-w-[340px]" onClick={e => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        onClick={() => setOpen(v => !v)}
        className={`w-full px-2.5 py-1 rounded-md border text-[13px] font-medium truncate text-left flex items-center gap-1 ${
          isOverridden
            ? "bg-amber-50 border-amber-300 text-amber-900"
            : "bg-white border-slate-300 text-slate-800"
        }`}
      >
        <span className="truncate flex-1">{label}</span>
        <ChevronDown size={12} className="text-slate-400 shrink-0" />
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="fixed z-[9999] max-h-[380px] bg-white border border-slate-200 rounded-lg shadow-xl flex flex-col"
          style={{ top: popRect.top, left: popRect.left, width: popRect.width }}
          data-testid={`${testId}-popover`}
        >
          {!addMode ? (
            <>
              <div className="p-2 border-b border-slate-100 flex items-center gap-2">
                <Search size={13} className="text-slate-400" />
                <input
                  ref={searchRef}
                  type="text"
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="Search categories…"
                  className="flex-1 outline-none text-sm placeholder:text-slate-400"
                  data-testid={`${testId}-search`}
                />
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                {filtered.length === 0 && (
                  <div className="px-3 py-4 text-xs text-slate-400 text-center">No matches</div>
                )}
                {filtered.map(g => (
                  <div key={g.type}>
                    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                      {g.type}
                    </div>
                    {g.items.map(a => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => { onChange?.(a.id); setOpen(false); setQ(""); }}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-cyan-50 ${
                          a.id === value ? "bg-cyan-100 text-cyan-900 font-medium" : "text-slate-700"
                        }`}
                      >
                        <span className="font-mono text-slate-500 mr-2">{a.code}</span>
                        {a.name}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => { setAddMode(true); setNewName(q); }}
                className="border-t border-slate-100 px-3 py-2 text-sm text-cyan-700 hover:bg-cyan-50 flex items-center gap-1.5 font-medium"
                data-testid={`${testId}-add-new`}
              >
                <Plus size={13} /> Add new category
                {q && <span className="text-slate-400 text-xs font-normal">— &quot;{q}&quot;</span>}
              </button>
            </>
          ) : (
            <div className="p-3 flex flex-col gap-2" data-testid={`${testId}-add-form`}>
              <div className="text-xs font-semibold text-slate-700">Create a new category</div>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") submitNew(); }}
                placeholder="Category name (e.g. Software subscriptions)"
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm outline-none focus:border-cyan-500"
                autoFocus
              />
              <div className="flex items-center gap-2 text-xs">
                <label className="text-slate-600">Type</label>
                <select
                  value={newType}
                  onChange={e => {
                    setNewType(e.target.value);
                    // Any previously-picked parent no longer applies once
                    // the type changes — clear it so we don't silently
                    // save a mismatched combo.
                    setNewParentId("");
                  }}
                  className="px-2 py-1 border border-slate-300 rounded text-sm bg-white"
                >
                  <option value="expense">Expense</option>
                  <option value="cogs">Cost of Goods Sold</option>
                  <option value="revenue">Revenue</option>
                  <option value="asset">Asset</option>
                  <option value="liability">Liability</option>
                  <option value="equity">Equity</option>
                </select>
              </div>
              <div className="flex flex-col gap-1 text-xs">
                <label className="text-slate-600">
                  Sub-account of <span className="text-slate-400">(optional)</span>
                </label>
                <select
                  value={newParentId}
                  onChange={e => setNewParentId(e.target.value)}
                  className="px-2 py-1 border border-slate-300 rounded text-sm bg-white"
                  data-testid={`${testId}-add-parent`}
                >
                  <option value="">— None (top-level) —</option>
                  {eligibleParents.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.code} · {p.name}
                    </option>
                  ))}
                </select>
                {eligibleParents.length === 0 && (
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    No top-level {newType} accounts yet — this will be a top-level category.
                  </div>
                )}
              </div>
              <div className="flex gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => { setAddMode(false); setNewName(""); setNewParentId(""); }}
                  disabled={busy}
                  className="flex-1 py-1.5 rounded border border-slate-300 bg-white text-slate-700 text-sm hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitNew}
                  disabled={busy || !newName.trim()}
                  className="flex-1 py-1.5 rounded bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-700 disabled:opacity-50 inline-flex items-center justify-center gap-1"
                >
                  {busy && <Loader2 size={12} className="animate-spin" />}
                  Create &amp; assign
                </button>
              </div>
              <div className="text-[10px] text-slate-400 mt-1">
                We'll auto-assign a code in the appropriate range for the type. If a category with this name already exists we'll re-use it.
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
