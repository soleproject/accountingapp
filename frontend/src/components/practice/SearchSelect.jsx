import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search, Plus, X } from "lucide-react";

export const SearchSelect = ({ value, onChange, options, placeholder = "Select...", newLabel, onNew, testId, clearable = false, disabled = false }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  const current = options.find(o => o.id === value);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const shown = options.filter(o => `${o.label} ${o.code || ""}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      {clearable && current && <button type="button" onClick={() => onChange("")} className="text-slate-500" data-testid={`${testId}-clear`}><X size={12} /></button>}
      <button type="button" disabled={disabled} onClick={() => setOpen(v => !v)} data-testid={testId}
              className="flex-1 h-9 rounded border border-slate-300 bg-white px-3 text-sm text-left flex items-center justify-between disabled:bg-slate-50">
        <span className={current ? "text-slate-700" : "text-slate-400"}>{current ? current.label : placeholder}</span>
        <ChevronDown size={14} className="text-slate-500" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded border border-slate-300 bg-white shadow-lg" data-testid={`${testId}-panel`}>
          <div className="flex items-center gap-2 border-b border-slate-200 px-3">
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} data-testid={`${testId}-search`} className="flex-1 h-9 text-sm outline-none bg-transparent" />
            <Search size={14} className="text-slate-500" />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {newLabel && (
              <button type="button" onClick={() => { setOpen(false); onNew?.(); }} data-testid={`${testId}-new`}
                      className="mx-2 my-1 inline-flex items-center gap-1 rounded-full bg-[#43A047] px-3 py-0.5 text-xs font-semibold text-white hover:bg-[#388E3C]"><Plus size={11} /> {newLabel}</button>
            )}
            {shown.map(o => (
              <button key={o.id} type="button" onClick={() => { onChange(o.id); setOpen(false); setQ(""); }} data-testid={`${testId}-option-${o.id}`}
                      className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100 ${o.id === value ? "bg-slate-50 font-semibold" : "text-slate-700"}`}>
                {o.label}{o.code && <span className="ml-1 text-[10px] text-slate-500">{o.code}</span>}
              </button>
            ))}
            {shown.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">No matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
};

export const DEFAULT_ITEMS = [
  ["Appear for/attend", "A109"], ["Communicate (in firm)", "A105"], ["Communicate (other external)", "A108"],
  ["Communicate (other outside counsel)", "A107"], ["Communicate (with client)", "A106"], ["Draft/revise", "A103"],
  ["Manage data/files", "A110"], ["No charge", ""], ["Other", "A111"], ["Plan and prepare for", "A101"],
  ["Research", "A102"], ["Review/analyze", "A104"],
].map(([label, code]) => ({ id: label, label, code }));

export const MiniModal = ({ title, onClose, children, testId }) => (
  <div className="fixed inset-0 z-[70] bg-black/40 flex items-start justify-center py-16 px-4" data-testid={testId}>
    <div className="w-full max-w-md rounded bg-white shadow-2xl">
      <div className="h-9 bg-[#1E88E5] rounded-t flex items-center justify-between px-3 text-white text-sm">
        <span className="inline-flex items-center gap-1 font-semibold"><Plus size={13} /> {title}</span>
        <button type="button" onClick={onClose} data-testid={`${testId}-close`}><X size={14} /></button>
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </div>
  </div>
);
