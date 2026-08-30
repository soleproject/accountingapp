import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  X, ClipboardList, Layers as LayersIcon, Clock, ExternalLink,
  Check, Trash2, Briefcase, User,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";

/**
 * CalendarEntityDrawer — right-side drawer for calendar drilldowns
 * (Phase B-3 polish, Feb 2026).
 *
 * `entity` shape:
 *   { kind: "task" | "phase" | "time", data: {…row from calendar API…} }
 *
 * All three actions post back through the same familiar endpoints,
 * so drilling in from the calendar feels identical to acting from
 * the Tasks drawer, Project detail, or Time page.
 */
export default function CalendarEntityDrawer({ entity, onClose, onChanged }) {
  const nav = useNavigate();
  const { currentId } = useCompany();
  const fmt = useMoneyFmt();
  if (!entity) return null;

  const { kind, data } = entity;

  return (
    <div className="fixed inset-0 z-[95] flex justify-end"
          role="dialog" aria-modal="true"
          data-testid="calendar-entity-drawer">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]"
            onClick={onClose} />
      <div className="relative bg-white shadow-2xl h-full w-full max-w-md flex flex-col animate-in slide-in-from-right duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2 text-sm">
            {kind === "task"  && <ClipboardList size={14} className="text-cyan-600" />}
            {kind === "phase" && <LayersIcon size={14} className="text-amber-600" />}
            {kind === "time"  && <Clock size={14} className="text-emerald-600" />}
            <span className="uppercase tracking-wider text-[10px] text-slate-500">
              {kind === "task" ? "Task" : kind === "phase" ? "Phase" : "Time entry"}
            </span>
          </div>
          <button onClick={onClose}
                  data-testid="calendar-drawer-close"
                  className="p-1 rounded hover:bg-slate-100 text-slate-400">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {kind === "task" && <TaskDrawer t={data} onClose={onClose}
                                            onChanged={onChanged} />}
          {kind === "phase" && <PhaseDrawer ph={data} onClose={onClose}
                                             nav={nav} />}
          {kind === "time" && <TimeDrawer t={data} onClose={onClose}
                                            onChanged={onChanged} fmt={fmt}
                                            currentId={currentId} />}
        </div>
      </div>
    </div>
  );
}

