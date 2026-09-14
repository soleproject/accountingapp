import React, { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import axios from "axios";
import { Send, Paperclip, HelpCircle, Loader2, Check, ArrowRight, Calendar, X, Mic, MicOff, ChevronLeft, ChevronRight } from "lucide-react";

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
  // ── Web Speech dictation (Milestone: mic on client review page) ────
  // Uses the browser's SpeechRecognition API — zero backend cost, no
  // key, no extra deps. Supported in Chrome / Edge / Safari. Unsupported
  // browsers (Firefox) hide the mic button.
  const [listening, setListening] = useState(false);
  const recogRef = useRef(null);
  const micSupported = typeof window !== "undefined" &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const toggleMic = () => {
    if (!micSupported) return;
    // If already listening, stop → onend will flip state.
    if (listening && recogRef.current) {
      try { recogRef.current.stop(); } catch {}
      return;
    }
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recog = new Ctor();
    recog.lang = navigator.language || "en-US";
    recog.interimResults = true;   // live-append as they speak
    recog.continuous = false;      // one turn per press — nicer UX
    // Track only interim text from THIS session so we don't
    // overwrite what the user had already typed.
    const baseline = input.endsWith(" ") || !input ? input : input + " ";
    let sessionText = "";
    recog.onresult = (e) => {
      let interim = "";
      let finalized = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalized += chunk;
        else interim += chunk;
      }
      sessionText = (sessionText + finalized).trim();
      const composed = (baseline + sessionText + (interim ? " " + interim : "")).trim();
      setInput(composed);
    };
    recog.onerror = () => {
      setListening(false);
    };
    recog.onend = () => {
      setListening(false);
      recogRef.current = null;
    };
    recogRef.current = recog;
    setListening(true);
    try { recog.start(); }
    catch {
      // start() throws if invoked without user gesture or too fast
      setListening(false);
      recogRef.current = null;
    }
  };

  // Ensure recognition stops if the component unmounts mid-listen.
  useEffect(() => {
    return () => {
      if (recogRef.current) {
        try { recogRef.current.stop(); } catch {}
        recogRef.current = null;
      }
    };
  }, []);
  const chatEndRef = useRef(null);
  const fileRef = useRef(null);

  // Auto-open the schedule picker if the email link carried
  // ?action=schedule. One-shot per mount — once the client has opened
  // the picker (or dismissed it, or set a time), a subsequent session
  // update must NOT reopen it. Otherwise saving the reminder briefly
  // closes the modal, session state updates, and the effect fires
  // again and re-opens it with fresh defaults — looking like the
  // Set-reminder click did nothing.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (searchParams.get("action") === "schedule" && session && !session.completed_at) {
      autoOpenedRef.current = true;
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

  // Manual navigation — Previous / Next buttons. Unlike `advance()`
  // (which is the auto-progress after a resolved answer), these can
  // move BACKWARDS to review earlier items and can land on items
  // that are already answered / deferred so the client can peek at
  // what they told us. Restores that item's chat history on jump.
  const jumpTo = (idx) => {
    if (idx < 0 || idx >= totalCount) return;
    setActiveIdx(idx);
    const priorMsgs = (session?.items || [])[idx]?.messages || [];
    setMessages(priorMsgs.map((m) => ({
      role: m.role,
      content: m.content,
      quickReplies: m.quick_replies || [],
    })));
    setInput("");
  };
  const canPrev = activeIdx > 0;
  const canNext = activeIdx < totalCount - 1;

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
      // Split-transaction receipts (item 8) — the backend runs GPT-4o
      // vision on the image, groups line items into business/personal,
      // and returns a proposed split. Show the analysis as an
      // assistant turn with a "Use this split" quick reply so the
      // client can accept in one tap, or type a correction.
      if (currentItem.item_type === 8 && r.data.analysis) {
        const a = r.data.analysis;
        const splits = Array.isArray(a.suggested_splits) ? a.suggested_splits : [];
        const money = (n) => `$${Math.abs(Number(n) || 0).toLocaleString("en-US", {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        })}`;
        const splitLines = splits.map(
          (s) => `• ${s.account_name}: ${money(s.amount)}${s.percent != null ? ` (${s.percent}%)` : ""}`
        ).join("\n");
        setMessages((m) => [...m, {
          role: "assistant",
          content: `${a.narrative || "Here's what I read from the receipt:"}\n\n${splitLines}\n\nUse this split, or tell me how to adjust it.`,
          quickReplies: ["Use this split", "Something's off"],
          _splitProposal: a,   // stashed on the message so the quick-reply handler can grab it
        }]);
        return;   // don't auto-close; wait for confirmation
      }
      // Uploads ARE the answer for W-9 (item 4), missing receipt
      // (item 3), and liability split (item 9). Advance immediately.
      if ([3, 4, 9].includes(currentItem.item_type)) {
        setMessages((m) => [...m, {
          role: "assistant",
          content: "Got it — filed away. On to the next question.",
        }]);
        await applyAnswer(
          { flow: "attached", filename: r.data.attachment.filename },
          `Uploaded ${r.data.attachment.filename}`,
        );
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
          <button
            onClick={() => jumpTo(activeIdx - 1)}
            disabled={!canPrev}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed shrink-0"
            title="Previous question"
            data-testid="review-prev-btn"
          >
            <ChevronLeft size={18} />
          </button>
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
              {currentItem?.answered_at && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-[10px] font-mono-num uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200"
                  data-testid="review-item-answered-chip"
                >
                  <Check size={9} /> answered
                </span>
              )}
              {currentItem?.deferred && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-[10px] font-mono-num uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200"
                  data-testid="review-item-deferred-chip"
                >
                  sent to bookkeeper
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => jumpTo(activeIdx + 1)}
            disabled={!canNext}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed shrink-0"
            title="Next question"
            data-testid="review-next-btn"
          >
            <ChevronRight size={18} />
          </button>
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
            <ChatBubble
              key={i}
              message={m}
              onQuickReply={(t) => {
                // Special: "Use this split" applies the AI's proposed
                // receipt split immediately instead of round-tripping
                // through Haiku.
                if (t === "Use this split" && m._splitProposal) {
                  const a = m._splitProposal;
                  applyAnswer(
                    {
                      flow: "receipt_split",
                      suggested_splits: a.suggested_splits || [],
                      totals: a.totals || null,
                      narrative: a.narrative || "",
                    },
                    `Approved AI split: ${(a.suggested_splits || [])
                      .map((s) => `${s.account_name} $${Number(s.amount || 0).toFixed(2)}`)
                      .join(", ")}`,
                  );
                  return;
                }
                sendTurn(t);
              }}
            />
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
              placeholder={listening ? "Listening… speak your answer" : "Type your answer…"}
              rows={1}
              className="flex-1 resize-none px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-500"
              data-testid="review-input"
            />
            {micSupported && (
              <button
                onClick={toggleMic}
                disabled={sending}
                className={`p-2 rounded-lg border ${
                  listening
                    ? "border-red-400 bg-red-50 text-red-600 animate-pulse"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                } disabled:opacity-40`}
                title={listening ? "Stop dictation" : "Dictate your answer"}
                data-testid="review-mic-btn"
              >
                {listening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}
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
                <Calendar size={11} />
                {session?.scheduled_for
                  ? `Scheduled for ${new Date(session.scheduled_for).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · Change`
                  : "Schedule for later"}
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
            setSession((s) => ({ ...s, scheduled_for: iso, status: "scheduled" }));
            setShowSchedule(false);
            // Also strip the ?action=schedule param so the auto-open
            // effect doesn't immediately re-open the modal with fresh
            // defaults (which looks like the click did nothing).
            const params = new URLSearchParams(searchParams);
            params.delete("action");
            setSearchParams(params, { replace: true });
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
  const meta = ctx.meta || {};
  // Pull transaction details from either the top-level context (used
  // by ITEM_UNCATEGORIZED which mirrors the transaction directly) or
  // from `context.meta.*` (used by every agent-finding-backed item —
  // vendor confirmations, missing receipts, ambiguous transfers,
  // splits, liability splits, recurring charges, etc.).
  const amount     = ctx.amount     ?? meta.txn_amount   ?? meta.amount   ?? null;
  const date       = ctx.date       ?? meta.txn_date     ?? null;
  const description= ctx.description?? meta.txn_desc     ?? null;
  const merchant   = ctx.merchant   ?? meta.vendor       ?? meta.contact_name ?? null;
  const account    = ctx.account    ?? meta.account      ?? meta.debit_acct  ?? null;
  // Domain-specific extras — surface when present so the client sees
  // "why is this being asked" without needing to click deeper.
  const cadence    = meta.cadence   ?? null;
  const ytdPaid    = meta.ytd_paid  ?? null;
  const daysApart  = meta.days_apart?? null;
  const creditAcct = meta.credit_acct ?? null;
  const state      = meta.state ?? null;

  const money = (n) => (n == null ? "" : `$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`);
  const fmtDate = (d) => {
    if (!d) return "";
    // Handle "YYYY-MM-DD" without timezone-shifting.
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const local = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return local.toLocaleDateString(undefined, {
        month: "short", day: "numeric", year: "numeric",
      });
    }
    try {
      return new Date(d).toLocaleDateString(undefined, {
        month: "short", day: "numeric", year: "numeric",
      });
    } catch {
      return String(d);
    }
  };

  // The primary "line item" — the fact of the transaction (date /
  // description / amount). Only rendered when we have at least one of
  // the three fields; otherwise fall back to the prompt-only card.
  const hasLineItem = date || description || merchant || amount != null;
  // Description shown on the card. Prefer the raw bank descriptor,
  // fall back to the resolved merchant name.
  const lineDesc = description || merchant || "";
  const isNegative = amount != null && Number(amount) < 0;

  // Splits / liability buckets — rendered under the primary line.
  const splits = Array.isArray(meta.suggested_splits) ? meta.suggested_splits : null;
  const buckets = Array.isArray(meta.expected_buckets) ? meta.expected_buckets : null;

  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
          {ITEM_TYPE_LABELS[item.item_type] || "Item"}
        </div>
        <div className="mt-1 text-sm text-slate-900">{item.prompt}</div>
      </div>

      {hasLineItem && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3"
             data-testid="review-txn-card">
          <div className="grid grid-cols-[auto_1fr_auto] gap-x-4 gap-y-2 items-baseline">
            <div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                Date
              </div>
              <div className="mt-0.5 text-sm text-slate-900 font-mono-num tabular-nums"
                   data-testid="txn-card-date">
                {date ? fmtDate(date) : <span className="text-slate-400">—</span>}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                Description
              </div>
              <div className="mt-0.5 text-sm text-slate-900 truncate"
                   title={lineDesc}
                   data-testid="txn-card-description">
                {lineDesc || <span className="text-slate-400">—</span>}
              </div>
              {merchant && description && merchant !== description && (
                <div className="text-[11px] text-slate-500 truncate mt-0.5"
                     data-testid="txn-card-merchant">
                  {merchant}
                </div>
              )}
              {account && (
                <div className="text-[11px] text-slate-500 truncate mt-0.5"
                     data-testid="txn-card-account">
                  {account}
                  {creditAcct && <span className="text-slate-400"> → {creditAcct}</span>}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                Amount
              </div>
              <div
                className={`mt-0.5 text-base font-semibold font-mono-num tabular-nums ${
                  isNegative ? "text-slate-900" : "text-emerald-700"
                }`}
                data-testid="txn-card-amount"
              >
                {amount != null
                  ? `${isNegative ? "−" : "+"}${money(amount)}`
                  : <span className="text-slate-400 text-sm font-normal">—</span>}
              </div>
            </div>
          </div>

          {/* Domain-specific meta — surfaced when it helps the client
              understand WHY this question is here. */}
          {(cadence || ytdPaid != null || daysApart != null || state) && (
            <div className="mt-3 pt-3 border-t border-slate-200 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
              {cadence && <span data-testid="chip-cadence">Repeats {cadence}</span>}
              {ytdPaid != null && <span data-testid="chip-ytd">{money(ytdPaid)} paid YTD</span>}
              {daysApart != null && <span data-testid="chip-days-apart">{daysApart} day{daysApart === 1 ? "" : "s"} apart</span>}
              {state && <span data-testid="chip-state">{state}</span>}
            </div>
          )}
        </div>
      )}

      {splits && splits.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3"
             data-testid="chip-splits">
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">
            AI suggested split
          </div>
          {splits.map((s, i) => (
            <div key={i} className="flex items-center justify-between text-sm text-slate-700 py-0.5">
              <span className="truncate">{s.account_name || `Line ${i + 1}`}</span>
              <span className="font-mono-num tabular-nums text-slate-500">
                {money(s.amount)}{s.percent != null ? ` · ${s.percent}%` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {buckets && buckets.length > 0 && (
        <div className="text-[11px] text-slate-500 px-1" data-testid="chip-buckets">
          Expected buckets: {buckets.join(" · ")}
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
