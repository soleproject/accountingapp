import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Check, Calculator, Move, Trash2, User } from "lucide-react";
import { RichNotes } from "@/components/practice/RichNotes";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { MatterPicker } from "@/components/practice/MatterPicker";
import { DateTimePicker, toISO } from "@/components/practice/DateTimePicker";

export const inp = "w-full h-9 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";
export const Help = ({ text }) => (
  <span className="relative group inline-flex">
    <span className="h-3.5 w-3.5 rounded-full bg-slate-400 text-white text-[9px] font-bold grid place-items-center cursor-help">?</span>
    <span className="pointer-events-none absolute left-0 top-full mt-1 z-50 hidden group-hover:block w-40 rounded bg-slate-900 px-2 py-1.5 text-[11px] font-semibold normal-case tracking-normal text-white text-center shadow-lg">{text}</span>
  </span>
);
export const Row = ({ label, required, help, children }) => (
  <div className="grid grid-cols-[150px_1fr] items-start gap-3 py-1.5">
    <div className="text-[12px] font-semibold uppercase tracking-wide text-slate-800 pt-2 flex items-center gap-1">{help && <Help text={help} />}{label}{required && <span className="text-red-500">*</span>}</div>
    <div>{children}</div>
  </div>
);
const METHODS = ["Email", "Popup", "Text Message"];
const UNITS = ["Minute(s)", "Hour(s)", "Day(s)", "Week(s)"];
const selCls = "h-8 rounded border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none";

export function Reminders({ list, onChange }) {
  const upd = (i, k, v) => onChange(list.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="space-y-1.5 pt-0.5" data-testid="practice-task-reminders">
      {list.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5" data-testid={`practice-task-reminder-${i}`}>
          <select className={`${selCls} w-28`} value={r.method} onChange={e => upd(i, "method", e.target.value)} data-testid={`practice-task-reminder-${i}-method`}>{METHODS.map(m => <option key={m}>{m}</option>)}</select>
          <input type="number" min="0" className={`${selCls} w-14`} value={r.amount} onChange={e => upd(i, "amount", Number(e.target.value))} data-testid={`practice-task-reminder-${i}-amount`} />
          <select className={`${selCls} w-24`} value={r.unit} onChange={e => upd(i, "unit", e.target.value)} data-testid={`practice-task-reminder-${i}-unit`}>{UNITS.map(u => <option key={u}>{u}</option>)}</select>
          <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} className="text-[#1E88E5]" data-testid={`practice-task-reminder-${i}-remove`}><Trash2 size={13} /></button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, { method: "Popup", amount: 10, unit: "Minute(s)" }])} className="text-sm text-slate-600 inline-flex items-center gap-1 pt-1" data-testid="practice-task-add-reminder"><Plus size={12} /> Add a reminder</button>
    </div>
  );
}

export function UserPicker({ selected, options, onChange }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const shown = options.filter(o => !selected.includes(o) && o.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="relative">
      <div className={`${inp} !h-auto min-h-9 flex items-center gap-2 flex-wrap py-1`} data-testid="practice-task-users">
        {selected.map(u => (
          <span key={u} className="inline-flex items-center gap-1 text-sm text-slate-700">
            <span className="h-5 w-5 rounded-full bg-slate-300 grid place-items-center"><User size={12} className="text-white fill-white" /></span>{u}
            <button type="button" onClick={() => onChange(selected.filter(x => x !== u))} data-testid={`practice-task-user-remove-${u.replace(/\s+/g, "-")}`}><X size={12} /></button>
          </span>
        ))}
        <input value={q} onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
               className="flex-1 min-w-[60px] outline-none text-sm bg-transparent placeholder:text-slate-400" placeholder={selected.length ? "" : "Select Users..."} data-testid="practice-task-users-input" />
        {q && <button type="button" onClick={() => setQ("")} className="text-slate-500"><X size={12} /></button>}
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded border border-slate-300 bg-white shadow-lg" data-testid="practice-task-users-panel">
          <div className="bg-slate-100 px-3 py-1 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-600">Users</div>
          {shown.length === 0 ? <div className="py-8 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">No data found.</div>
            : shown.map(o => <button key={o} type="button" onMouseDown={() => { onChange([...selected, o]); setQ(""); }} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100" data-testid={`practice-task-user-option-${o.replace(/\s+/g, "-")}`}>{o}</button>)}
        </div>
      )}
    </div>
  );
}
export const Toggle = ({ value, onChange, testId }) => (
  <button type="button" onClick={() => onChange(!value)} data-testid={testId}
          className={`h-7 w-14 rounded border text-xs font-semibold flex items-center ${value ? "bg-[#1E88E5] border-[#1E88E5] text-white justify-start pl-2" : "bg-white border-slate-300 text-slate-700 justify-end pr-2"}`}>{value ? "Yes" : "No"}</button>
);
export const Card = ({ title, children }) => <section className="rounded border border-slate-200 bg-white px-5 py-4">{title && <h3 className="text-base font-bold uppercase tracking-wide text-slate-800 mb-2">{title}</h3>}{children}</section>;

