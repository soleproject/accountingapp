import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { NewTaskModal } from "@/components/practice/NewTaskModal";
import { NewEventModal } from "@/components/practice/NewEventModal";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";
import { TaskPopover } from "@/components/practice/TaskPopover";
import { toast } from "sonner";
import { toISO } from "@/components/practice/DateTimePicker";
import { CalendarDays, Tag, Filter, ChevronDown, ChevronLeft, ChevronRight, Plus, Search, Calendar } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { CalendarSidebar, addDays, startOfWeek } from "@/components/practice/CalendarSidebar";
import { MonthView, TimeGrid, AgendaView } from "@/components/practice/CalendarViews";

const VIEWS = ["Month", "Week", "Work Week", "Day", "Agenda"];
const MONTH = (d) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" }).toUpperCase();
const MD = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();

function range(view, d) {
  if (view === "Month") { const s = new Date(d.getFullYear(), d.getMonth(), 1); return [s, new Date(d.getFullYear(), d.getMonth() + 1, 0)]; }
  if (view === "Week") { const s = startOfWeek(d); return [s, addDays(s, 6)]; }
  if (view === "Work Week") { const s = addDays(startOfWeek(d), 1); return [s, addDays(s, 4)]; }
  if (view === "Agenda") return [d, addDays(d, 6)];
  return [d, d];
}

function title(view, d) {
  const [s, e] = range(view, d);
  if (view === "Month") return MONTH(d);
  if (view === "Day") return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }).toUpperCase();
  const sameMonth = s.getMonth() === e.getMonth();
  return sameMonth ? `${MD(s)} – ${e.getDate()}, ${e.getFullYear()}` : `${MD(s)} – ${MD(e)}, ${e.getFullYear()}`;
}

function step(view, d, n) {
  if (view === "Month") return new Date(d.getFullYear(), d.getMonth() + n, 1);
  if (view === "Day") return addDays(d, n);
  return addDays(d, 7 * n);
}

const Pill = ({ children, testId, className = "" }) => (
  <button type="button" data-testid={testId} className={`inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 ${className}`}>{children}</button>
);

