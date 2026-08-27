import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { Play, Square, Loader2, Clock, X } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * TimeTimer — live-clock timer for /team/time (Phase B-3 polish).
 *
 * Users pick an employee + project + phase, hit Start, and a
 * running clock ticks up. When they hit Stop, the elapsed time
 * is rounded to 2 decimal hours and POSTed as a new time entry.
 *
 * State survives reloads by mirroring into localStorage:
 *   { started_at, employee_id, project_id, phase_id, notes, billable }
 * so field crews can start a timer on their phone, close the app,
 * and stop it later without losing the elapsed time.
 */
const LS_KEY = "axiom_time_timer_v1";
// Per-company namespace so switching companies mid-timer doesn't
// accidentally POST an entry to the wrong tenant.
function keyFor(cid) { return `${LS_KEY}::${cid || "none"}`; }

export default function TimeTimer({ onSaved }) {
  const { currentId } = useCompany();
  const [employees, setEmployees] = useState([]);
  const [projects, setProjects] = useState([]);
  const [phases, setPhases] = useState([]);
  const [saving, setSaving] = useState(false);
  const [tick, setTick] = useState(0);
  const tickRef = useRef(null);

  // Load persisted timer state — or start blank.
  const [timer, setTimer] = useState(() => readLS(null));
  const running = !!timer.started_at;

  // Reload timer state when the active company changes (per-tenant
  // key namespace prevents cross-company leakage).
  useEffect(() => {
    setTimer(readLS(currentId));
  }, [currentId]);

  // Load employees + projects.
  useEffect(() => {
    if (!currentId) return;
    (async () => {
      try {
        const [emp, proj] = await Promise.all([
          api.get(`/companies/${currentId}/employees`),
          api.get(`/companies/${currentId}/projects`),
        ]);
        setEmployees(emp.data?.employees || []);
        setProjects((proj.data?.projects || []).filter(p => p.active !== false));
        setTimer(t => {
          if (t.employee_id || !emp.data?.employees?.length) return t;
          if (emp.data.employees.length === 1) {
            return { ...t, employee_id: emp.data.employees[0].id };
          }
          return t;
        });
      } catch { /* silent */ }
    })();
  }, [currentId]);

  // Load phases whenever project changes.
  useEffect(() => {
    if (!currentId || !timer.project_id) { setPhases([]); return; }
    (async () => {
      try {
        const r = await api.get(
          `/companies/${currentId}/projects/${timer.project_id}/phases`);
        setPhases(r.data?.phases || []);
      } catch { /* silent */ }
    })();
  }, [currentId, timer.project_id]);

  // Tick 1s while running to force re-render of the display.
  useEffect(() => {
    if (!running) return;
    tickRef.current = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(tickRef.current);
  }, [running]);

  // Persist timer state.
  useEffect(() => { writeLS(currentId, timer); }, [currentId, timer]);

  const canStart = timer.employee_id && timer.project_id;

  const start = () => {
    if (!canStart) return;
    setTimer(t => ({ ...t, started_at: new Date().toISOString() }));
    setTick(0);
    toast.success("Timer started");
  };

  const stop = async () => {
    if (!running) return;
    const startedMs = new Date(timer.started_at).getTime();
    const elapsedMs = Date.now() - startedMs;
    // Round to nearest 0.01 hour (~36 seconds). Enforce a 1-min floor
    // so a stray double-click doesn't drop a 0.00-hour entry.
    let hours = Math.max(1 / 60, elapsedMs / 3_600_000);
    hours = Math.round(hours * 100) / 100;
    // Also cap at 24 to satisfy backend guard.
    if (hours > 24) hours = 24;
    const date = timer.started_at.slice(0, 10);
    setSaving(true);
    try {
      const payload = {
        employee_id: timer.employee_id,
        project_id: timer.project_id,
        phase_id: timer.phase_id || null,
        date, hours,
        billable: !!timer.billable,
        notes: timer.notes || "",
      };
      const r = await api.post(
        `/companies/${currentId}/time-entries`, payload);
      toast.success(`Logged ${hours}h`);
      // Clear the timer but keep the last-picked employee/project so
      // field crews can start another timer with one click.
      setTimer(t => ({ ...t, started_at: null, notes: "" }));
      onSaved?.(r.data?.time_entry);
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  const discard = () => {
    if (!confirm("Discard the running timer? Elapsed time won't be saved.")) return;
    setTimer(t => ({ ...t, started_at: null }));
    toast.message("Timer discarded");
  };

  const elapsed = running
    ? Date.now() - new Date(timer.started_at).getTime()
    : 0;

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${
        running
          ? "bg-emerald-50/60 border-emerald-300 shadow-inner"
          : "bg-white"
      }`}
        data-testid="time-timer">
      <div className="flex items-center gap-2 flex-wrap justify-between">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
          <Clock size={13} className={running ? "text-emerald-600" : "text-slate-500"} />
          Timer
          {running && (
            <span className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-700 bg-emerald-100 border border-emerald-200 rounded px-1.5 py-0.5"
                  data-testid="timer-running-pill">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse" />
              Running
            </span>
          )}
        </div>
        <div className="font-mono-num text-2xl tabular-nums text-slate-900"
              data-testid="timer-display" title="Elapsed time">
          {formatElapsed(elapsed)}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <select value={timer.employee_id}
                  onChange={(e) => !running && setTimer(t => ({...t, employee_id: e.target.value}))}
                  disabled={running}
                  data-testid="timer-employee"
                  className="border border-slate-300 rounded px-2 py-1.5 text-sm bg-white disabled:bg-slate-50">
          <option value="">— employee —</option>
          {employees.map(e => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        <select value={timer.project_id}
                  onChange={(e) => !running && setTimer(t => ({
                    ...t, project_id: e.target.value, phase_id: ""}))}
                  disabled={running}
                  data-testid="timer-project"
                  className="border border-slate-300 rounded px-2 py-1.5 text-sm bg-white disabled:bg-slate-50">
          <option value="">— project —</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={timer.phase_id}
                  onChange={(e) => !running && setTimer(t => ({...t, phase_id: e.target.value}))}
                  disabled={running || !timer.project_id || phases.length === 0}
                  data-testid="timer-phase"
                  className="border border-slate-300 rounded px-2 py-1.5 text-sm bg-white disabled:bg-slate-50 disabled:text-slate-400">
          <option value="">(no phase)</option>
          {phases.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <label className="text-xs text-slate-700 flex items-center gap-1.5 h-full px-1">
          <input type="checkbox" checked={!!timer.billable}
                  disabled={running}
                  onChange={(e) => setTimer(t => ({...t, billable: e.target.checked}))}
                  data-testid="timer-billable" />
          Billable
        </label>
        <input value={timer.notes}
                onChange={(e) => setTimer(t => ({...t, notes: e.target.value}))}
                placeholder="What are you working on?"
                data-testid="timer-notes"
                className="border border-slate-300 rounded px-2 py-1.5 text-sm" />
      </div>

      <div className="flex gap-2 justify-end">
        {running && (
          <button onClick={discard}
                  data-testid="timer-discard"
                  className="text-xs px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1">
            <X size={12} /> Discard
          </button>
        )}
        {!running ? (
          <button onClick={start}
                  disabled={!canStart}
                  data-testid="timer-start"
                  className="text-sm px-4 py-1.5 rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Play size={13} /> Start timer
          </button>
        ) : (
          <button onClick={stop}
                  disabled={saving}
                  data-testid="timer-stop"
                  className="text-sm px-4 py-1.5 rounded-md bg-rose-600 text-white font-medium hover:bg-rose-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />}
            Stop & log
          </button>
        )}
      </div>
    </div>
  );
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function readLS(cid) {
  try {
    const s = localStorage.getItem(keyFor(cid));
    if (!s) return _blank();
    const p = JSON.parse(s);
    return { ..._blank(), ...p };
  } catch { return _blank(); }
}
function writeLS(cid, t) {
  try { localStorage.setItem(keyFor(cid), JSON.stringify(t)); } catch { /* full disk / private mode */ }
}
function _blank() {
  return { started_at: null, employee_id: "", project_id: "", phase_id: "",
            notes: "", billable: true };
}