export const NewTaskModal = ({ defaultDate, task, onSaved, onClose, defaults = {} }) => {
  const { user } = useAuth();
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState(() => task ? { ...task, contact_id: task.contact_id || "", matter_id: task.matter_id || "", due_time: task.due_time || "09:00", tags: (task.tags || []).join(", ") } : {
    contact_id: "", matter_id: "", subject: "", due_date: toISO(defaultDate || new Date()), due_time: "09:00", all_day: true,
    status: "Not Completed", description: "", private: false, priority: "Medium", repeat: "Never",
    assigned_users: [user?.name].filter(Boolean), assigned_contacts: "", tags: "", email_assignees: true,
    reminders: [], save_reminders: true, ...defaults,
  });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));

  useEffect(() => {
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
    if (!task) api.get("/practice/tasks/reminder-defaults").then(r => { if (r.data?.length) setF(p => ({ ...p, reminders: r.data })); }).catch(() => {});
  }, [task]);

  const save = async () => {
    if (!f.subject.trim()) return toast.error("Subject is required.");
    if (f.assigned_users.length === 0) return toast.error("Assign at least one user.");
    setBusy(true);
    try {
      const payload = { ...f, contact_id: f.contact_id || null, matter_id: f.matter_id || null,
        due_time: f.all_day ? null : f.due_time, tags: f.tags.split(",").map(t => t.trim()).filter(Boolean) };
      const r = task ? await api.put(`/practice/tasks/${task.id}`, payload) : await api.post("/practice/tasks", payload);
      toast.success("Task saved");
      onSaved(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save task"); } finally { setBusy(false); }
  };


  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4" data-testid="practice-new-task-modal">
      <div className="w-full max-w-xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> {task ? "Edit Task" : "New Task"}</span>
          <span className="inline-flex items-center gap-3"><span className="inline-flex items-center gap-1 text-xs"><Calculator size={13} /> Date Calculator</span><Move size={13} className="cursor-move" />
            <button type="button" onClick={onClose} data-testid="practice-new-task-close"><X size={16} /></button></span>
        </div>
        <div className="p-4 bg-slate-50 space-y-3 rounded-b">
          <Card title="Linked To">
            <Row label="Contact"><ContactPicker value={f.contact_id} onChange={(id) => setF(p => ({ ...p, contact_id: id, matter_id: "" }))} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-task-contact" /></Row>
            <Row label="Matter">
              <MatterPicker value={f.matter_id} onChange={set("matter_id")} matters={matters} contactId={f.contact_id} contacts={contacts}
                            onCreated={(m) => setMatters(l => [m, ...l])} onContactChange={(id) => setF(p => ({ ...p, contact_id: id }))} testId="practice-task-matter" />
            </Row>
          </Card>
          <Card title="Task">
            <Row label="Subject" required><input className={inp} placeholder="Add Subject..." value={f.subject} onChange={set("subject")} data-testid="practice-task-subject" /></Row>
            <Row label="Due Date"><DateTimePicker date={f.due_date} time={f.due_time} allDay={f.all_day} onDate={set("due_date")} onTime={set("due_time")} testId="practice-task-due" /></Row>
            <Row label="All Day?"><Toggle value={f.all_day} onChange={set("all_day")} testId="practice-task-allday" /></Row>
            <Row label="Status"><select className={inp} value={f.status} onChange={set("status")} data-testid="practice-task-status"><option>Not Completed</option><option>Completed</option><option>In Progress</option></select></Row>
            <Row label="Description"><RichNotes value={f.description} onChange={set("description")} testId="practice-task-description" placeholder="Add description..." minHeight={140} /></Row>
          </Card>
          <Card>
            <Row label="Reminders"><Reminders list={f.reminders} onChange={set("reminders")} /></Row>
            {f.reminders.length > 0 && <Row label="Save Reminders" help="Save these reminders to automatically set them on your next task."><Toggle value={f.save_reminders} onChange={set("save_reminders")} testId="practice-task-save-reminders" /></Row>}
            <Row label="Private" help="Click here to hide the details of this event, task or note from other users in your firm."><Toggle value={f.private} onChange={set("private")} testId="practice-task-private" /></Row>
            <Row label="Priority"><select className={inp} value={f.priority} onChange={set("priority")} data-testid="practice-task-priority"><option>Low</option><option>Medium</option><option>High</option></select></Row>
            <Row label="Repeat"><select className={inp} value={f.repeat} onChange={set("repeat")} data-testid="practice-task-repeat">{["Never", "Daily", "Weekly", "Monthly", "Yearly"].map(o => <option key={o}>{o}</option>)}</select></Row>
            <Row label="Assigned To" help="Users and contacts who will see this task on their calendar.">
              <div className="text-xs font-semibold text-slate-700 mb-1">Users <span className="text-red-500">*</span></div>
              <UserPicker selected={f.assigned_users} options={[user?.name].filter(Boolean)} onChange={set("assigned_users")} />
              <div className="text-xs font-semibold text-slate-700 mt-2 mb-1">Contacts</div>
              <input className={inp} placeholder="Select Contacts..." value={f.assigned_contacts} onChange={set("assigned_contacts")} data-testid="practice-task-contacts" />
            </Row>
            <Row label="Tags" help="Tags help you group and filter tasks."><input className={inp} value={f.tags} onChange={set("tags")} data-testid="practice-task-tags" /></Row>
            <Row label="Attachments"><input type="file" multiple className="text-sm pt-1.5" data-testid="practice-task-attachments" /></Row>
            <Row label="Email Assignees" help="Send an email to the assigned users when this task is saved."><Toggle value={f.email_assignees} onChange={set("email_assignees")} testId="practice-task-email" /></Row>
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