// ---------------- Task detail ----------------
function TaskDrawer({ t, onClose, onChanged }) {
  const { currentId } = useCompany();

  const toggle = async () => {
    try {
      await api.post(`/companies/${currentId}/tasks/${t.id}/complete`);
      toast.success(t.status === "done" ? "Reopened" : "Marked done");
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };
  const del = async () => {
    if (!confirm(`Delete "${t.title}"?`)) return;
    try {
      await api.delete(`/companies/${currentId}/tasks/${t.id}`);
      toast.success("Deleted");
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  return (
    <>
      <div>
        <h2 className="font-heading text-lg font-bold text-slate-900" data-testid="drawer-task-title">
          {t.title}
        </h2>
        <div className="text-xs text-slate-500 mt-1">
          {t.status === "done" ? "Completed" : "Open"}
          {t.priority && <> · <span className="capitalize">{t.priority}</span> priority</>}
          {t.due_date && <> · Due <b className="font-mono-num text-slate-700">{t.due_date}</b></>}
          {t.due_time && <> · <b className="font-mono-num text-slate-700">{t.due_time}</b></>}
          {t.duration_minutes ? <> · {t.duration_minutes} min</> : null}
          {t.kind && t.kind !== "task" && <> · <span className="capitalize">{t.kind}</span></>}
          {t.assignee_user_ids && t.assignee_user_ids.length > 1 && (
            <> · {t.assignee_user_ids.length} assignees</>
          )}
        </div>
      </div>
      {t.description && (
        <div className="rounded-lg border bg-slate-50/60 p-3 text-sm text-slate-700 whitespace-pre-wrap"
              data-testid="drawer-task-description">
          {t.description}
        </div>
      )}
      {t.entity_type && t.entity_label && (
        <div className="text-xs text-slate-600 border rounded-lg p-3 bg-white">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Linked to</div>
          <div className="text-sm text-slate-800 mt-0.5 capitalize">
            {t.entity_type} · {t.entity_label}
          </div>
        </div>
      )}
      <div className="flex gap-2 pt-2">
        <button onClick={toggle}
                data-testid="drawer-task-toggle"
                className="text-sm px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 inline-flex items-center gap-1.5">
          <Check size={13} /> {t.status === "done" ? "Reopen" : "Mark done"}
        </button>
        <button onClick={del}
                data-testid="drawer-task-delete"
                className="text-sm px-3 py-1.5 rounded-md border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 inline-flex items-center gap-1.5">
          <Trash2 size={13} /> Delete
        </button>
      </div>
    </>
  );
}

// ---------------- Phase detail ----------------
function PhaseDrawer({ ph, onClose, nav }) {
  const openProject = () => {
    onClose();
    if (ph.project_id) nav(`/accounting/projects/${ph.project_id}`);
  };
  return (
    <>
      <div>
        <h2 className="font-heading text-lg font-bold text-slate-900" data-testid="drawer-phase-title">
          {ph.name}
        </h2>
        <div className="text-xs text-slate-500 mt-1 flex items-center gap-1">
          <Briefcase size={11} />
          <b className="text-slate-700">{ph.project_name || "Project"}</b>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Kv label="Start" value={ph.start_date || "—"} />
        <Kv label="End"   value={ph.end_date   || "—"} />
        <Kv label="Status" value={(ph.status || "in_progress").replace("_", " ")} className="capitalize" />
      </div>
      <button onClick={openProject}
              data-testid="drawer-phase-open-project"
              className="text-sm px-3 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800 inline-flex items-center gap-1.5">
        <ExternalLink size={13} /> Open project
      </button>
    </>
  );
}

// ---------------- Time entry detail ----------------
function TimeDrawer({ t, onClose, onChanged, fmt, currentId }) {
  const cost = Number(t.hours || 0) * Number(t.cost_rate_snapshot || 0);
  const del = async () => {
    if (!confirm(`Delete ${t.hours}h on ${t.date}?`)) return;
    try {
      await api.delete(`/companies/${currentId}/time-entries/${t.id}`);
      toast.success("Deleted");
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };
  return (
    <>
      <div>
        <h2 className="font-heading text-lg font-bold text-slate-900" data-testid="drawer-time-title">
          {Number(t.hours || 0).toFixed(2)}h logged
        </h2>
        <div className="text-xs text-slate-500 mt-1 flex items-center gap-1">
          <User size={11} /> {t.employee_name || "—"}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Kv label="Date" value={t.date} />
        <Kv label="Billable" value={t.billable ? "Yes" : "No"} />
        <Kv label="Project" value={t.project_name || "—"} />
        <Kv label="Phase" value={t.phase_name || "—"} />
        <Kv label="Rate / hr" value={fmt(t.cost_rate_snapshot || 0)} />
        <Kv label="Labor cost" value={fmt(cost)} className="text-emerald-700 font-semibold" />
        <Kv label="Status" value={(t.status || "approved")} className="capitalize" />
      </div>
      {t.notes && (
        <div className="rounded-lg border bg-slate-50/60 p-3 text-sm text-slate-700 whitespace-pre-wrap">
          {t.notes}
        </div>
      )}
      <button onClick={del}
              data-testid="drawer-time-delete"
              className="text-sm px-3 py-1.5 rounded-md border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 inline-flex items-center gap-1.5">
        <Trash2 size={13} /> Delete
      </button>
    </>
  );
}

function Kv({ label, value, className = "" }) {
  return (
    <div className="rounded border border-slate-200 bg-white p-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-sm text-slate-800 mt-0.5 ${className}`}>{value}</div>
    </div>
  );
}
