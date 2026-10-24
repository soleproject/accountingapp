import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search, Plus, X } from "lucide-react";
import { ContactForm } from "@/pages/PracticeNewContact";

function NewContactModal({ onSaved, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-8 px-4" data-testid="practice-new-contact-modal">
      <div className="w-full max-w-3xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-end px-3">
          <button type="button" onClick={onClose} className="text-white" data-testid="practice-new-contact-modal-close"><X size={16} /></button>
        </div>
        <div className="p-4 bg-slate-50 rounded-b">
          <ContactForm compact onSaved={onSaved} onCancel={onClose} />
        </div>
      </div>
    </div>
  );
}

export const ContactPicker = ({ value, onChange, contacts, onCreated, testId = "practice-matter-contact" }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [modal, setModal] = useState(false);
  const ref = useRef(null);
  const current = contacts.find(c => c.id === value);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const shown = contacts.filter(c => (c.display_name + " " + (c.company_name || "")).toLowerCase().includes(q.toLowerCase()));

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(v => !v)} data-testid={testId}
              className="w-full h-10 rounded border border-slate-300 bg-white px-3 text-[15px] text-left flex items-center justify-between focus:border-[#1E88E5]">
        <span className={current ? "text-slate-700" : "text-slate-400"}>{current ? current.display_name : "Select Contact..."}</span>
        <ChevronDown size={14} className="text-slate-500" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-40 rounded border border-slate-300 bg-white shadow-lg" data-testid={`${testId}-panel`}>
          <div className="flex items-center gap-2 border-b border-slate-200 px-3">
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} data-testid={`${testId}-search`}
                   className="flex-1 h-9 text-sm outline-none bg-transparent" />
            <Search size={14} className="text-slate-500" />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            <button type="button" onClick={() => { setOpen(false); setModal(true); }} data-testid={`${testId}-new`}
                    className="mx-2 my-1 inline-flex items-center gap-1 rounded-full bg-[#43A047] px-3 py-0.5 text-xs font-semibold text-white hover:bg-[#388E3C]">
              <Plus size={11} /> New Contact
            </button>
            {shown.map(c => (
              <button key={c.id} type="button" onClick={() => { onChange(c.id); setOpen(false); setQ(""); }} data-testid={`${testId}-option-${c.id}`}
                      className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100 ${c.id === value ? "bg-slate-50 font-semibold" : "text-slate-700"}`}>
                {c.display_name}
              </button>
            ))}
            {shown.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">No contacts match.</div>}
          </div>
        </div>
      )}
      {modal && <NewContactModal onClose={() => setModal(false)} onSaved={(c) => { setModal(false); onCreated(c); onChange(c.id); }} />}
    </div>
  );
};
