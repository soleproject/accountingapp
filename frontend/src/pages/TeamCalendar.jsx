import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CalendarDays, ChevronLeft, ChevronRight, Loader2, Users,
  ClipboardList, Layers as LayersIcon, Clock,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import CalendarEntityDrawer from "@/components/CalendarEntityDrawer";

/**
 * TeamCalendar — /team/calendar (Phase B-3, Feb 2026).
 *
 * A single-payload calendar that overlays three data streams onto
 * one day grid:
 *   • Tasks (with due_date)         — blue chips
 *   • Phase deadlines (start/end)   — amber ribbon (start) + rose ribbon (end)
 *   • Time entries (hours logged)   — emerald hours totals
 *
 * Users can toggle Month ↔ Week views, page through periods, and
 * filter to a single employee (task assignee + time-entry logger).
 */
const PRIORITY_COLORS = {
  high:   "bg-rose-100 text-rose-800 border-rose-200",
  medium: "bg-cyan-100 text-cyan-800 border-cyan-200",
  low:    "bg-slate-100 text-slate-700 border-slate-200",
};

export default function TeamCalendar() {
  const { currentId } = useCompany();
  const [view, setView] = useState("month");   // "month" | "week"
  const [anchor, setAnchor] = useState(() => todayISO());
  const [employeeId, setEmployeeId] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [drilldown, setDrilldown] = useState(null); // {kind, data}

  // Window bounds — computed once per (view, anchor).
  const { from, to, days } = useMemo(
    () => (view === "month" ? monthWindow(anchor) : weekWindow(anchor)),
    [view, anchor]);

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ date_from: from, date_to: to });
      if (employeeId) params.set("employee_id", employeeId);
      const r = await api.get(
        `/companies/${currentId}/team-calendar?${params.toString()}`);
      setData(r.data);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ },
    [currentId, from, to, employeeId]);

  // Index events by ISO date for fast per-cell lookup.
  const byDate = useMemo(() => {
    const map = {};
    const ensure = (d) => (map[d] = map[d] || { tasks: [], starts: [], ends: [], entries: [], hours: 0 });
    for (const t of (data?.tasks || [])) {
      if (t.due_date) ensure(t.due_date).tasks.push(t);
    }
    for (const ph of (data?.phases || [])) {
      if (ph.start_date) ensure(ph.start_date).starts.push(ph);
      if (ph.end_date)   ensure(ph.end_date  ).ends.push(ph);
    }
    for (const te of (data?.time_entries || [])) {
      const d = ensure(te.date);
      d.entries.push(te);
      d.hours += Number(te.hours || 0);
    }
    for (const d of Object.values(map)) d.hours = Math.round(d.hours * 100) / 100;
    return map;
  }, [data]);

  const shift = (delta) => {
    setAnchor(view === "month" ? shiftMonth(anchor, delta) : shiftIso(anchor, delta * 7));
  };

  // Employees can be filtered even before the first data payload
  // — expose the list from `data.employees` (returned on every call).
  const employees = data?.employees || [];
  const totals = data?.counts || {tasks: 0, phases: 0, time_entries: 0};

  return (
    <div className="max-w-7xl space-y-5" data-testid="team-calendar-page">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <CalendarDays size={22} className="text-emerald-600" />
            Calendar
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Tasks, phase deadlines, and time entries on one grid. Filter to any teammate to see just their week.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Employee filter */}
          <label className="text-xs text-slate-600 flex items-center gap-1.5">
            <Users size={12} className="text-slate-400" />
            <select value={employeeId}
                    onChange={(e) => setEmployeeId(e.target.value)}
                    data-testid="calendar-employee-filter"
                    className="border border-slate-200 rounded px-2 py-1 bg-white text-xs">
              <option value="">All teammates</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </label>
          {/* View toggle */}
          <div className="inline-flex rounded-md border border-slate-200 overflow-hidden text-xs"
                data-testid="calendar-view-toggle">
            <button onClick={() => setView("month")}
                    data-testid="calendar-view-month"
                    className={`px-3 py-1.5 ${view === "month" ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
              Month
            </button>
            <button onClick={() => setView("week")}
                    data-testid="calendar-view-week"
                    className={`px-3 py-1.5 border-l border-slate-200 ${view === "week" ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
              Week
            </button>
          </div>
        </div>
      </div>

      {/* Nav strip */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-2"
              data-testid="calendar-period-label">
          {view === "month" ? monthLabel(anchor) : `Week of ${from}`}
          {loading && <Loader2 size={12} className="animate-spin text-slate-400" />}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => shift(-1)}
                  data-testid="calendar-nav-prev"
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                  title={view === "month" ? "Previous month" : "Previous week"}>
            <ChevronLeft size={14} />
          </button>
          <button onClick={() => setAnchor(todayISO())}
                  data-testid="calendar-nav-today"
                  className="text-xs px-2.5 py-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">
            Today
          </button>
          <button onClick={() => shift(1)}
                  data-testid="calendar-nav-next"
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                  title={view === "month" ? "Next month" : "Next week"}>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="rounded-xl border bg-white overflow-hidden"
            data-testid={`calendar-grid-${view}`}>
        {/* Weekday header */}
        <div className="grid grid-cols-7 bg-slate-50 border-b text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(w => (
            <div key={w} className="px-2 py-2 text-center">{w}</div>
          ))}
        </div>
        {/* Cells */}
        <div className={`grid grid-cols-7 ${view === "week" ? "min-h-[420px]" : ""}`}>
          {days.map((d, i) => {
            const cell = byDate[d.date] || { tasks: [], starts: [], ends: [], entries: [], hours: 0 };
            const isToday = d.date === todayISO();
            return (
              <div key={d.date + i}
                    data-testid={`calendar-cell-${d.date}`}
                    className={`border-b border-r p-1.5 space-y-1 ${
                      d.inPeriod ? "bg-white" : "bg-slate-50/50 text-slate-400"
                    } ${view === "week" ? "min-h-[400px]" : "min-h-[110px]"}`}>
                <div className={`flex items-center justify-between text-[11px] ${
                    isToday ? "text-emerald-700 font-bold" : "text-slate-600"
                  }`}>
                  <span>
                    {view === "month" && d.date.slice(-2).replace(/^0/, "")}
                    {view === "week" && (
                      <>
                        <span className="uppercase tracking-wider text-[9px] text-slate-400 mr-1">
                          {weekdayShort(d.date)}
                        </span>
                        {d.date.slice(-2).replace(/^0/, "")}
                      </>
                    )}
                  </span>
                  {cell.hours > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1 font-mono-num"
                            data-testid={`calendar-hours-${d.date}`}
                            title={`${cell.hours}h logged`}>
                      <Clock size={9} />{cell.hours}h
                    </span>
                  )}
                </div>
                {/* Phase start markers */}
                {cell.starts.map(ph => (
                  <div key={"s"+ph.id}
                        onClick={(e) => { e.stopPropagation(); setDrilldown({kind:"phase", data: ph}); }}
                        data-testid={`calendar-phase-start-${ph.id}`}
                        title={`${ph.project_name} · ${ph.name} — starts`}
                        className="text-[10px] rounded px-1 py-0.5 bg-amber-50 border border-amber-200 text-amber-800 flex items-center gap-0.5 truncate cursor-pointer hover:bg-amber-100">
                    <LayersIcon size={9} />▶ {ph.name}
                  </div>
                ))}
                {/* Phase end markers */}
                {cell.ends.map(ph => (
                  <div key={"e"+ph.id}
                        onClick={(e) => { e.stopPropagation(); setDrilldown({kind:"phase", data: ph}); }}
                        data-testid={`calendar-phase-end-${ph.id}`}
                        title={`${ph.project_name} · ${ph.name} — ends`}
                        className="text-[10px] rounded px-1 py-0.5 bg-rose-50 border border-rose-200 text-rose-800 flex items-center gap-0.5 truncate cursor-pointer hover:bg-rose-100">
                    <LayersIcon size={9} />■ {ph.name}
                  </div>
                ))}
                {/* Tasks */}
                {cell.tasks.map(t => (
                  <div key={t.id}
                        onClick={(e) => { e.stopPropagation(); setDrilldown({kind:"task", data: t}); }}
                        data-testid={`calendar-task-${t.id}`}
                        title={`${t.title}${t.entity_label ? " · " + t.entity_label : ""}${t.priority ? " · " + t.priority : ""}`}
                        className={`text-[10px] rounded px-1 py-0.5 flex items-center gap-0.5 truncate border cursor-pointer hover:brightness-95 ${
                          PRIORITY_COLORS[t.priority] || PRIORITY_COLORS.medium
                        } ${t.status === "done" ? "line-through opacity-60" : ""}`}>
                    <ClipboardList size={9} />{t.title}
                  </div>
                ))}
                {/* Time entries — collapse to one row in month view */}
                {view === "week" && cell.entries.slice(0, 4).map(te => (
                  <div key={te.id}
                        onClick={(e) => { e.stopPropagation(); setDrilldown({kind:"time", data: te}); }}
                        data-testid={`calendar-time-${te.id}`}
                        title={`${te.employee_name} · ${te.project_name}${te.phase_name ? " › " + te.phase_name : ""} · ${te.hours}h`}
                        className="text-[10px] rounded px-1 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-center gap-0.5 truncate cursor-pointer hover:bg-emerald-100">
                    <Clock size={9} />{te.employee_name.split(" ")[0]} · {te.hours}h
                  </div>
                ))}
                {view === "week" && cell.entries.length > 4 && (
                  <div className="text-[9px] text-slate-500 italic">
                    + {cell.entries.length - 4} more…
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend + summary */}
      <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
        <div className="flex items-center gap-3 flex-wrap text-slate-600">
          <Legend swatch="bg-cyan-100 border-cyan-200" label="Task" />
          <Legend swatch="bg-amber-50 border-amber-200" label="Phase start" />
          <Legend swatch="bg-rose-50 border-rose-200" label="Phase end" />
          <Legend swatch="bg-emerald-50 border-emerald-200" label="Time logged" />
        </div>
        <div className="text-slate-500 flex items-center gap-3">
          <span data-testid="calendar-counts-tasks"><b>{totals.tasks}</b> tasks</span>
          <span data-testid="calendar-counts-phases"><b>{totals.phases}</b> phases</span>
          <span data-testid="calendar-counts-entries"><b>{totals.time_entries}</b> time entries</span>
          <Link to="/team/time" className="text-emerald-600 hover:underline">
            Go to Time →
          </Link>
        </div>
      </div>

      {drilldown && (
        <CalendarEntityDrawer
          entity={drilldown}
          onClose={() => setDrilldown(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

// ------------ helpers ------------
function Legend({ swatch, label }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block w-3 h-3 rounded border ${swatch}`} />
      {label}
    </span>
  );
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function shiftIso(iso, deltaDays) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function shiftMonth(iso, delta) {
  const [y, m] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return dt.toISOString().slice(0, 10);
}

function weekdayShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
}

function monthLabel(iso) {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

// Monday-anchored week window (7 cells).
function weekWindow(anchorIso) {
  const [y, m, d] = anchorIso.split("-").map(Number);
  const anc = new Date(Date.UTC(y, m - 1, d));
  const dow = anc.getUTCDay();          // 0=Sun..6=Sat
  const backToMon = (dow + 6) % 7;
  const monday = new Date(anc.getTime() - backToMon * 86400000);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(monday.getTime() + i * 86400000);
    days.push({ date: dt.toISOString().slice(0, 10), inPeriod: true });
  }
  return { from: days[0].date, to: days[6].date, days };
}

// Month window: 6-row grid starting on Monday, so leading/trailing days
// from adjacent months are filled in but flagged inPeriod=false.
function monthWindow(anchorIso) {
  const [y, m] = anchorIso.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const firstDow = first.getUTCDay();
  const leadingDays = (firstDow + 6) % 7;   // # cells from previous month
  const gridStart = new Date(first.getTime() - leadingDays * 86400000);
  const days = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(gridStart.getTime() + i * 86400000);
    days.push({
      date: dt.toISOString().slice(0, 10),
      inPeriod: dt.getUTCMonth() === m - 1,
    });
  }
  return { from: days[0].date, to: days[41].date, days };
}
