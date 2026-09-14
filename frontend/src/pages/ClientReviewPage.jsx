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

// Item types that surface the 📎 paperclip in the composer:
//   1 — Uncategorized transaction (receipt as evidence + optional category)
//   2 — Vendor categorization confirmation (receipt as evidence)
//   3 — Missing receipt (upload IS the answer)
//   4 — W-9 needed (upload IS the answer)
//   8 — Split receipt (upload runs GPT-4o line-item vision)
//   9 — Liability payment (upload runs GPT-4o statement vision)
const UPLOAD_ITEM_TYPES = new Set([1, 2, 3, 4, 8, 9]);

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
        // Restore any prior message history AND rehydrate the vision
        // breakdown / upload bubbles so returning feels identical.
        if (idx !== -1) {
          setMessages(hydrateMessages((r.data.items || [])[idx]));
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
      // If the backend re-ran the vision analysis (Q8 refresh), render
      // the updated breakdown card instead of a plain text bubble.
      if (a.analysis) {
        setMessages((m) => [...m, {
          role: "assistant",
          content: a.assistant_reply,
          quickReplies: a.quick_replies || ["Use this split", "Something's off"],
          _splitProposal: a.analysis,
          _splitBreakdown: {
            line_items:       a.analysis.line_items       || [],
            suggested_splits: a.analysis.suggested_splits || [],
            totals:           a.analysis.totals           || null,
          },
        }]);
      } else {
        setMessages((m) => [...m, {
          role: "assistant",
          content: a.assistant_reply,
          quickReplies: a.quick_replies || [],
          action: a.action,
        }]);
      }
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

  // Friendly rotating transitions the AI drops between questions so
  // the client feels acknowledged before the next prompt appears.
  // Two pools:
  //   * DEPARTURE — bubble that lands at the END of the CURRENT chat
  //     the moment the answer is captured ("got it, moving on…").
  //   * ARRIVAL — bubble that opens the NEXT question's chat, framing
  //     the new prompt ("ok, here's the next one…").
  // Same-line-twice avoidance via `last*IdxRef` refs so nothing feels
  // canned across the 9 questions.
  const DEPARTURE_LINES = [
    "Perfect — moving on.",
    "Got it. On to the next one.",
    "Nice work. Let's keep going.",
    "That's one down — here's the next.",
    "Awesome. Onward!",
    "Great, that's handled.",
    "Smooth. Locked in.",
    "Filed away — nicely done.",
    "You're crushing it.",
    "Boom, done.",
    "Solid. Let's roll.",
    "Captured — thanks!",
  ];
  const ARRIVAL_LINES = [
    "Ok, here's the next one.",
    "Alright — this one next.",
    "Here comes the next question.",
    "Next up:",
    "Ok, let's tackle this one.",
    "This one should be quick.",
    "Alright, here's what I've got next.",
    "One more coming — this one:",
    "Ok, on to this one.",
    "Here we go — next question.",
  ];
  const lastDepartureIdxRef = useRef(-1);
  const lastArrivalIdxRef = useRef(-1);
  const pickFrom = (pool, ref) => {
    if (pool.length <= 1) return pool[0];
    let i = Math.floor(Math.random() * pool.length);
    if (i === ref.current) i = (i + 1) % pool.length;
    ref.current = i;
    return pool[i];
  };
  const pickDeparture = () => pickFrom(DEPARTURE_LINES, lastDepartureIdxRef);
  const pickArrival   = () => pickFrom(ARRIVAL_LINES,   lastArrivalIdxRef);

  const advance = () => {
    const nextIdx = (session?.items || []).findIndex(
      (i, k) => k > activeIdx && !i.answered_at && !i.deferred
    );
    const wasLast = nextIdx === -1;

    // Mark the current item as answered locally so the progress bar
    // ticks over immediately.
    setSession((s) => {
      if (!s) return s;
      const items = [...(s.items || [])];
      if (currentItem) {
        items[activeIdx] = { ...items[activeIdx], answered_at: new Date().toISOString() };
      }
      return { ...s, items };
    });

    // On the wrap-up screen there's no next question to introduce, so
    // skip the transition entirely.
    if (wasLast) {
      setMessages([]);
      setActiveIdx(totalCount);
      return;
    }

    // Drop the DEPARTURE bubble at the END of the CURRENT chat, pause
    // ~2.1 s so the user visibly sees the acknowledgment, THEN flip to
    // the next question with an ARRIVAL bubble already in place framing
    // the new prompt. This "goodbye → hello" pairing feels human — the
    // AI acknowledged what just happened AND welcomes the next task.
    const dep = pickDeparture();
    setMessages((m) => [...m, {
      role: "assistant",
      content: dep,
      isTransition: true,
    }]);
    const arr = pickArrival();
    setTimeout(() => {
      setMessages([{
        role: "assistant",
        content: arr,
        isTransition: true,
      }]);
      setActiveIdx(nextIdx);
    }, 2100);
  };

  // Manual navigation — Previous / Next buttons. Unlike `advance()`
  // (which is the auto-progress after a resolved answer), these can
  // move BACKWARDS to review earlier items and can land on items
  // that are already answered / deferred so the client can peek at
  // Restore the full look of an item's chat when you jump back —
  // stored messages PLUS reconstructing the "📎 Uploaded ..." bubble
  // and vision breakdown (receipt / categorization / liability) that
  // the AI already produced on the earlier visit, so returning to a
  // question feels exactly like when you left it.
  const hydrateMessages = (item) => {
    const priorMsgs = (item?.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
      quickReplies: m.quick_replies || [],
    }));
    const answered = !!item?.answered_at;
    const atts = item?.attachments || [];
    const hydrated = [...priorMsgs];
    for (const a of atts) {
      hydrated.push({
        role: "user",
        content: `📎 Uploaded ${a.filename || "receipt"}`,
        _attachmentId: a.id,
        _itemId:       item.item_id,
        // Once an answer is filed, the ✕ is disabled — the receipt is
        // now part of the booked JE, removing it would orphan the split.
        _readOnly:     answered,
      });
    }
    // Vision breakdowns are read-only after answer, but STILL shown so
    // returning to an answered question feels like scrolling back
    // through what you saw, not landing on an empty page.
    const breakdownReplies = answered ? [] : ["Use this split", "Something's off"];
    if (item?.categorization_analysis) {
      const a = item.categorization_analysis;
      hydrated.push({
        role: "assistant",
        content: a.narrative || "Here's what I read from the receipt:",
        quickReplies: breakdownReplies,
        _categorizationProposal: a,
        _categorizationBreakdown: {
          line_items:           a.line_items           || [],
          suggested_categories: a.suggested_categories || [],
          totals:               a.totals               || null,
        },
      });
    } else if (item?.receipt_analysis) {
      const a = item.receipt_analysis;
      hydrated.push({
        role: "assistant",
        content: a.narrative || "Here's what I read from the receipt:",
        quickReplies: breakdownReplies,
        _splitProposal: a,
        _splitBreakdown: {
          line_items:        a.line_items       || [],
          suggested_splits:  a.suggested_splits || [],
          totals:            a.totals           || null,
        },
      });
    } else if (item?.liability_analysis) {
      const a = item.liability_analysis;
      hydrated.push({
        role: "assistant",
        content: a.narrative ||
          `Here's what I read from the loan statement${a.lender_name ? ` (${a.lender_name})` : ""}:`,
        quickReplies: breakdownReplies,
        _liabilityProposal: a,
        _liabilityBreakdown: {
          statement_type: a.statement_type,
          lender_name:    a.lender_name,
          buckets:        a.buckets   || [],
          totals:         a.totals    || null,
          payment_amount: a.payment_amount,
        },
      });
    }
    // Cap it off with a confirmation bubble so it's crystal clear the
    // answer is locked. Includes the plain-English "Approved split: …"
    // line the client sent, so they see exactly what got posted.
    if (answered) {
      const note = item.client_answer ||
                   item.answer_summary ||
                   "Your answer was submitted to your bookkeeper.";
      hydrated.push({
        role: "assistant",
        content: `✓ Answered on ${(item.answered_at || "").slice(0, 10)} — ${note}`,
        _readOnlyAnswered: true,
      });
    }
    return hydrated;
  };


  // Jump to a specific question by index. Keeps a light audit of
  // what they told us. Restores that item's chat history on jump.
  const jumpTo = (idx) => {
    if (idx < 0 || idx >= totalCount) return;
    setActiveIdx(idx);
    setMessages(hydrateMessages((session?.items || [])[idx]));
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
                       : currentItem.item_type === 8 ? "split_receipt"
                       : "receipt");
      const r = await axios.post(
        `${API}/${token}/items/${currentItem.item_id}/upload`,
        form
      );
      // Patch the local session so a jump-away + return rehydrates
      // this attachment + its vision analysis instead of showing a
      // blank Q1 again. Backend already persisted everything to
      // `client_review_batches.items[]`; we just mirror it locally.
      setSession((prev) => {
        if (!prev) return prev;
        const items = (prev.items || []).map((it) => {
          if (it.item_id !== currentItem.item_id) return it;
          const patched = { ...it };
          patched.attachments = [
            ...(it.attachments || []),
            r.data.attachment,
          ];
          if (r.data.categorization_analysis) {
            patched.categorization_analysis = r.data.categorization_analysis;
          }
          if (r.data.analysis) {
            patched.receipt_analysis = r.data.analysis;
          }
          if (r.data.liability_analysis) {
            patched.liability_analysis = r.data.liability_analysis;
          }
          return patched;
        });
        return { ...prev, items };
      });
      setMessages((m) => [...m, {
        role: "user",
        content: `📎 Uploaded ${r.data.attachment.filename}`,
        _attachmentId: r.data.attachment.id,   // for the delete button
        _itemId:       currentItem.item_id,
      }]);
      // Split-transaction receipts (item 8) — the backend runs GPT-4o
      // vision on the image, groups line items into business/personal,
      // and returns a proposed split. Render the FULL breakdown so
      // the client sees exactly how each line was classified.
      if (currentItem.item_type === 8 && r.data.analysis) {
        const a = r.data.analysis;
        setMessages((m) => [...m, {
          role: "assistant",
          content: a.narrative || "Here's what I read from the receipt:",
          quickReplies: ["Use this split", "Something's off"],
          _splitProposal: a,   // stashed for the quick-reply handler
          _splitBreakdown: {
            line_items:        a.line_items       || [],
            suggested_splits:  a.suggested_splits || [],
            totals:            a.totals           || null,
          },
        }]);
        return;   // don't auto-close; wait for confirmation
      }
      // Liability statement (item 9) — backend runs GPT-4o vision on
      // the mortgage / credit-card / auto-loan statement and returns
      // Principal / Interest / Escrow / Fees buckets so the client
      // sees exactly how their payment retires the loan.
      if (currentItem.item_type === 9 && r.data.liability_analysis) {
        const a = r.data.liability_analysis;
        const kind = ({
          mortgage:      "mortgage statement",
          credit_card:   "credit-card statement",
          auto_loan:     "auto-loan statement",
          generic_loan:  "loan statement",
        })[a.statement_type] || "loan statement";
        setMessages((m) => [...m, {
          role: "assistant",
          content: a.narrative ||
            `Here's what I read from the ${kind}${a.lender_name ? ` (${a.lender_name})` : ""}:`,
          quickReplies: ["Use this split", "Something's off"],
          _liabilityProposal: a,
          _liabilityBreakdown: {
            statement_type: a.statement_type,
            lender_name:    a.lender_name,
            buckets:        a.buckets   || [],
            totals:         a.totals    || null,
            payment_amount: a.payment_amount,
          },
        }]);
        return;   // wait for "Use this split" confirmation
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
      // Uncategorized transaction (item 1) / vendor categorization
      // (item 2) — backend runs GPT-4o vision on the receipt and
      // returns a per-line-item Chart-of-Accounts split. Render the
      // grouped breakdown so the client sees each line mapped to an
      // account and can tap "Use this split" or tweak an account.
      if ([1, 2].includes(currentItem.item_type) && r.data.categorization_analysis) {
        const a = r.data.categorization_analysis;
        setMessages((m) => [...m, {
          role: "assistant",
          content: a.narrative || "Here's what I read from the receipt:",
          quickReplies: ["Use this split", "Something's off"],
          _categorizationProposal: a,
          _categorizationBreakdown: {
            line_items:           a.line_items           || [],
            suggested_categories: a.suggested_categories || [],
            totals:               a.totals               || null,
          },
        }]);
        return;   // wait for "Use this split" confirmation
      }
      // Vision fell through (no OpenAI key, no COA, or LLM error) —
      // fall back to the plain ack + prompt for a description so the
      // bookkeeper still gets something.
      if ([1, 2].includes(currentItem.item_type)) {
        setMessages((m) => [...m, {
          role: "assistant",
          content:
            "Got it — receipt attached. In one line, what was this for? " +
            "(e.g. \"lumber for the Miller job\", \"office supplies\", " +
            "\"team lunch after the install\"). I'll pass it to your " +
            "bookkeeper with the photo.",
        }]);
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

  // Delete an attachment the client just uploaded. Called from the
  // little ✕ on the dark "📎 Uploaded receipt.png" bubble. Removes
  // it from the batch item, the source record (transaction /
  // contact / finding), and drops the assistant response bubbles
  // that were generated FROM that upload (categorization proposal,
  // vision split, etc.) so the client can rescan cleanly.
  const removeAttachment = async (attachmentId, itemId, msgIndex) => {
    if (!attachmentId || !itemId) return;
    try {
      await axios.delete(`${API}/${token}/items/${itemId}/attachments/${attachmentId}`);
    } catch {
      // If the DELETE 404s (already gone) we still want the UI to clean up.
    }
    // Mirror the removal on the local session so rehydrate is clean
    // on the next jump back.
    setSession((prev) => {
      if (!prev) return prev;
      const items = (prev.items || []).map((it) => {
        if (it.item_id !== itemId) return it;
        return {
          ...it,
          attachments: (it.attachments || []).filter((a) => a.id !== attachmentId),
          // Vision analyses are tied to the attachment — drop them too.
          categorization_analysis: undefined,
          receipt_analysis:         undefined,
          liability_analysis:       undefined,
        };
      });
      return { ...prev, items };
    });
    // Drop the "Uploaded …" bubble AND the assistant reply that
    // immediately followed it (which is either the vision breakdown
    // or the "Got it, what was this for?" prompt).
    setMessages((prev) => {
      if (msgIndex == null) return prev;
      const next = [...prev];
      // Remove the assistant bubble that came right after, if it
      // was generated from this upload (vision/ack).
      const after = next[msgIndex + 1];
      if (after && after.role === "assistant" &&
          (after._categorizationBreakdown || after._splitBreakdown ||
           after._liabilityBreakdown ||
           /receipt attached|filed away|Here's what I read/i.test(after.content || ""))) {
        next.splice(msgIndex + 1, 1);
      }
      next.splice(msgIndex, 1);
      return next;
    });
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

      {/* Arrival transition bubble — the AI's "ok, here's the next
          one" line that opens a fresh question. Rendered ABOVE the
          question card so it introduces the prompt (a bubble below
          the card feels like a trailing comment on the PREVIOUS
          answer). Only the first message is treated as an arrival. */}
      {currentItem && messages[0]?.isTransition && (
        <div className="max-w-2xl mx-auto w-full px-4 pt-3">
          <ChatBubble message={{ role: "assistant", content: messages[0].content }} />
        </div>
      )}

      {/* Item context card */}
      {currentItem && (
        <div className="max-w-2xl mx-auto w-full px-4 pt-4">
          <ItemContextCard item={currentItem} />
        </div>
      )}

      {/* Chat */}
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-4">
        <div className="space-y-3">
          {/* `visibleMessages` = the chat excluding the leading arrival
              transition bubble (rendered ABOVE the item card). Initial
              per-item prompts should appear when the client hasn't
              actually replied yet, even if the "here's the next one"
              transition is still on-screen above the card. */}
          {(() => { return null; })()}
          {messages.filter((m) => !m.isTransition).length === 0 && currentItem && currentItem.item_type === 4 && (
            <ChatBubble
              message={{
                role: "assistant",
                content:
                  "Two ways to knock this out — you can grab the info yourself, or we can email them for you.",
                quickReplies: [
                  "What information should I get from them",
                  "Please contact them and get the info for me",
                ],
              }}
              onQuickReply={(qr) => {
                if (qr === "What information should I get from them") {
                  setMessages((prev) => [...prev, {
                    role: "user", content: qr,
                  }, {
                    role: "assistant",
                    _w9Checklist: true,
                    content: "Here's exactly what you need from them:",
                    quickReplies: [
                      "Download current-year W-9 (PDF)",
                      "Create an email for me",
                    ],
                  }]);
                } else {
                  // Hand-off — CPA picks it up. Fire the standard
                  // "defer" flow so the batch tracker knows.
                  setMessages((prev) => [...prev, {
                    role: "user", content: qr,
                  }, {
                    role: "assistant",
                    content: "Perfect — I'll email them the W-9 request today and follow up. You'll see the completed form back in your books once they return it. Nothing else needed from you.",
                  }]);
                  deferItem();
                }
              }}
            />
          )}
          {messages.length === 0 && currentItem && currentItem.item_type === 8 && (
            <ChatBubble
              message={{
                role: "assistant",
                content:
                  "Before I dig into the receipt — is this charge all business, or a mix of business and personal? If it's all business, I can categorize it in one shot. Otherwise, upload the receipt and I'll read each line item and propose a split.",
                quickReplies: ["All business", "It's a mix — I'll upload the receipt"],
              }}
              onQuickReply={(qr) => {
                if (qr === "All business") {
                  // Ask what account to book the whole amount to.
                  setMessages([
                    { role: "user", content: "It's all business." },
                    { role: "assistant",
                      content: "Perfect — no need to upload the receipt then. What business account should I book the whole $1,200.00 to? (e.g. Office Supplies, Materials, Meals, Tools)" },
                  ]);
                } else {
                  setMessages([
                    { role: "user", content: qr },
                    { role: "assistant",
                      content: "Great — tap the 📎 paperclip below and pick the receipt. I'll read every line and mark each one as business or personal for your industry. You can tap any line to flip it after." },
                  ]);
                }
              }}
            />
          )}
          {messages.length === 0 && currentItem && currentItem.item_type === 9 && (
            <ChatBubble
              message={{
                role: "assistant",
                content:
                  "This looks like a liability payment — a mortgage, credit card, auto loan, or business loan. The easiest path is to upload the statement (photo or PDF) and I'll pull out the principal, interest, escrow, and fees so we can post each piece to the right account.",
                quickReplies: [
                  "Upload the statement",
                  "I don't have the statement",
                ],
              }}
              onQuickReply={(qr) => {
                if (qr === "Upload the statement") {
                  setMessages([
                    { role: "user", content: qr },
                    { role: "assistant",
                      content: "Great — tap the 📎 paperclip below and pick the statement (mortgage, credit card, or auto-loan). I'll read the payment breakdown line-by-line and propose the split. You can adjust any line before confirming." },
                  ]);
                } else {
                  setMessages([
                    { role: "user", content: qr },
                    { role: "assistant",
                      content: "No worries — what kind of liability is this (mortgage, credit card, auto loan, or business loan)? If you know the split — for example \"$812 principal, $1,104 interest\" — you can just type it and I'll book it." },
                  ]);
                }
              }}
            />
          )}
          {messages.filter((m) => !m.isTransition).length === 0 && currentItem && ![4, 8, 9].includes(currentItem.item_type) && (
            <div className="text-center text-xs text-slate-500 py-4">
              Type your answer below, or tap "not sure" to send this to your bookkeeper.
            </div>
          )}
          {messages.map((m, i) => (
            // Skip the leading arrival transition bubble — it's already
            // rendered above the ItemContextCard so it opens the slide
            // instead of trailing below it.
            i === 0 && m.isTransition ? null : (
            <ChatBubble
              key={i}
              message={m}
              w9Token={token}
              w9ItemId={currentItem?.item_id}
              onW9Sent={(to) => {
                // Mirror the "we'll let you know when they reply"
                // acknowledgment as a chat bubble AND advance the flow
                // — the item is server-side deferred by the endpoint.
                setMessages((prev) => [...prev, {
                  role: "assistant",
                  content: `Locked in — email sent to ${to || "them"}. As soon as they reply with the completed W-9, you'll see it back in your books.`,
                }]);
                setTimeout(() => advance(), 900);
              }}
              onRemoveAttachment={(aid, itemId) => removeAttachment(aid, itemId, i)}
              onBreakdownChange={(next) => {
                setMessages((prev) => prev.map((mm, idx) => {
                  if (idx !== i) return mm;
                  if (mm._liabilityBreakdown) {
                    return { ...mm, _liabilityBreakdown: next, _liabilityProposal: next };
                  }
                  if (mm._categorizationBreakdown) {
                    return { ...mm, _categorizationBreakdown: next, _categorizationProposal: next };
                  }
                  return { ...mm, _splitBreakdown: next, _splitProposal: next };
                }));
              }}
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
                      line_items: a.line_items || [],
                    },
                    `Approved split: ${(a.suggested_splits || [])
                      .map((s) => `${s.account_name} $${Number(s.amount || 0).toFixed(2)}`)
                      .join(", ")}`,
                  );
                  return;
                }
                // Liability statement (item 9) "Use this split" — apply
                // Principal / Interest / Escrow / Fees buckets.
                if (t === "Use this split" && m._liabilityProposal) {
                  const a = m._liabilityProposal;
                  applyAnswer(
                    {
                      flow: "liability_split",
                      statement_type: a.statement_type,
                      lender_name:    a.lender_name,
                      buckets:        a.buckets || [],
                      totals:         a.totals || null,
                      payment_amount: a.payment_amount,
                    },
                    `Approved split: ${(a.buckets || [])
                      .map((b) => `${b.label} $${Number(b.amount || 0).toFixed(2)}`)
                      .join(", ")}`,
                  );
                  return;
                }
                // Receipt categorization (item 1/2) "Use this split" —
                // apply per-account subtotals so the bookkeeper posts
                // the transaction as a multi-line JE.
                if (t === "Use this split" && m._categorizationProposal) {
                  const a = m._categorizationProposal;
                  applyAnswer(
                    {
                      flow: "receipt_categorization",
                      line_items:           a.line_items           || [],
                      suggested_categories: a.suggested_categories || [],
                      totals:               a.totals               || null,
                      narrative:            a.narrative            || "",
                    },
                    `Approved categorization: ${(a.suggested_categories || [])
                      .map((s) => `${s.account_name} $${Number(s.amount || 0).toFixed(2)}`)
                      .join(", ")}`,
                  );
                  return;
                }
                // "Something's off" / "Still off — I'll tap the lines"
                // are pure UI hints — no round-trip needed. Just prompt
                // the client to either tap lines or add context in chat.
                if (t === "Something's off" || t === "Still off — I'll tap the lines") {
                  setMessages((prev) => [...prev, {
                    role: "assistant",
                    content:
                      "No problem — either tap the lines above to move them between business and personal, or just tell me what's off (e.g. \"the coffee is for the office kitchen\" or \"I run a restaurant so food is inventory\"). I'll re-read it with that context.",
                  }]);
                  return;
                }
                // Q4 (W-9 collection) — download the IRS fw9.pdf.
                if (t === "Download current-year W-9 (PDF)") {
                  window.open("https://www.irs.gov/pub/irs-pdf/fw9.pdf",
                              "_blank", "noopener,noreferrer");
                  setMessages((prev) => [...prev, {
                    role: "user", content: t,
                  }, {
                    role: "assistant",
                    content: "Opened the IRS fw9.pdf in a new tab — grab it and send it to them however works best.",
                  }]);
                  return;
                }
                // Q4 — offer a canned request email the client can send
                // or copy. `_w9EmailDraft` renders the composable card.
                if (t === "Create an email for me") {
                  const contactName = currentItem?.context?.meta?.contact_name
                    || "the vendor";
                  const companyName = session?.company_name || "our company";
                  const subject = `W-9 request from ${companyName}`;
                  const bodyTxt =
`Hi,

For year-end 1099 reporting, ${companyName} needs a completed Form W-9 from ${contactName} on file. You can grab the official IRS form here:
https://www.irs.gov/pub/irs-pdf/fw9.pdf

Please fill it out and reply to this email with the completed form attached. Let me know if you have any questions.

Thanks,
${companyName}`;
                  setMessages((prev) => [...prev, {
                    role: "user", content: t,
                  }, {
                    role: "assistant",
                    _w9EmailDraft: { subject, body: bodyTxt },
                    content: "Here's a ready-to-go message. Send it directly or copy it into your own email tool.",
                  }]);
                  return;
                }
                sendTurn(t);
              }}
            />
            )
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

function SplitBreakdown({ breakdown, onChange }) {
  // Local editable copy of the AI's initial classification. Clicks on
  // a line item flip its `kind` between business ↔ personal so the
  // client can override anything the model got wrong. Subtotals + the
  // proposed split reflow live. `onChange(next)` propagates edits up
  // so "Use this split" applies the edited version.
  const [items, setItems] = React.useState(() =>
    (breakdown.line_items || []).map((x, i) => ({ ...x, _idx: i })),
  );
  const money = (n) => `$${Math.abs(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
  const flip = (idx) => {
    setItems((prev) => {
      const next = prev.map((it) => it._idx === idx
        ? { ...it, kind: it.kind === "business" ? "personal" : "business" }
        : it);
      // Recompute totals + splits from the edited items and push up.
      const totBiz = next.filter((x) => x.kind === "business")
        .reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0);
      const totPer = next.filter((x) => x.kind === "personal")
        .reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0);
      const other = next.filter((x) => !["business", "personal"].includes(x.kind))
        .reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0);
      // Split "other" (tax/shipping/unknown) proportionally between
      // business and personal so the total still adds up.
      const base = totBiz + totPer || 1;
      const bizFinal = round2(totBiz + other * (totBiz / base));
      const perFinal = round2(totPer + other * (totPer / base));
      const grand = round2(bizFinal + perFinal);
      const splits = (breakdown.suggested_splits || []).map((s, i) => ({
        ...s,
        amount: i === 0 ? bizFinal : perFinal,
        percent: grand > 0 ? Math.round(((i === 0 ? bizFinal : perFinal) / grand) * 100) : 0,
      }));
      onChange?.({
        ...breakdown,
        line_items: next.map(({ _idx, ...rest }) => rest),
        suggested_splits: splits,
        totals: { business: bizFinal, personal: perFinal, grand_total: grand },
      });
      return next;
    });
  };

  // Group items by kind for display.
  const groups = { business: [], personal: [], tax: [], shipping: [], unknown: [] };
  items.forEach((it) => {
    const k = (it.kind || "unknown").toLowerCase();
    (groups[k] || groups.unknown).push(it);
  });

  const kindStyle = {
    business: { label: "Business", bg: "bg-emerald-50",  text: "text-emerald-700", border: "border-emerald-200" },
    personal: { label: "Personal", bg: "bg-slate-50",   text: "text-slate-700",   border: "border-slate-200" },
    tax:      { label: "Tax",      bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-200" },
    shipping: { label: "Shipping", bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-200" },
    unknown:  { label: "Unclear",  bg: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-200" },
  };

  return (
    <div className="mt-3 space-y-3" data-testid="split-breakdown">
      <div className="text-[11px] text-slate-500 italic px-1">
        Tap a line to flip it between business and personal.
      </div>
      {["business", "personal", "tax", "shipping", "unknown"].map((k) => {
        const group = groups[k];
        if (!group || group.length === 0) return null;
        const style = kindStyle[k];
        const subtotal = group.reduce((s, x) => s + Math.abs(Number(x.amount || 0)), 0);
        return (
          <div key={k} className={`rounded-lg border ${style.border} ${style.bg} p-2`}>
            <div className={`flex items-center justify-between mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${style.text}`}>
              <span>{style.label} · {group.length} item{group.length === 1 ? "" : "s"}</span>
              <span className="font-mono-num tabular-nums">{money(subtotal)}</span>
            </div>
            <div className="space-y-0.5">
              {group.map((it) => (
                <button
                  key={it._idx}
                  onClick={() => (k === "business" || k === "personal") && flip(it._idx)}
                  disabled={k !== "business" && k !== "personal"}
                  className={`w-full text-left flex items-center justify-between text-[12px] rounded px-1 py-0.5 ${
                    (k === "business" || k === "personal")
                      ? "text-slate-700 hover:bg-white/60 cursor-pointer"
                      : "text-slate-500 cursor-default"
                  }`}
                  data-testid={`split-line-${it._idx}`}
                  title={
                    (k === "business" || k === "personal")
                      ? `Click to mark as ${k === "business" ? "personal" : "business"}`
                      : ""
                  }
                >
                  <span className="truncate pr-2">{it.description}</span>
                  <span className="font-mono-num tabular-nums text-slate-500 shrink-0">
                    {money(it.amount)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {(breakdown.suggested_splits || []).length > 0 && (
        <div className="rounded-lg border border-slate-300 bg-white p-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
            Proposed split
          </div>
          {(breakdown.suggested_splits || []).map((s, i) => (
            <div key={i} className="flex items-center justify-between text-sm text-slate-800 py-0.5">
              <span className="truncate pr-2">{s.account_name}</span>
              <span className="font-mono-num tabular-nums shrink-0">
                {money(s.amount)}
                {s.percent != null && <span className="text-slate-400"> · {s.percent}%</span>}
              </span>
            </div>
          ))}
          {breakdown.totals && breakdown.totals.grand_total != null && (
            <div className="mt-1.5 pt-1.5 border-t border-slate-200 flex items-center justify-between text-sm font-semibold text-slate-900">
              <span>Total</span>
              <span className="font-mono-num tabular-nums">
                {money(breakdown.totals.grand_total)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CategorizationBreakdown({ breakdown, onChange }) {
  // Editable per-line-item categorization for item_type=1/2. Each
  // line has {description, amount, account_code, account_name, kind}.
  // Client can retype an account inline; the grouped subtotals reflow.
  // This is the "categorize each line item" flavor of a receipt split —
  // it's not business/personal, it's all-business but per-account.
  const [items, setItems] = React.useState(() =>
    (breakdown.line_items || []).map((it, i) => ({ ...it, _idx: i })),
  );
  const money = (n) => `$${Math.abs(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

  const recompute = (nextItems) => {
    const buckets = new Map();
    nextItems.forEach((it, i) => {
      const key = `${it.account_code || ""}|${it.account_name || "Uncategorized"}`;
      const cur = buckets.get(key) || {
        account_code: it.account_code,
        account_name: it.account_name || "Uncategorized",
        amount:       0,
        line_indices: [],
      };
      cur.amount = Math.round((cur.amount + Number(it.amount || 0)) * 100) / 100;
      cur.line_indices.push(i);
      buckets.set(key, cur);
    });
    const suggested = [...buckets.values()].sort((a, b) => b.amount - a.amount);
    const grand = Math.round(nextItems.reduce((s, x) => s + Number(x.amount || 0), 0) * 100) / 100;
    onChange?.({
      ...breakdown,
      line_items:           nextItems.map(({ _idx, ...rest }) => rest),
      suggested_categories: suggested,
      totals:               { ...(breakdown.totals || {}), grand_total: grand },
    });
  };

  const editItem = (idx, patch) => {
    setItems((prev) => {
      const next = prev.map((it) => (it._idx === idx ? { ...it, ...patch } : it));
      recompute(next);
      return next;
    });
  };

  // Group by (account_code|account_name) for the grouped display.
  const groups = new Map();
  items.forEach((it) => {
    const key = `${it.account_code || ""}|${it.account_name || "Uncategorized"}`;
    const g = groups.get(key) || {
      account_code: it.account_code,
      account_name: it.account_name || "Uncategorized",
      subtotal:     0,
      items:        [],
    };
    g.subtotal = Math.round((g.subtotal + Number(it.amount || 0)) * 100) / 100;
    g.items.push(it);
    groups.set(key, g);
  });
  const groupList = [...groups.values()].sort((a, b) => b.subtotal - a.subtotal);
  const grand = groupList.reduce((s, g) => s + g.subtotal, 0);

  return (
    <div className="mt-3 space-y-2 max-h-96 overflow-y-auto"
         data-testid="receipt-categorization">
      <div className="text-[11px] text-slate-500 italic px-1">
        Tap an account name to change it. Every line is on the books as a business expense.
      </div>
      {groupList.map((g, gi) => (
        <div
          key={`${g.account_code || ""}-${gi}`}
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-2"
          data-testid={`cat-group-${gi}`}
        >
          <div className="flex items-center justify-between mb-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
            <span className="truncate pr-2">
              {g.account_code ? `${g.account_code} · ` : ""}{g.account_name}
              <span className="ml-1 text-emerald-600/70 font-normal normal-case tracking-normal">
                · {g.items.length} item{g.items.length === 1 ? "" : "s"}
              </span>
            </span>
            <span className="font-mono-num tabular-nums">{money(g.subtotal)}</span>
          </div>
          <div className="space-y-0.5">
            {g.items.map((it) => (
              <div key={it._idx}
                   className="flex items-center gap-2 text-[12px] text-slate-700 py-0.5"
                   data-testid={`cat-item-${it._idx}`}>
                <div className="flex-1 min-w-0">
                  <div className="truncate">{it.description}</div>
                  <input
                    type="text"
                    value={it.account_name || ""}
                    placeholder="Account name"
                    onChange={(e) => editItem(it._idx, { account_name: e.target.value })}
                    className="w-full mt-0.5 text-[11px] px-1 py-0.5 border border-transparent hover:border-emerald-300 focus:border-emerald-500 rounded bg-transparent focus:bg-white focus:outline-none"
                    data-testid={`cat-item-account-${it._idx}`}
                  />
                </div>
                <span className="font-mono-num tabular-nums text-slate-600 shrink-0">
                  {money(it.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="rounded-lg border border-slate-300 bg-white p-2">
        <div className="flex items-center justify-between text-sm font-semibold text-slate-900">
          <span>Receipt total</span>
          <span className="font-mono-num tabular-nums">{money(grand)}</span>
        </div>
      </div>
    </div>
  );
}


function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

function LiabilityBreakdown({ breakdown, onChange }) {
  // Editable bucket list for mortgage / credit-card / auto-loan
  // statements. Each bucket has {label, amount, account_name}. The
  // client can tweak any amount inline; the total reflows. `onChange`
  // pushes the edited breakdown up so "Use this split" applies it.
  const [buckets, setBuckets] = React.useState(() =>
    (breakdown.buckets || []).map((b, i) => ({ ...b, _idx: i })),
  );
  const money = (n) => `$${Math.abs(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

  const editBucket = (idx, patch) => {
    setBuckets((prev) => {
      const next = prev.map((b) => (b._idx === idx ? { ...b, ...patch } : b));
      const grand = round2(next.reduce((s, b) => s + (Number(b.amount) || 0), 0));
      onChange?.({
        ...breakdown,
        buckets: next.map(({ _idx, ...rest }) => rest),
        totals: { ...(breakdown.totals || {}), grand_total: grand },
        payment_amount: breakdown.payment_amount ?? grand,
      });
      return next;
    });
  };

  const typeStyle = {
    mortgage:     { label: "Mortgage statement",     accent: "text-rose-700",   bg: "bg-rose-50",    border: "border-rose-200"  },
    credit_card:  { label: "Credit card statement",  accent: "text-blue-700",   bg: "bg-blue-50",    border: "border-blue-200"  },
    auto_loan:    { label: "Auto loan statement",    accent: "text-indigo-700", bg: "bg-indigo-50",  border: "border-indigo-200" },
    generic_loan: { label: "Loan statement",         accent: "text-slate-700",  bg: "bg-slate-50",   border: "border-slate-200" },
  }[breakdown.statement_type] || {
    label: "Loan statement", accent: "text-slate-700",
    bg: "bg-slate-50", border: "border-slate-200",
  };

  const grandTotal = buckets.reduce((s, b) => s + (Number(b.amount) || 0), 0);

  return (
    <div className="mt-3 space-y-3" data-testid="liability-breakdown">
      <div className={`rounded-lg border ${typeStyle.border} ${typeStyle.bg} p-2.5`}>
        <div className={`flex items-center justify-between mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${typeStyle.accent}`}>
          <span>{typeStyle.label}{breakdown.lender_name ? ` · ${breakdown.lender_name}` : ""}</span>
          {breakdown.payment_amount != null && (
            <span className="font-mono-num tabular-nums">
              Payment {money(breakdown.payment_amount)}
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-500 italic mb-2">
          Tap an amount to edit if I read it wrong.
        </div>
        <div className="space-y-1">
          {buckets.map((b) => (
            <div key={b._idx} className="flex items-center gap-2 text-[13px] text-slate-800 py-0.5"
                 data-testid={`liability-bucket-${b._idx}`}>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{b.label}</div>
                {b.account_name && (
                  <div className="text-[11px] text-slate-500 truncate">
                    → {b.account_name}
                  </div>
                )}
              </div>
              <input
                type="number"
                step="0.01"
                value={b.amount ?? 0}
                onChange={(e) => editBucket(b._idx, { amount: parseFloat(e.target.value) || 0 })}
                className="w-24 text-right font-mono-num tabular-nums border border-slate-300 rounded px-1.5 py-0.5 text-[12px] bg-white shrink-0"
                data-testid={`liability-bucket-amount-${b._idx}`}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 pt-1.5 border-t border-slate-300 flex items-center justify-between text-sm font-semibold text-slate-900">
          <span>Total</span>
          <span className="font-mono-num tabular-nums">{money(grandTotal)}</span>
        </div>
      </div>
    </div>
  );
}

function W9EmailDraft({ draft, token, itemId, onSent }) {
  const [subject, setSubject] = useState(draft?.subject || "");
  const [body,    setBody]    = useState(draft?.body    || "");
  const [sending, setSending] = useState(false);
  const [copied,  setCopied]  = useState(false);
  const [needsEmail, setNeedsEmail] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [emailErr,   setEmailErr]   = useState("");
  const [sentTo, setSentTo] = useState("");

  const doSend = async (overrideEmail) => {
    setEmailErr("");
    setSending(true);
    try {
      const r = await axios.post(
        `${API}/${token}/items/${itemId}/w9-request-email`,
        { email: overrideEmail || null, subject, body },
      );
      if (r.data?.needs_email) {
        setNeedsEmail(true);
        setSending(false);
        return;
      }
      setSentTo(r.data?.sent_to || overrideEmail || "");
      onSent?.(r.data?.sent_to);
    } catch (e) {
      setEmailErr(e?.response?.data?.detail || "Send failed. Try again.");
    } finally {
      setSending(false);
    }
  };

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  if (sentTo) {
    return (
      <div className="mt-3 border border-emerald-200 bg-emerald-50 rounded-lg p-3 text-sm text-emerald-900"
           data-testid="w9-email-sent">
        <div className="font-medium">Sent to {sentTo}.</div>
        <div className="mt-1 text-emerald-800">
          We'll let you know as soon as they reply with the completed W-9.
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 border border-slate-200 rounded-lg bg-white overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wide font-semibold text-slate-600">
        Draft email
      </div>
      <div className="p-3 space-y-2">
        <div>
          <label className="text-[11px] uppercase tracking-wide text-slate-500">Subject</label>
          <input
            data-testid="w9-email-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm font-medium"
          />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-slate-500">Message</label>
          <textarea
            data-testid="w9-email-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={9}
            className="w-full border rounded px-2 py-1.5 text-sm font-mono-num leading-relaxed"
          />
        </div>
        {needsEmail && (
          <div className="border border-amber-200 bg-amber-50 rounded p-2">
            <label className="text-[11px] uppercase tracking-wide text-amber-800">
              We don't have an email on file for this vendor — add one below
            </label>
            <div className="flex gap-2 mt-1">
              <input
                type="email"
                placeholder="vendor@example.com"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                data-testid="w9-email-address-input"
                className="flex-1 border rounded px-2 py-1.5 text-sm"
              />
              <button
                onClick={() => {
                  const em = (emailInput || "").trim();
                  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
                    setEmailErr("That doesn't look like a valid email.");
                    return;
                  }
                  doSend(em);
                }}
                disabled={sending}
                data-testid="w9-email-address-confirm"
                className="px-3 py-1.5 rounded bg-slate-900 text-white text-sm disabled:opacity-50"
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        )}
        {emailErr && (
          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
            {emailErr}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <button
            data-testid="w9-email-send-now"
            onClick={() => doSend()}
            disabled={sending}
            className="px-3 py-1.5 rounded-full bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send now"}
          </button>
          <button
            data-testid="w9-email-copy"
            onClick={copyEmail}
            className="px-3 py-1.5 rounded-full border border-slate-300 text-slate-800 text-xs font-medium hover:bg-slate-100"
          >
            {copied ? "Copied!" : "Copy email"}
          </button>
        </div>
      </div>
    </div>
  );
}

function W9Checklist() {
  const items = [
    { label: "Legal name",            hint: "Business or individual as it appears with the IRS" },
    { label: "Business name / DBA",   hint: "If different from the legal name" },
    { label: "Federal tax classification", hint: "Sole prop, C-Corp, S-Corp, LLC (with tax type), Partnership, etc." },
    { label: "Exemptions",            hint: "Payee code / FATCA code — usually blank for domestic contractors" },
    { label: "Full address",          hint: "Street, city, state, ZIP" },
    { label: "TIN (SSN or EIN)",      hint: "9-digit taxpayer ID — required for the 1099-NEC" },
    { label: "Signature & date",      hint: "Certifies the info is accurate under penalty of perjury" },
  ];
  return (
    <div className="mt-3 border border-slate-200 rounded-lg bg-slate-50 overflow-hidden">
      <div className="px-3 py-2 bg-white border-b border-slate-200 text-[11px] uppercase tracking-wide font-semibold text-slate-600">
        W-9 checklist
      </div>
      <ul className="divide-y divide-slate-200">
        {items.map((it, i) => (
          <li key={i} className="px-3 py-2 flex items-start gap-2" data-testid={`w9-checklist-item-${i}`}>
            <div className="shrink-0 w-5 h-5 rounded-full border border-slate-300 bg-white text-slate-400 text-[10px] flex items-center justify-center font-mono-num">
              {i + 1}
            </div>
            <div className="min-w-0">
              <div className="text-sm text-slate-900 font-medium">{it.label}</div>
              <div className="text-xs text-slate-500">{it.hint}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className="px-3 py-2 bg-white border-t border-slate-200 text-[11px] text-slate-500">
        Tip: the official IRS form (fw9.pdf) already has all these fields — the fastest path is to email them a link to <span className="font-mono-num">irs.gov/pub/irs-pdf/fw9.pdf</span> and ask them to fill it out and return it.
      </div>
    </div>
  );
}

function ChatBubble({ message, onQuickReply, onBreakdownChange, onRemoveAttachment, w9Token, w9ItemId, onW9Sent }) {
  const isUser = message.role === "user";
  const hasBreakdown = !isUser && message._splitBreakdown;
  const hasLiability = !isUser && message._liabilityBreakdown;
  const hasCategorization = !isUser && message._categorizationBreakdown;
  const wide = hasBreakdown || hasLiability || hasCategorization;
  const isAttachment = isUser && message._attachmentId;
  const isAnswered = !isUser && message._readOnlyAnswered;
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} group`}>
      <div
        className={`${wide ? "max-w-[92%]" : "max-w-[85%]"} rounded-2xl px-4 py-2 text-sm ${
          isUser ? "bg-slate-900 text-white rounded-br-sm"
                 : isAnswered
                   ? "bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-bl-sm"
                   : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm"
        } ${isAttachment ? "pr-8 relative" : ""}`}
      >
        {message.content}
        {isAttachment && !message._readOnly && (
          <button
            onClick={() => onRemoveAttachment?.(message._attachmentId, message._itemId)}
            className="absolute top-1 right-1 opacity-60 group-hover:opacity-100 p-1 rounded hover:bg-white/10 text-white/80 hover:text-white transition"
            title="Remove this receipt"
            data-testid={`review-attachment-remove-${message._attachmentId}`}
            aria-label="Remove receipt"
          >
            <X size={13} />
          </button>
        )}
        {hasBreakdown && (
          <SplitBreakdown
            breakdown={message._splitBreakdown}
            onChange={(next) => onBreakdownChange?.(next)}
          />
        )}
        {hasLiability && (
          <LiabilityBreakdown
            breakdown={message._liabilityBreakdown}
            onChange={(next) => onBreakdownChange?.(next)}
          />
        )}
        {hasCategorization && (
          <CategorizationBreakdown
            breakdown={message._categorizationBreakdown}
            onChange={(next) => onBreakdownChange?.(next)}
          />
        )}
        {!isUser && message._w9Checklist && <W9Checklist />}
        {!isUser && message._w9EmailDraft && (
          <W9EmailDraft
            draft={message._w9EmailDraft}
            token={w9Token}
            itemId={w9ItemId}
            onSent={(to) => onW9Sent?.(to)}
          />
        )}
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
