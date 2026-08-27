import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Clock, Loader2, Trash2, Building2, ChevronLeft, ChevronRight, Filter,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import TimeEntryForm from "@/components/TimeEntryForm";

/**
 * TimeLog — /team/time (Phase B-3, Feb 2026).
 *
 * The personal time-tracking hub. Shows a Monday-anchored weekly
 * summary strip, a log form, and a day-grouped list of entries.
 * Users can filter by project or "billable only", and step forward
 * and back through weeks with the arrow buttons.
 */
export default function TimeLog() {
  const { currentId, current } = useCompany();
  const fmt = useMoneyFmt();

  // Monday anchor for the summary strip. Defaults to this week.
  const [anchor, setAnchor] = useState(() => todayISO());
  const [week, setWeek] = useState(null);
  const [loadingWeek, setLoadingWeek] = useState(false);

  // Filters for the day-grouped list.
  const [projectFilter, setProjectFilter] = useState("");
  const [billableOnly, setBillableOnly] = useState(false);
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState({ total_hours: 0, total_cost: 0 });
  const [loadingList, setLoadingList] = useState(false);
  const [projects, setProjects] = useState([]);

  // ---------- data loaders ----------
  const loadWeek = async (iso = anchor) => {
    if (!currentId) return;
    setLoadingWeek(true);
    try {
      const r = await api.get(
        `/companies/${currentId}/time-entries/my-week?anchor=${iso}`);
      setWeek(r.data);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoadingWeek(false); }
  };

  const loadList = async () => {
    if (!currentId) return;
    setLoadingList(true);
    try {
      // 30-day window ending today.
      const to = todayISO();
      const from = shiftIso(to, -30);
      const params = new URLSearchParams({ date_from: from, date_to: to });
      if (projectFilter) params.set("project_id", projectFilter);
      if (billableOnly) params.set("billable", "true");
      const r = await api.get(
        `/companies/${currentId}/time-entries?${params.toString()}`);
      setRows(r.data?.time_entries || []);
      setTotals({
        total_hours: r.data?.total_hours || 0,
        total_cost: r.data?.total_cost || 0,
      });
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoadingList(false); }
  };

  const loadProjects = async () => {
    if (!currentId) return;
    try {
      const r = await api.get(`/companies/${currentId}/projects`);
      setProjects((r.data?.projects || []).filter(p => p.active !== false));
    } catch { /* silent */ }
  };

  useEffect(() => { loadWeek(); loadProjects(); /* eslint-disable-next-line */ }, [currentId]);
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [currentId, projectFilter, billableOnly]);

  const shiftWeek = (delta) => {
    const next = shiftIso(anchor, delta * 7);
    setAnchor(next);
    loadWeek(next);
  };

  const deleteEntry = async (t) => {
    if (!confirm(`Delete ${t.hours}h on ${t.date}?`)) return;
    try {
      await api.delete(`/companies/${currentId}/time-entries/${t.id}`);
      toast.success("Deleted");
      await Promise.all([loadList(), loadWeek()]);
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  // Group list rows by date for the day sections.
  const grouped = useMemo(() => {
    const g = {};
    for (const r of rows) {
      (g[r.date] = g[r.date] || []).push(r);
    }
    return Object.entries(g)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))     // newest first
      .map(([date, entries]) => ({
        date,
        entries,
        hours: round2(entries.reduce((s, r) => s + Number(r.hours || 0), 0)),
        cost: round2(entries.reduce((s, r) =>
          s + Number(r.hours || 0) * Number(r.cost_rate_snapshot || 0), 0)),
      }));
  }, [rows]);

  return (
    <div className="max-w-5xl space-y-6" data-testid="time-log-page">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
          <Clock size={22} className="text-emerald-600" />
          Time
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Log hours against a project or phase. Labor cost rolls into the project P&amp;L automatically — no journal entry required.
        </p>
      </div>

      {/* Weekly summary strip */}
      <div className="rounded-xl border bg-white p-4 space-y-3" data-testid="time-week-strip">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-900">
            {week ? `Week of ${week.monday}` : "This week"}
            {loadingWeek && <Loader2 size={12} className="inline animate-spin ml-2 text-slate-400" />}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => shiftWeek(-1)}
                    data-testid="time-week-prev"
                    className="p-1.5 rounded hover:bg-slate-100 text-slate-500" title="Previous week">
              <ChevronLeft size={14} />
            </button>
            <button onClick={() => { setAnchor(todayISO()); loadWeek(todayISO()); }}
                    data-testid="time-week-today"
                    className="text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">
              This week
            </button>
            <button onClick={() => shiftWeek(1)}
                    data-testid="time-week-next"
                    className="p-1.5 rounded hover:bg-slate-100 text-slate-500" title="Next week">
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-2">
          {(week?.days || Array.from({length:7}).map(() => ({date:"", hours:0, entries:[]}))).map((d, i) => (
            <div key={d.date || i}
                  data-testid={`time-week-day-${d.date || i}`}
                  className={`rounded-lg border p-2 text-center ${
                    d.hours > 0 ? "bg-emerald-50/60 border-emerald-200" : "bg-slate-50 border-slate-100"}`}>
              <div className="text-[9px] uppercase tracking-wider text-slate-500">
                {d.date ? weekdayShort(d.date) : "—"}
              </div>
              <div className="text-[10px] text-slate-500">{d.date?.slice(5) || ""}</div>
              <div className={`text-lg font-mono-num mt-0.5 ${d.hours > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                {d.hours.toFixed(1)}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-slate-400">hrs</div>
            </div>
          ))}
        </div>
        <div className="text-xs text-slate-600 flex justify-between border-t pt-2">
          <span>{week?.employee_name ? <>Logging as <b>{week.employee_name}</b></> : "Not linked to an employee — logging shows entries you created"}</span>
          <span className="font-mono-num text-slate-800"><b>{(week?.total_hours || 0).toFixed(2)}</b> hrs this week</span>
        </div>
      </div>

      {/* Log form */}
      <TimeEntryForm onSaved={() => { loadList(); loadWeek(); }} />

      {/* Filters + last 30 days */}
      <div className="rounded-xl border bg-white">
        <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b">
          <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
            <Filter size={12} className="text-slate-500" /> Last 30 days
            {loadingList && <Loader2 size={12} className="inline animate-spin ml-1 text-slate-400" />}
          </div>
          <div className="flex items-center gap-2">
            <select value={projectFilter}
                      onChange={(e) => setProjectFilter(e.target.value)}
                      data-testid="time-filter-project"
                      className="text-xs border border-slate-200 rounded px-2 py-1 bg-white">
              <option value="">All projects</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={billableOnly}
                        onChange={(e) => setBillableOnly(e.target.checked)}
                        data-testid="time-filter-billable" />
              Billable only
            </label>
          </div>
        </div>
        {rows.length === 0 && !loadingList ? (
          <div className="p-10 text-center text-slate-500 text-sm">
            No time entries in the last 30 days.
            <div className="text-xs text-slate-400 italic mt-1">Use the form above to log your first hour.</div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="time-day-list">
            {grouped.map(day => (
              <li key={day.date} data-testid={`time-day-${day.date}`}>
                <div className="px-4 py-2 bg-slate-50/60 flex items-center justify-between text-xs">
                  <div className="text-slate-700 font-medium">
                    {longDate(day.date)}
                    <span className="text-slate-400"> · {weekdayShort(day.date)}</span>
                  </div>
                  <div className="text-slate-600 font-mono-num">
                    <b>{day.hours.toFixed(2)}</b> hrs
                    <span className="text-slate-400"> · {fmt(day.cost)}</span>
                  </div>
                </div>
                <ul className="divide-y divide-slate-100">
                  {day.entries.map(t => (
                    <li key={t.id}
                        data-testid={`time-entry-${t.id}`}
                        className="px-4 py-2 grid grid-cols-12 gap-2 items-center hover:bg-slate-50">
                      <div className="col-span-4 min-w-0">
                        <div className="text-sm text-slate-800 truncate flex items-center gap-1.5">
                          <Building2 size={11} className="text-slate-400" />
                          {t.project_name}
                          {t.phase_name && (
                            <>
                              <span className="text-slate-300">›</span>
                              <span className="text-slate-600">{t.phase_name}</span>
                            </>
                          )}
                        </div>
                        {t.notes && (
                          <div className="text-[11px] text-slate-500 mt-0.5 truncate">{t.notes}</div>
                        )}
                      </div>
                      <div className="col-span-3 text-[11px] text-slate-500 truncate">
                        {t.employee_name}
                      </div>
                      <div className="col-span-1 text-right">
                        {t.billable ? (
                          <span className="text-[10px] uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1">bill</span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wider text-slate-500 bg-slate-100 border border-slate-200 rounded px-1">int</span>
                        )}
                      </div>
                      <div className="col-span-2 text-right font-mono-num text-sm text-slate-800">
                        {Number(t.hours).toFixed(2)} hrs
                      </div>
                      <div className="col-span-1 text-right font-mono-num text-xs text-slate-500">
                        {fmt(Number(t.hours) * Number(t.cost_rate_snapshot || 0))}
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <button onClick={() => deleteEntry(t)}
                                title="Delete"
                                data-testid={`time-entry-delete-${t.id}`}
                                className="p-1 rounded hover:bg-red-50 text-red-500">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {rows.length > 0 && (
          <div className="px-4 py-2 border-t bg-slate-50 flex justify-between text-xs">
            <span className="text-slate-600">{rows.length} entries · virtual roll-up (no GL posting)</span>
            <span className="font-mono-num text-slate-800">
              <b>{(totals.total_hours || 0).toFixed(2)}</b> hrs · {fmt(totals.total_cost || 0)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- date helpers ----------
function todayISO() { return new Date().toISOString().slice(0, 10); }

function shiftIso(iso, deltaDays) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function weekdayShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
}

function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
}

function round2(n) { return Math.round(n * 100) / 100; }
