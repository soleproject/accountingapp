import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Check, Move, Play, Square } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { RichNotes } from "@/components/practice/RichNotes";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { MatterPicker } from "@/components/practice/MatterPicker";
import { DateTimePicker, toISO } from "@/components/practice/DateTimePicker";
import { inp, Row, Card, Toggle, UserPicker } from "@/components/practice/NewTaskModal";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";

const nowTime = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const fmtDur = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return m ? `${h}h ${m}m` : `${h}h`; };

function Frame({ title, kind, onClose, children, testId }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4" data-testid={testId}>
      <div className="w-full max-w-xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> {title}</span>
          <span className="inline-flex items-center gap-3"><Move size={13} className="cursor-move" /><button type="button" onClick={onClose} data-testid={`practice-${kind}-close`}><X size={16} /></button></span>
        </div>
        <div className="p-4 bg-slate-50 space-y-3 rounded-b">{children}</div>
      </div>
    </div>
  );
}

function useLinked(f, setF) {
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  useEffect(() => {
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
  }, []);
  return (testId) => (
    <Card title="Linked To">
      <Row label="Contact"><ContactPicker value={f.contact_id} onChange={(id) => setF(p => ({ ...p, contact_id: id, matter_id: "" }))} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId={`${testId}-contact`} /></Row>
      <Row label="Matter"><MatterPicker value={f.matter_id} onChange={(v) => setF(p => ({ ...p, matter_id: v }))} matters={matters} contactId={f.contact_id} contacts={contacts} onCreated={(m) => setMatters(l => [m, ...l])} onContactChange={(id) => setF(p => ({ ...p, contact_id: id }))} testId={`${testId}-matter`} /></Row>
    </Card>
  );
}

function Buttons({ kind, busy, onSave, onClose }) {
  const g = "inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60";
  return (
    <div className="flex items-center gap-2 pt-1">
      <button type="button" onClick={() => onSave(false)} disabled={busy} className={g} data-testid={`practice-${kind}-save-btn`}><Check size={14} /> Save</button>
      <button type="button" onClick={() => onSave(true)} disabled={busy} className={g} data-testid={`practice-${kind}-save-time-btn`}><Plus size={14} /> Save and add time entry</button>
      <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" data-testid={`practice-${kind}-cancel-btn`}><X size={14} /> Cancel</button>
    </div>
  );
}

