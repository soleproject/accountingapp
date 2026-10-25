import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Plus, Check, X, Trash2, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";

const inp = "w-full h-8 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";
const sel = "h-8 rounded border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none";
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const Section = ({ title, children, testId }) => <section className="rounded border border-slate-200 bg-white px-6 py-5 space-y-3" data-testid={testId}><h2 className="text-base font-bold uppercase tracking-wide text-slate-800">{title}</h2>{children}</section>;
const Row = ({ label, required, children }) => <div className="grid grid-cols-[190px_1fr] items-center gap-3"><div className="text-[12px] font-semibold uppercase tracking-wide text-slate-800">{label}{required && <span className="text-red-500">*</span>}</div><div className="max-w-xl">{children}</div></div>;
const Pill = ({ children, onClick, testId }) => <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded-full bg-[#1E88E5] px-3 py-1 text-xs font-semibold text-white hover:bg-[#1976D2]" data-testid={testId}><Plus size={12} /> {children}</button>;
const Card = ({ children, onDelete, testId }) => (
  <div className="rounded border border-slate-200 px-4 py-4 space-y-2.5" data-testid={testId}>
    {children}
    <button type="button" className="text-xs font-semibold uppercase tracking-wide text-[#1E88E5]" data-testid={`${testId}-more`}>More Options</button>
    <div><button type="button" onClick={onDelete} className="inline-flex items-center gap-1 text-xs text-[#1E88E5] hover:underline" data-testid={`${testId}-delete`}><Trash2 size={11} /> Delete</button></div>
  </div>
);

const newEvent = () => ({ id: uid(), subject: "", description: "", private: false, assigned_users: [], tags: [] });
const newTask = () => ({ id: uid(), subject: "", description: "", due_mode: "No due date.", due_n: 1, due_unit: "Business Days", due_dir: "After", due_field: "Due Date", due_anchor: "", priority: "Medium", private: false, assigned_users: [], tags: [] });

function DueDate({ t, anchors, onChange }) {
  const set = (k) => (e) => onChange({ ...t, [k]: e.target.type === "number" ? Number(e.target.value) : e.target.value });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select className={`${sel} w-32`} value={t.due_mode} onChange={set("due_mode")} data-testid={`practice-wf-task-${t.id}-mode`}><option>No due date.</option><option>Automatically</option></select>
      {t.due_mode === "Automatically" && <>
        <input type="number" min="0" className={`${sel} w-28`} value={t.due_n} onChange={set("due_n")} data-testid={`practice-wf-task-${t.id}-n`} />
        <select className={`${sel} w-32`} value={t.due_unit} onChange={set("due_unit")}>{["Business Days", "Calendar Days", "Weeks", "Months"].map(o => <option key={o}>{o}</option>)}</select>
        <select className={`${sel} w-20`} value={t.due_dir} onChange={set("due_dir")}><option>After</option><option>Before</option></select>
        <select className={`${sel} w-28`} value={t.due_field} onChange={set("due_field")}><option>Due Date</option><option>Start Date</option></select>
        <select className={`${sel} w-56`} value={t.due_anchor} onChange={set("due_anchor")} data-testid={`practice-wf-task-${t.id}-anchor`}><option value="">Select...</option>{anchors.map(a => <option key={a.id} value={a.id}>{a.subject || "(untitled)"}</option>)}</select>
      </>}
    </div>
  );
}

