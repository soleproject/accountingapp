import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { SearchSelect, MiniModal } from "@/components/practice/SearchSelect";

const inp = "w-full h-9 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";

export const MatterPicker = ({ value, onChange, matters, contactId, contacts = [], onCreated, onContactChange, testId = "practice-matter-picker" }) => {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [cid, setCid] = useState("");
  const visible = matters.filter(m => !contactId || m.contact_id === contactId);
  const contactName = contacts.find(c => c.id === (contactId || cid))?.display_name;

  const create = async () => {
    const contact = contactId || cid;
    if (!contact) return toast.error("Select a contact for the matter.");
    if (!name.trim()) return toast.error("Matter name is required.");
    try {
      const r = await api.post("/practice/matters", { contact_id: contact, name: name.trim(), assigned_to: user?.name || "" });
      onCreated?.(r.data); onChange(r.data.id); if (!contactId) onContactChange?.(contact);
      setOpen(false); setName(""); setCid(""); toast.success("Matter created");
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not create matter"); }
  };

  return (
    <>
      <SearchSelect value={value} placeholder="Select Matter..." testId={testId} newLabel="New Matter" onNew={() => setOpen(true)}
                    options={visible.map(m => ({ id: m.id, label: m.name }))}
                    onChange={(id) => { onChange(id); const m = matters.find(x => x.id === id); if (m && !contactId) onContactChange?.(m.contact_id); }} />
      {open && (
        <MiniModal title="New Matter" onClose={() => setOpen(false)} testId={`${testId}-new-modal`}>
          {contactId ? <div className="text-xs text-slate-600">Contact: <span className="font-semibold text-slate-800">{contactName}</span></div> : (
            <select className={inp} value={cid} onChange={e => setCid(e.target.value)} data-testid={`${testId}-new-contact`}>
              <option value="">Select Contact...</option>{contacts.map(c => <option key={c.id} value={c.id}>{c.display_name}</option>)}
            </select>
          )}
          <input autoFocus className={inp} placeholder="Matter Name..." value={name} onChange={e => setName(e.target.value)} data-testid={`${testId}-new-name`} />
          <div className="flex gap-2">
            <button type="button" onClick={create} data-testid={`${testId}-new-save`} className="rounded bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white">Save</button>
            <button type="button" onClick={() => setOpen(false)} className="rounded border border-slate-300 px-4 py-1.5 text-sm text-slate-700">Cancel</button>
          </div>
        </MiniModal>
      )}
    </>
  );
};
