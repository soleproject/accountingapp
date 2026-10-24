import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Check, Move, Play, Calendar } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { toISO } from "@/components/practice/DateTimePicker";

const inp = "w-full h-9 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";
const Row = ({ label, required, help, sub, children }) => (
  <div className="grid grid-cols-[160px_1fr] items-start gap-3 py-1.5">
    <div className="text-[12px] font-semibold uppercase tracking-wide text-slate-800 pt-2 flex items-center gap-1">
      {help && <span className="h-3.5 w-3.5 rounded-full bg-slate-400 text-white text-[9px] font-bold grid place-items-center">?</span>}{label}{sub && <span className="text-[10px] text-slate-500 normal-case">({sub})</span>}{required && <span className="text-red-500">*</span>}
    </div>
    <div>{children}</div>
  </div>
);
const Toggle = ({ value, onChange, testId }) => (
  <button type="button" onClick={() => onChange(!value)} data-testid={testId}
          className={`h-7 w-14 rounded border text-xs font-semibold flex items-center ${value ? "bg-[#1E88E5] border-[#1E88E5] text-white justify-start pl-2" : "bg-white border-slate-300 text-slate-700 justify-end pr-2"}`}>{value ? "Yes" : "No"}</button>
);
const Card = ({ title, children }) => <section className="rounded border border-slate-200 bg-white px-5 py-4"><h3 className="text-base font-bold uppercase tracking-wide text-slate-800 mb-2">{title}</h3>{children}</section>;

const ITEMS = ["Consultation", "Research", "Drafting", "Court Appearance", "Phone Call", "Email", "Meeting", "Other"];

export const NewTimeEntryModal = ({ task, onSaved, onClose }) => {
  const { user } = useAuth();
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    contact_id: task?.contact_id || "", matter_id: task?.matter_id || "", item: "", hours_raw: "", date: task?.due_date || toISO(new Date()),
    description: task ? [task.subject, (task.description || "").replace(/<[^>]+>/g, "")].filter(Boolean).join("\n") : "",
    billable: true, billed_by: user?.name || "", hourly_rate: 0, private_notes: "",
  });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));
  const hours = parseHours(f.hours_raw);
  const total = f.billable && hours ? hours * Number(f.hourly_rate || 0) : 0;

  useEffect(() => {
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
    api.get("/practice/profile").then(r => setF(p => ({ ...p, hourly_rate: r.data.hourly_rate || 0 }))).catch(() => {});
  }, []);

  const save = async () => {
    if (!f.contact_id) return toast.error("Select a contact.");
    if (!f.matter_id) return toast.error("Select a matter.");
    if (!hours) return toast.error("Enter hours like 1h 10m, 1:10 or 1.2h");
    setBusy(true);
    try {
      const r = await api.post("/practice/time-entries", { ...f, task_id: task?.id || null, hours, hourly_rate: Number(f.hourly_rate || 0), total });
      toast.success("Time entry saved");
      onSaved(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save time entry"); } finally { setBusy(false); }
  };

  const visibleMatters = matters.filter(m => !f.contact_id || m.contact_id === f.contact_id);

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4" data-testid="practice-time-entry-modal">
      <div className="w-full max-w-xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> New Time Entry</span>
          <span className="inline-flex items-center gap-3"><Move size={13} /><button type="button" onClick={onClose} data-testid="practice-time-entry-close"><X size={16} /></button></span>
        </div>
        <div className="p-4 bg-slate-50 space-y-3 rounded-b">
          <Card title="Linked To">
            <Row label="Contact" required><ContactPicker value={f.contact_id} onChange={(id) => setF(p => ({ ...p, contact_id: id, matter_id: "" }))} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-te-contact" /></Row>
            <Row label="Matter" required>
              <select className={inp} value={f.matter_id} onChange={set("matter_id")} data-testid="practice-te-matter">
                <option value="">Select Matter...</option>{visibleMatters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Row>
          </Card>
          <Card title="Time Entries">
            <Row label="Item" help><select className={inp} value={f.item} onChange={set("item")} data-testid="practice-te-item"><option value="">Select Item...</option>{ITEMS.map(i => <option key={i}>{i}</option>)}</select></Row>
            <Row label="Hours" required>
              <input className={inp} placeholder="Format: 1h 10m, 1:10, 1.2h" value={f.hours_raw} onChange={set("hours_raw")} data-testid="practice-te-hours" />
              <button type="button" className="mt-1.5 w-full h-8 rounded bg-[#1E88E5] text-white text-sm font-semibold inline-flex items-center justify-center gap-1.5" data-testid="practice-te-start-timer"><Play size={12} className="fill-white" /> Start Timer</button>
            </Row>
            <Row label="Date"><div className="relative"><input type="date" className={inp} value={f.date} onChange={set("date")} data-testid="practice-te-date" /><Calendar size={14} className="absolute right-9 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none hidden" /></div></Row>
            <Row label="Description" help><textarea rows={4} className={`${inp} !h-auto py-2`} value={f.description} onChange={set("description")} data-testid="practice-te-description" /></Row>
          </Card>
          <Card title="Billing">
            <Row label="Billable" help><Toggle value={f.billable} onChange={set("billable")} testId="practice-te-billable" /></Row>
            <Row label="Billed By"><select className={inp} value={f.billed_by} onChange={set("billed_by")} data-testid="practice-te-billed-by"><option>{user?.name}</option></select></Row>
            <Row label="Hourly Rate" sub="USD" help><input type="number" step="0.01" className={inp} value={f.hourly_rate} onChange={set("hourly_rate")} data-testid="practice-te-rate" /></Row>
            <Row label="Total" sub="USD"><input readOnly className={`${inp} bg-slate-50`} value={total.toFixed(2)} data-testid="practice-te-total" /></Row>
            <Row label="Private Notes" help><input className={inp} placeholder="Add private notes..." value={f.private_notes} onChange={set("private_notes")} data-testid="practice-te-private-notes" /></Row>
          </Card>
          <div className="flex items-center gap-2 pt-1 whitespace-nowrap">
            <button type="button" onClick={save} disabled={busy} data-testid="practice-te-save-btn" className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Check size={14} /> Save</button>
            <button type="button" onClick={save} disabled={busy} data-testid="practice-te-save-timer-btn" className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Play size={12} className="fill-white" /> Save and Start Timer</button>
            <button type="button" onClick={onClose} data-testid="practice-te-cancel-btn" className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"><X size={14} /> Cancel</button>
            <div className="flex-1" />
            <button type="button" className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-te-multiple-btn"><Plus size={14} /> Multiple Time Entries</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export function parseHours(raw) {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes(":")) { const [h, m] = s.split(":"); return (Number(h) || 0) + (Number(m) || 0) / 60; }
  const h = s.match(/([\d.]+)\s*h/), m = s.match(/([\d.]+)\s*m/);
  if (h || m) return (h ? Number(h[1]) : 0) + (m ? Number(m[1]) : 0) / 60;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
