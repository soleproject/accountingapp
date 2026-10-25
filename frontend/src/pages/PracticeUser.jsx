import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { UserPlus, Pencil, KeyRound, Calendar, Lock, Smartphone, Phone, User, ClipboardList, CalendarDays, MessageSquare, Filter, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { toISO, fmtTime } from "@/components/practice/DateTimePicker";
import { ContactsTable, MattersTable, TimeEntriesTable } from "@/components/practice/tables";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";

const fmtAt = (iso) => new Date(iso).toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function Agenda({ first }) {
  const nav = useNavigate();
  const [items, setItems] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const today = toISO(new Date());
  useEffect(() => {
    api.get("/practice/tasks", { params: { start: today, end: today } }).then(r => setItems(r.data)).catch(() => {});
    api.get("/practice/tasks", { params: { start: "2000-01-01", end: toISO(new Date(Date.now() - 86400000)) } })
      .then(r => setOverdue(r.data.filter(t => t.kind !== "event" && t.status !== "Completed"))).catch(() => {});
  }, [today]);
  const dueLabel = (d) => {
    const days = Math.round((new Date(today) - new Date(d)) / 86400000);
    return days === 1 ? "Yesterday" : new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  };
  const renderItem = (t, showDue) => (
    <li key={t.id} className="text-[13px] leading-[18px]" data-testid={`practice-user-agenda-${t.id}`}>
      <div className="flex items-center gap-1.5 text-[#1E88E5] font-semibold text-[15px]">{t.kind === "event" ? <CalendarDays size={14} /> : <ClipboardList size={14} />}{t.subject}</div>
      {showDue && <div className="text-slate-700 ml-6">{dueLabel(t.due_date)}</div>}
      {t.kind === "event" && !t.all_day && <div className="text-slate-700 ml-6">{fmtTime(t.start_time)} – {fmtTime(t.end_time)}</div>}
      {t.description && <div className="text-slate-700 ml-6">{t.description.replace(/<[^>]+>/g, "")}</div>}
      {(t.contact_name || t.matter_name) && <div className="ml-6 font-semibold text-slate-800">Re: {[t.contact_name, t.matter_name].filter(Boolean).join(" / ")}</div>}
    </li>
  );
  return (
    <section className="rounded border border-slate-200 bg-white px-4 py-4" data-testid="practice-user-agenda">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-bold uppercase tracking-wider text-slate-700">{first}'s Agenda</h2>
        <div className="flex gap-5 text-xs font-semibold uppercase tracking-wider text-slate-700">
          <button type="button" onClick={() => nav("/practice/calendar")} className="hover:text-[#1E88E5]" data-testid="practice-user-view-calendar">View Calendar ⊕</button>
          <button type="button" onClick={() => nav("/practice/calendar")} className="hover:text-[#1E88E5]" data-testid="practice-user-all-tasks">All Tasks ⊕</button>
        </div>
      </div>
      {overdue.length > 0 && (
        <div data-testid="practice-user-agenda-overdue">
          <div className="mt-5 text-[13px] font-bold uppercase tracking-wider text-slate-800">Overdue</div>
          <ul className="mt-4 space-y-4">{overdue.map(t => renderItem(t, true))}</ul>
        </div>
      )}
      <div className="mt-5 text-[13px] font-bold uppercase tracking-wider text-slate-800">Today</div>
      {items.length === 0 ? <div className="mt-3 text-[13px] text-slate-500">Nothing on the agenda today.</div> : (
        <ul className="mt-4 space-y-4">{items.map(t => renderItem(t, false))}</ul>
      )}
    </section>
  );
}

function Activity({ first, name }) {
  const nav = useNavigate();
  const [items, setItems] = useState(null);
  const [text, setText] = useState("");
  const load = () => api.get("/practice/activity").then(r => setItems(r.data)).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  const post = async () => {
    if (!text.trim()) return;
    try { await api.post("/practice/activity", { text }); setText(""); load(); } catch { toast.error("Could not save"); }
  };
  return (
    <section className="rounded border border-slate-200 bg-white" data-testid="practice-user-activity">
      <h2 className="px-4 pt-4 text-[13px] font-bold uppercase tracking-wider text-slate-700">{first}'s Activity</h2>
      <div className="flex items-stretch gap-2 px-3 py-4">
        <label className="flex-1 flex items-center gap-2 rounded border border-slate-300 bg-white px-3">
          <MessageSquare size={16} className="text-slate-400" />
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && post()} placeholder="What's new?" data-testid="practice-user-activity-input" className="flex-1 h-9 text-[15px] outline-none bg-transparent" />
          <Filter size={14} className="text-slate-400" /><ChevronDown size={14} className="text-slate-400" />
        </label>
        <button type="button" onClick={post} className="h-9 px-4 rounded bg-[#1E88E5] text-white text-sm font-semibold" data-testid="practice-user-activity-save">Save ›</button>
      </div>
      <ul>
        {(items || []).slice(0, 10).map((a, i) => (
          <li key={i} className={`flex gap-3 px-3 py-4 text-[13px] leading-[19px] ${i % 2 ? "bg-white" : "bg-slate-50"}`} data-testid="practice-user-activity-item">
            <span className="h-8 w-8 rounded-full bg-slate-300 grid place-items-center shrink-0"><User size={16} className="text-white fill-white" /></span>
            <div>
              <div><span className="font-semibold text-slate-800 text-[15px]">{name}</span> <span className="text-slate-400 text-[11px]">{fmtAt(a.at)}</span></div>
              {a.re?.length > 0 && <div className="text-slate-500">Re: {a.re.map((r, j) => <span key={j}>{j > 0 && " / "}{r.to ? <button type="button" onClick={() => nav(r.to)} className="text-[#1E88E5] hover:underline">{r.label}</button> : r.label}</span>)}</div>}
              <div className="text-slate-700">{a.text}</div>
            </div>
          </li>
        ))}
        {items && items.length === 0 && <li className="px-4 py-6 text-[13px] text-slate-500">No activity yet.</li>}
      </ul>
      <div className="flex items-center gap-3 px-4 py-3 border-t border-slate-200 text-xs uppercase tracking-wider text-slate-500">
        <span className="text-slate-300">« ‹</span><span className="text-slate-800 text-sm border-b border-slate-400 px-2">1</span><span className="text-slate-300">› »</span>
        <span className="ml-2 rounded-full border border-slate-300 px-2 py-0.5">10 ▾</span><span className="font-semibold">Items per page</span>
        <span className="flex-1 text-right">1 - {Math.min(10, items?.length || 0)} of {items?.length || 0} items</span>
      </div>
    </section>
  );
}

