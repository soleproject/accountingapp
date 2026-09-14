import React, { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import axios from "axios";
import { Send, Paperclip, HelpCircle, Loader2, Check, ArrowRight, Calendar, X } from "lucide-react";

/**
 * ClientReviewPage — token-gated batch review flow.
 *
 * Loads a batch by token, walks the client through unanswered items one
 * at a time via a chat UI backed by Haiku on the server. Every item has
 * a persistent "Not sure — send to my bookkeeper" escape hatch. When
 * all items are finalized (answered or deferred), a summary screen
 * shows X updated / Y sent to your bookkeeper.
 *
 * No login required — the URL token is the credential. Backend
 * validates every mutation against `client_review_batches.client_token`.
 */
const API = `${process.env.REACT_APP_BACKEND_URL}/api/client-review`;

const ITEM_TYPE_LABELS = {
  1: "Uncategorized transaction",
  2: "Vendor confirmation",
  3: "Missing receipt",
  4: "W-9 collection",
  5: "Ambiguous transfer",
  6: "Recurring charge",
  7: "Setup detail",
  8: "Split transaction",
  9: "Liability payment",
};

const UPLOAD_ITEM_TYPES = new Set([3, 4, 9]);

export default function ClientReviewPage() {
  const { token } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [messages, setMessages] = useState([]); // {role, content, quickReplies}
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const chatEndRef = useRef(null);
  const fileRef = useRef(null);

  // Auto-open the schedule picker if the email link carried ?action=schedule
  useEffect(() => {
    if (searchParams.get("action") === "schedule" && session && !session.completed_at) {
      setShowSchedule(true);
    }
  }, [searchParams, session]);

  // ------- initial load -------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get(`${API}/${token}`);
        if (cancelled) return;
        setSession(r.data);
        // Pick the first not-yet-finalized item
        const idx = (r.data.items || []).findIndex(
          (i) => !i.answered_at && !i.deferred
        );
        setActiveIdx(idx === -1 ? (r.data.items || []).length : idx);
        // Restore any prior message history for that item
        if (idx !== -1) {
          const priorMsgs = ((r.data.items || [])[idx]?.messages) || [];
          setMessages(priorMsgs.map((m) => ({
            role: m.role,
            content: m.content,
            quickReplies: m.quick_replies || [],
          })));
        }
      } catch (e) {
        setError(e.response?.data?.detail || "This review session can't be opened.");
      } finally {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const currentItem = session?.items?.[activeIdx];
  const finishedCount = (session?.items || []).filter(
    (i) => i.answered_at || i.deferred
  ).length;
  const totalCount = session?.items?.length || 0;
  const allDone = totalCount > 0 && finishedCount === totalCount;

  // ------- interactions -------
  const sendTurn = async (text) => {
    if (!currentItem || sending || !text.trim()) return;
    setSending(true);
    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    try {
      const r = await axios.post(`${API}/${token}/turn`, {
        item_id: currentItem.item_id,
        message: text,
      });
      const a = r.data;
      setMessages((m) => [...m, {
        role: "assistant",
        content: a.assistant_reply,
        quickReplies: a.quick_replies || [],
        action: a.action,
      }]);
      // If the AI signalled a definitive answer, apply it
      if (a.action?.type === "answer") {
        await applyAnswer(a.action.payload || {}, text);
      } else if (a.action?.type === "defer") {
        await deferItem(a.action.payload?.note);
      }
    } catch (e) {
      setMessages((m) => [...m, {
        role: "assistant",
        content: "Sorry — I hit a snag. Please try again, or tap 'send to my bookkeeper'.",
      }]);
    } finally {
      setSending(false);
    }
  };

  const applyAnswer = async (payload, answerText) => {
    if (!currentItem || busy) return;
    setBusy(true);
    try {
      await axios.post(
        `${API}/${token}/items/${currentItem.item_id}/answer`,
        { answer: answerText || payload.answer_text || "Answered", payload }
      );
      advance();
    } catch (e) {
      // 409 = already finalized; just advance
      advance();
    } finally {
      setBusy(false);
    }
  };

  const deferItem = async (note) => {
    if (!currentItem || busy) return;
    setBusy(true);
    try {
      await axios.post(
        `${API}/${token}/items/${currentItem.item_id}/defer`,
        { note: note || "" }
      );
      advance();
    } catch (e) {
      advance();
    } finally {
      setBusy(false);
    }
  };

  const advance = () => {
    setSession((s) => {
      if (!s) return s;
      // mark current locally so progress bar updates immediately
      const items = [...(s.items || [])];
      if (currentItem) {
        items[activeIdx] = { ...items[activeIdx], answered_at: new Date().toISOString() };
      }
      return { ...s, items };
    });
    setMessages([]);
    const nextIdx = (session?.items || []).findIndex(
      (i, k) => k > activeIdx && !i.answered_at && !i.deferred
    );
    setActiveIdx(nextIdx === -1 ? totalCount : nextIdx);
  };

  const handleUpload = async (file) => {
    if (!currentItem || uploading) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", currentItem.item_type === 4 ? "w9"
                       : currentItem.item_type === 9 ? "loan_statement"
                       : "receipt");
      const r = await axios.post(
        `${API}/${token}/items/${currentItem.item_id}/upload`,
        form
      );
      setMessages((m) => [...m, {
        role: "user",
        content: `📎 Uploaded ${r.data.attachment.filename}`,
      }]);
      // After upload, if it's a W-9, close as attached; for others, continue
      // the conversation so the AI can extract details.
      if (currentItem.item_type === 4) {
        await applyAnswer({ flow: "attached" }, "W-9 uploaded");
      }
    } catch (e) {
      setMessages((m) => [...m, {
        role: "assistant",
        content: "Couldn't accept that file (max 8 MB, PDF/image only).",
      }]);
    } finally {
      setUploading(false);
    }
  };

  const complete = async () => {
    try {
      const r = await axios.post(`${API}/${token}/complete`);
      setSession((s) => ({ ...s, status: "completed",
                           answer_count: r.data.answer_count,
                           defer_count: r.data.defer_count }));
    } catch {
      /* advisory — UI already shows all done */
    }
  };

  // ------- render states -------
  if (loading) {
    return <FullPageStatus icon={<Loader2 className="animate-spin" size={22} />}
                            text="Loading your review session…" />;
  }
  if (error) {
    return <FullPageStatus icon={<HelpCircle size={22} />} text={error} />;
  }
  if (session?.status === "completed" || allDone) {
    return <SummaryScreen session={session} onComplete={complete} />;
  }

  const firmLabel = session?.firm_name || "your bookkeeping team";

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col" data-testid="client-review-page">
      {/* Header */}
      <header className="bg-white border-b px-4 py-3 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-slate-500 uppercase tracking-wide">
              Quick check-in from {firmLabel}
            </div>
            <div className="text-sm text-slate-900 font-heading truncate">
              Question {Math.min(activeIdx + 1, totalCount)} of {totalCount}
              {currentItem && (
                <span className="text-slate-400 font-normal">
                  {" · "}{ITEM_TYPE_LABELS[currentItem.item_type] || "Item"}
                </span>
              )}
            </div>
          </div>
        </div>
        {/* Progress bar */}
        <div className="max-w-2xl mx-auto mt-2 h-1 bg-slate-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-slate-900 transition-all"
            style={{ width: `${(finishedCount / Math.max(1, totalCount)) * 100}%` }}
            data-testid="review-progress"
          />
        </div>
      </header>

      {/* Item context card */}
      {currentItem && (
        <div className="max-w-2xl mx-auto w-full px-4 pt-4">
          <ItemContextCard item={currentItem} />
        </div>
      )}

      {/* Chat */}
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-4">
        <div className="space-y-3">
          {messages.length === 0 && currentItem && (
            <div className="text-center text-xs text-slate-500 py-4">
              Type your answer below, or tap "not sure" to send this to your bookkeeper.
            </div>
          )}
          {messages.map((m, i) => (
            <ChatBubble key={i} message={m} onQuickReply={(t) => sendTurn(t)} />
          ))}
          {sending && (
            <ChatBubble message={{ role: "assistant",
              content: <Loader2 className="animate-spin" size={14} /> }} />
          )}
          <div ref={chatEndRef} />
        </div>
      </main>

      {/* Composer */}
      <footer className="bg-white border-t px-4 py-3 sticky bottom-0">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-end gap-2">
            {UPLOAD_ITEM_TYPES.has(currentItem?.item_type) && (
              <>
                <input
                  ref={fileRef} type="file" accept="image/*,.pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUpload(f);
                    e.target.value = "";
                  }}
                  data-testid="review-file-input"
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="p-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50"
                  title="Attach a document"
                  data-testid="review-upload-btn"
                >
                  {uploading ? <Loader2 className="animate-spin" size={16} />
                             : <Paperclip size={16} />}
                </button>
              </>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendTurn(input);
                }
              }}
              placeholder="Type your answer…"
              rows={1}
              className="flex-1 resize-none px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-500"
              data-testid="review-input"
            />
            <button
              onClick={() => sendTurn(input)}
              disabled={sending || !input.trim()}
              className="p-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40"
              data-testid="review-send-btn"
            >
              <Send size={16} />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => deferItem()}
                disabled={busy || !currentItem}
                className="text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2 disabled:opacity-50"
                data-testid="review-defer-btn"
              >
                Not sure — send to my bookkeeper
              </button>
              <span className="text-slate-300">·</span>
              <button
                onClick={() => setShowSchedule(true)}
                disabled={busy}
                className="text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2 disabled:opacity-50 inline-flex items-center gap-1"
                data-testid="review-schedule-btn"
              >
                <Calendar size={11} /> Schedule for later
              </button>
            </div>
            {totalCount > 1 && (
              <span className="text-[11px] text-slate-400">
                {finishedCount} of {totalCount} done
              </span>
            )}
          </div>
        </div>
      </footer>

      {showSchedule && (
        <ScheduleModal
          token={token}
          expiresAt={session?.expires_at}
          onClose={() => {
            setShowSchedule(false);
            // Clear the ?action=schedule param so it doesn't re-open on refresh
            const params = new URLSearchParams(searchParams);
            params.delete("action");
            setSearchParams(params, { replace: true });
          }}
          onScheduled={(iso) => {
            setSession((s) => ({ ...s, scheduled_for: iso }));
            setShowSchedule(false);
          }}
        />
      )}
    </div>
  );
}

