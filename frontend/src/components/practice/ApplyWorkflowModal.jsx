import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Workflow, X, Check, CalendarDays, ClipboardList } from "lucide-react";
import { api } from "@/lib/api";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { MatterPicker } from "@/components/practice/MatterPicker";
import { DateTimePicker, toISO } from "@/components/practice/DateTimePicker";
import { inp, Row, Card } from "@/components/practice/NewTaskModal";

export const ApplyWorkflowModal = ({ contactId = "", matterId = "", onClose, onApplied }) => {
  const [workflows, setWorkflows] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  const [wfId, setWfId] = useState("");
  const [link, setLink] = useState({ contact_id: contactId, matter_id: matterId });
  const [dates, setDates] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/practice/workflows").then(r => setWorkflows(r.data)).catch(() => {});
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
  }, []);
  const wf = workflows.find(w => w.id === wfId);
  const today = toISO(new Date());
  const ed = (id) => dates[id] || { date: today, start_time: "10:00", end_time: "11:00" };
  const setEd = (id, patch) => setDates(d => ({ ...d, [id]: { ...ed(id), ...patch } }));
  const apply = async () => {
    if (!wf) return toast.error("Select a workflow.");
    if (!link.contact_id && !link.matter_id) return toast.error("Link the workflow to a contact or matter.");
    setBusy(true);
    try {
      const r = await api.post(`/practice/workflows/${wf.id}/apply`, { ...link, event_dates: Object.fromEntries((wf.events || []).map(e => [e.id, ed(e.id)])) });
      toast.success(`Workflow applied: ${r.data.events} event(s) and ${r.data.tasks} task(s) created.`);
      onApplied?.(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not apply workflow"); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4" data-testid="practice-apply-workflow-modal">
      <div className="w-full max-w-xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1.5 font-semibold"><Workflow size={14} /> Apply Workflow</span>
          <button type="button" onClick={onClose} data-testid="practice-apply-workflow-close"><X size={16} /></button>
        </div>
        <div className="p-4 bg-slate-50 space-y-3 rounded-b">
          <Card title="Workflow">
            <Row label="Workflow" required>
              <select className={inp} value={wfId} onChange={e => setWfId(e.target.value)} data-testid="practice-apply-workflow-select">
                <option value="">Select Workflow...</option>{workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Row>
            {wf && <div className="text-xs text-slate-500 pl-[162px]">{wf.events?.length || 0} event(s), {wf.tasks?.length || 0} task(s){wf.description ? ` — ${wf.description}` : ""}</div>}
          </Card>
          <Card title="Linked To">
            <Row label="Contact"><ContactPicker value={link.contact_id} onChange={(id) => setLink({ contact_id: id, matter_id: "" })} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-apply-workflow-contact" /></Row>
            <Row label="Matter"><MatterPicker value={link.matter_id} onChange={(id) => setLink(p => ({ ...p, matter_id: id }))} matters={matters} contactId={link.contact_id} contacts={contacts} onCreated={(m) => setMatters(l => [m, ...l])} onContactChange={(id) => setLink(p => ({ ...p, contact_id: id }))} testId="practice-apply-workflow-matter" /></Row>
          </Card>
          {wf && (wf.events || []).length > 0 && (
            <Card title="Event Dates">
              <p className="text-xs text-slate-500 mb-2">Task due dates are calculated from these event dates.</p>
              {wf.events.map(e => (
                <Row key={e.id} label={<span className="inline-flex items-center gap-1 normal-case tracking-normal"><CalendarDays size={12} /> {e.subject}</span>}>
                  <DateTimePicker date={ed(e.id).date} time={ed(e.id).start_time} allDay={false} onDate={(v) => setEd(e.id, { date: v, end_date: v })} onTime={(v) => setEd(e.id, { start_time: v })} testId={`practice-apply-workflow-event-${e.id}`} />
                </Row>
              ))}
            </Card>
          )}
          {wf && (wf.tasks || []).length > 0 && (
            <Card title="Tasks To Be Created">
              <ul className="space-y-1 text-sm text-slate-700" data-testid="practice-apply-workflow-tasks">
                {wf.tasks.map(t => <li key={t.id} className="inline-flex items-center gap-1.5 w-full"><ClipboardList size={12} className="text-slate-400" /> {t.subject}<span className="ml-auto text-xs text-slate-500">{t.due_mode === "Automatically" ? `${t.due_n} ${t.due_unit} ${(t.due_dir || "After").toLowerCase()} ${[...(wf.events || []), ...wf.tasks].find(a => a.id === t.due_anchor)?.subject || "kickoff"}` : "no due date"}</span></li>)}
              </ul>
            </Card>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={apply} disabled={busy} className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60" data-testid="practice-apply-workflow-save"><Check size={14} /> Apply Workflow</button>
            <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-apply-workflow-cancel"><X size={14} /> Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
};
