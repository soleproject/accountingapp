import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Check, Calculator, Move, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { DateTimePicker, toISO, fmtTime } from "@/components/practice/DateTimePicker";
import { inp, Row, Toggle, Card, Reminders, UserPicker } from "@/components/practice/NewTaskModal";

const SWATCHES = ["#1E88E5", "#43A047", "#8E24AA", "#FB8C00", "#E53935"];
const addHour = (t) => { const [h, m] = t.split(":").map(Number); return `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`; };
const fmtDT = (d, t) => { const [y, m, dd] = d.split("-"); return `${Number(m)}/${Number(dd)}/${y}${t ? ` ${fmtTime(t)}` : ""}`; };

function ColorField({ value, onChange }) {
  const [custom, setCustom] = useState(!SWATCHES.includes(value));
  return (
    <div className="flex items-center gap-3 pt-1" data-testid="practice-event-color">
      {custom ? (
        <label className="inline-flex items-center rounded border border-slate-300 overflow-hidden h-7">
          <input type="color" value={value} onChange={e => onChange(e.target.value)} className="h-9 w-9 -m-1 cursor-pointer border-0 p-0" data-testid="practice-event-color-custom" />
          <span className="px-1.5 text-xs text-slate-700">{value}</span><ChevronDown size={12} className="mr-1 text-slate-500" />
        </label>
      ) : (
        <div className="inline-flex rounded overflow-hidden border border-slate-300">
          {SWATCHES.map(c => (
            <button key={c} type="button" onClick={() => onChange(c)} data-testid={`practice-event-swatch-${c.slice(1)}`}
                    className={`h-6 w-6 ${value === c ? "ring-2 ring-inset ring-white outline outline-2 outline-slate-600" : ""}`} style={{ backgroundColor: c }} />
          ))}
        </div>
      )}
      <button type="button" onClick={() => setCustom(v => !v)} className="text-sm text-[#1E88E5]" data-testid="practice-event-color-toggle">{custom ? "Basic Colors" : "Custom Colors"}</button>
    </div>
  );
}

