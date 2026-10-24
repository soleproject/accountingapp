import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { UserPlus, Pencil, KeyRound, Calendar, Lock, Smartphone, Phone, User, ClipboardList, CalendarDays, MessageSquare, Filter, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { toISO, fmtTime } from "@/components/practice/DateTimePicker";

const fmtAt = (iso) => new Date(iso).toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function Agenda({ first }) {
  const nav = useNavigate();
  const [items, setItems] = useState([]);
  const today = toISO(new Date());
  useEffect(() => { api.get("/practice/tasks", { params: { start: today, end: today } }).then(r => setItems(r.data)).catch(() => {}); }, [today]);
  return (
    <section className="rounded border border-slate-200 bg-white px-4 py-3" data-testid="practice-user-agenda">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">{first}'s Agenda</h2>
        <div className="flex gap-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
          <button type="button" onClick={() => nav("/practice/calendar")} className="hover:text-[#1E88E5]" data-testid="practice-user-view-calendar">View Calendar ⊕</button>
          <button type="button" onClick={() => nav("/practice/calendar")} className="hover:text-[#1E88E5]" data-testid="practice-user-all-tasks">All Tasks ⊕</button>
        </div>
      </div>
      <div className="mt-3 text-[10px] font-bold uppercase tracking-wider text-slate-700">Today</div>
      {items.length === 0 ? <div className="mt-2 text-xs text-slate-500">Nothing on the agenda today.</div> : (
        <ul className="mt-2 space-y-3">
          {items.map(t => (
            <li key={t.id} className="text-xs" data-testid={`practice-user-agenda-${t.id}`}>
              <div className="flex items-center gap-1.5 text-[#1E88E5] font-semibold text-sm">{t.kind === "event" ? <CalendarDays size={12} /> : <ClipboardList size={12} />}{t.subject}</div>
              {t.kind === "event" && !t.all_day && <div className="text-slate-600 ml-5">{fmtTime(t.start_time)} – {fmtTime(t.end_time)}</div>}
              {t.description && <div className="text-slate-600 ml-5">{t.description.replace(/<[^>]+>/g, "")}</div>}
              {(t.contact_name || t.matter_name) && <div className="ml-5 font-semibold text-slate-800">Re: {[t.contact_name, t.matter_name].filter(Boolean).join(" / ")}</div>}
            </li>
          ))}
        </ul>
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
      <h2 className="px-4 pt-3 text-xs font-bold uppercase tracking-wider text-slate-700">{first}'s Activity</h2>
      <div className="flex items-stretch gap-2 px-4 py-3">
        <label className="flex-1 flex items-center gap-2 rounded border border-slate-300 bg-white px-3">
          <MessageSquare size={14} className="text-slate-400" />
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && post()} placeholder="What's new?" data-testid="practice-user-activity-input" className="flex-1 h-8 text-sm outline-none bg-transparent" />
          <Filter size={12} className="text-slate-400" /><ChevronDown size={12} className="text-slate-400" />
        </label>
        <button type="button" onClick={post} className="h-8 px-3 rounded bg-[#1E88E5] text-white text-xs font-semibold" data-testid="practice-user-activity-save">Save ›</button>
      </div>
      <ul>
        {(items || []).slice(0, 10).map((a, i) => (
          <li key={i} className={`flex gap-3 px-4 py-3 text-xs ${i % 2 ? "bg-white" : "bg-slate-50"}`} data-testid="practice-user-activity-item">
            <span className="h-7 w-7 rounded-full bg-slate-300 grid place-items-center shrink-0"><User size={14} className="text-white fill-white" /></span>
            <div>
              <div><span className="font-semibold text-slate-800">{name}</span> <span className="text-slate-400">{fmtAt(a.at)}</span></div>
              {a.re?.length > 0 && <div className="text-slate-500">Re: {a.re.map((r, j) => <span key={j}>{j > 0 && " / "}{r.to ? <button type="button" onClick={() => nav(r.to)} className="text-[#1E88E5] hover:underline">{r.label}</button> : r.label}</span>)}</div>}
              <div className="text-slate-700">{a.text}</div>
            </div>
          </li>
        ))}
        {items && items.length === 0 && <li className="px-4 py-6 text-xs text-slate-500">No activity yet.</li>}
      </ul>
      <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-200 text-[10px] uppercase tracking-wider text-slate-500">
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
          <UserPlus size={28} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-2xl font-bold text-slate-800">User - {name}</h1>
          <button type="button" className="text-slate-700" data-testid="practice-user-edit"><Pencil size={14} /></button>
          <div className="flex-1" />
          <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50" data-testid="practice-user-change-password"><KeyRound size={12} /> Change Your Password</button>
        </div>
        <section className="rounded border border-slate-200 bg-white px-4 py-3" data-testid="practice-user-card">
          <div className="flex items-center gap-3">
            <span className="h-10 w-10 rounded bg-slate-300 grid place-items-center"><User size={26} className="text-white fill-white" /></span>
            <div>
              <div className="flex items-center gap-2 text-lg font-semibold text-slate-800">{name} <span className="rounded bg-[#43A047] px-1.5 py-px text-[10px] font-bold text-white">Online</span></div>
              <div className="text-xs text-[#1E88E5]">{user?.email}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-5 text-[11px] text-slate-600">
            <span className="inline-flex items-center gap-1"><Calendar size={11} /> Last Seen: {fmtAt(new Date().toISOString())}</span>
            <span className="inline-flex items-center gap-1"><Lock size={11} /> Security Role: <span className="text-[#1E88E5]">Admin</span></span>
            {profile.mobile && <span className="inline-flex items-center gap-1"><Smartphone size={11} /> <span className="text-[#1E88E5]">{profile.mobile}</span></span>}
            {profile.office_phone && <span className="inline-flex items-center gap-1"><Phone size={11} /> <span className="text-[#1E88E5]">{profile.office_phone}</span></span>}
          </div>
        </section>
        <div className="flex border-b border-slate-200" data-testid="practice-user-tabs">
          {tabs.map(t => (
            <button key={t} type="button" onClick={() => setTab(t)} data-testid={`practice-user-tab-${t.toLowerCase().replace(/\s+/g, "-")}`}
                    className={`-mb-px px-3 py-2 text-xs border ${tab === t ? "border-slate-200 border-b-white bg-white text-slate-900 font-medium rounded-t" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{first}'s {t}</button>
          ))}
        </div>
        {tab === "Dashboard" ? <div className="space-y-4"><Agenda first={first} /><Activity first={first} name={name} /></div>
          : <UserTabList tab={tab} />}
      </div>
    </PracticeShell>
  );
}

function UserTabList({ tab }) {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const url = { Contacts: "/practice/contacts?status=All", Matters: "/practice/matters?status=All", "Time Entries": "/practice/time-entries/all" }[tab];
  useEffect(() => { setRows(null); api.get(url).then(r => setRows(r.data)).catch(() => setRows([])); }, [url]);
  const label = (r) => tab === "Contacts" ? r.display_name : tab === "Matters" ? `${r.contact_name} | ${r.name}` : `${r.date} · ${r.item || "Time"} · ${Number(r.hours).toFixed(2)} hrs · $${Number(r.total).toFixed(2)}`;
  const to = (r) => tab === "Contacts" ? `/practice/contacts/${r.id}` : tab === "Matters" ? `/practice/matters/${r.id}` : "/practice/time-entries";
  return (
    <section className="rounded border border-slate-200 bg-white" data-testid={`practice-user-list-${tab.toLowerCase().replace(/\s+/g, "-")}`}>
      {rows === null ? <div className="p-6 text-xs text-slate-500">Loading…</div> : rows.length === 0 ? <div className="p-6 text-xs text-slate-500">Nothing here yet.</div> : (
        <ul className="divide-y divide-slate-100">{rows.map(r => <li key={r.id} className="px-4 py-2 text-sm"><button type="button" onClick={() => nav(to(r))} className="text-[#1E88E5] hover:underline">{label(r)}</button></li>)}</ul>
      )}
    </section>
  );
}
