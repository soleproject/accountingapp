import { useEffect, useMemo, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CheckSquare, X, Plus, Loader2, Circle, CheckCircle2, Trash2,
  Calendar, AlertCircle, Sparkles,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";

/**
 * GlobalTasksButton — top-bar icon + count badge that opens the
 * cross-product Tasks drawer. Visible in every product because it
 * lives on the shared Layout.
 *
 * The drawer:
 *   • filter chips (Open / Today / Overdue / Mine / Done)
 *   • quick-add input at the bottom of the drawer
 *   • per-task: checkbox → toggle done, click → jump to entity
 *
 * Backed by /api/companies/{cid}/tasks (Phase A-1).
 */
const FILTERS = [
  ["open",     "Open"],
  ["today",    "Today"],
  ["overdue",  "Overdue"],
  ["mine",     "Mine"],
  ["done",     "Done"],
];
const PRIORITY_COLOR = {
  high:   "text-rose-600",
  medium: "text-amber-500",
  low:    "text-slate-400",
};

export default function GlobalTasksButton() {
  const { currentId } = useCompany();
  const [open, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);

  // Poll the open-count every 60s so the badge stays roughly fresh
  // even when the drawer isn't open. Cheap ping.
  const refreshCount = useCallback(async () => {
    if (!currentId) return;
    try {
      const r = await api.get(
        `/companies/${currentId}/tasks?filter=open`);
      setOpenCount(r.data?.count || 0);
    } catch { /* silent */ }
  }, [currentId]);
  useEffect(() => {
    refreshCount();
    const id = setInterval(refreshCount, 60000);
    return () => clearInterval(id);
  }, [refreshCount]);

  // Keyboard: ⌘⇧T opens the drawer with focus on the quick-add.
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button onClick={() => setOpen(true)}
              title="Tasks (⌘⇧T)"
              data-testid="global-tasks-btn"
              className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-slate-100 text-slate-600">
        <CheckSquare size={15} />
        {openCount > 0 && (
          <span data-testid="global-tasks-badge"
                className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono-num bg-slate-900 text-white leading-none">
            {openCount > 99 ? "99+" : openCount}
          </span>
        )}
      </button>
      {open && (
        <TasksDrawer
          onClose={() => { setOpen(false); refreshCount(); }}
          onChange={refreshCount}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------
// The drawer
// ------------------------------------------------------------------
function TasksDrawer({ onClose, onChange }) {
  const { currentId } = useCompany();
  const { user } = useAuth();
  const [filter, setFilter] = useState("open");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newPriority, setNewPriority] = useState("medium");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${currentId}/tasks?filter=${filter}`);
      setRows(r.data?.tasks || []);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, [currentId, filter]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = async () => {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      await api.post(`/companies/${currentId}/tasks`, {
        title: newTitle.trim(),
        due_date: newDue || null,
        priority: newPriority,
      });
      setNewTitle("");
      setNewDue("");
      setNewPriority("medium");
      await load();
      onChange?.();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setCreating(false); }
  };

  const toggle = async (task) => {
    try {
      await api.post(`/companies/${currentId}/tasks/${task.id}/complete`);
      await load();
      onChange?.();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const remove = async (task) => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    try {
      await api.delete(`/companies/${currentId}/tasks/${task.id}`);
      await load();
      onChange?.();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const grouped = useMemo(() => groupByDue(rows), [rows]);

  return (
    <div className="fixed inset-0 z-[85] flex justify-end"
          role="dialog" aria-modal="true"
          data-testid="global-tasks-drawer">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]"
            onClick={onClose} />
      <div className="relative bg-white shadow-2xl h-full w-full max-w-md flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <CheckSquare size={16} className="text-slate-600" />
            <h2 className="font-heading font-semibold text-slate-900">Tasks</h2>
          </div>
          <button onClick={onClose}
                    data-testid="global-tasks-close"
                    className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
            <X size={16} />
          </button>
        </div>

        {/* Filter chips */}
        <div className="px-4 py-2 flex gap-1 flex-wrap border-b bg-slate-50/60">
          {FILTERS.map(([k, label]) => (
            <button key={k}
                      onClick={() => setFilter(k)}
                      data-testid={`global-tasks-filter-${k}`}
                      className={`px-2.5 py-1 rounded-full text-[11px] uppercase tracking-wider transition ${
                        filter === k
                          ? "bg-slate-900 text-white"
                          : "bg-white border border-slate-200 text-slate-600 hover:border-slate-400"
                      }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="text-center py-10 text-slate-500 text-sm">
              <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            <div className="space-y-4">
              {grouped.map(([bucket, tasks]) => (
                <div key={bucket}>
                  <div className="px-2 pb-1 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                    {bucket} <span className="text-slate-300 font-normal">({tasks.length})</span>
                  </div>
                  <ul className="space-y-0.5">
                    {tasks.map(t => (
                      <TaskRow key={t.id} task={t}
                                onToggle={() => toggle(t)}
                                onDelete={() => remove(t)} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick-add footer */}
        <div className="border-t bg-slate-50/60 px-3 py-3 space-y-2"
              data-testid="global-tasks-quickadd">
          <input value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") add(); }}
                    placeholder="Add a task…"
                    data-testid="global-tasks-quickadd-title"
                    className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-slate-500 bg-white" />
          <div className="flex items-center gap-2">
            <input type="date" value={newDue}
                      onChange={(e) => setNewDue(e.target.value)}
                      data-testid="global-tasks-quickadd-due"
                      className="flex-1 border border-slate-300 rounded-md px-2 py-1.5 text-xs bg-white" />
            <select value={newPriority}
                      onChange={(e) => setNewPriority(e.target.value)}
                      data-testid="global-tasks-quickadd-priority"
                      className="border border-slate-300 rounded-md px-2 py-1.5 text-xs bg-white">
              <option value="low">Low</option>
              <option value="medium">Med</option>
              <option value="high">High</option>
            </select>
            <button onClick={add}
                      disabled={!newTitle.trim() || creating}
                      data-testid="global-tasks-quickadd-submit"
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50">
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Add
            </button>
          </div>
          <div className="text-[10px] text-slate-400 italic flex items-center gap-1">
            <Sparkles size={10} /> Tip: press ⌘⇧T anywhere to open this drawer.
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskRow({ task, onToggle, onDelete }) {
  const done = task.status === "done";
  const overdue = !done && task.due_date && task.due_date < isoToday();
  const link = entityLink(task);

  const body = (
    <div className="flex items-start gap-2 flex-1 min-w-0">
      <button onClick={onToggle}
                aria-label={done ? "Mark as open" : "Mark as done"}
                data-testid={`global-tasks-row-toggle-${task.id}`}
                className={`shrink-0 mt-0.5 ${done ? "text-emerald-500" : "text-slate-300 hover:text-slate-600"}`}>
        {done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
      </button>
      <div className="flex-1 min-w-0">
        <div className={`text-sm truncate ${done ? "line-through text-slate-400" : "text-slate-800"}`}>
          {task.title}
        </div>
        <div className="text-[10px] text-slate-500 flex items-center gap-1.5 flex-wrap mt-0.5">
          {task.due_date && (
            <span className={overdue ? "text-rose-600 font-medium inline-flex items-center gap-0.5" : "inline-flex items-center gap-0.5"}>
              {overdue ? <AlertCircle size={10} /> : <Calendar size={10} />}
              {task.due_date}
            </span>
          )}
          <span className={`uppercase tracking-wider text-[9px] ${PRIORITY_COLOR[task.priority] || "text-slate-400"}`}>
            {task.priority}
          </span>
          {task.entity_label && (
            <span className="inline-flex items-center gap-0.5 text-slate-500 truncate">
              · <span className="italic truncate">{task.entity_type}:</span>
              <span className="truncate">{task.entity_label}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <li className="group px-2 py-1.5 rounded hover:bg-slate-50 flex items-center gap-1"
        data-testid={`global-tasks-row-${task.id}`}>
      {link ? (
        <Link to={link} className="flex-1 min-w-0">{body}</Link>
      ) : body}
      <button onClick={onDelete}
                aria-label="Delete task"
                data-testid={`global-tasks-row-delete-${task.id}`}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-rose-50 text-slate-400 hover:text-rose-500">
        <Trash2 size={12} />
      </button>
    </li>
  );
}

function EmptyState({ filter }) {
  const msg = filter === "overdue" ? "Nothing overdue — nice."
              : filter === "today" ? "No tasks due today."
              : filter === "mine" ? "You have no open tasks."
              : filter === "done" ? "No completed tasks yet."
              : "You're all caught up.";
  return (
    <div className="text-center py-14 text-sm text-slate-500" data-testid="global-tasks-empty">
      <CheckSquare size={24} className="mx-auto text-slate-300 mb-2" />
      {msg}
      <div className="text-[11px] text-slate-400 mt-1 italic">Add one below to get started.</div>
    </div>
  );
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------
function isoToday() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function groupByDue(rows) {
  const today = isoToday();
  const buckets = { Overdue: [], Today: [], "This week": [], Later: [], "No due date": [] };
  const inSevenDays = (d) => {
    const now = new Date(today);
    const dd = new Date(d);
    const diff = (dd - now) / 86400000;
    return diff > 0 && diff <= 7;
  };
  for (const t of rows) {
    if (t.status === "done") { buckets["No due date"].push(t); continue; }
    if (!t.due_date) buckets["No due date"].push(t);
    else if (t.due_date < today) buckets.Overdue.push(t);
    else if (t.due_date === today) buckets.Today.push(t);
    else if (inSevenDays(t.due_date)) buckets["This week"].push(t);
    else buckets.Later.push(t);
  }
  return Object.entries(buckets).filter(([, v]) => v.length > 0);
}

function entityLink(t) {
  if (!t.entity_type || !t.entity_id) return null;
  const routes = {
    invoice:  `/invoices/${t.entity_id}/edit`,
    bill:     `/bills/${t.entity_id}/edit`,
    estimate: `/estimates/${t.entity_id}/edit`,
    project:  `/accounting/projects/${t.entity_id}`,
    transaction: `/transactions`,
  };
  return routes[t.entity_type] || null;
}