export const NewEventModal = ({ defaultDate, event, onSaved, onClose }) => {
  const { user } = useAuth();
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [busy, setBusy] = useState(false);
  const d0 = toISO(defaultDate || new Date());
  const [f, setF] = useState(() => event ? { ...event, contact_id: event.contact_id || "", matter_id: event.matter_id || "", start_time: event.start_time || "10:00", end_time: event.end_time || "11:00", tags: (event.tags || []).join(", ") } : {
    contact_id: "", matter_id: "", subject: "", start_date: d0, start_time: "10:00", end_date: d0, end_time: "11:00", all_day: false, description: "",
    reminders: [{ method: "Popup", amount: 10, unit: "Minute(s)" }, { method: "Popup", amount: 10, unit: "Minute(s)" }],
    private: false, location: "", color: "#1E88E5", priority: "Medium", repeat: "Never",
    assigned_users: [user?.name].filter(Boolean), assigned_contacts: "", tags: "", email_assignees: true,
  });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));
  const setStart = (k) => (v) => setF(p => {
    const n = { ...p, [k]: v };
    if (k === "start_date" && p.end_date < v) n.end_date = v;
    if (k === "start_time" && p.start_date === p.end_date && p.end_time <= v) n.end_time = addHour(v);
    return n;
  });

  useEffect(() => {
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
  }, []);
  useEffect(() => {
    api.get("/practice/events/conflicts", { params: { date: f.start_date, start: f.all_day ? "00:00" : f.start_time, end: f.all_day ? "23:59" : f.end_time, exclude: event?.id } })
      .then(r => setConflicts(r.data)).catch(() => setConflicts([]));
  }, [f.start_date, f.start_time, f.end_time, f.all_day, event?.id]);

  const save = async () => {
    if (!f.subject.trim()) return toast.error("Subject is required.");
    if (f.assigned_users.length === 0) return toast.error("Add at least one user.");
    setBusy(true);
    try {
      const payload = { ...f, contact_id: f.contact_id || null, matter_id: f.matter_id || null, tags: f.tags.split(",").map(t => t.trim()).filter(Boolean) };
      const r = event ? await api.put(`/practice/events/${event.id}`, payload) : await api.post("/practice/events", payload);
      toast.success("Event saved"); onSaved(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save event"); } finally { setBusy(false); }
  };

  const visibleMatters = matters.filter(m => !f.contact_id || m.contact_id === f.contact_id);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4" data-testid="practice-new-event-modal">
      <div className="w-full max-w-xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> {event ? "Edit Event" : "New Event"}</span>
          <span className="inline-flex items-center gap-3"><span className="inline-flex items-center gap-1 text-xs"><Calculator size={13} /> Date Calculator</span><Move size={13} />
            <button type="button" onClick={onClose} data-testid="practice-new-event-close"><X size={16} /></button></span>
        </div>
        <div className="p-4 bg-slate-50 space-y-3 rounded-b">
          <Card title="Linked To">
            <Row label="Contact"><ContactPicker value={f.contact_id} onChange={(id) => setF(p => ({ ...p, contact_id: id, matter_id: "" }))} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-event-contact" /></Row>
            <Row label="Matter">
              <select className={inp} value={f.matter_id} onChange={set("matter_id")} data-testid="practice-event-matter">
                <option value="">Select Matter...</option>{visibleMatters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Row>
          </Card>
          <Card title="Event">
            <Row label="Subject" required><input className={inp} placeholder="Add Subject..." value={f.subject} onChange={set("subject")} data-testid="practice-event-subject" /></Row>
            <Row label="Start"><DateTimePicker date={f.start_date} time={f.start_time} allDay={f.all_day} onDate={setStart("start_date")} onTime={setStart("start_time")} testId="practice-event-start" /></Row>
            <Row label="End"><DateTimePicker date={f.end_date} time={f.end_time} allDay={f.all_day} onDate={set("end_date")} onTime={set("end_time")} testId="practice-event-end" /></Row>
            <Row label="All Day?"><Toggle value={f.all_day} onChange={set("all_day")} testId="practice-event-allday" /></Row>
            {conflicts.length > 0 && (
              <Row label="Conflicts">
                <div className="space-y-1" data-testid="practice-event-conflicts">
                  {conflicts.map(c => (
                    <div key={c.id} className="rounded bg-red-50 px-3 py-1.5 text-sm text-slate-700">
                      {(c.assigned_users || [])[0] || user?.name} - {fmtDT(f.start_date, c.all_day ? null : c.start_time)} - <span className="text-[#1E88E5]">{c.subject}</span>
                    </div>
                  ))}
                </div>
              </Row>
            )}
            <Row label="Description"><input className={inp} placeholder="Add description..." value={f.description} onChange={set("description")} data-testid="practice-event-description" /></Row>
          </Card>
          <Card>
            <Row label="Reminders"><Reminders list={f.reminders} onChange={set("reminders")} /></Row>
            <Row label="Private" help="Click here to hide the details of this event, task or note from other users in your firm."><Toggle value={f.private} onChange={set("private")} testId="practice-event-private" /></Row>
            <Row label="Location"><input className={inp} placeholder="Add location..." value={f.location} onChange={set("location")} data-testid="practice-event-location" /></Row>
            <Row label="Color" help="The color this event shows on the calendar."><ColorField value={f.color} onChange={set("color")} /></Row>
            <Row label="Priority"><select className={inp} value={f.priority} onChange={set("priority")} data-testid="practice-event-priority"><option>Low</option><option>Medium</option><option>High</option></select></Row>
            <Row label="Repeat"><select className={inp} value={f.repeat} onChange={set("repeat")} data-testid="practice-event-repeat">{["Never", "Daily", "Weekly", "Monthly", "Yearly"].map(o => <option key={o}>{o}</option>)}</select></Row>
            <Row label="Attendees" help="Users and contacts invited to this event.">
              <div className="text-xs font-semibold text-slate-700 mb-1">Users <span className="text-red-500">*</span></div>
              <UserPicker selected={f.assigned_users} options={[user?.name].filter(Boolean)} onChange={set("assigned_users")} />
              <div className="text-xs font-semibold text-slate-700 mt-2 mb-1">Contacts</div>
              <input className={inp} placeholder="Select Contacts..." value={f.assigned_contacts} onChange={set("assigned_contacts")} data-testid="practice-event-contacts" />
            </Row>
            <Row label="Tags" help="Tags help you group and filter events."><input className={inp} value={f.tags} onChange={set("tags")} data-testid="practice-event-tags" /></Row>
            <Row label="Attachments"><input type="file" multiple className="text-sm pt-1.5" data-testid="practice-event-attachments" /></Row>
            <Row label="Email Assignees" help="Send an email to the attendees when this event is saved."><Toggle value={f.email_assignees} onChange={set("email_assignees")} testId="practice-event-email" /></Row>
          </Card>
          <div className="flex items-center gap-2 pt-1 whitespace-nowrap">
            <button type="button" onClick={save} disabled={busy} data-testid="practice-event-save-btn" className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Check size={14} /> Save</button>
            <button type="button" onClick={save} disabled={busy} data-testid="practice-event-save-time-btn" className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Plus size={14} /> Save and add time entry</button>
            <button type="button" onClick={onClose} data-testid="practice-event-cancel-btn" className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"><X size={14} /> Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
};
