import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, Plus, ChevronDown, Loader2, X } from "lucide-react";
import { ContactBadge } from "@/components/ContactBadge";

// Inline contact combobox for the Transactions grid — same portaled
// popover pattern as AccountPicker so it isn't clipped by the table.
export default function ContactPicker({ value, name, logoUrl, contacts, onChange, onCreate, testId }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  const popRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const [popRect, setPopRect] = useState({ top: 0, left: 0, width: 0 });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = needle ? contacts.filter(c => (c.name || "").toLowerCase().includes(needle)) : contacts;
    return [...rows].sort((a, b) => (a.name || "").localeCompare(b.name || "")).slice(0, 200);
  }, [contacts, q]);
  const exact = contacts.some(c => (c.name || "").trim().toLowerCase() === q.trim().toLowerCase());

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false); setQ("");
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => { if (open) setTimeout(() => searchRef.current?.focus(), 20); }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPopRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 280) });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => { window.removeEventListener("resize", compute); window.removeEventListener("scroll", compute, true); };
  }, [open]);

  const pick = (id, nm) => { onChange?.(id, nm); setOpen(false); setQ(""); };

  const create = async () => {
    const nm = q.trim();
    if (!nm || busy) return;
    setBusy(true);
    try {
      const created = await onCreate?.(nm);
      if (created?.id) pick(created.id, created.name || nm);
    } finally { setBusy(false); }
  };

  return (
    <div ref={rootRef} className="relative min-w-0" onClick={e => e.stopPropagation()}>
      <button ref={triggerRef} type="button" data-testid={testId} onClick={() => setOpen(v => !v)}
              title={name || "Pick a contact"}
              className="group w-full max-w-[200px] flex items-center gap-2 min-w-0 px-1.5 py-1 -ml-1.5 rounded-md border border-transparent hover:border-slate-300 hover:bg-white text-left">
        <ContactBadge contact={{ name, logo_url: logoUrl }} size={22} />
        <span className={`truncate flex-1 ${name ? "text-slate-700" : "text-slate-300"}`}>{name || "—"}</span>
        <ChevronDown size={12} className="text-slate-400 shrink-0 opacity-0 group-hover:opacity-100" />
      </button>

      {open && createPortal(
        <div ref={popRef} data-testid={`${testId}-popover`}
             className="fixed z-[9999] max-h-[380px] bg-white border border-slate-200 rounded-lg shadow-xl flex flex-col"
             style={{ top: popRect.top, left: popRect.left, width: popRect.width }}>
          <div className="p-2 border-b border-slate-100 flex items-center gap-2">
            <Search size={13} className="text-slate-400" />
            <input ref={searchRef} type="text" value={q} onChange={e => setQ(e.target.value)}
                   onKeyDown={e => { if (e.key === "Enter" && q.trim() && !exact && filtered.length === 0) create(); }}
                   placeholder="Search contacts…" className="flex-1 outline-none text-sm placeholder:text-slate-400"
                   data-testid={`${testId}-search`} />
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {value && (
              <button type="button" onClick={() => pick(null, null)} data-testid={`${testId}-clear`}
                      className="w-full text-left px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 flex items-center gap-2">
                <X size={13} /> No contact
              </button>
            )}
            {filtered.length === 0 && <div className="px-3 py-4 text-xs text-slate-400 text-center">No matches</div>}
            {filtered.map(c => (
              <button key={c.id} type="button" onClick={() => pick(c.id, c.name)} data-testid={`${testId}-option-${c.id}`}
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-cyan-50 ${c.id === value ? "bg-cyan-100 text-cyan-900 font-medium" : "text-slate-700"}`}>
                <ContactBadge contact={{ name: c.name, logo_url: c.logo_url }} size={18} />
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </div>
          {onCreate && (
            <button type="button" onClick={create} disabled={busy || !q.trim() || exact} data-testid={`${testId}-add-new`}
                    className="border-t border-slate-100 px-3 py-2 text-sm text-cyan-700 hover:bg-cyan-50 disabled:text-slate-400 disabled:hover:bg-transparent flex items-center gap-1.5 font-medium">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              Add new contact{q.trim() && !exact ? <span className="text-slate-400 text-xs font-normal">— &quot;{q.trim()}&quot;</span> : <span className="text-slate-400 text-xs font-normal">— type a name</span>}
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
