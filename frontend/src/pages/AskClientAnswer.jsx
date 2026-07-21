import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import {
  CheckCircle2, Loader2, AlertTriangle, Send, Sparkles, Bot, User as UserIcon,
} from "lucide-react";

// Public, no-auth chat page — clients arrive via the magic-link in the
// ask-client email. Uses raw axios (not the authenticated `api` client) so
// the request carries no JWT and hits the wide-open /api/q/:token routes.
const BASE = process.env.REACT_APP_BACKEND_URL;

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

  const send = async () => {
    const msg = input.trim();
    if (!msg) return;
    setBusy(true);
    // Optimistically append the client turn so it appears instantly.
    setQ(prev => ({
      ...prev,
      chat_messages: [...(prev.chat_messages || []), { role: "client", content: msg }],
    }));
    setInput("");
    try {
      const r = await axios.post(`${BASE}/api/q/${token}/chat`, { message: msg });
      // Replace optimistic history with the authoritative version from server.
      setQ(prev => ({ ...prev, chat_messages: r.data.history || prev.chat_messages }));
      if (r.data.finalize) {
        // Give the AI's final "thanks" bubble a moment on screen before
        // switching to the done state.
        setTimeout(() => setDone(true), 800);
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Send failed. Try again.");
      // Roll back the optimistic message so the client doesn't lose it.
      setQ(prev => ({
        ...prev,
        chat_messages: (prev.chat_messages || []).filter((m, i, arr) => i !== arr.length - 1),
      }));
      setInput(msg);
    } finally {
      setBusy(false);
    }
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
          {busy && <TypingBubble />}
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
        {content}
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
