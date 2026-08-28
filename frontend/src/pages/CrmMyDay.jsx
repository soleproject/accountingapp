import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CalendarCheck, Phone, Mail, ClipboardList, AlertTriangle,
  Flame, Loader2, ArrowRight, Check, ExternalLink, Circle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * MyDay — the daily execution dashboard rendered inside /crm when the
 * view toggle is set to "day".
 *
 * Sections (all filtered to today unless noted):
 *   • Appointments (kind=meeting)      • Tasks
 *   • Calls to make (kind=call)         • Overdue (all past-due, still open)
 *   • Deals needing follow-up            • Unread Gmail preview (if connected)
 */
export default function MyDay({ onOpenDeal }) {
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  const [loading, setLoading] = useState(true);
  const [data, setData]       = useState(null);

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const offset = -new Date().getTimezoneOffset(); // minutes east of UTC
      const r = await api.get(
        `/companies/${currentId}/my-day?tz_offset_min=${offset}`);
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load My Day");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  const markTaskDone = async (t) => {
    try {
      await api.post(`/companies/${currentId}/tasks/${t.id}/complete`,
                      { status: "done" });
      // Optimistic remove from lists
      setData(d => d && ({
        ...d,
        appointments: (d.appointments || []).filter(x => x.id !== t.id),
        tasks:        (d.tasks        || []).filter(x => x.id !== t.id),
        calls:        (d.calls        || []).filter(x => x.id !== t.id),
        overdue:      (d.overdue      || []).filter(x => x.id !== t.id),
      }));
      toast.success("Marked done");
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };

  const snoozeTaskTomorrow = async (t) => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    const tomorrow = d.toISOString().slice(0, 10);
    try {
      await api.patch(`/companies/${currentId}/tasks/${t.id}`,
                       { due_date: tomorrow });
      setData(d => d && ({
        ...d,
        appointments: (d.appointments || []).filter(x => x.id !== t.id),
        tasks:        (d.tasks        || []).filter(x => x.id !== t.id),
        calls:        (d.calls        || []).filter(x => x.id !== t.id),
      }));
      toast.success("Snoozed to tomorrow");
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };

  if (loading && !data) {
    return <div className="flex justify-center py-16 text-slate-400"
                data-testid="my-day-loading">
      <Loader2 size={24} className="animate-spin"/>
    </div>;
  }
  if (!data) return null;

  const emptyDay =
    !(data.appointments?.length || data.calls?.length || data.tasks?.length
      || data.overdue?.length || data.follow_ups?.length
      || (data.unread?.count > 0));

  return (
    <div className="space-y-4" data-testid="my-day">
      {emptyDay && (
        <div className="rounded-xl border border-slate-200 bg-gradient-to-r from-violet-50 to-cyan-50 p-8 text-center">
          <div className="text-2xl mb-1">☀️</div>
          <div className="text-slate-700 font-semibold">Nothing on your plate today</div>
          <div className="text-xs text-slate-500 mt-1">
            Add a new deal or schedule a follow-up to stay in front of your pipeline.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Appointments */}
        <Panel
          icon={CalendarCheck} tone="cyan"
          title="Today's appointments"
          count={data.appointments?.length}
          testid="my-day-appointments"
          empty="No meetings today"
          items={data.appointments}
          renderItem={(t) => (
            <TaskRow
              key={t.id} task={t}
              icon={CalendarCheck}
              onDone={() => markTaskDone(t)}
              onSnooze={() => snoozeTaskTomorrow(t)}
              onOpen={() => t.deal_id && onOpenDeal?.(t.deal_id)}
            />
          )}
        />

        {/* Calls */}
        <Panel
          icon={Phone} tone="emerald"
          title="Calls to make"
          count={data.calls?.length}
          testid="my-day-calls"
          empty="No calls scheduled"
          items={data.calls}
          renderItem={(t) => (
            <TaskRow
              key={t.id} task={t}
              icon={Phone}
              onDone={() => markTaskDone(t)}
              onSnooze={() => snoozeTaskTomorrow(t)}
              onOpen={() => t.deal_id && onOpenDeal?.(t.deal_id)}
            />
          )}
        />

        {/* Tasks */}
        <Panel
          icon={ClipboardList} tone="violet"
          title="Tasks due today"
          count={data.tasks?.length}
          testid="my-day-tasks"
          empty="No tasks due today"
          items={data.tasks}
          renderItem={(t) => (
            <TaskRow
              key={t.id} task={t}
              icon={ClipboardList}
              onDone={() => markTaskDone(t)}
              onSnooze={() => snoozeTaskTomorrow(t)}
              onOpen={() => t.deal_id && onOpenDeal?.(t.deal_id)}
            />
          )}
        />

        {/* Emails */}
        <Panel
          icon={Mail} tone="blue"
          title="Emails waiting"
          count={data.unread?.count}
          testid="my-day-emails"
          empty={data.unread?.connected ? "Inbox zero 🎉" : "Connect Google to see unread emails"}
          items={data.unread?.threads}
          headerAction={
            <Link to="/crm/email" className="text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5">
              Open inbox <ArrowRight size={11}/>
            </Link>
          }
          renderItem={(t) => (
            <Link key={t.id} to="/crm/email"
                  className="flex items-start gap-2 px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                  data-testid={`my-day-email-${t.id}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-2 shrink-0"/>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-slate-800 truncate">
                  {displaySender(t.from)}
                </div>
                <div className="text-xs text-slate-700 truncate">{t.subject || "(no subject)"}</div>
                <div className="text-[11px] text-slate-500 truncate">{t.snippet}</div>
              </div>
            </Link>
          )}
        />

        {/* Overdue */}
        <Panel
          icon={AlertTriangle} tone="rose"
          title="Overdue"
          count={data.overdue?.length}
          testid="my-day-overdue"
          empty="Nothing overdue — nice"
          items={data.overdue?.slice(0, 8)}
          renderItem={(t) => (
            <TaskRow
              key={t.id} task={t}
              icon={AlertTriangle} accent="rose"
              onDone={() => markTaskDone(t)}
              onSnooze={() => snoozeTaskTomorrow(t)}
              onOpen={() => t.deal_id && onOpenDeal?.(t.deal_id)}
            />
          )}
        />

        {/* Follow-ups */}
        <Panel
          icon={Flame} tone="amber"
          title="Deals needing follow-up"
          count={data.follow_ups?.length}
          testid="my-day-follow-ups"
          empty="All caught up"
          items={data.follow_ups}
          headerAction={
            <Link to="/crm/settings" className="text-xs text-amber-700 hover:underline inline-flex items-center gap-0.5">
              Configure <ArrowRight size={11}/>
            </Link>
          }
          renderItem={(d) => (
            <button key={d.id}
                    onClick={() => onOpenDeal?.(d.id)}
                    data-testid={`my-day-followup-${d.id}`}
                    className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0 text-left">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"/>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-slate-800 truncate">
                  {d.title || "(untitled deal)"}
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                  {d.stage} · {d.days_since_activity}d since last {d.last_activity_kind || "touch"}
                  {d.value ? ` · ${fmt(d.value)}` : ""}
                </div>
              </div>
              <ArrowRight size={12} className="text-slate-400 shrink-0"/>
            </button>
          )}
        />
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Panel wrapper                                                      */
/* ------------------------------------------------------------------ */
function Panel({ icon: Icon, tone = "slate", title, count, items, empty, renderItem, headerAction, testid }) {
  const toneMap = {
    cyan:    "bg-cyan-50 text-cyan-700",
    emerald: "bg-emerald-50 text-emerald-700",
    violet:  "bg-violet-50 text-violet-700",
    blue:    "bg-blue-50 text-blue-700",
    rose:    "bg-rose-50 text-rose-700",
    amber:   "bg-amber-50 text-amber-700",
    slate:   "bg-slate-50 text-slate-700",
  };
  return (
    <section className="rounded-xl border border-slate-200 bg-white"
             data-testid={testid}>
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100">
        <div className={`w-6 h-6 rounded-md flex items-center justify-center ${toneMap[tone]}`}>
          <Icon size={13}/>
        </div>
        <h3 className="text-sm font-semibold text-slate-800 flex-1">
          {title}
          {count > 0 && <span className="ml-1.5 text-slate-500 font-normal">· {count}</span>}
        </h3>
        {headerAction}
      </header>
      <div className="max-h-[280px] overflow-y-auto">
        {(!items || items.length === 0) ? (
          <div className="px-4 py-6 text-center text-xs text-slate-400">{empty}</div>
        ) : items.map(renderItem)}
      </div>
    </section>
  );
}


/* ------------------------------------------------------------------ */
/*  TaskRow                                                            */
/* ------------------------------------------------------------------ */
function TaskRow({ task, icon: Icon, accent = "slate", onDone, onSnooze, onOpen }) {
  return (
    <div
      data-testid={`my-day-task-${task.id}`}
      className="group flex items-center gap-2 px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0">
      <button onClick={onDone}
              title="Mark done"
              data-testid={`my-day-task-done-${task.id}`}
              className="w-4 h-4 rounded-full border-2 border-slate-300 hover:border-emerald-500 hover:bg-emerald-50 flex items-center justify-center shrink-0">
        <Check size={10} className="text-transparent group-hover:text-emerald-600 transition"/>
      </button>
      <Icon size={13} className={`shrink-0 ${accent === "rose" ? "text-rose-500" : "text-slate-400"}`}/>
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onOpen}>
        <div className={`text-xs font-medium text-slate-800 truncate ${accent === "rose" ? "text-rose-700" : ""}`}>
          {task.title || "(untitled)"}
        </div>
        <div className="text-[11px] text-slate-500 truncate">
          {task.due_time ? formatTime(task.due_time) : (accent === "rose" ? `due ${task.due_date}` : "Today")}
          {task.priority && task.priority !== "medium" ? ` · ${task.priority}` : ""}
        </div>
      </div>
      <button onClick={onSnooze}
              title="Snooze to tomorrow"
              data-testid={`my-day-task-snooze-${task.id}`}
              className="opacity-0 group-hover:opacity-100 text-[10px] text-slate-500 hover:text-violet-600 transition">
        Snooze
      </button>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function formatTime(hhmm) {
  if (!hhmm) return "";
  try {
    const [h, m] = hhmm.split(":").map(Number);
    const ampm = h >= 12 ? "pm" : "am";
    const h12 = ((h + 11) % 12) + 1;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
  } catch { return hhmm; }
}

function displaySender(raw) {
  if (!raw) return "(unknown)";
  const s = String(raw);
  if (s.includes("<")) return s.split("<")[0].trim().replace(/^["']|["']$/g, "") || s;
  return s;
}