const useSave = (kind, item, f, onSaved, extra = {}) => {
  const [busy, setBusy] = useState(false);
  const [timeFor, setTimeFor] = useState(null);
  const save = async (addTime) => {
    if (!f.subject.trim()) return toast.error("Subject is required.");
    setBusy(true);
    try {
      const payload = { ...f, ...extra, contact_id: f.contact_id || null, matter_id: f.matter_id || null, tags: (f.tags || "").split(",").map(t => t.trim()).filter(Boolean) };
      const r = item ? await api.put(`/practice/${kind}s/${item.id}`, payload) : await api.post(`/practice/${kind}s`, payload);
      toast.success("Item saved successfully.");
      if (addTime) setTimeFor(r.data); else onSaved(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save"); } finally { setBusy(false); }
  };
  return { busy, save, timeFor, setTimeFor };
};

export const NewNoteModal = ({ note, defaults = {}, onSaved, onClose }) => {
  const [f, setF] = useState(() => note ? { ...note, contact_id: note.contact_id || "", matter_id: note.matter_id || "", tags: (note.tags || []).join(", ") }
    : { contact_id: "", matter_id: "", subject: "", private: false, description: "", due_date: toISO(new Date()), due_time: nowTime(), tags: "", ...defaults });
  const set = (k) => (v) => setF(p => ({ ...p, [k]: v?.target ? v.target.value : v }));
  const linked = useLinked(f, setF);
  const { busy, save, timeFor, setTimeFor } = useSave("note", note, f, onSaved);
  if (timeFor) return <NewTimeEntryModal task={timeFor} onClose={() => onSaved(timeFor)} onSaved={() => onSaved(timeFor)} />;
  return (
    <Frame title={note ? "Edit Note" : "New Note"} kind="note" onClose={onClose} testId="practice-new-note-modal">
      {linked("practice-note")}
      <Card title="Note">
        <Row label="Subject" required><input className={inp} placeholder="Add Subject..." value={f.subject} onChange={set("subject")} data-testid="practice-note-subject" /></Row>
        <Row label="Private" help="Hide the details of this note from other users in your firm."><Toggle value={f.private} onChange={set("private")} testId="practice-note-private" /></Row>
        <Row label="Note"><RichNotes value={f.description} onChange={set("description")} testId="practice-note-body" placeholder="" minHeight={180} alwaysOpen /></Row>
        <Row label="Date/Time"><DateTimePicker date={f.due_date} time={f.due_time} allDay={false} onDate={set("due_date")} onTime={set("due_time")} testId="practice-note-dt" /></Row>
        <Row label="Tags" help="Tags help you group and filter notes."><input className={inp} value={f.tags} onChange={set("tags")} data-testid="practice-note-tags" /></Row>
        <Row label="Attachments"><input type="file" multiple className="text-sm pt-1.5" data-testid="practice-note-attachments" /></Row>
      </Card>
      <Buttons kind="note" busy={busy} onSave={save} onClose={onClose} />
      {timeFor && null}
    </Frame>
  );
};

export const NewCallModal = ({ call, defaults = {}, onSaved, onClose }) => {
  const { user } = useAuth();
  const [f, setF] = useState(() => call ? { ...call, contact_id: call.contact_id || "", matter_id: call.matter_id || "", tags: (call.tags || []).join(", ") }
    : { contact_id: "", matter_id: "", subject: "", call_type: "Inbound", due_date: toISO(new Date()), due_time: nowTime(), duration: "", description: "", private: false,
        assigned_users: [user?.name].filter(Boolean), assigned_contacts: "", tags: "", ...defaults });
  const set = (k) => (v) => setF(p => ({ ...p, [k]: v?.target ? v.target.value : v }));
  const linked = useLinked(f, setF);
  const [timer, setTimer] = useState(null);
  const [base, setBase] = useState(0);
  const [secs, setSecs] = useState(0);
  useEffect(() => { if (!timer) return; const id = setInterval(() => setSecs(base + Math.floor((Date.now() - timer) / 1000)), 1000); return () => clearInterval(id); }, [timer, base]);
  useEffect(() => { if (timer || secs) setF(p => ({ ...p, duration: fmtDur(secs) })); }, [secs]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleTimer = () => { if (timer) { setBase(secs); setTimer(null); } else { setTimer(Date.now()); } };
  const clock = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(n => String(n).padStart(2, "0")).join(":");
  const { busy, save, timeFor } = useSave("call", call, f, onSaved);
  if (timeFor) return <NewTimeEntryModal task={timeFor} onClose={() => onSaved(timeFor)} onSaved={() => onSaved(timeFor)} />;
  return (
    <Frame title={call ? "Edit Call" : "New Call"} kind="call" onClose={onClose} testId="practice-new-call-modal">
      {linked("practice-call")}
      <Card title="Call">
        <Row label="Subject" required><input className={inp} placeholder="Add Subject..." value={f.subject} onChange={set("subject")} data-testid="practice-call-subject" /></Row>
        <Row label="Call Type"><select className={inp} value={f.call_type} onChange={set("call_type")} data-testid="practice-call-type"><option>Inbound</option><option>Outbound</option><option>Missed</option></select></Row>
        <Row label="Date/Time"><DateTimePicker date={f.due_date} time={f.due_time} allDay={false} onDate={set("due_date")} onTime={set("due_time")} testId="practice-call-dt" /></Row>
        <Row label="Call Duration">
          <input className={inp} placeholder="Format: 1h 10m, 1:10, 1.2h" value={f.duration} onChange={set("duration")} data-testid="practice-call-duration" />
          <button type="button" onClick={toggleTimer} className="mt-1.5 w-full h-8 rounded bg-[#1E88E5] text-sm font-semibold text-white inline-flex items-center justify-center gap-1.5 hover:bg-[#1976D2]" data-testid="practice-call-timer">
            {timer ? <><Square size={12} className="fill-white" /> Pause Timer</> : <><Play size={13} /> {secs ? "Resume Timer" : "Start Timer"}</>}
          </button>
          {(timer || secs > 0) && <div className="pt-2 text-center text-4xl font-light tabular-nums text-slate-700" data-testid="practice-call-clock">{clock(secs)}</div>}
        </Row>
        <Row label="Description"><input className={inp} placeholder="Add description..." value={f.description} onChange={set("description")} data-testid="practice-call-description" /></Row>
      </Card>
      <Card>
        <Row label="Private" help="Hide the details of this call from other users in your firm."><Toggle value={f.private} onChange={set("private")} testId="practice-call-private" /></Row>
        <Row label="Participants">
          <div className="text-xs font-semibold text-slate-700 mb-1">Users <span className="text-red-500">*</span></div>
          <UserPicker selected={f.assigned_users} options={[user?.name].filter(Boolean)} onChange={set("assigned_users")} />
          <div className="text-xs font-semibold text-slate-700 mt-2 mb-1">Contacts</div>
          <input className={inp} placeholder="Select Contacts..." value={f.assigned_contacts} onChange={set("assigned_contacts")} data-testid="practice-call-contacts" />
        </Row>
        <Row label="Tags" help="Tags help you group and filter calls."><input className={inp} value={f.tags} onChange={set("tags")} data-testid="practice-call-tags" /></Row>
        <Row label="Attachments"><input type="file" multiple className="text-sm pt-1.5" data-testid="practice-call-attachments" /></Row>
      </Card>
      <Buttons kind="call" busy={busy} onSave={save} onClose={onClose} />
    </Frame>
  );
};
