import { useEffect, useMemo, useState, useRef } from "react";
import { useLocation, Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CalendarDays, ChevronLeft, ChevronRight, Loader2, Plus, Mail,
  Video, MapPin, ExternalLink, Users, Trash2, RefreshCw, X,
  ClipboardList, CalendarCheck, Phone, ChevronDown,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import CalendarQuickAddModal from "@/components/CalendarQuickAddModal";
import CalendarEntityDrawer from "@/components/CalendarEntityDrawer";

/* ------------------------------------------------------------------ */
/*  Date helpers                                                       */
/* ------------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoDay(new Date());

const monthWindow = (anchor) => {
  const [y, m] = anchor.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const last  = new Date(y, m, 0);
  // Grid starts on Monday
  const gridStart = new Date(first);
  const offset = (first.getDay() + 6) % 7; // Mon=0
  gridStart.setDate(first.getDate() - offset);
  const gridEnd = new Date(last);
  const tail = (7 - ((last.getDay() + 6) % 7) - 1) % 7;
  gridEnd.setDate(last.getDate() + tail);
  const days = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    days.push({
      date: isoDay(d),
      inPeriod: d.getMonth() === first.getMonth(),
    });
  }
  return {
    from: gridStart.toISOString(),
    to:   new Date(gridEnd.getTime() + 24 * 3600 * 1000).toISOString(),
    label: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    days,
  };
};

const weekWindow = (anchorDate) => {
  const d = new Date(anchorDate);
  const offset = (d.getDay() + 6) % 7;   // Mon=0
  const monday = new Date(d);
  monday.setDate(d.getDate() - offset);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const nd = new Date(monday); nd.setDate(monday.getDate() + i);
    days.push({ date: isoDay(nd), inPeriod: true });
  }
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const sameMonth = monday.getMonth() === sunday.getMonth();
  const label = sameMonth
    ? `${monday.toLocaleDateString(undefined, { month: "long" })} ${monday.getDate()}–${sunday.getDate()}, ${monday.getFullYear()}`
    : `${monday.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${sunday.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${sunday.getFullYear()}`;
  return {
    from:  new Date(days[0].date + "T00:00:00").toISOString(),
    to:    new Date(days[6].date + "T23:59:59").toISOString(),
    label, days,
  };
};

const dayWindow = (anchorDate) => {
  const d = new Date(anchorDate);
  return {
    from:  new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString(),
    to:    new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString(),
    label: d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    days:  [{ date: isoDay(d), inPeriod: true }],
  };
};

const shiftMonth = (anchor, delta) => {
  const [y, m] = anchor.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return isoDay(d).slice(0, 7) + "-01";
};

const shiftDays = (anchor, delta) => {
  const d = new Date(anchor);
  d.setDate(d.getDate() + delta);
  return isoDay(d);
};

const fmtTime = (iso) => {
  if (!iso) return "";
  if (iso.length === 10) return "All day";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
  } catch { return ""; }
};

const fmtTimeShort = (iso) => {
  if (!iso || iso.length === 10) return "";
  try {
    const d = new Date(iso);
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "pm" : "am";
    const h12 = ((h + 11) % 12) + 1;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${pad(m)}${ampm}`;
  } catch { return ""; }
};

const dayOf = (iso) => (iso || "").slice(0, 10);

// Minutes since midnight from an ISO datetime string
const minutesOfDay = (iso) => {
  if (!iso || iso.length === 10) return null;
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};


/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */
export default function CrmCalendar() {
  const { currentId } = useCompany();
  const location = useLocation();

  const [status, setStatus] = useState({ loading: true, connected: false, email: "" });
  const [view, setView] = useState(() => localStorage.getItem("crm_cal_view") || "month"); // month | week | day
  const [anchor, setAnchor] = useState(() => todayISO().slice(0, 7) + "-01"); // month anchor (1st of month)
  const [dayAnchor, setDayAnchor] = useState(() => todayISO());                // day/week anchor
  const [events, setEvents] = useState([]);          // Google events
  const [appData, setAppData] = useState(null);      // { tasks, phases, time_entries }
  const [loadingApp, setLoadingApp] = useState(false);
  const [loadingGoog, setLoadingGoog] = useState(false);
  const [calendars, setCalendars] = useState([]);
  const [calendarId, setCalendarId] = useState("primary");
  const [selectedDate, setSelectedDate] = useState(null);
  const [creatingGoogle, setCreatingGoogle] = useState(false);
  const [quickAddDate, setQuickAddDate] = useState(null);
  const [detailEvent, setDetailEvent] = useState(null);
  const [drilldown, setDrilldown] = useState(null);   // {kind, data} for app entities
  const [showGoogle, setShowGoogle] = useState(() => localStorage.getItem("crm_cal_show_google") !== "0");

  useEffect(() => { localStorage.setItem("crm_cal_view", view); }, [view]);

  const { from, to, days, label } = useMemo(() => {
    if (view === "week") return weekWindow(dayAnchor);
    if (view === "day")  return dayWindow(dayAnchor);
    return monthWindow(anchor);
  }, [view, anchor, dayAnchor]);

  const shiftView = (delta) => {
    if (view === "month") setAnchor(shiftMonth(anchor, delta));
    else if (view === "week") setDayAnchor(shiftDays(dayAnchor, delta * 7));
    else setDayAnchor(shiftDays(dayAnchor, delta));
  };

  const goToday = () => {
    setAnchor(todayISO().slice(0, 7) + "-01");
    setDayAnchor(todayISO());
  };

  /* ── OAuth callback toast (shared with /crm/email) ── */
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get("gmail_connected") === "1") {
      toast.success("Google connected");
      window.history.replaceState({}, "", "/crm/calendar");
    }
    if (p.get("gmail_error")) {
      toast.error("Google connection failed: " + p.get("gmail_error"));
      window.history.replaceState({}, "", "/crm/calendar");
    }
  }, [location.search]);

  /* ── connection status ── */
  const loadStatus = async () => {
    try {
      const r = await api.get("/gmail/status");
      setStatus({ loading: false, connected: !!r.data?.connected, email: r.data?.email || "" });
    } catch { setStatus({ loading: false, connected: false, email: "" }); }
  };
  useEffect(() => { loadStatus(); }, []);

  /* ── app-native data (tasks/phases/time) — always ── */
  const loadApp = async () => {
    if (!currentId) return;
    setLoadingApp(true);
    try {
      // team-calendar expects YYYY-MM-DD bounds
      const df = days[0].date;
      const dt = days[days.length - 1].date;
      const r = await api.get(
        `/companies/${currentId}/team-calendar?date_from=${df}&date_to=${dt}`);
      setAppData(r.data);
    } catch (e) {
      /* silent — leave grid empty */
    } finally { setLoadingApp(false); }
  };
  useEffect(() => { loadApp(); /* eslint-disable-next-line */ }, [currentId, view, anchor, dayAnchor]);

  /* ── Google calendars list ── */
  useEffect(() => {
    if (!status.connected) return;
    api.get("/google/calendar/list").then(r => setCalendars(r.data?.calendars || []))
       .catch(() => {});
  }, [status.connected]);

  /* ── Google events ── */
  const loadEvents = async () => {
    if (!status.connected || !showGoogle) { setEvents([]); return; }
    setLoadingGoog(true);
    try {
      const params = new URLSearchParams({ time_min: from, time_max: to, calendar_id: calendarId });
      const r = await api.get(`/google/calendar/events?${params.toString()}`);
      setEvents(r.data?.events || []);
    } catch (e) {
      if (e?.response?.status === 401) {
        setStatus({ loading: false, connected: false, email: "" });
      }
    } finally { setLoadingGoog(false); }
  };
  useEffect(() => { loadEvents(); /* eslint-disable-next-line */ },
    [status.connected, showGoogle, view, anchor, dayAnchor, calendarId]);

  useEffect(() => { localStorage.setItem("crm_cal_show_google", showGoogle ? "1" : "0"); }, [showGoogle]);

  const byDay = useMemo(() => {
    const map = {};
    const ensure = (d) => (map[d] = map[d] || { tasks: [], starts: [], ends: [], entries: [], google: [] });
    for (const t of (appData?.tasks || [])) {
      if (t.due_date) ensure(t.due_date).tasks.push(t);
    }
    for (const ph of (appData?.phases || [])) {
      if (ph.start_date) ensure(ph.start_date).starts.push(ph);
      if (ph.end_date)   ensure(ph.end_date  ).ends.push(ph);
    }
    for (const te of (appData?.time_entries || [])) {
      ensure(te.date).entries.push(te);
    }
    for (const e of events) {
      const d = dayOf(e.start);
      if (d) ensure(d).google.push(e);
    }
    for (const d of Object.values(map)) {
      d.google.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    }
    return map;
  }, [appData, events]);

  const connect = async () => {
    try {
      const r = await api.get("/oauth/gmail/start?return_to=/crm/calendar");
      window.location.href = r.data.auth_url;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to start Google connect");
    }
  };

  const deleteEvent = async (ev) => {
    if (!window.confirm("Delete this event?")) return;
    try {
      await api.delete(`/google/calendar/events/${ev.id}?calendar_id=${calendarId}&send_updates=all`);
      setEvents(es => es.filter(x => x.id !== ev.id));
      setDetailEvent(null);
      toast.success("Event deleted");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };

  const handleCellClick = (date) => {
    setSelectedDate(date);
    if (status.connected) setCreatingGoogle(true);
    else setQuickAddDate(date);
  };

  const handleNewEvent = () => {
    const d = view === "day" || view === "week" ? dayAnchor : todayISO();
    setSelectedDate(d);
    if (status.connected) setCreatingGoogle(true);
    else setQuickAddDate(d);
  };

  if (status.loading) {
    return <div className="p-8 flex items-center gap-2 text-slate-500">
      <Loader2 className="animate-spin" size={16}/> Loading calendar…
    </div>;
  }

  return (
    <div className="max-w-[1400px] space-y-4 p-2" data-testid="crm-calendar-page">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <CalendarDays size={22} className="text-emerald-600"/>
            CRM Calendar
          </h1>
          <div className="text-slate-500 text-sm mt-1">
            Tasks, meetings, and phase deadlines
            {status.connected ? " — Google events overlaid." : "."}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {status.connected && (
            <>
              <select value={calendarId} onChange={e => setCalendarId(e.target.value)}
                      data-testid="calendar-select"
                      className="border border-slate-200 rounded px-2 py-1 bg-white text-xs">
                {calendars.map(c => (
                  <option key={c.id} value={c.id}>{c.summary}{c.primary ? " (primary)" : ""}</option>
                ))}
              </select>
              <button
                onClick={() => setShowGoogle(v => !v)}
                data-testid="calendar-toggle-google"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition ${
                  showGoogle
                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}>
                <CalendarDays size={12}/> Google {showGoogle ? "on" : "off"}
              </button>
            </>
          )}
          <button onClick={handleNewEvent}
                  data-testid="calendar-new-event-btn"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm">
            <Plus size={14}/> New event
          </button>
          <button onClick={() => { loadApp(); loadEvents(); }} title="Refresh"
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
            <RefreshCw size={14}/>
          </button>
        </div>
      </div>

      {/* Google Connect banner (non-blocking) */}
      {!status.connected && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 flex items-center gap-3 text-sm"
             data-testid="calendar-connect-banner">
          <CalendarDays size={16} className="text-emerald-700 shrink-0"/>
          <div className="text-slate-700 flex-1">
            <b>Connect Google</b> to overlay your Google Calendar events here and auto-invite attendees.
          </div>
          <button onClick={connect}
                  data-testid="calendar-connect-btn"
                  className="text-xs px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white">
            Connect Google
          </button>
        </div>
      )}

      {/* Nav — Google-style */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <button onClick={goToday}
                  data-testid="calendar-today"
                  className="text-sm px-3 py-1.5 rounded-full border border-slate-300 bg-white hover:bg-slate-50 text-slate-700">
            Today
          </button>
          <button onClick={() => shiftView(-1)}
                  className="p-1.5 rounded-full hover:bg-slate-100 text-slate-600"
                  data-testid="calendar-prev">
            <ChevronLeft size={18}/>
          </button>
          <button onClick={() => shiftView(1)}
                  className="p-1.5 rounded-full hover:bg-slate-100 text-slate-600"
                  data-testid="calendar-next">
            <ChevronRight size={18}/>
          </button>
          <div className="text-xl font-medium text-slate-800 ml-2">
            {label}
          </div>
          {(loadingApp || loadingGoog) && <Loader2 size={14} className="animate-spin text-slate-400 ml-1"/>}
          {status.connected && <span className="text-xs text-slate-400 font-normal ml-2">· {status.email}</span>}
        </div>

        {/* View switcher (Day / Week / Month) */}
        <ViewSwitcher view={view} setView={setView}/>
      </div>

      {/* Body — Month / Week / Day */}
      {view === "month" && (
        <MonthGrid days={days} byDay={byDay}
          onCellClick={handleCellClick}
          onEventClick={setDetailEvent}
          onTaskClick={(t) => setDrilldown({ kind:"task", data:t })}
          onPhaseClick={(ph) => setDrilldown({ kind:"phase", data:ph })}
          status={status}/>
      )}
      {view !== "month" && (
        <TimeGrid days={days} byDay={byDay} view={view}
          onCellClick={handleCellClick}
          onEventClick={setDetailEvent}
          onTaskClick={(t) => setDrilldown({ kind:"task", data:t })}/>
      )}

      {/* Legend */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-600">
        <LegendDot color="bg-cyan-500" label="Task / Meeting"/>
        <LegendDot color="bg-amber-500" label="Phase start"/>
        <LegendDot color="bg-rose-500" label="Phase end"/>
        {status.connected && <LegendDot color="bg-emerald-500" label="Google event"/>}
      </div>

      {/* Google compose modal */}
      {creatingGoogle && (
        <EventComposeModal
          date={selectedDate}
          calendarId={calendarId}
          companyId={currentId}
          onClose={() => setCreatingGoogle(false)}
          onSaved={() => { setCreatingGoogle(false); loadEvents(); toast.success("Event created"); }}
        />
      )}

      {/* App-native compose modal (fallback when Google not connected) */}
      {quickAddDate && (
        <CalendarQuickAddModal
          date={quickAddDate}
          onClose={() => setQuickAddDate(null)}
          onSaved={() => { setQuickAddDate(null); loadApp(); toast.success("Added"); }}
        />
      )}

      {/* Google event detail modal */}
      {detailEvent && (
        <EventDetailModal
          event={detailEvent}
          onClose={() => setDetailEvent(null)}
          onDelete={() => deleteEvent(detailEvent)}
        />
      )}

      {/* App entity drawer (task/phase) */}
      {drilldown && (
        <CalendarEntityDrawer
          entity={drilldown}
          onClose={() => setDrilldown(null)}
          onChanged={loadApp}
        />
      )}
    </div>
  );
}


function LegendDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`}/> {label}
    </span>
  );
}


/* ------------------------------------------------------------------ */
/*  View switcher (Day / Week / Month)                                 */
/* ------------------------------------------------------------------ */
function ViewSwitcher({ view, setView }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const on = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, []);
  const label = view === "day" ? "Day" : view === "week" ? "Week" : "Month";
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        data-testid="calendar-view-switcher"
        className="inline-flex items-center gap-2 px-4 py-1.5 rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-sm min-w-[110px] justify-between">
        <span>{label}</span> <ChevronDown size={14}/>
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-40 rounded-lg border border-slate-200 bg-white shadow-lg py-1">
          {[
            { id: "day",   label: "Day",   key: "D" },
            { id: "week",  label: "Week",  key: "W" },
            { id: "month", label: "Month", key: "M" },
          ].map(o => (
            <button key={o.id}
                    data-testid={`calendar-view-${o.id}`}
                    onClick={() => { setView(o.id); setOpen(false); }}
                    className={`w-full flex items-center justify-between px-3 py-1.5 text-sm hover:bg-slate-50 ${
                      view === o.id ? "text-emerald-700 font-medium" : "text-slate-700"
                    }`}>
                <span>{o.label}</span>
                <span className="text-xs text-slate-400">{o.key}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Google-style event row (colored bullet + time + title)             */
/* ------------------------------------------------------------------ */
function EventBullet({ dot, time, title, striked, onClick, testid, badge, size = "sm" }) {
  const textCls = size === "sm" ? "text-xs" : "text-sm";
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      title={title}
      className={`w-full flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-slate-100 text-left ${textCls} ${striked ? "line-through text-slate-400" : "text-slate-700"}`}>
      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dot}`}/>
      {badge && <span className="shrink-0">{badge}</span>}
      {time && <span className="text-slate-600 shrink-0">{time}</span>}
      <span className="truncate">{title}</span>
    </button>
  );
}


