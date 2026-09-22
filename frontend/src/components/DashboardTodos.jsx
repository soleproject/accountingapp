// Dashboard to-do checklist — a context-aware close-cycle stepper that
// surfaces above the toggle content on every dashboard view (Classic,
// Firm at a Glance, Business Overview).
//
// Backend drives the mode + visibility (fetched by Dashboard.jsx and
// passed in as a prop so the same object drives the Needs-your-attention
// shimmer-suppression logic too).
//   • "setup"  → "Set Up: Review Books"  ← shimmer moves onto the first
//                incomplete step in this checklist (steer the user here)
//   • "close"  → "{PrevMonth} {Year} Closing Tasks"  ← no shimmer on
//                steps; the Needs-your-attention shimmer keeps its
//                current behavior.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { emitAction, useActionListener } from "@/lib/createBus";
import { api } from "@/lib/api";
import {
  X, Check, CheckCircle2, ArrowRight as ArrowRightIcon, ListChecks, MessageCircle,
  FileText, Receipt as ReceiptIcon, Users,
} from "lucide-react";

export default function DashboardTodos({ todos }) {
  const { currentId } = useCompany();
  const { user } = useAuth();
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const key = todos?.checklist_key || "unknown";
  const dismissKey = `todo_dismissed:${currentId || "_"}:${key}:${today}`;

  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissKey) === "1"; }
    catch { return false; }
  });
  // "Force-show" flag — flipped when the user clicks the pill.
  // Overrides the backend's `todos.visible` gate so the checklist
  // opens even when the backend deems it should stay collapsed
  // (e.g. fresh companies with no `visible=true` signal yet).
  const [forceOpen, setForceOpen] = useState(false);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(dismissKey) === "1"); }
    catch { /* ignore */ }
  }, [dismissKey]);

  const dismiss = () => {
    try { localStorage.setItem(dismissKey, "1"); } catch { /* ignore */ }
    setDismissed(true);
    setForceOpen(false);
  };
  const reopen = () => {
    try { localStorage.removeItem(dismissKey); } catch { /* ignore */ }
    setDismissed(false);
    setForceOpen(true);
  };

  // --------- Coached transitions between checklist steps ---------
  // When a Setup-mode step flips from >0 → 0, post an assistant bubble to
  // the AI chat with a "Jump to Step N+1" CTA so the checklist feels like
  // one continuous coached experience rather than three independent
  // buttons. Fires at most once per user + company + step (localStorage-
  // gated) so users aren't re-nudged after re-syncs surface fresh work.
  //
  // The "previous counts" snapshot is ALSO persisted in localStorage —
  // otherwise a cold reload between the "1 category" state and the
  // "0 categories" state would remount with no baseline and miss the
  // transition. Persisting means the coach still fires when the user
  // approves work then bounces back to the dashboard on a new tab.
  useEffect(() => {
    if (!todos) return;
    if (todos.mode !== "setup") return;
    if (!currentId || !user?.id) return;

    const prevKey = `todo_prev_counts:${user.id}:${currentId}`;
    const nowCounts = {
      1: todos.step1?.count ?? 0,
      2: todos.step2?.count ?? 0,
      3: todos.step3?.count ?? 0,
    };
    let prev = null;
    try {
      const raw = localStorage.getItem(prevKey);
      if (raw) prev = JSON.parse(raw);
    } catch { /* ignore */ }
    try { localStorage.setItem(prevKey, JSON.stringify(nowCounts)); }
    catch { /* ignore */ }
    if (!prev) return; // First time we've seen this pair — establish baseline.

    const seenKeyFor = (n) => `coach_seen:${user.id}:${currentId}:step${n}`;
    const alreadyCoached = (n) => {
      try { return localStorage.getItem(seenKeyFor(n)) === "1"; }
      catch { return false; }
    };
    const markCoached = (n) => {
      try { localStorage.setItem(seenKeyFor(n), "1"); } catch { /* ignore */ }
    };

    // Coach when Step N just hit 0 AND there's still work left downstream.
    const coach = (n, msg, ctaLabel, ctaActionKey, ctaData) => {
      if ((prev[n] ?? 0) === 0 || nowCounts[n] > 0) return;
      if (alreadyCoached(n)) return;
      markCoached(n);
      emitAction("ai-chat-say-with-cta", {
        message: msg,
        cta: { label: ctaLabel, actionKey: ctaActionKey, data: ctaData || {} },
      });
    };

    const completedInStep1 = prev[1];
    const completedInStep2 = prev[2];

    if (nowCounts[2] > 0 || nowCounts[3] > 0) {
      coach(
        1,
        `Nice — ${completedInStep1} categor${completedInStep1 === 1 ? "y" : "ies"} approved. Ready for the vendor batches?`,
        "Jump to Step 2",
        "jump-to-step",
        { link: todos.step2?.cta_link },
      );
    }
    if (nowCounts[3] > 0) {
      coach(
        2,
        `Great work — ${completedInStep2} vendor group${completedInStep2 === 1 ? "" : "s"} sorted. Time for the no-contact review.`,
        "Jump to Step 3",
        "jump-to-step",
        { link: todos.step3?.cta_link },
      );
    }
    if (nowCounts[1] === 0 && nowCounts[2] === 0 && nowCounts[3] === 0) {
      const seen3 = seenKeyFor(3);
      try {
        if (localStorage.getItem(seen3) !== "1") {
          localStorage.setItem(seen3, "1");
          emitAction("ai-chat-say", {
            message: "Books are clean. First close is ready when you are.",
          });
        }
      } catch { /* ignore */ }
    }
  }, [todos, currentId, user?.id]);

  // "Jump to Step N" chat CTA → navigate to that step's cta_link.
  useActionListener("chat-cta:jump-to-step", (payload) => {
    const link = payload?.link;
    if (link) navigate(link);
  });

  if (todos === null || todos === undefined) {
    // Still loading — Dashboard.jsx hasn't finished the firm-glance
    // fetch yet.
    return (
      <div className="rounded-xl border bg-white p-5 animate-pulse">
        <div className="h-4 w-40 bg-slate-100 rounded" />
        <div className="mt-3 h-16 bg-slate-100 rounded" />
      </div>
    );
  }
  if (todos === false) {
    // Fetch failed — show a friendly retry rather than an infinite
    // skeleton. Refresh reruns Dashboard.jsx's effect.
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-900 flex items-center justify-between">
        <div>Couldn't load your review checklist — this company's dashboard hit a hiccup.</div>
        <button
          onClick={() => window.location.reload()}
          className="text-[12px] px-2.5 py-1 rounded-md border border-amber-300 bg-white hover:bg-amber-100 font-semibold"
          data-testid="todos-retry"
        >
          Retry
        </button>
      </div>
    );
  }
  if (todos.is_complete) return null;

  if ((todos.visible || forceOpen) && !dismissed) {
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
  const { currentId } = useCompany();
  const steps = [todos.step1, todos.step2, todos.step3];
  const doneCount = steps.filter(s => (s?.count ?? 0) === 0).length;
  // Only Setup mode shifts the rainbow shimmer onto the checklist. In
  // Close mode the shimmer stays on the Needs-your-attention section.
  const highlightIdx = todos.mode === "setup"
    ? steps.findIndex(s => (s?.count ?? 0) > 0)
    : -1;

  // Setup mode has a "Switch to chat mode" toggle that swaps the three
  // checklist steps in-place for three chat-review tiles. Chat mode is
  // the default; preference persists across reloads once the user
  // explicitly picks either mode.
  const [chatMode, setChatMode] = useState(() => {
    try {
      const v = localStorage.getItem("dashboard-todos-mode");
      return v === null ? true : v === "chat";
    } catch { return true; }
  });
  const [chatCounts, setChatCounts] = useState(null);
  useEffect(() => {
    if (!chatMode || !currentId) return;
    let cancelled = false;
    api.get(`/companies/${currentId}/reviewv2/chat-review-queue`)
      .then(r => {
        if (cancelled) return;
        setChatCounts({
          no_category:  r.data?.no_category?.length  || 0,
          transactions: r.data?.transactions?.length || 0,
          checks:       r.data?.checks?.length       || 0,
        });
      })
      .catch(() => !cancelled && setChatCounts({ no_category: 0, transactions: 0, checks: 0 }));
    return () => { cancelled = true; };
  }, [chatMode, currentId]);
  const toggleChat = () => {
    setChatMode(v => {
      const next = !v;
      try { localStorage.setItem("dashboard-todos-mode", next ? "chat" : "checklist"); } catch {}
      return next;
    });
  };
  const chatSteps = chatMode ? [
    {
      title:    "No Category",
      subtitle: "Contacts without a category yet — describe them in chat",
      count:    chatCounts?.no_category ?? "…",
      unit:     "questions",
      cta:      "/accounting/review-chat?tab=no_category",
      icon:     Users,
    },
    {
      title:    "Transactions",
      subtitle: "No-contact groups — link a contact then chat the category",
      count:    chatCounts?.transactions ?? "…",
      unit:     "questions",
      cta:      "/accounting/review-chat?tab=transactions",
      icon:     FileText,
    },
    {
      title:    "Checks",
      subtitle: "Unassigned checks — fill it in or let AI parse it for you",
      count:    chatCounts?.checks ?? "…",
      unit:     "questions",
      cta:      "/accounting/review-chat?tab=checks",
      icon:     ReceiptIcon,
    },
  ] : null;
  const chatDoneCount = chatCounts
    ? [chatCounts.no_category, chatCounts.transactions, chatCounts.checks].filter(n => n === 0).length
    : 0;

  return (
    <div className="rounded-xl border bg-white p-5" data-testid="dashboard-todos">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
            {chatMode
              ? "Chat review mode"
              : todos.mode === "setup" ? "Setup checklist" : "Monthly close checklist"}
          </div>
          <div className="font-heading text-lg font-semibold text-slate-900 mt-0.5">
            {chatMode ? "Answer with AI" : todos.title}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {chatMode
              ? "Same books, chat-first. Pick a section to start."
              : todos.subtitle}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {todos.mode === "setup" && (
            <button
              type="button"
              onClick={toggleChat}
              className="hidden md:flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:underline"
              data-testid="dashboard-switch-chat-mode"
              title={chatMode
                ? "Go back to the classic 1/2/3 checklist"
                : "Answer these as a guided AI chat instead of the checklist"}
            >
              <MessageCircle size={12} />
              {chatMode ? "Switch to checklist mode" : "Switch to chat mode"}
            </button>
          )}
          <div className="text-[11px] text-slate-500">
            {chatMode ? chatDoneCount : doneCount} of 3 done
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
          {chatMode ? (
            chatSteps.map((s, i) => (
              <ChatStep key={i} index={i + 1} step={s} loading={chatCounts === null} />
            ))
          ) : (
            steps.map((step, i) => (
              <TodoStep
                key={i}
                index={i + 1}
                step={step}
                highlight={i === highlightIdx}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ChatStep({ index, step, loading }) {
  const Icon = step.icon;
  const done = !loading && step.count === 0;
  return (
    <div className="relative flex items-start gap-3" data-testid={`dashboard-chat-step-${index}`}>
      <div
        className={`relative z-10 shrink-0 w-12 h-12 rounded-full border-2 flex items-center justify-center font-heading font-bold text-lg transition-colors ${
          done
            ? "bg-emerald-500 border-emerald-500 text-white"
            : "bg-white border-indigo-500 text-indigo-600"
        }`}
        aria-label={done ? `Step ${index} complete` : `Step ${index}`}
      >
        {done ? <Check size={20} /> : index}
      </div>
      <div className="flex-1 min-w-0 rounded-lg p-3 border border-slate-200 bg-slate-50/40 hover:bg-slate-50 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Icon size={13} className="text-slate-500 shrink-0" />
              <div className="text-sm font-semibold text-slate-900 truncate">
                {step.title}
              </div>
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
              {step.subtitle}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className={`font-mono-num text-2xl font-bold leading-none ${
              done ? "text-emerald-600"
                   : loading ? "text-slate-300" : "text-slate-900"
            }`}>
              {loading ? "…" : step.count}
            </div>
            <div className="text-[9px] uppercase tracking-wider text-slate-400 mt-0.5">
              {step.unit}
            </div>
          </div>
        </div>
        {!done ? (
          <Link
            to={step.cta}
            data-testid={`dashboard-chat-cta-${index}`}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium px-3 py-1.5 transition-colors"
          >
            Open chat
            <ArrowRightIcon size={12} />
          </Link>
        ) : (
          <div className="mt-3 inline-flex items-center gap-1 text-emerald-700 text-xs font-medium">
            <CheckCircle2 size={13} /> All clear
          </div>
        )}
      </div>
    </div>
  );
}

function TodoStep({ index, step, highlight }) {
  const count = step?.count ?? 0;
  const done = count === 0;
  // Apply the same rainbow-outline shimmer used by the "Needs your
  // attention" priority card — draws the eye to the single active step
  // during Setup mode.
  const bodyBase = "flex-1 min-w-0 rounded-lg p-3 transition-colors";
  const bodyClass = highlight
    ? `${bodyBase} attention-rainbow relative z-10`
    : `${bodyBase} border border-slate-200 bg-slate-50/40 hover:bg-slate-50`;
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
      <div className={bodyClass}>
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
              {/* Two-phase Step 3: filled dot = transfers done, hollow dot */}
              {/* = no-contact review still open. Gives the CPA a "halfway  */}
              {/* there" cue without cluttering the tile layout.            */}
              {typeof step?.transfer_pairs_count === "number" &&
                typeof step?.no_contact_count === "number" &&
                (step.transfer_pairs_count + step.no_contact_count > 0) && (
                <span
                  className="inline-flex items-center gap-0.5 shrink-0"
                  data-testid={`todo-step-${index}-phase-dots`}
                  title={
                    step.transfer_pairs_count > 0
                      ? `Phase 1: ${step.transfer_pairs_count} transfer pair${step.transfer_pairs_count === 1 ? "" : "s"} pending`
                      : `Phase 2: ${step.no_contact_count} no-contact row${step.no_contact_count === 1 ? "" : "s"} pending`
                  }
                >
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${
                      step.transfer_pairs_count === 0
                        ? "bg-emerald-500"
                        : "bg-indigo-500"
                    }`}
                    aria-label="Phase 1 status"
                  />
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${
                      step.transfer_pairs_count > 0
                        ? "border border-slate-300 bg-white"
                        : step.no_contact_count === 0
                          ? "bg-emerald-500"
                          : "bg-indigo-500"
                    }`}
                    aria-label="Phase 2 status"
                  />
                  <span className="ml-1 text-[9px] uppercase tracking-wider text-slate-400 font-semibold">
                    {step.transfer_pairs_count > 0 ? "1/2" : "2/2"}
                  </span>
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
              {step?.subtitle_parts && Array.isArray(step.subtitle_parts) ? (
                step.subtitle_parts.map((p, i) => p.href ? (
                  <a
                    key={i}
                    href={p.href}
                    onClick={(e) => { e.stopPropagation(); }}
                    className="text-indigo-600 hover:text-indigo-800 underline decoration-dotted underline-offset-2"
                    data-testid={`todo-subtitle-link-${p.text}`}
                  >
                    {p.text}{typeof p.count === "number" ? ` (${p.count})` : ""}
                  </a>
                ) : (
                  <span key={i}>{p.text}</span>
                ))
              ) : (
                step?.subtitle || " "
              )}
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
