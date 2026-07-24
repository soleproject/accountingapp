// Dashboard to-do checklist — a context-aware close-cycle stepper that
// surfaces above the toggle content on every dashboard view (Classic,
// Firm at a Glance, Business Overview).
//
// Backend drives the mode + visibility:
//   • "setup"  → "Set Up: Review Books" (company hasn't closed a month yet)
//   • "close"  → "{PrevMonth} {Year} Closing Tasks" (day 3+, prior month
//                still open)
//
// The container also handles per-day dismissal via localStorage and a
// compact "To Do (N)" reopen pill when dismissed.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import {
  X, Check, CheckCircle2, ArrowRight as ArrowRightIcon, ListChecks,
} from "lucide-react";

export default function DashboardTodos() {
  const { currentId } = useCompany();
  const [todos, setTodos] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentId) return;
    setLoading(true);
    // Firm-glance is cached backend-side (15s), so calling it for todos
    // alongside FirmAtAGlance's own render is cheap.
    api.get(`/companies/${currentId}/dashboard/firm-glance`)
      .then(r => setTodos(r.data?.todos || null))
      .catch(() => setTodos(null))
      .finally(() => setLoading(false));
  }, [currentId]);

  const today = new Date().toISOString().slice(0, 10);
  const key = todos?.checklist_key || "unknown";
  const dismissKey = `todo_dismissed:${currentId || "_"}:${key}:${today}`;

  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissKey) === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { setDismissed(localStorage.getItem(dismissKey) === "1"); }
    catch { /* ignore */ }
  }, [dismissKey]);

  const dismiss = () => {
    try { localStorage.setItem(dismissKey, "1"); } catch { /* ignore */ }
    setDismissed(true);
  };
  const reopen = () => {
    try { localStorage.removeItem(dismissKey); } catch { /* ignore */ }
    setDismissed(false);
  };

  if (loading && !todos) {
    return (
      <div className="rounded-xl border bg-white p-5 animate-pulse">
        <div className="h-4 w-40 bg-slate-100 rounded" />
        <div className="mt-3 h-16 bg-slate-100 rounded" />
      </div>
    );
  }
  if (!todos) return null;
  if (todos.is_complete) return null;

  if (todos.visible && !dismissed) {
    return <MonthlyTodos todos={todos} onDismiss={dismiss} />;
  }

  const totalItems =
    (todos.step1?.count || 0) + (todos.step2?.count || 0) + (todos.step3?.count || 0);
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={reopen}
        data-testid="dashboard-todo-reopen"
        className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 text-xs font-medium shadow-sm transition-colors"
      >
        <ListChecks size={14} className="text-indigo-600" />
        <span>To Do</span>
        {totalItems > 0 && (
          <span className="inline-flex items-center justify-center rounded-full bg-indigo-600 text-white text-[10px] font-bold h-4 min-w-4 px-1">
            {totalItems}
          </span>
        )}
      </button>
    </div>
  );
}

function MonthlyTodos({ todos, onDismiss }) {
  const steps = [todos.step1, todos.step2, todos.step3];
  const doneCount = steps.filter(s => (s?.count ?? 0) === 0).length;
  return (
    <div className="rounded-xl border bg-white p-5" data-testid="dashboard-todos">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
            {todos.mode === "setup" ? "Setup checklist" : "Monthly close checklist"}
          </div>
          <div className="font-heading text-lg font-semibold text-slate-900 mt-0.5">
            {todos.title}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">{todos.subtitle}</div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-[11px] text-slate-500">
            {doneCount} of 3 done
          </div>
          <button
            type="button"
            onClick={onDismiss}
            data-testid="dashboard-todo-dismiss"
            className="text-slate-400 hover:text-slate-700 rounded p-1 hover:bg-slate-100 transition-colors"
            aria-label="Dismiss checklist"
            title="Hide until tomorrow"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="relative">
        <div className="absolute left-0 right-0 top-6 h-0.5 bg-slate-100 -z-0" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative">
          {steps.map((step, i) => (
            <TodoStep key={i} index={i + 1} step={step} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TodoStep({ index, step }) {
  const count = step?.count ?? 0;
  const done = count === 0;
  return (
    <div className="relative flex items-start gap-3" data-testid={`dashboard-todo-step-${index}`}>
      <div
        className={`relative z-10 shrink-0 w-12 h-12 rounded-full border-2 flex items-center justify-center font-heading font-bold text-lg transition-colors ${
          done
            ? "bg-emerald-500 border-emerald-500 text-white"
            : count > 0
              ? "bg-white border-indigo-500 text-indigo-600"
              : "bg-white border-slate-300 text-slate-400"
        }`}
        aria-label={done ? "Step complete" : `Step ${index}`}
      >
        {done ? <Check size={20} /> : index}
      </div>
      <div className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-slate-50/40 hover:bg-slate-50 transition-colors p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-slate-900 truncate">
                Step {index}: {step?.title || ""}
              </div>
              {step?.coming_soon && (
                <span className="text-[9px] uppercase tracking-wider text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                  Preview
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
              {step?.subtitle || " "}
            </div>
          </div>
          {step && (
            <div className="text-right shrink-0">
              <div className={`font-mono-num text-2xl font-bold leading-none ${done ? "text-emerald-600" : count > 0 ? "text-slate-900" : "text-slate-400"}`}>
                {count}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-slate-400 mt-0.5">
                {step.unit}
              </div>
            </div>
          )}
        </div>
        {step && !done && (
          <Link
            to={step.cta_link}
            data-testid={`dashboard-todo-cta-${index}`}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium px-3 py-1.5 transition-colors"
          >
            {step.cta_label}
            <ArrowRightIcon size={12} />
          </Link>
        )}
        {step && done && (
          <div className="mt-3 inline-flex items-center gap-1 text-emerald-700 text-xs font-medium">
            <CheckCircle2 size={13} />
            All caught up
          </div>
        )}
      </div>
    </div>
  );
}
