import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Plus, X, Check, Move, Play, Calendar, Square } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { toISO } from "@/components/practice/DateTimePicker";
import { SearchSelect, DEFAULT_ITEMS } from "@/components/practice/SearchSelect";
import { NewItemModal } from "@/components/practice/NewItemModal";
import { MatterPicker } from "@/components/practice/MatterPicker";

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


export const NewTimeEntryModal = ({ task, entry, timerSeconds = 0, timerNotes = "", onSaved, onClose }) => {
  const { user } = useAuth();
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  const [busy, setBusy] = useState(false);
  const [customItems, setCustomItems] = useState([]);
  const items = [...DEFAULT_ITEMS, ...customItems.map(i => ({ id: i.id, label: i.name, code: i.code, price: i.price, use_item_price: i.use_item_price }))];
  const [newItem, setNewItem] = useState(null);
  const [f, setF] = useState(entry ? { ...entry, hours_raw: entry.hours_raw || String(entry.hours), private_notes: entry.private_notes || "" } : {
    contact_id: task?.contact_id || "", matter_id: task?.matter_id || "", item: "", hours_raw: timerSeconds ? fmtHours(timerSeconds) : "", date: task?.due_date || toISO(new Date()),
    description: task?.subject ? [task.subject, (task.description || "").replace(/<[^>]+>/g, "")].filter(Boolean).join("\n") : timerNotes,
    billable: true, billed_by: user?.name || "", hourly_rate: 0, private_notes: "",
  });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));
  const nav = useNavigate();
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(timerSeconds);
  const startRef = useRef(null);
  useEffect(() => {
    if (!running) return;
    const base = elapsed; startRef.current = Date.now();
    const t = setInterval(() => {
      const secs = base + Math.floor((Date.now() - startRef.current) / 1000);
      setElapsed(secs);
      setF(p => ({ ...p, hours_raw: fmtHours(secs) }));
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  const timerUsed = elapsed > 0 || running;
  const hours = timerUsed ? elapsed / 3600 : parseHours(f.hours_raw);
  const total = f.billable && hours ? hours * Number(f.hourly_rate || 0) : 0;

  useEffect(() => {
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
    if (!entry) api.get("/practice/profile").then(r => setF(p => ({ ...p, hourly_rate: r.data.hourly_rate || 0 }))).catch(() => {});
    api.get("/practice/items").then(r => setCustomItems(r.data)).catch(() => {});
  }, [entry]);
  const pickItem = (id) => {
    const it = items.find(i => i.id === id);
    setF(p => ({ ...p, item: id, ...(it?.use_item_price ? { hourly_rate: it.price } : {}) }));
  };
  const matter = matters.find(m => m.id === f.matter_id);

  const save = async () => {
    if (!f.contact_id) return toast.error("Select a contact.");
    if (!f.matter_id) return toast.error("Select a matter.");
    if (hours === null || (!timerUsed && !hours)) return toast.error("Enter hours like 1h 10m, 1:10 or 1.2h");
    setRunning(false);
    setBusy(true);
    try {
      const payload = { ...f, task_id: task?.id || f.task_id || null, hours: Math.round(hours * 10000) / 10000, hourly_rate: Number(f.hourly_rate || 0), total };
      const r = entry ? await api.put(`/practice/time-entries/${entry.id}`, payload) : await api.post("/practice/time-entries", payload);
      toast.info("Item saved successfully.", { action: { label: "Go to time entry", onClick: () => nav("/practice/time-entries") }, duration: 6000 });
      onSaved(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save time entry"); } finally { setBusy(false); }
  };


  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4" data-testid="practice-time-entry-modal">
      <div className="w-full max-w-xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> {entry ? "Edit Time Entry" : "New Time Entry"}</span>
          <span className="inline-flex items-center gap-3"><Move size={13} /><button type="button" onClick={onClose} data-testid="practice-time-entry-close"><X size={16} /></button></span>
        </div>
        <div className="p-4 bg-slate-50 space-y-3 rounded-b">
          <Card title="Linked To">
            <Row label="Contact" required><ContactPicker value={f.contact_id} onChange={(id) => setF(p => ({ ...p, contact_id: id, matter_id: "" }))} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-te-contact" /></Row>
            <Row label="Matter" required>
              <MatterPicker value={f.matter_id} onChange={set("matter_id")} matters={matters} contactId={f.contact_id} contacts={contacts}
                            onCreated={(m) => setMatters(l => [m, ...l])} onContactChange={(id) => setF(p => ({ ...p, contact_id: id }))} testId="practice-te-matter" />
            </Row>
          </Card>
          <Card title="Time Entries">
            <Row label="Item" help>
              <SearchSelect value={f.item} onChange={pickItem} placeholder="Select Item..." testId="practice-te-item" clearable
                            options={items} newLabel="New Item" onNew={() => setNewItem(true)} />
            </Row>
            <Row label="Hours" required>
              <input className={inp} placeholder="Format: 1h 10m, 1:10, 1.2h" value={f.hours_raw} readOnly={timerUsed} onChange={set("hours_raw")} data-testid="practice-te-hours" />
              <button type="button" onClick={() => setRunning(r => !r)} className="mt-1.5 w-full h-8 rounded bg-[#1E88E5] text-white text-sm font-semibold inline-flex items-center justify-center gap-1.5" data-testid="practice-te-start-timer">
                {running ? <><Square size={11} className="fill-white" /> Pause Timer</> : <><Play size={12} className="fill-white" /> {elapsed > 0 ? "Resume Timer" : "Start Timer"}</>}
              </button>
              {timerUsed && <div className="mt-1 text-center text-3xl font-light text-slate-700 tabular-nums" data-testid="practice-te-timer-display">{fmtClock(elapsed)}</div>}
            </Row>
            <Row label="Date"><div className="relative"><input type="date" className={inp} value={f.date} onChange={set("date")} data-testid="practice-te-date" /><Calendar size={14} className="absolute right-9 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none hidden" /></div></Row>
            <Row label="Description" help><textarea rows={4} className={`${inp} !h-auto py-2`} value={f.description} onChange={set("description")} data-testid="practice-te-description" /></Row>
          </Card>
          <Card title="Billing">
            <Row label="Billable" help><Toggle value={f.billable} onChange={set("billable")} testId="practice-te-billable" /></Row>
            <Row label="Billed By"><select className={inp} value={f.billed_by} onChange={set("billed_by")} data-testid="practice-te-billed-by"><option>{user?.name}</option></select></Row>
            <Row label="Hourly Rate" sub="USD" help>
              <input type="number" step="0.01" className={inp} value={f.hourly_rate} onChange={set("hourly_rate")} data-testid="practice-te-rate" />
              {matter && (matter.matter_rate === "User Hourly Rate" || !matter.matter_rate) && <p className="mt-1 text-xs text-slate-500" data-testid="practice-te-rate-hint">This matter is set to the default user rate.</p>}
            </Row>
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
      {newItem && <NewItemModal onClose={() => setNewItem(false)} onSaved={(it) => { setCustomItems(l => [...l, it]); setNewItem(false); setF(p => ({ ...p, item: it.id, ...(it.use_item_price ? { hourly_rate: it.price } : {}) })); }} />}
    </div>
  );
};

const fmtClock = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(n => String(n).padStart(2, "0")).join(":");
const fmtHours = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return m ? `${h}h ${m}m` : `${h}h`; };

export function parseHours(raw) {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes(":")) { const [h, m] = s.split(":"); return (Number(h) || 0) + (Number(m) || 0) / 60; }
  const h = s.match(/([\d.]+)\s*h/), m = s.match(/([\d.]+)\s*m/);
  if (h || m) return (h ? Number(h[1]) : 0) + (m ? Number(m[1]) : 0) / 60;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