/* ------------------------------------------------------------------ */
/*  Month grid (Google-style: white cells, bullet rows)                */
/* ------------------------------------------------------------------ */
function MonthGrid({ days, byDay, onCellClick, onEventClick, onTaskClick, onPhaseClick, status }) {
  const dayNames = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const MAX_ROWS = 4;
  return (
    <div className="rounded-lg border bg-white overflow-hidden">
      <div className="grid grid-cols-7 border-b text-[11px] uppercase tracking-wider text-slate-500 font-medium">
        {dayNames.map(w => (
          <div key={w} className="px-2 py-2 text-center">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const cell = byDay[d.date] || { tasks: [], starts: [], ends: [], entries: [], google: [] };
          const isToday = d.date === todayISO();
          const totalRows = cell.starts.length + cell.ends.length + cell.tasks.length + cell.google.length;
          const shown = { starts: cell.starts.slice(0, MAX_ROWS), ends: [], tasks: [], google: [] };
          let remaining = MAX_ROWS - shown.starts.length;
          shown.ends   = cell.ends.slice(0, Math.max(0, remaining)); remaining -= shown.ends.length;
          shown.tasks  = cell.tasks.slice(0, Math.max(0, remaining)); remaining -= shown.tasks.length;
          shown.google = cell.google.slice(0, Math.max(0, remaining));
          const overflow = totalRows - (shown.starts.length + shown.ends.length + shown.tasks.length + shown.google.length);
          return (
            <div key={d.date}
                  data-testid={`calendar-cell-${d.date}`}
                  onClick={() => d.inPeriod && onCellClick(d.date)}
                  className={`border-b border-r p-1.5 space-y-0.5 min-h-[126px] group ${
                    d.inPeriod ? "bg-white cursor-pointer hover:bg-slate-50/50" : "bg-slate-50/50 text-slate-400"
                  }`}>
              <div className="flex items-center justify-center py-0.5">
                {isToday
                  ? <div className="w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-semibold flex items-center justify-center">
                      {d.date.slice(-2).replace(/^0/, "")}
                    </div>
                  : <div className={`text-xs ${d.inPeriod ? "text-slate-700" : "text-slate-400"}`}>
                      {d.date.slice(-2).replace(/^0/, "")}
                    </div>}
              </div>
              {shown.starts.map(ph => (
                <EventBullet key={"s"+ph.id}
                  dot="bg-amber-500"
                  title={`▶ ${ph.name}`}
                  onClick={(e) => { e.stopPropagation(); onPhaseClick(ph); }}/>
              ))}
              {shown.ends.map(ph => (
                <EventBullet key={"e"+ph.id}
                  dot="bg-rose-500"
                  title={`■ ${ph.name}`}
                  onClick={(e) => { e.stopPropagation(); onPhaseClick(ph); }}/>
              ))}
              {shown.tasks.map(t => (
                <EventBullet key={t.id}
                  dot="bg-cyan-500"
                  time={t.due_time ? fmtTimeShort(`2020-01-01T${t.due_time}:00`) : ""}
                  title={t.title}
                  striked={t.status === "done"}
                  onClick={(e) => { e.stopPropagation(); onTaskClick(t); }}/>
              ))}
              {shown.google.map(e => (
                <EventBullet key={e.id}
                  testid={`calendar-event-${e.id}`}
                  dot="bg-emerald-500"
                  time={e.all_day ? "" : fmtTimeShort(e.start)}
                  title={e.summary || "(no title)"}
                  badge={e.hangout_link ? <Video size={10} className="text-emerald-600"/> : null}
                  onClick={(ev) => { ev.stopPropagation(); onEventClick(e); }}/>
              ))}
              {overflow > 0 && (
                <div className="text-[10px] text-slate-500 px-1 italic">{overflow} more</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Time grid — for Week and Day views (hourly rows, positioned events) */
/* ------------------------------------------------------------------ */
function TimeGrid({ days, byDay, view, onCellClick, onEventClick, onTaskClick }) {
  // 24 hour view, but Google shows an implicit scroll centered near work day
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const HOUR_HEIGHT = 48; // px per hour
  const scrollRef = useRef(null);

  // On mount, scroll to 7am so the workday is visible
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_HEIGHT;
  }, [view]);

  const isToday = (dateStr) => dateStr === todayISO();
  const nowMin  = new Date().getHours() * 60 + new Date().getMinutes();

  return (
    <div className="rounded-lg border bg-white overflow-hidden">
      {/* Day-name headers */}
      <div className={`grid ${view === "day" ? "grid-cols-[64px_1fr]" : "grid-cols-[64px_repeat(7,1fr)]"} border-b bg-slate-50`}>
        <div className="border-r"/>
        {days.map(d => {
          const [y, m, day] = d.date.split("-").map(Number);
          const dt = new Date(y, m - 1, day);
          const dayName = dt.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
          const today = isToday(d.date);
          return (
            <div key={d.date} className="px-2 py-2 text-center border-r last:border-r-0">
              <div className={`text-[11px] font-medium ${today ? "text-emerald-700" : "text-slate-500"}`}>{dayName}</div>
              {today
                ? <div className="mx-auto mt-0.5 w-8 h-8 rounded-full bg-emerald-600 text-white text-base font-semibold flex items-center justify-center">{day}</div>
                : <div className="text-2xl font-light text-slate-700 mt-0.5">{day}</div>}
            </div>
          );
        })}
      </div>

      {/* Body */}
      <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight: "68vh" }}>
        <div className={`relative grid ${view === "day" ? "grid-cols-[64px_1fr]" : "grid-cols-[64px_repeat(7,1fr)]"}`}>
          {/* Hour gutter */}
          <div className="border-r">
            {HOURS.map(h => (
              <div key={h} style={{ height: HOUR_HEIGHT }} className="relative">
                <span className="absolute -top-1.5 right-1 text-[10px] text-slate-400 bg-white px-1">
                  {h === 0 ? "" : (h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`)}
                </span>
              </div>
            ))}
          </div>
          {/* Day columns */}
          {days.map(d => {
            const cell = byDay[d.date] || { tasks: [], starts: [], ends: [], entries: [], google: [] };
            // Timed items: tasks with due_time + Google events with dateTime
            const timedTasks = cell.tasks.filter(t => t.due_time);
            const untimedTasks = cell.tasks.filter(t => !t.due_time);
            const timedGoogle = cell.google.filter(g => !g.all_day && g.start);
            const untimedGoogle = cell.google.filter(g => g.all_day);
            return (
              <div key={d.date}
                    onClick={() => onCellClick(d.date)}
                    className="relative border-r last:border-r-0 hover:bg-slate-50/60 cursor-pointer"
                    style={{ height: HOUR_HEIGHT * 24 }}>
                {/* Hour lines */}
                {HOURS.map(h => (
                  <div key={h} style={{ top: h * HOUR_HEIGHT }}
                       className="absolute inset-x-0 h-px bg-slate-100"/>
                ))}
                {/* Now line */}
                {isToday(d.date) && (
                  <div style={{ top: (nowMin / 60) * HOUR_HEIGHT }}
                       className="absolute inset-x-0 h-px bg-rose-500 z-10">
                    <span className="absolute -top-1 -left-1 w-2 h-2 rounded-full bg-rose-500"/>
                  </div>
                )}
                {/* All-day / untimed rail at top */}
                {(untimedTasks.length > 0 || untimedGoogle.length > 0) && (
                  <div className="absolute inset-x-0 top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-100 px-1 py-1 space-y-0.5">
                    {untimedGoogle.map(g => (
                      <EventBullet key={g.id} dot="bg-emerald-500" title={g.summary || "(no title)"}
                        onClick={(e) => { e.stopPropagation(); onEventClick(g); }}/>
                    ))}
                    {untimedTasks.map(t => (
                      <EventBullet key={t.id} dot="bg-cyan-500" title={t.title}
                        striked={t.status === "done"}
                        onClick={(e) => { e.stopPropagation(); onTaskClick(t); }}/>
                    ))}
                  </div>
                )}
                {/* Timed items */}
                {timedTasks.map(t => {
                  const [h, m] = t.due_time.split(":").map(Number);
                  const top = ((h * 60 + m) / 60) * HOUR_HEIGHT;
                  const height = Math.max(24, ((t.duration_minutes || 30) / 60) * HOUR_HEIGHT);
                  return (
                    <div key={t.id}
                         onClick={(e) => { e.stopPropagation(); onTaskClick(t); }}
                         style={{ top: top + 2, height: height - 4, left: 4, right: 4 }}
                         className={`absolute rounded-md bg-cyan-500 text-white text-xs px-2 py-1 shadow-sm hover:bg-cyan-600 cursor-pointer overflow-hidden ${t.status === "done" ? "line-through opacity-60" : ""}`}>
                      <div className="font-medium truncate">{t.title}</div>
                      <div className="text-[10px] opacity-90">{fmtTimeShort(`2020-01-01T${t.due_time}:00`)}</div>
                    </div>
                  );
                })}
                {timedGoogle.map(g => {
                  const start = new Date(g.start);
                  const end = g.end ? new Date(g.end) : new Date(start.getTime() + 30 * 60000);
                  const top = ((start.getHours() * 60 + start.getMinutes()) / 60) * HOUR_HEIGHT;
                  const durMin = Math.max(15, (end - start) / 60000);
                  const height = Math.max(24, (durMin / 60) * HOUR_HEIGHT);
                  return (
                    <div key={g.id}
                         data-testid={`calendar-event-${g.id}`}
                         onClick={(e) => { e.stopPropagation(); onEventClick(g); }}
                         style={{ top: top + 2, height: height - 4, left: 4, right: 4 }}
                         className="absolute rounded-md bg-emerald-500 text-white text-xs px-2 py-1 shadow-sm hover:bg-emerald-600 cursor-pointer overflow-hidden">
                      <div className="font-medium truncate">{g.summary || "(no title)"}</div>
                      <div className="text-[10px] opacity-90 truncate">
                        {fmtTimeShort(g.start)}–{fmtTimeShort(g.end)}
                        {g.location ? ` · ${g.location}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Compose modal                                                      */
/* ------------------------------------------------------------------ */
export function EventComposeModal({ date, calendarId = "primary", defaultAttendees = [], defaultSummary = "", defaultDescription = "", companyId, onClose, onSaved }) {
  const [summary, setSummary]         = useState(defaultSummary);
  const [description, setDescription] = useState(defaultDescription);
  const [location, setLocation]       = useState("");
  const [startDate, setStartDate]     = useState(date || todayISO());
  const [startTime, setStartTime]     = useState("09:00");
  const [endTime, setEndTime]         = useState("09:30");
  const [allDay, setAllDay]           = useState(false);
  const [attendeesText, setAttendeesText] = useState(
    (defaultAttendees || []).map(a => a.email).filter(Boolean).join(", ")
  );
  const [sendInvites, setSendInvites] = useState(true);
  const [addMeet, setAddMeet]         = useState(false);
  const [busy, setBusy]               = useState(false);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const submit = async () => {
    if (!summary.trim()) { toast.error("Give this event a title"); return; }
    setBusy(true);
    try {
      const attendees = attendeesText.split(/[,;]/).map(s => s.trim()).filter(Boolean)
        .map(email => ({ email }));
      const payload = {
        summary,
        description,
        location,
        calendar_id: calendarId,
        all_day: allDay,
        time_zone: tz,
        start: allDay ? startDate : `${startDate}T${startTime}:00`,
        end:   allDay ? startDate : `${startDate}T${endTime}:00`,
        attendees,
        send_updates: sendInvites ? "all" : "none",
        add_meet_link: addMeet,
        company_id: companyId || undefined,
      };
      await api.post("/google/calendar/events", payload);
      onSaved && onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to create event");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           data-testid="calendar-compose-modal"
           className="bg-white rounded-xl w-full max-w-lg mx-3 shadow-2xl">
        <div className="flex items-center px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold">New event</div>
          <div className="flex-1"/>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X size={16}/>
          </button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <input value={summary} onChange={e => setSummary(e.target.value)}
                 placeholder="Add title"
                 data-testid="event-title"
                 className="w-full px-2 py-2 text-base font-medium border-b border-slate-200 focus:outline-none focus:border-emerald-500"/>
          <div className="flex items-center gap-2">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                   data-testid="event-date"
                   className="px-2 py-1 border border-slate-200 rounded text-sm"/>
            {!allDay && (
              <>
                <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                       data-testid="event-start-time"
                       className="px-2 py-1 border border-slate-200 rounded text-sm"/>
                <span className="text-slate-400">→</span>
                <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                       data-testid="event-end-time"
                       className="px-2 py-1 border border-slate-200 rounded text-sm"/>
              </>
            )}
            <label className="ml-1 text-xs text-slate-600 inline-flex items-center gap-1">
              <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)}
                     data-testid="event-all-day"/> All day
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Users size={14} className="text-slate-400 shrink-0"/>
            <input value={attendeesText} onChange={e => setAttendeesText(e.target.value)}
                   placeholder="Attendees, comma-separated (email@…)"
                   data-testid="event-attendees"
                   className="flex-1 px-2 py-1 border border-slate-200 rounded text-sm"/>
          </div>
          <div className="flex items-center gap-2">
            <MapPin size={14} className="text-slate-400 shrink-0"/>
            <input value={location} onChange={e => setLocation(e.target.value)}
                   placeholder="Location"
                   data-testid="event-location"
                   className="flex-1 px-2 py-1 border border-slate-200 rounded text-sm"/>
          </div>
          <textarea value={description} onChange={e => setDescription(e.target.value)}
                    placeholder="Description"
                    data-testid="event-description"
                    className="w-full px-2 py-1 border border-slate-200 rounded text-sm min-h-[70px]"/>
          <div className="flex items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-1 text-slate-600">
              <input type="checkbox" checked={sendInvites} onChange={e => setSendInvites(e.target.checked)}
                     data-testid="event-send-invites"/>
              Email invites to attendees
            </label>
            <label className="inline-flex items-center gap-1 text-slate-600">
              <input type="checkbox" checked={addMeet} onChange={e => setAddMeet(e.target.checked)}
                     data-testid="event-add-meet"/>
              Add Google Meet link
            </label>
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200">
          <button onClick={submit} disabled={busy}
                  data-testid="event-save-btn"
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin"/> : <Plus size={14}/>}
            Create
          </button>
          <div className="flex-1"/>
          <button onClick={onClose} className="text-sm text-slate-600 hover:text-slate-800">Cancel</button>
        </div>
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Detail modal                                                       */
/* ------------------------------------------------------------------ */
function EventDetailModal({ event, onClose, onDelete }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           data-testid="calendar-event-detail"
           className="bg-white rounded-xl w-full max-w-lg mx-3 shadow-2xl">
        <div className="flex items-center px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold truncate">{event.summary || "(no title)"}</div>
          <div className="flex-1"/>
          {event.html_link && (
            <a href={event.html_link} target="_blank" rel="noreferrer"
               className="text-xs text-emerald-700 hover:underline inline-flex items-center gap-1 mr-3">
              Open in Google <ExternalLink size={11}/>
            </a>
          )}
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X size={16}/>
          </button>
        </div>
        <div className="p-4 space-y-2 text-sm">
          <div className="text-slate-700">
            {event.all_day ? "All day" : `${fmtTime(event.start)} – ${fmtTime(event.end)}`}
            <span className="text-slate-400 ml-2">· {dayOf(event.start)}</span>
          </div>
          {event.location && (
            <div className="text-slate-600 flex items-center gap-1"><MapPin size={12}/> {event.location}</div>
          )}
          {event.hangout_link && (
            <div>
              <a href={event.hangout_link} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                <Video size={13}/> Join Google Meet
              </a>
            </div>
          )}
          {event.description && (
            <div className="text-slate-700 whitespace-pre-wrap text-xs bg-slate-50 border border-slate-200 rounded p-2 max-h-40 overflow-y-auto">
              {event.description}
            </div>
          )}
          {event.attendees?.length > 0 && (
            <div className="text-xs">
              <div className="text-slate-500 mb-1">Attendees</div>
              <div className="space-y-0.5">
                {event.attendees.map((a, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"/>
                    <span className="text-slate-800">{a.display_name || a.email}</span>
                    <span className="text-slate-400 text-[10px]">{a.response_status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200">
          <button onClick={onDelete}
                  data-testid="calendar-event-delete"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-rose-700 hover:bg-rose-50">
            <Trash2 size={14}/> Delete
          </button>
          <div className="flex-1"/>
          <button onClick={onClose} className="text-sm text-slate-600 hover:text-slate-800">Close</button>
        </div>
      </div>
    </div>
  );
}
