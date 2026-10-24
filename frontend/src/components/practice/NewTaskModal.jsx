import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Check, Calculator } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { DateTimePicker, toISO } from "@/components/practice/DateTimePicker";

const inp = "w-full h-9 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";
const Row = ({ label, required, help, children }) => (
  <div className="grid grid-cols-[150px_1fr] items-start gap-3 py-1.5">
    <div className="text-[12px] font-semibold uppercase tracking-wide text-slate-800 pt-2 flex items-center gap-1">{help && <span className="text-slate-400">?</span>}{label}{required && <span className="text-red-500">*</span>}</div>
    <div>{children}</div>
  </div>
);
const Toggle = ({ value, onChange, testId }) => (
  <button type="button" onClick={() => onChange(!value)} data-testid={testId}
          className={`h-7 w-14 rounded border text-xs font-semibold flex items-center ${value ? "bg-[#1E88E5] border-[#1E88E5] text-white justify-start pl-2" : "bg-white border-slate-300 text-slate-700 justify-end pr-2"}`}>{value ? "Yes" : "No"}</button>
);
const Card = ({ title, children }) => <section className="rounded border border-slate-200 bg-white px-5 py-4">{title && <h3 className="text-base font-bold uppercase tracking-wide text-slate-800 mb-2">{title}</h3>}{children}</section>;

export const NewTaskModal = ({ defaultDate, onSaved, onClose }) => {
  const { user } = useAuth();
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    contact_id: "", matter_id: "", subject: "", due_date: toISO(defaultDate || new Date()), due_time: "09:00", all_day: true,
    status: "Not Completed", description: "", private: false, priority: "Medium", repeat: "Never",
    assigned_users: [user?.name].filter(Boolean), assigned_contacts: "", tags: "", email_assignees: true,
  });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));

  useEffect(() => {
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
  }, []);

  const save = async () => {
    if (!f.subject.trim()) return toast.error("Subject is required.");
    setBusy(true);
    try {
      const r = await api.post("/practice/tasks", { ...f, contact_id: f.contact_id || null, matter_id: f.matter_id || null,
        due_time: f.all_day ? null : f.due_time, tags: f.tags.split(",").map(t => t.trim()).filter(Boolean) });
      toast.success("Task saved");
      onSaved(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save task"); } finally { setBusy(false); }
  };

  const visibleMatters = matters.filter(m => !f.contact_id || m.contact_id === f.contact_id);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4" data-testid="practice-new-task-modal">
      <div className="w-full max-w-xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> New Task</span>
          <span className="inline-flex items-center gap-3"><span className="inline-flex items-center gap-1 text-xs"><Calculator size={13} /> Date Calculator</span>
            <button type="button" onClick={onClose} data-testid="practice-new-task-close"><X size={16} /></button></span>
        </div>
        <div className="p-4 bg-slate-50 space-y-3 rounded-b">
          <Card title="Linked To">
            <Row label="Contact"><ContactPicker value={f.contact_id} onChange={(id) => setF(p => ({ ...p, contact_id: id, matter_id: "" }))} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-task-contact" /></Row>
            <Row label="Matter">
              <select className={inp} value={f.matter_id} onChange={set("matter_id")} data-testid="practice-task-matter">
                <option value="">Select Matter...</option>{visibleMatters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Row>
          </Card>
          <Card title="Task">
            <Row label="Subject" required><input className={inp} placeholder="Add Subject..." value={f.subject} onChange={set("subject")} data-testid="practice-task-subject" /></Row>
            <Row label="Due Date"><DateTimePicker date={f.due_date} time={f.due_time} allDay={f.all_day} onDate={set("due_date")} onTime={set("due_time")} testId="practice-task-due" /></Row>
            <Row label="All Day?"><Toggle value={f.all_day} onChange={set("all_day")} testId="practice-task-allday" /></Row>
            <Row label="Status"><select className={inp} value={f.status} onChange={set("status")} data-testid="practice-task-status"><option>Not Completed</option><option>Completed</option><option>In Progress</option></select></Row>
            <Row label="Description"><input className={inp} placeholder="Add description..." value={f.description} onChange={set("description")} data-testid="practice-task-description" /></Row>
          </Card>
          <Card>
            <Row label="Reminders"><button type="button" className="pt-2 text-sm text-slate-600 inline-flex items-center gap-1" data-testid="practice-task-add-reminder"><Plus size={12} /> Add a reminder</button></Row>
            <Row label="Private" help><Toggle value={f.private} onChange={set("private")} testId="practice-task-private" /></Row>
            <Row label="Priority"><select className={inp} value={f.priority} onChange={set("priority")} data-testid="practice-task-priority"><option>Low</option><option>Medium</option><option>High</option></select></Row>
            <Row label="Repeat"><select className={inp} value={f.repeat} onChange={set("repeat")} data-testid="practice-task-repeat">{["Never", "Daily", "Weekly", "Monthly", "Yearly"].map(o => <option key={o}>{o}</option>)}</select></Row>
            <Row label="Assigned To" help>
              <div className="text-xs font-semibold text-slate-700 mb-1">Users <span className="text-red-500">*</span></div>
              <div className={`${inp} flex items-center gap-2 flex-wrap`} data-testid="practice-task-users">
                {f.assigned_users.map(u => <span key={u} className="inline-flex items-center gap-1 text-sm">{u}<button type="button" onClick={() => setF(p => ({ ...p, assigned_users: p.assigned_users.filter(x => x !== u) }))}><X size={12} /></button></span>)}
                {f.assigned_users.length === 0 && <button type="button" className="text-sm text-[#1E88E5]" onClick={() => setF(p => ({ ...p, assigned_users: [user?.name] }))} data-testid="practice-task-assign-me">Assign to me</button>}
              </div>
              <div className="text-xs font-semibold text-slate-700 mt-2 mb-1">Contacts</div>
              <input className={inp} placeholder="Select Contacts..." value={f.assigned_contacts} onChange={set("assigned_contacts")} data-testid="practice-task-contacts" />
            </Row>
            <Row label="Tags" help><input className={inp} value={f.tags} onChange={set("tags")} data-testid="practice-task-tags" /></Row>
            <Row label="Attachments"><input type="file" multiple className="text-sm pt-1.5" data-testid="practice-task-attachments" /></Row>
            <Row label="Email Assignees" help><Toggle value={f.email_assignees} onChange={set("email_assignees")} testId="practice-task-email" /></Row>
          </Card>
          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={save} disabled={busy} data-testid="practice-task-save-btn" className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Check size={14} /> Save</button>
            <button type="button" onClick={save} disabled={busy} data-testid="practice-task-save-time-btn" className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Plus size={14} /> Save and add time entry</button>
            <button type="button" onClick={onClose} data-testid="practice-task-cancel-btn" className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"><X size={14} /> Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
};
