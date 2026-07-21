import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import {
  CheckCircle2, Loader2, AlertTriangle, Send, Sparkles, Bot, User as UserIcon,
} from "lucide-react";

const BASE = process.env.REACT_APP_BACKEND_URL;

// Extract plain **bold** and • bullets into inline JSX so AI markdown
// renders correctly in chat bubbles without pulling in a full renderer.
function renderMarkdown(text) {
  if (!text) return null;
  const lines = String(text).split("\n");
  return lines.map((line, li) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g).map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**")) return <b key={i}>{p.slice(2, -2)}</b>;
      return <span key={i}>{p}</span>;
    });
    return <div key={li}>{parts}</div>;
  });
}

export default function AskClientAnswer() {
  const { token } = useParams();
  const [q, setQ] = useState(null);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const scrollerRef = useRef(null);

  // Load the question + any prior chat history (so a client who closed the
  // tab and re-opened the link resumes exactly where they left off).
  useEffect(() => {
    axios.get(`${BASE}/api/q/${token}`)
      .then(r => {
        setQ(r.data);
        if (r.data.status === "answered") setDone(true);
      })
      .catch(e => setError(e.response?.data?.detail || "This link is invalid or expired."));
  }, [token]);

  // Autoscroll on every new message.
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [q?.chat_messages, busy, done]);

  // The most recently proposed plan, if the AI's last turn emitted a PLAN
  // block. When set, we render an interactive green card. Cleared once the
  // client accepts or types another message.
  const [pendingPlan, setPendingPlan] = useState(null);

  const send = async () => {
    const msg = input.trim();
    if (!msg) return;
    setBusy(true);
    setPendingPlan(null);   // any new client message cancels an outstanding plan card
    setQ(prev => ({
      ...prev,
      chat_messages: [...(prev.chat_messages || []), { role: "client", content: msg }],
    }));
    setInput("");
    try {
      const r = await axios.post(`${BASE}/api/q/${token}/chat`, { message: msg });
      setQ(prev => ({ ...prev, chat_messages: r.data.history || prev.chat_messages }));
      if (r.data.plan) setPendingPlan(r.data.plan);
      if (r.data.finalize) {
        // Fast-path DONE — server already applied everything.
        setTimeout(() => setDone(true), 800);
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Send failed. Try again.");
      setQ(prev => ({
        ...prev,
        chat_messages: (prev.chat_messages || []).filter((m, i, arr) => i !== arr.length - 1),
      }));
      setInput(msg);
    } finally {
      setBusy(false);
    }
  };

  const applyPlan = async () => {
    if (!pendingPlan) return;
    setBusy(true);
    try {
      await axios.post(`${BASE}/api/q/${token}/apply-plan`, { plan: pendingPlan });
      setPendingPlan(null);
      // Add a client bubble showing they said yes, then transition to done.
      setQ(prev => ({
        ...prev,
        chat_messages: [
          ...(prev.chat_messages || []),
          { role: "client", content: "Yes, apply that." },
          { role: "ai", content: "Done — everything's categorized and sent to your accountant. Thanks!" },
        ],
      }));
      setTimeout(() => setDone(true), 900);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't apply the plan. Please type instead.");
    } finally {
      setBusy(false);
    }
  };

  const rejectPlan = () => {
    setPendingPlan(null);
    setInput("");
    // Focus input so client can re-explain.
    setTimeout(() => document.querySelector('[data-testid="chat-input"]')?.focus(), 50);
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  if (error) return <Wrap><ErrorState msg={error} /></Wrap>;
  if (!q)    return <Wrap><Loading /></Wrap>;

  if (done) {
    return <Wrap>
      <div className="text-center space-y-3 py-8" data-testid="answer-done">
        <CheckCircle2 size={48} className="text-emerald-500 mx-auto" />
        <div className="text-lg font-semibold text-slate-900">Thanks — your answer is with your accountant.</div>
        <div className="text-sm text-slate-500 max-w-md mx-auto">
          You can close this window. If you need to add anything, just email
          {q.asked_by_name ? <> <b>{q.asked_by_name}</b></> : " them"} directly.
        </div>
      </div>
    </Wrap>;
  }

  // Show the first "AI" turn (the accountant's original question, styled
  // as a message from the assistant) even before any exchange has happened
  // so the client sees the same chat framing as the "Let's review" panel
  // inside the app.
  const initialQ = { role: "ai", content: q.question, seed: true };
  const messages = [initialQ, ...(q.chat_messages || [])];

  return (
    <Wrap wide>
      <div className="space-y-4" data-testid="answer-chat">
        <div className="flex items-center gap-2 text-xs text-cyan-700">
          <Sparkles size={14} /> Question from your accountant
        </div>
        <div>
          <h1 className="font-heading text-2xl font-bold text-slate-900">
            {q.txns && q.txns.length > 1
              ? <>Let's sort out {q.counterparty_label || `${q.txns.length} transactions`}</>
              : <>Let's review a transaction</>
            }
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            {q.asked_by_name || "Your accountant"} is reviewing the books for <b>{q.company_name}</b>. Type below — I'll ask a follow-up if I need one, then send everything over.
          </p>
        </div>

        {q.txns && q.txns.length > 0 && (
          <TxnPanel txns={q.txns} counterparty={q.counterparty_label} />
        )}

        <div
          ref={scrollerRef}
          className="rounded-lg border bg-slate-50/60 h-[380px] overflow-y-auto px-4 py-4 space-y-3"
          data-testid="chat-scroller"
        >
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} content={m.content} />
          ))}
          {pendingPlan && (
            <PlanCard
              plan={pendingPlan}
              busy={busy}
              onApply={applyPlan}
              onReject={rejectPlan}
              txnCount={q.txns?.length || 0}
              totalAbs={Math.abs((q.txns || []).reduce((s, t) => s + Number(t.amount || 0), 0))}
              counterparty={q.counterparty_label}
            />
          )}
          {busy && !pendingPlan && <TypingBubble />}
        </div>

        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            placeholder="Type your answer… (Enter to send)"
            disabled={busy}
            className="flex-1 text-sm border rounded-md px-3 py-2 resize-none"
            data-testid="chat-input"
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            data-testid="chat-send"
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 font-medium"
          >
            {busy ? <Loader2 className="animate-spin" size={16} /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </Wrap>
  );
}