export default function PracticeWorkflowEdit() {
  const { id } = useParams();
  const nav = useNavigate();
  const [f, setF] = useState(id ? null : { name: "", description: "", permissions: "Share this workflow with all users", events: [], tasks: [] });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (id) api.get(`/practice/workflows/${id}`).then(r => setF(r.data)).catch(() => { toast.error("Workflow not found"); nav("/practice/workflows"); }); }, [id, nav]);
  if (!f) return <PracticeShell withRail={false}><div className="p-6 text-sm text-slate-500">Loading…</div></PracticeShell>;
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }));
  const upd = (coll, i, patch) => setF(p => ({ ...p, [coll]: p[coll].map(x => x.id === i.id ? { ...x, ...patch } : x) }));
  const rm = (coll, i) => setF(p => ({ ...p, [coll]: p[coll].filter(x => x.id !== i.id) }));
  const save = async (addNew) => {
    if (!f.name.trim()) return toast.error("Workflow name is required.");
    setBusy(true);
    try {
      if (id) await api.put(`/practice/workflows/${id}`, f); else await api.post("/practice/workflows", f);
      toast.success("Item saved successfully.");
      nav(addNew ? "/practice/workflows/new" : "/practice/workflows");
      if (addNew && !id) setF({ name: "", description: "", permissions: "Share this workflow with all users", events: [], tasks: [] });
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save workflow"); } finally { setBusy(false); }
  };
  const g = "inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60";
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-workflow-edit">
        <div className="flex items-center gap-3"><Workflow size={26} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-2xl font-bold text-slate-800">{id ? "Edit Workflow" : "New Workflow"}</h1></div>
        <Section title="Workflow" testId="practice-wf-main">
          <Row label="Workflow Name" required><input className={inp} placeholder="Add Name..." value={f.name} onChange={set("name")} data-testid="practice-wf-name" /></Row>
          <Row label="Workflow Description"><input className={inp} placeholder="Add description..." value={f.description} onChange={set("description")} data-testid="practice-wf-description" /></Row>
          <Row label="Workflow Permissions"><select className={`${sel} w-full`} value={f.permissions} onChange={set("permissions")} data-testid="practice-wf-permissions"><option>Share this workflow with all users</option><option>Only I can see this workflow</option></select></Row>
        </Section>
        <Section title={`Workflow Events (${f.events.length})`} testId="practice-wf-events">
          {f.events.map(ev => (
            <Card key={ev.id} onDelete={() => rm("events", ev)} testId={`practice-wf-event-${ev.id}`}>
              <Row label="Event Subject" required><input className={inp} placeholder="Add Subject..." value={ev.subject} onChange={e => upd("events", ev, { subject: e.target.value })} data-testid={`practice-wf-event-${ev.id}-subject`} /></Row>
              <Row label="Event Description"><input className={inp} placeholder="Add description..." value={ev.description} onChange={e => upd("events", ev, { description: e.target.value })} /></Row>
            </Card>
          ))}
          <Pill onClick={() => setF(p => ({ ...p, events: [...p.events, newEvent()] }))} testId="practice-wf-new-event">New Event</Pill>
        </Section>
        <Section title={`Workflow Tasks (${f.tasks.length})`} testId="practice-wf-tasks">
          {f.tasks.map((t, idx) => (
            <Card key={t.id} onDelete={() => rm("tasks", t)} testId={`practice-wf-task-${t.id}`}>
              <Row label="Task Subject" required><input className={inp} placeholder="Add Subject..." value={t.subject} onChange={e => upd("tasks", t, { subject: e.target.value })} data-testid={`practice-wf-task-${t.id}-subject`} /></Row>
              <Row label="Task Description"><input className={inp} placeholder="Add description..." value={t.description} onChange={e => upd("tasks", t, { description: e.target.value })} /></Row>
              <div className="grid grid-cols-[190px_1fr] items-center gap-3"><div className="text-[12px] font-semibold uppercase tracking-wide text-slate-800">Due Date{t.due_mode === "Automatically" && <span className="text-red-500">*</span>}</div>
                <DueDate t={t} anchors={[...f.events, ...f.tasks.slice(0, idx)]} onChange={(nt) => upd("tasks", t, nt)} /></div>
            </Card>
          ))}
          <Pill onClick={() => setF(p => ({ ...p, tasks: [...p.tasks, newTask()] }))} testId="practice-wf-new-task">New Task</Pill>
        </Section>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => save(false)} disabled={busy} className={g} data-testid="practice-wf-save"><Check size={14} /> Save</button>
          <button type="button" onClick={() => save(true)} disabled={busy} className={g} data-testid="practice-wf-save-new"><Check size={14} /> Save & Add New</button>
          <button type="button" onClick={() => nav("/practice/workflows")} className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-wf-cancel"><X size={14} /> Cancel</button>
        </div>
      </div>
    </PracticeShell>
  );
}