function ScheduleModal({ token, expiresAt, onClose, onScheduled }) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Sensible default: tomorrow at 10:00 local.
  useEffect(() => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(10, 0, 0, 0);
    setDate(t.toISOString().slice(0, 10));
    setTime("10:00");
  }, []);

  const maxDate = expiresAt
    ? new Date(expiresAt).toISOString().slice(0, 10)
    : "";
  const minDate = new Date().toISOString().slice(0, 10);

  const submit = async () => {
    setError("");
    if (!date || !time) {
      setError("Pick a date and time");
      return;
    }
    // Compose local Date, convert to UTC ISO
    const local = new Date(`${date}T${time}:00`);
    if (isNaN(local.getTime())) {
      setError("That doesn't look like a valid time");
      return;
    }
    if (local <= new Date()) {
      setError("Please pick a time in the future");
      return;
    }
    const iso = local.toISOString();
    setSaving(true);
    try {
      await axios.post(`${API}/${token}/schedule`, { scheduled_for: iso });
      onScheduled(iso);
    } catch (e) {
      setError(e.response?.data?.detail || "Couldn't save that time");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center px-4"
         data-testid="schedule-modal">
      <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-heading text-lg text-slate-900">Pick a time</h2>
            <p className="text-xs text-slate-500 mt-1">
              We'll email you a reminder so the questions are one tap away.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1"
                  data-testid="schedule-close">
            <X size={18} />
          </button>
        </div>
        <div className="mt-5 space-y-3">
          <label className="block">
            <span className="text-xs font-semibold text-slate-700">Date</span>
            <input
              type="date"
              value={date}
              min={minDate}
              max={maxDate || undefined}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              data-testid="schedule-date"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-700">Time</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              data-testid="schedule-time"
            />
          </label>
          {error && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
            data-testid="schedule-cancel"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1"
            data-testid="schedule-confirm"
          >
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Calendar size={14} />}
            Set reminder
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message, onQuickReply }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
          isUser ? "bg-slate-900 text-white rounded-br-sm"
                 : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm"
        }`}
      >
        {message.content}
        {!isUser && (message.quickReplies || []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(message.quickReplies || []).slice(0, 4).map((qr, i) => (
              <button
                key={i}
                onClick={() => onQuickReply?.(qr)}
                className="text-[11px] px-2.5 py-1 rounded-full border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                data-testid={`review-quick-reply-${i}`}
              >
                {qr}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ItemContextCard({ item }) {
  const ctx = item.context || {};
  const money = (n) => (n == null ? "" : `$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`);
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
        {ITEM_TYPE_LABELS[item.item_type] || "Item"}
      </div>
      <div className="mt-1 text-sm text-slate-900">{item.prompt}</div>
      {(ctx.amount != null || ctx.date || ctx.merchant) && (
        <div className="mt-2 flex gap-3 text-[11px] text-slate-500">
          {ctx.date && <span>{ctx.date}</span>}
          {ctx.amount != null && <span>{money(ctx.amount)}</span>}
          {ctx.merchant && <span className="truncate">{ctx.merchant}</span>}
        </div>
      )}
    </div>
  );
}

function SummaryScreen({ session, onComplete }) {
  useEffect(() => {
    if (session?.status !== "completed") onComplete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const answered = session?.answer_count ?? 0;
  const deferred = session?.defer_count ?? 0;
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 p-6 text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-emerald-100 flex items-center justify-center">
          <Check className="text-emerald-700" size={22} />
        </div>
        <h1 className="mt-4 font-heading text-xl text-slate-900">
          Thanks — all done.
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          <strong>{answered}</strong> answer{answered === 1 ? "" : "s"} updated your books.
          {deferred > 0 && (
            <> <strong>{deferred}</strong> question{deferred === 1 ? "" : "s"} went to your bookkeeper.</>
          )}
        </p>
        <div className="mt-6 text-[11px] text-slate-400">
          You can close this window.
        </div>
      </div>
    </div>
  );
}

function FullPageStatus({ icon, text }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 p-6 text-center">
        <div className="w-10 h-10 mx-auto rounded-full bg-slate-100 flex items-center justify-center text-slate-600">
          {icon}
        </div>
        <p className="mt-3 text-sm text-slate-700">{text}</p>
      </div>
    </div>
  );
}