function Bubble({ role, content }) {
  const isAi = role === "ai";
  return (
    <div className={`flex items-start gap-2 ${isAi ? "" : "flex-row-reverse"}`} data-testid={`bubble-${role}`}>
      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-white ${isAi ? "bg-cyan-600" : "bg-slate-500"}`}>
        {isAi ? <Bot size={14} /> : <UserIcon size={14} />}
      </div>
      <div
        className={`max-w-[78%] text-sm rounded-lg px-3.5 py-2.5 whitespace-pre-wrap leading-relaxed
          ${isAi ? "bg-white border border-slate-200 text-slate-800" : "bg-cyan-600 text-white"}`}
      >
        {isAi ? renderMarkdown(content) : content}
      </div>
    </div>
  );
}

// Green plan card — rendered inline in the chat when the AI emits [[PLAN:...]]
// because the mapping needs client confirmation (split, big money, unusual).
function PlanCard({ plan, busy, onApply, onReject, txnCount, totalAbs, counterparty }) {
  return (
    <div className="flex items-start gap-2" data-testid="plan-card">
      <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-cyan-600 text-white">
        <Sparkles size={14} />
      </div>
      <div className="max-w-[85%] rounded-lg border-2 border-emerald-400 bg-emerald-50/70 p-4 space-y-3">
        <div className="text-sm text-slate-900">
          <div className="font-semibold mb-1.5">Here's the plan{counterparty ? <> for <b>{counterparty}</b></> : ""}:</div>
          <ul className="text-sm space-y-1 pl-1">
            <li>• <b>{txnCount}</b> row{txnCount === 1 ? "" : "s"}{totalAbs ? <> totaling <b className="font-mono-num">${totalAbs.toFixed(2)}</b></> : ""} → <b>{plan.account_name}</b> ({plan.account_code})</li>
            {plan.summary && <li>• Category: <i>{plan.summary}</i></li>}
            {plan.create_rule && plan.rule_pattern && (
              <li>• Also create a rule so future <b>{plan.rule_pattern}</b> charges auto-categorize.</li>
            )}
          </ul>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onApply}
            disabled={busy}
            data-testid="plan-apply"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 text-sm font-semibold"
          >
            {busy ? <Loader2 className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
            Yes, apply{plan.create_rule ? " + create rule" : ""}
          </button>
          <button
            onClick={onReject}
            disabled={busy}
            data-testid="plan-reject"
            className="px-4 py-2 rounded-md border bg-white hover:bg-slate-50 text-sm text-slate-700"
          >
            No, thanks
          </button>
        </div>
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex items-start gap-2" data-testid="bubble-typing">
      <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-cyan-600 text-white">
        <Bot size={14} />
      </div>
      <div className="bg-white border border-slate-200 rounded-lg px-4 py-3">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" style={{ animationDelay: "0ms" }} />
          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" style={{ animationDelay: "150ms" }} />
          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    </div>
  );
}

function TxnPanel({ txns, counterparty }) {
  const batched = txns.length > 1;
  const total = txns.reduce((s, t) => s + Number(t.amount || 0), 0);
  return (
    <details className="rounded-lg border bg-slate-50 group" data-testid="txn-panel" open={!batched}>
      <summary className="list-none cursor-pointer px-4 py-2.5 flex items-center justify-between text-xs text-slate-600 hover:bg-slate-100 rounded-lg">
        <span>
          {batched
            ? <>{txns.length} transactions from <b>{counterparty || "this vendor"}</b> · combined <span className="font-mono-num">${Math.abs(total).toFixed(2)}</span></>
            : <>1 transaction</>
          }
        </span>
        <span className="text-cyan-700 group-open:hidden">Show</span>
        <span className="text-cyan-700 hidden group-open:inline">Hide</span>
      </summary>
      <div className="divide-y border-t">
        {txns.map(t => (
          <div key={t.id} className="grid grid-cols-[95px_1fr_100px] items-center gap-3 px-4 py-1.5">
            <span className="text-xs text-slate-500 font-mono-num">{t.date}</span>
            <span className="text-xs text-slate-800 truncate">{t.description}</span>
            <span className={`text-xs text-right font-mono-num ${Number(t.amount) < 0 ? "text-slate-800" : "text-emerald-700 font-semibold"}`}>
              {Number(t.amount) < 0 ? "-" : ""}${Math.abs(Number(t.amount || 0)).toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function Wrap({ children, wide }) {
  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className={`${wide ? "max-w-2xl" : "max-w-xl"} mx-auto bg-white rounded-xl shadow-sm border p-6 sm:p-8`}>
        {children}
        <div className="mt-6 pt-4 border-t text-xs text-slate-400 text-center">
          Axiom Ledger · <span className="font-mono-num">accountingapp.ai</span>
        </div>
      </div>
    </div>
  );
}

function Loading() {
  return <div className="py-16 text-center text-slate-500">
    <Loader2 className="animate-spin mx-auto mb-2" size={24} /> Loading…
  </div>;
}

function ErrorState({ msg }) {
  return <div className="py-8 text-center space-y-3" data-testid="answer-error">
    <AlertTriangle size={40} className="text-amber-500 mx-auto" />
    <div className="text-lg font-semibold text-slate-900">Link unavailable</div>
    <div className="text-sm text-slate-600 max-w-md mx-auto">{msg}</div>
  </div>;
}
