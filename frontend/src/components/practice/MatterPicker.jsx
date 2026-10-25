import { useState } from "react";
import { SearchSelect, MiniModal } from "@/components/practice/SearchSelect";
import { NewMatterModal } from "@/pages/PracticeNewMatter";

const inp = "w-full h-9 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";

export const MatterPicker = ({ value, onChange, matters, contactId, contacts = [], onCreated, onContactChange, testId = "practice-matter-picker" }) => {
  const [open, setOpen] = useState(false);
  const [cid, setCid] = useState("");
  const visible = matters.filter(m => !contactId || m.contact_id === contactId);

  return (
    <>
      <SearchSelect value={value} placeholder="Select Matter..." testId={testId} newLabel="New Matter" onNew={() => setOpen(true)}
                    options={visible.map(m => ({ id: m.id, label: m.name }))}
                    onChange={(id) => { onChange(id); const m = matters.find(x => x.id === id); if (m && !contactId) onContactChange?.(m.contact_id); }} />
      {open && !(contactId || cid) && (
        <MiniModal title="New Matter" onClose={() => setOpen(false)} testId={`${testId}-pick-contact`}>
          <div className="text-xs text-slate-600">Select the contact this matter belongs to:</div>
          <select autoFocus className={inp} value={cid} onChange={e => setCid(e.target.value)} data-testid={`${testId}-new-contact`}>
            <option value="">Select Contact...</option>{contacts.map(c => <option key={c.id} value={c.id}>{c.display_name}</option>)}
          </select>
          <button type="button" onClick={() => setOpen(false)} className="rounded border border-slate-300 px-4 py-1.5 text-sm text-slate-700">Cancel</button>
        </MiniModal>
      )}
      {open && (contactId || cid) && (
        <NewMatterModal contactId={contactId || cid} onClose={() => { setOpen(false); setCid(""); }}
                        onSaved={(m) => { onCreated?.(m); onChange(m.id); if (!contactId) onContactChange?.(cid); setOpen(false); setCid(""); }} />
      )}
    </>
  );
};
