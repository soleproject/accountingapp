import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CalendarCheck, Phone, Mail, ClipboardList, AlertTriangle,
  Flame, Loader2, ArrowRight, Check, ExternalLink, Circle,
  Sparkles, RefreshCw,
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
  const [brief, setBrief]     = useState(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefEnabled, setBriefEnabled] = useState(false);
  const [tab, setTab] = useState(() => localStorage.getItem("crm_my_day_tab") || "todo"); // "todo" | "done"
  useEffect(() => { localStorage.setItem("crm_my_day_tab", tab); }, [tab]);

  // Read the Morning Brief opt-in from CRM settings
  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/crm-settings`)
       .then(r => setBriefEnabled(!!r.data?.show_morning_brief))
       .catch(() => setBriefEnabled(false));
  }, [currentId]);

  const loadBrief = async (force = false) => {
    if (!currentId) return;
    setBriefLoading(true);
    try {
      const offset = -new Date().getTimezoneOffset();
      const r = await api.get(
        `/companies/${currentId}/my-day/brief?tz_offset_min=${offset}${force ? "&force=1" : ""}`);
      setBrief(r.data);
    } catch { /* silent — the panel just stays empty */ }
    finally { setBriefLoading(false); }
  };

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
  useEffect(() => {
    load();
    if (briefEnabled) loadBrief();
    /* eslint-disable-next-line */
  }, [currentId, briefEnabled]);

  const markTaskDone = async (t) => {
    try {
      await api.post(`/companies/${currentId}/tasks/${t.id}/complete`,
                      { status: "done" });
      // Optimistic move from open lists → completed lists
      setData(d => {
        if (!d) return d;
        const done = { ...t, status: "done" };
        const bucket = t.kind === "meeting" ? "appointments"
                     : t.kind === "call"    ? "calls"
                     : "tasks";
        return {
          ...d,
          appointments: (d.appointments || []).filter(x => x.id !== t.id),
          tasks:        (d.tasks        || []).filter(x => x.id !== t.id),
          calls:        (d.calls        || []).filter(x => x.id !== t.id),
          overdue:      (d.overdue      || []).filter(x => x.id !== t.id),
          completed: {
            ...(d.completed || {}),
            [bucket]: [...(d.completed?.[bucket] || []), done],
          },
          completed_count: (d.completed_count || 0) + 1,
        };
      });
      toast.success("Marked done");
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };

  const undoComplete = async (t) => {
    try {
      await api.post(`/companies/${currentId}/tasks/${t.id}/complete`,
                      { status: "open" });
      setData(d => {
        if (!d) return d;
        const back = { ...t, status: "open" };
        const bucket = t.kind === "meeting" ? "appointments"
                     : t.kind === "call"    ? "calls"
                     : "tasks";
        return {
          ...d,
          [bucket]: [...(d[bucket] || []), back],
          completed: {
            ...(d.completed || {}),
            [bucket]: (d.completed?.[bucket] || []).filter(x => x.id !== t.id),
          },
          completed_count: Math.max(0, (d.completed_count || 0) - 1),
        };
      });
      toast.success("Moved back to To Do");
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

  const doneCount = data.completed_count || 0;
  const todoCount = (data.appointments?.length || 0) + (data.calls?.length || 0) + (data.tasks?.length || 0);
  const isDone = tab === "done";
  // Route each panel's items through the active tab
  const panelAppointments = isDone ? (data.completed?.appointments || []) : (data.appointments || []);
  const panelCalls        = isDone ? (data.completed?.calls || [])        : (data.calls || []);
  const panelTasks        = isDone ? (data.completed?.tasks || [])        : (data.tasks || []);

  const rowOnDone   = (t) => isDone ? undoComplete(t) : markTaskDone(t);
  const rowOnSnooze = (t) => isDone ? undoComplete(t) : snoozeTaskTomorrow(t);
  const snoozeLabel = isDone ? "Undo" : "Snooze";

  return (
    <div className="space-y-4" data-testid="my-day">
      {/* Morning Brief — AI summary (opt-in via CRM Settings) */}
      {briefEnabled && (
      <div className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-cyan-50 p-4"
           data-testid="my-day-brief">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-600 text-white flex items-center justify-center shrink-0 shadow-sm">
            <Sparkles size={15}/>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-[10px] uppercase tracking-widest text-violet-700 font-semibold">
                Morning Brief
              </div>
              {brief?.cached && (
                <span className="text-[9px] text-slate-400">cached · {(brief.generated_at || "").slice(11, 16)}</span>
              )}
              <div className="flex-1"/>
              <button
                onClick={() => loadBrief(true)}
                disabled={briefLoading}
                data-testid="my-day-brief-refresh"
                className="text-[10px] text-violet-600 hover:text-violet-800 disabled:opacity-40 inline-flex items-center gap-1">
                {briefLoading ? <Loader2 size={11} className="animate-spin"/> : <RefreshCw size={11}/>}
                Regenerate
              </button>
            </div>
            <p className="text-sm text-slate-800 leading-relaxed"
               data-testid="my-day-brief-text">
              {briefLoading && !brief
                ? "Generating your morning brief…"
                : brief?.brief || "Your brief will appear here."}
            </p>
          </div>
        </div>
      </div>
      )}

      {/* To Do / Completed toggle */}
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
             data-testid="my-day-tab-toggle">
          <button
            onClick={() => setTab("todo")}
            data-testid="my-day-tab-todo"
            className={`px-3 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition ${
              tab === "todo"
                ? "bg-violet-600 text-white"
                : "text-slate-600 hover:bg-slate-50"
            }`}>
            <Circle size={11}/> To Do
            <span className={`ml-0.5 text-[10px] ${tab === "todo" ? "text-white/80" : "text-slate-400"}`}>· {todoCount}</span>
          </button>
          <button
            onClick={() => setTab("done")}
            data-testid="my-day-tab-done"
            className={`px-3 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition ${
              tab === "done"
                ? "bg-emerald-600 text-white"
                : "text-slate-600 hover:bg-slate-50"
            }`}>
            <Check size={11}/> Completed
            <span className={`ml-0.5 text-[10px] ${tab === "done" ? "text-white/80" : "text-slate-400"}`}>· {doneCount}</span>
          </button>
        </div>
        <div className="text-[11px] text-slate-500">
          {isDone
            ? doneCount > 0 && "Way to go — click any row to undo."
            : todoCount > 0 && `${todoCount} to do · ${doneCount} done today`}
        </div>
      </div>

      {emptyDay && !isDone && (
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
          title={isDone ? "Completed appointments" : "Today's appointments"}
          count={panelAppointments.length}
          testid="my-day-appointments"
          empty={isDone ? "None ticked off yet" : "No meetings today"}
          items={panelAppointments}
          renderItem={(t) => (
            <TaskRow
              key={t.id} task={t} done={isDone}
              icon={CalendarCheck}
              onDone={() => rowOnDone(t)}
              onSnooze={() => rowOnSnooze(t)}
              snoozeLabel={snoozeLabel}
              onOpen={() => t.deal_id && onOpenDeal?.(t.deal_id)}
            />
          )}
        />

        {/* Calls */}
        <Panel
          icon={Phone} tone="emerald"
          title={isDone ? "Completed calls" : "Calls to make"}
          count={panelCalls.length}
          testid="my-day-calls"
          empty={isDone ? "None ticked off yet" : "No calls scheduled"}
          items={panelCalls}
          renderItem={(t) => (
            <TaskRow
              key={t.id} task={t} done={isDone}
              icon={Phone}
              onDone={() => rowOnDone(t)}
              onSnooze={() => rowOnSnooze(t)}
              snoozeLabel={snoozeLabel}
              onOpen={() => t.deal_id && onOpenDeal?.(t.deal_id)}
            />
          )}
        />

        {/* Tasks */}
        <Panel
          icon={ClipboardList} tone="violet"
          title={isDone ? "Completed tasks" : "Tasks due today"}
          count={panelTasks.length}
          testid="my-day-tasks"
          empty={isDone ? "None ticked off yet" : "No tasks due today"}
          items={panelTasks}
          renderItem={(t) => (
            <TaskRow
              key={t.id} task={t} done={isDone}
              icon={ClipboardList}
              onDone={() => rowOnDone(t)}
              onSnooze={() => rowOnSnooze(t)}
              snoozeLabel={snoozeLabel}
              onOpen={() => t.deal_id && onOpenDeal?.(t.deal_id)}
            />
          )}
        />

        {/* Emails — always the same (only shown in To Do) */}
        {!isDone && (
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
        />)}

        {/* Overdue — only in To Do */}
        {!isDone && (
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
        />)}

        {/* Follow-ups — only in To Do */}
        {!isDone && (
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
        />)}
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
function TaskRow({ task, icon: Icon, accent = "slate", done = false, snoozeLabel = "Snooze", onDone, onSnooze, onOpen }) {
  const isGcal = task.source === "gcal";
  const openLink = isGcal ? () => task.html_link && window.open(task.html_link, "_blank", "noopener,noreferrer") : onOpen;
  return (
    <div
      data-testid={`my-day-task-${task.id}`}
      className={`group flex items-center gap-2 px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0 ${done ? "opacity-70" : ""}`}>
      {isGcal ? (
        <span title="From Google Calendar"
              className="w-4 h-4 rounded-full border-2 border-cyan-300 bg-cyan-50 flex items-center justify-center shrink-0">
          <CalendarCheck size={9} className="text-cyan-600"/>
        </span>
      ) : (
        <button onClick={onDone}
                title={done ? "Undo — move back to To Do" : "Mark done"}
                data-testid={`my-day-task-done-${task.id}`}
                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition ${
                  done
                    ? "border-emerald-500 bg-emerald-500 hover:bg-emerald-600 hover:border-emerald-600"
                    : "border-slate-300 hover:border-emerald-500 hover:bg-emerald-50"
                }`}>
          <Check size={10} className={done
            ? "text-white"
            : "text-transparent group-hover:text-emerald-600 transition"}/>
        </button>
      )}
      <Icon size={13} className={`shrink-0 ${accent === "rose" ? "text-rose-500" : "text-slate-400"}`}/>
      <div className="flex-1 min-w-0 cursor-pointer" onClick={openLink}>
        <div className={`text-xs font-medium truncate ${
          done ? "text-slate-500 line-through"
               : accent === "rose" ? "text-rose-700"
               : "text-slate-800"}`}>
          {task.title || "(untitled)"}
          {isGcal && (
            <span className="ml-1.5 text-[9px] uppercase tracking-widest text-cyan-600 font-semibold">
              GCal
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-500 truncate">
          {task.due_time ? formatTime(task.due_time) : (accent === "rose" ? `due ${task.due_date}` : (task.all_day ? "All day" : "Today"))}
          {task.priority && task.priority !== "medium" ? ` · ${task.priority}` : ""}
          {isGcal && task.location ? ` · ${task.location}` : ""}
        </div>
      </div>
      {!isGcal && (
        <button onClick={onSnooze}
                title={done ? "Undo — move back to To Do" : "Snooze to tomorrow"}
                data-testid={`my-day-task-snooze-${task.id}`}
                className="opacity-0 group-hover:opacity-100 text-[10px] text-slate-500 hover:text-violet-600 transition">
          {snoozeLabel}
        </button>
      )}
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