export default function PracticeCalendar() {
  const { user } = useAuth();
  const [view, setView] = useState("Month");
  const [date, setDate] = useState(new Date());
  const [calOn, setCalOn] = useState(true);
  const [tasks, setTasks] = useState([]);
  const [taskModal, setTaskModal] = useState(false);
  const [editTask, setEditTask] = useState(null);
  const [eventModal, setEventModal] = useState(false);
  const [editEvent, setEditEvent] = useState(null);
  const [popTask, setPopTask] = useState(null);
  const [timeTask, setTimeTask] = useState(null);
  const del = async () => { try { await api.delete(`/practice/tasks/${popTask.id}`); toast.success("Task deleted"); setPopTask(null); load(); } catch { toast.error("Could not delete"); } };
  const complete = async () => { try { await api.patch(`/practice/tasks/${popTask.id}/status`, { status: "Completed" }); toast.success("Task completed"); setPopTask(null); load(); } catch { toast.error("Could not update"); } };
  const [s, e] = range(view, date);
  const loadStart = toISO(addDays(startOfWeek(new Date(s.getFullYear(), s.getMonth(), 1)), 0));
  const loadEnd = toISO(addDays(e, 42));
  const load = useCallback(() => {
    api.get("/practice/tasks", { params: { start: loadStart, end: loadEnd } }).then(r => setTasks(r.data)).catch(() => {});
  }, [loadStart, loadEnd]);
  useEffect(() => { load(); }, [load]);
  const visible = calOn ? tasks : [];
  const rangeTasks = visible.filter(t => t.due_date >= toISO(s) && t.due_date <= toISO(e));
  const inRange = (d) => view !== "Month" && view !== "Day" && d >= new Date(s.toDateString()) && d <= new Date(e.toDateString());
  const days = view === "Day" ? [date] : Array.from({ length: Math.round((e - s) / 86400000) + 1 }, (_, i) => addDays(s, i));

  return (
    <PracticeShell>
      <div className="space-y-3" data-testid="practice-calendar-page">
        <div className="flex items-center gap-3">
          <CalendarDays size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">Calendar</h1>
          <div className="flex-1" />
          <Pill testId="practice-cal-tags"><Tag size={14} /> Tags <ChevronDown size={12} /></Pill>
          <Pill testId="practice-cal-filter"><Filter size={14} /> <ChevronDown size={12} /></Pill>
          <Pill testId="practice-cal-sync"><Calendar size={14} /> Sync Your Calendar</Pill>
          <button type="button" onClick={() => setTaskModal(true)} data-testid="practice-cal-new-task" className="inline-flex items-center gap-1 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]"><Plus size={14} /> New Task</button>
          <button type="button" onClick={() => setEventModal(true)} data-testid="practice-cal-new-event" className="inline-flex items-center gap-1 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]"><Plus size={14} /> New Event</button>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          <CalendarSidebar selected={date} onSelect={setDate} inRange={inRange} userName={user?.name} calOn={calOn} setCalOn={setCalOn} />
          <section className="rounded border border-slate-200 bg-white p-3 space-y-3" data-testid="practice-cal-main">
            <label className="flex items-center gap-3 border-b border-slate-200 px-2">
              <Search size={16} className="text-slate-400" />
              <input placeholder="Search..." data-testid="practice-cal-search" className="flex-1 h-9 text-sm outline-none bg-transparent" />
            </label>
            {!calOn ? <div className="py-3 text-sm font-bold uppercase tracking-wide text-slate-800" data-testid="practice-cal-none-selected">Please select at least one calendar.</div> : (<>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-full border border-slate-300 overflow-hidden">
                <button type="button" onClick={() => setDate(d => step(view, d, -1))} className="px-2.5 py-1 hover:bg-slate-50" data-testid="practice-cal-prev"><ChevronLeft size={14} /></button>
                <button type="button" onClick={() => setDate(d => step(view, d, 1))} className="px-2.5 py-1 border-l border-slate-300 hover:bg-slate-50" data-testid="practice-cal-next"><ChevronRight size={14} /></button>
              </div>
              <button type="button" onClick={() => setDate(new Date())} className="rounded-full border border-slate-300 px-3 py-1 text-xs uppercase tracking-wide text-slate-700 hover:bg-slate-50" data-testid="practice-cal-today">Today</button>
              <h2 className="ml-2 text-lg font-bold text-slate-800" data-testid="practice-cal-title">{title(view, date)}</h2>
              <div className="flex-1" />
              {VIEWS.map(v => (
                <button key={v} type="button" onClick={() => setView(v)} data-testid={`practice-cal-view-${v.toLowerCase().replace(/\s+/g, "-")}`}
                        className={`rounded-full px-3 py-1 text-xs uppercase tracking-wide ${view === v ? "bg-[#1E88E5] text-white" : "border border-slate-300 text-slate-700 hover:bg-slate-50"}`}>{v}</button>
              ))}
            </div>
            {view === "Month" ? <MonthView date={date} selected={date} onPick={(d) => { setDate(d); setView("Day"); }} tasks={visible} onOpen={setPopTask} />
              : view === "Agenda" ? <AgendaView start={s} end={e} tasks={rangeTasks} onOpen={setPopTask} />
              : <TimeGrid days={days} userName={user?.name} tasks={visible} onOpen={setPopTask} />}
            </>)}
          </section>
        </div>
      </div>
      {taskModal && <NewTaskModal defaultDate={date} onClose={() => setTaskModal(false)} onSaved={() => { setTaskModal(false); load(); }} />}
      {eventModal && <NewEventModal defaultDate={date} onClose={() => setEventModal(false)} onSaved={() => { setEventModal(false); load(); }} />}
      {editEvent && <NewEventModal event={editEvent} onClose={() => setEditEvent(null)} onSaved={() => { setEditEvent(null); load(); }} />}
      {editTask && <NewTaskModal task={editTask} onClose={() => setEditTask(null)} onSaved={() => { setEditTask(null); load(); }} />}
      {popTask && <TaskPopover task={popTask} onClose={() => setPopTask(null)} onLogTime={() => { setTimeTask(popTask); setPopTask(null); }}
                               onEdit={() => { (popTask.kind === "event" ? setEditEvent : setEditTask)(popTask); setPopTask(null); }} onDelete={del} onComplete={complete} />}
      {timeTask && <NewTimeEntryModal task={timeTask} onClose={() => setTimeTask(null)} onSaved={() => setTimeTask(null)} />}
    </PracticeShell>
  );
}