export default function PracticeUser() {
  const { user } = useAuth();
  const [profile, setProfile] = useState({});
  const [tab, setTab] = useState("Dashboard");
  useEffect(() => { api.get("/practice/profile").then(r => setProfile(r.data)).catch(() => {}); }, []);
  const name = user?.name || "";
  const first = name.split(" ")[0];
  const tabs = ["Dashboard", "Contacts", "Matters", "Time Entries"];

  return (
    <PracticeShell>
      <div className="space-y-4" data-testid="practice-user-page">
        <div className="flex items-center gap-3">
          <UserPlus size={32} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-[26px] font-bold text-slate-800">User - {name}</h1>
          <button type="button" className="text-slate-700" data-testid="practice-user-edit"><Pencil size={16} /></button>
          <div className="flex-1" />
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50" data-testid="practice-user-change-password"><KeyRound size={14} /> Change Your Password</button>
        </div>
        <section className="rounded border border-slate-200 bg-white px-4 py-4" data-testid="practice-user-card">
          <div className="flex items-center gap-3">
            <span className="h-12 w-12 rounded bg-slate-300 grid place-items-center"><User size={30} className="text-white fill-white" /></span>
            <div>
              <div className="flex items-center gap-2 text-xl font-semibold text-slate-800">{name} <span className="rounded bg-[#43A047] px-1.5 py-px text-[11px] font-bold text-white">Online</span></div>
              <div className="text-[13px] text-[#1E88E5]">{user?.email}</div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-6 text-[13px] text-slate-600">
            <span className="inline-flex items-center gap-1"><Calendar size={13} /> Last Seen: {fmtAt(new Date().toISOString())}</span>
            <span className="inline-flex items-center gap-1"><Lock size={13} /> Security Role: <span className="text-[#1E88E5]">Admin</span></span>
            {profile.mobile && <span className="inline-flex items-center gap-1"><Smartphone size={13} /> <span className="text-[#1E88E5]">{profile.mobile}</span></span>}
            {profile.office_phone && <span className="inline-flex items-center gap-1"><Phone size={13} /> <span className="text-[#1E88E5]">{profile.office_phone}</span></span>}
          </div>
        </section>
        <div className="flex border-b border-slate-200" data-testid="practice-user-tabs">
          {tabs.map(t => (
            <button key={t} type="button" onClick={() => setTab(t)} data-testid={`practice-user-tab-${t.toLowerCase().replace(/\s+/g, "-")}`}
                    className={`-mb-px px-3 py-2.5 text-sm border ${tab === t ? "border-slate-200 border-b-white bg-white text-slate-900 font-medium rounded-t" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{first}'s {t}</button>
          ))}
        </div>
        {tab === "Dashboard" ? <div className="space-y-4"><Agenda first={first} /><Activity first={first} name={name} /></div>
          : <UserTabList key={tab} tab={tab} />}
      </div>
    </PracticeShell>
  );
}

function UserTabList({ tab }) {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [track, setTrack] = useState(null);
  const url = { Contacts: "/practice/contacts?status=All", Matters: "/practice/matters?status=All", "Time Entries": "/practice/time-entries/all" }[tab];
  const load = () => api.get(url).then(r => setRows(r.data)).catch(() => setRows([]));
  useEffect(() => { setRows(null); load(); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = () => toast.success("Item saved successfully.");
  const setStatus = async (r, st) => { try { await api.patch(`/practice/time-entries/${r.id}/status`, { status: st }); saved(); load(); } catch { toast.error("Could not update"); } };
  const clone = async (r) => { try { await api.post(`/practice/time-entries/${r.id}/clone`); saved(); load(); } catch { toast.error("Could not clone"); } };
  return (
    <section className="rounded border border-slate-200 bg-white overflow-hidden" data-testid={`practice-user-list-${tab.toLowerCase().replace(/\s+/g, "-")}`}>
      {rows === null ? <div className="p-6 text-[13px] text-slate-500">Loading…</div> : rows.length === 0 ? <div className="p-6 text-[13px] text-slate-500">Nothing here yet.</div>
        : tab === "Contacts" ? <ContactsTable rows={rows} nav={nav} />
        : tab === "Matters" ? <MattersTable rows={rows} nav={nav} onTrackTime={setTrack} />
        : <TimeEntriesTable rows={rows} nav={nav} onEdit={setEdit} onStatus={setStatus} onClone={clone} />}
      {edit && <NewTimeEntryModal entry={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {track && <NewTimeEntryModal task={{ contact_id: track.contact_id, matter_id: track.id }} onClose={() => setTrack(null)} onSaved={() => setTrack(null)} />}
    </section>
  );
}
