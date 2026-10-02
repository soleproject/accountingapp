import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import axios from "axios";
import { Send, Paperclip, HelpCircle, Loader2, Check, CheckCircle2, ArrowRight, Calendar, X, Mic, MicOff, ChevronLeft, ChevronRight, Link2 as LinkChain, Pencil, Trash2, FileText, Eye, AlarmClock, Landmark, Percent, Home, ShieldAlert, ReceiptText, Users, Clock, AlertTriangle } from "lucide-react";

// A parked ("I don't have it now") item is skipped until its reminder time.
const isParked = (i) => !!(i?.snoozed_until && !i.answered_at && !i.deferred
  && new Date(i.snoozed_until).getTime() > Date.now());
const isOpenItem = (i) => !i.answered_at && !i.deferred && !isParked(i);
import CheckinAnswerForm from "../components/CheckinAnswerForm";
import { LinkModal } from "./Transactions";

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
  2: "No Vendor",
  3: "Missing receipt",
  4: "W-9 collection",
  9: "Liability payment",
  10: "Meals & entertainment",
  11: "Owner's Draw check",
  12: "Deposit",
  13: "Checks without payee",
  14: "Travel & lodging",
  // Deprecated (still labeled so legacy batches render, but no longer
  // part of the 10-type Quick Check-in lineup):
  5: "Ambiguous transfer",
  6: "Recurring charge",
  7: "Setup detail",
  8: "Split transaction",
  15: "AI cleanup",
};

// Item types that surface the 📎 paperclip in the composer:
//   1 — Uncategorized transaction (receipt as evidence + optional category)
//   2 — Vendor categorization confirmation (receipt as evidence)
//   3 — Missing receipt (upload IS the answer)
//   4 — W-9 needed (upload IS the answer)
//   8 — Split receipt (upload runs GPT-4o line-item vision)
//   9 — Liability payment (upload runs GPT-4o statement vision)
//  10 — IRS meals compliance (receipt is required for >$75 IRS threshold)
//  11 — Owner's Draw check (receipt lets client prove it was business)
//  12 — Deposits (no upload — free-text answer)
//  14 — IRS Travel (lodging receipt required at any amount per §274)
const UPLOAD_ITEM_TYPES = new Set([1, 2, 3, 4, 8, 9, 10, 11, 14]);

export default function ClientReviewPage({ embedded = false, token: tokenProp = null, itemTypes = null, embeddedTitle = null }) {
  const { token: tokenParam } = useParams();
  const token = tokenProp || tokenParam;
  const [searchParams, setSearchParams] = useSearchParams();
  // Embedded (in-shell) mode only shows the item types the host page asked for.
  const scopeItems = (data) => {
    if (!itemTypes || !data) return data;
    return { ...data, items: (data.items || []).filter((i) => itemTypes.includes(i.item_type)) };
  };
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
  const [reminderMode, setReminderMode] = useState(null); // "follow_up" | "item"
  // Pro mode: opened from the Cockpit (?via=pro) with a logged-in pro
  // session. Answers are attributed to the pro in the audit trail.
  const proToken = (embedded || searchParams.get("via") === "pro") ? localStorage.getItem("axiom_token") : null;
  const attributeToPro = (itemId) => {
    if (!proToken || !itemId) return;
    axios.post(`${API}/${token}/items/${itemId}/attribute`, {}, {
      headers: { Authorization: `Bearer ${proToken}` },
    }).then((r) => {
      setSession((s) => {
        if (!s) return s;
        const items = (s.items || []).map((i) => i.item_id === itemId ? { ...i, answered_by: r.data.answered_by } : i);
        return { ...s, items };
      });
    }).catch(() => {});
  };
  // Persistent "✓ Completed — Continue" gate. Set by every success
  // path (deposit booking, receipt upload, category pick, defer, chat
  // answer, etc.) INSTEAD of auto-advancing. The user must tap
  // Continue (or use the header chevrons) to move on. Payload shape:
  // { label, detail } — rendered in the gate banner.
  const [justCompleted, setJustCompleted] = useState(null);
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

  // Top-level Category picker state, opened when the client taps the
  // "Show categories" escape-hatch quick_reply on Owner's Draw (or any
  // future confirmation item type). The picker itself is the same
  // component the Uncategorized 4-tile grid uses.
  const [reviewCatPickerOpen, setReviewCatPickerOpen] = useState(false);

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
        r.data = scopeItems(r.data);
        setSession(r.data);
        // Pick the first not-yet-finalized item
        // ?item=<id> (pro jumping in from the Cockpit) wins, even if parked.
        const wanted = searchParams.get("item");
        const wantedIdx = wanted ? (r.data.items || []).findIndex((i) => i.item_id === wanted) : -1;
        const idx = wantedIdx !== -1 ? wantedIdx : (r.data.items || []).findIndex(isOpenItem);
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
    // Form-heavy item types (Meals · Travel) render a full field-capture
    // card that's taller than the viewport — auto-scrolling to the chat
    // end drops the client into the Submit button. For those, jump to
    // the top of the page so the item context card is visible first.
    const it = session?.items?.[activeIdx];
    const isFormType = it && [10, 14].includes(it.item_type);
    if (isFormType) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, activeIdx, session]);

  // When embedded in the pro Cockpit (iframe), tell the parent whenever
  // the batch's progress changes so its row/chips refresh live.
  const progressSig = JSON.stringify([
    session?.status, session?.follow_up_at,
    (session?.items || []).map((i) => [i.answered_at ? 1 : 0, i.deferred ? 1 : 0, i.snoozed_until || null]),
  ]);
  const lastSigRef = useRef(null);
  useEffect(() => {
    if (!session) return;
    if (lastSigRef.current === null) { lastSigRef.current = progressSig; return; }
    if (lastSigRef.current === progressSig) return;
    lastSigRef.current = progressSig;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "qc:changed", batch_id: session.batch_id, token }, window.location.origin);
    }
  }, [progressSig, session, token]);

  const currentItem = session?.items?.[activeIdx];
  const finishedCount = (session?.items || []).filter(
    (i) => i.answered_at || i.deferred
  ).length;
  const parkedItems = (session?.items || []).filter(isParked);
  const totalCount = session?.items?.length || 0;

  // Group items by item_type so the header can show a "3 of 4 Uncategorized"
  // style progress bar and the advance transition can announce type
  // changes ("Now let's do Liability Payments"). We rebuild on every
  // render — cheap; totalCount is small (7–20 rows in practice).
  const groups = React.useMemo(() => {
    const out = [];
    const byType = new Map();
    for (const it of session?.items || []) {
      const t = it.item_type;
      let g = byType.get(t);
      if (!g) {
        g = {
          item_type: t,
          label: ITEM_TYPE_LABELS[t] || "Item",
          items: [],
          startIdx: null,   // filled after sort — first index in session.items
          done: 0,
        };
        byType.set(t, g);
        out.push(g);
      }
      g.items.push(it);
      if ((it.answered_at) || (it.deferred)) g.done += 1;
    }
    // Compute startIdx & endIdx once we know the flat order. Since the
    // backend now groups same-type items contiguously (Sep 2026), each
    // group's first/last flat index is a simple scan.
    let cursor = 0;
    for (const g of out) {
      g.startIdx = cursor;
      g.endIdx   = cursor + g.items.length - 1;
      cursor += g.items.length;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.items]);

  // Which group does the active item belong to?
  const activeGroup = React.useMemo(() => {
    return groups.find(
      (g) => activeIdx >= g.startIdx && activeIdx <= g.endIdx,
    ) || null;
  }, [groups, activeIdx]);
  const allDone = totalCount > 0 && finishedCount === totalCount;
  const doneForNow = totalCount > 0 && parkedItems.length > 0
    && finishedCount + parkedItems.length === totalCount;

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
      // If the AI signalled a definitive answer, apply it — UNLESS
      // the client's message was itself a question (ends with "?" or
      // opens with a common interrogative). In that case the user is
      // asking us for info; auto-finalizing here would look like the
      // app dismissed their question. Belt-and-suspenders on top of
      // the engine's own `clarify` rule.
      const trimmed = (text || "").trim();
      const looksLikeQuestion =
        /\?\s*$/.test(trimmed) ||
        /^(should|can|could|do|does|did|is|are|was|were|will|would|what|how|why|when|where|which|who)\b/i
          .test(trimmed);
      if (a.action?.type === "answer" && !looksLikeQuestion) {
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
      markCompleted({
        label:  "Answer sent",
        detail: answerText || payload.answer_text || "Answered.",
      });
    } catch (e) {
      // 409 = already finalized; still gate on Continue so the flow
      // is consistent whether or not this call actually mutated state.
      markCompleted({ label: "Answer sent" });
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
      markCompleted({
        label:  "Sent to bookkeeper",
        detail: "Your bookkeeper will handle this one.",
      });
    } catch (e) {
      markCompleted({ label: "Sent to bookkeeper" });
    } finally {
      setBusy(false);
    }
  };

  // Undo / re-open an already-answered item. Reverses the underlying
  // side effects (bill payment / txn categorization / liability split
  // / receipt dismiss) on the backend, then reloads the batch so the
  // wizard picks the item back up in `gathering` state.
  const reopenItem = async () => {
    if (!currentItem || busy) return;
    // Guardrail — the button also shouldn't render when there's
    // nothing to undo, but belt-and-braces.
    if (!(currentItem.answered_at || currentItem.deferred)) return;
    if (!window.confirm(
      "Undo this answer? I'll reverse the booking and reopen this "
      + "question so you can redo it."
    )) return;
    setBusy(true);
    try {
      await axios.post(
        `${API}/${token}/items/${currentItem.item_id}/reopen`
      );
      // Refetch the whole batch so the item's answered fields clear
      // and the chat rehydrates in "gathering" state.
      const r = await axios.get(`${API}/${token}`);
      r.data = scopeItems(r.data);
      setSession(r.data);
      const reopened = (r.data?.items || []).find(
        (i) => i.item_id === currentItem.item_id
      );
      setMessages(hydrateMessages(reopened));
      setJustCompleted(null);
      setInput("");
    } catch (e) {
      alert(e?.response?.data?.detail
             || "Couldn't undo that one — please refresh and try again.");
    } finally {
      setBusy(false);
    }
  };

  // Q2 (Vendor confirmation) — the DescriptorBindingsList component
  // fires a window CustomEvent so it doesn't need to know how to
  // finalize an item. We listen at the page level and translate into
  // an applyAnswer call with the standard alias payload.
  useEffect(() => {
    const onConfirm = (e) => {
      const { itemId, bindings } = e.detail || {};
      if (!itemId || !bindings) return;
      if (!currentItem || currentItem.item_id !== itemId) return;
      const summary = bindings
        .filter((b) => !b.skip)
        .map((b) => `${b.descriptor.slice(0, 24)} → ${b.contact_id ? "existing" : (b.create_name || "?")}`)
        .join("; ");
      applyAnswer(
        { flow: "descriptor_aliases", bindings },
        `Confirmed ${bindings.filter((b) => !b.skip).length} vendor binding${bindings.length === 1 ? "" : "s"}` +
          (summary ? ` — ${summary}` : ""),
      );
    };
    window.addEventListener("client-review:confirm-descriptor-bindings", onConfirm);
    return () => window.removeEventListener("client-review:confirm-descriptor-bindings", onConfirm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItem, busy]);

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

  // Mark the current item as "just completed" — sets the persistent
  // Continue gate INSTEAD of auto-advancing. The item is flagged
  // `answered_at` locally so the shortcuts hide (they gate on this
  // flag) and the header progress chip ticks over, but the wizard
  // stays on the current item until the user taps Continue.
  const markCompleted = (payload = {}) => {
    attributeToPro(currentItem?.item_id);
    setSession((s) => {
      if (!s) return s;
      const items = [...(s.items || [])];
      if (currentItem) {
        items[activeIdx] = {
          ...items[activeIdx],
          answered_at: items[activeIdx]?.answered_at || new Date().toISOString(),
          snoozed_until: null,
        };
      }
      return { ...s, items };
    });
    setJustCompleted({
      label:  payload.label  || "Done",
      detail: payload.detail || null,
    });
  };

  const advance = () => {
    // Clear the Continue gate — the user tapped through.
    setJustCompleted(null);
    const nextIdx = (session?.items || []).findIndex(
      (i, k) => k > activeIdx && isOpenItem(i)
    );
    const wasLast = nextIdx === -1;

    // Mark the current item as answered locally so the progress bar
    // ticks over immediately.
    setSession((s) => {
      if (!s) return s;
      const items = [...(s.items || [])];
      if (currentItem && !isParked(items[activeIdx])) {
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
    // the new prompt. When the NEXT question is a different item_type
    // than the current, the arrival line calls out the type shift
    // ("Now let's do Liability Payments") so the client mentally
    // switches gears.
    const dep = pickDeparture();
    setMessages((m) => [...m, {
      role: "assistant",
      content: dep,
      isTransition: true,
    }]);
    const nextItem = (session?.items || [])[nextIdx];
    const isTypeShift = !!(nextItem && currentItem
                          && nextItem.item_type !== currentItem.item_type);
    const nextGroup = groups.find(
      (g) => nextItem && g.item_type === nextItem.item_type,
    );
    const remaining = nextGroup ? nextGroup.items.length : 0;
    const arr = isTypeShift
      ? `Now let's do ${nextGroup?.label || "the next section"}${
          remaining > 1 ? ` — ${remaining} to go` : ""
        }.`
      : pickArrival();
    setTimeout(() => {
      setMessages([{
        role: "assistant",
        content: arr,
        isTransition: true,
      }]);
      setActiveIdx(nextIdx);
    }, 2100);
  };

  // Persist the Q4 (W-9) client-side chat to the backend so returning
  // to the question rehydrates the checklist / email-draft / sent
  // bubbles instead of just the "✓ Answered" line. Fire-and-forget
  // — a persist failure never blocks the interactive flow.
  const persistClientMessagesRef = useRef(0);
  const persistQ4Messages = (msgs) => {
    if (!currentItem || currentItem.item_type !== 4) return;
    persistClientMessagesRef.current += 1;
    const my = persistClientMessagesRef.current;
    axios.post(
      `${API}/${token}/items/${currentItem.item_id}/save-client-messages`,
      { messages: (msgs || []).filter((m) => !m.isTransition) },
    ).catch(() => {
      // Silent — user can still complete the flow locally.
    });
  };
  // Whenever the Q4 chat mutates, persist the trailing snapshot so a
  // back-navigation returns to exactly this state.
  useEffect(() => {
    if (!currentItem || currentItem.item_type !== 4) return;
    // Skip the trivial "just an arrival bubble" state — nothing to save.
    if (messages.length === 0) return;
    if (messages.length === 1 && messages[0].isTransition) return;
    persistQ4Messages(messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, currentItem?.item_id]);

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
    // Q4 (W-9) rides on `client_messages` — those cards live only on
    // the client, so on rehydrate we pull them back verbatim BEFORE
    // layering on attachments / breakdowns / the "✓ Answered" bubble.
    const clientMsgs = Array.isArray(item?.client_messages)
      ? item.client_messages.map((m) => ({ ...m, quickReplies: [] }))
      : [];
    const priorMsgs = (item?.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
      quickReplies: m.quick_replies || [],
    }));
    const answered = !!item?.answered_at || !!item?.deferred;
    const atts = item?.attachments || [];
    // Merge — client-persisted bubbles come first (they represent the
    // pre-answer conversation the user actually saw), then any /turn
    // history that came back from the LLM.
    const hydrated = [...clientMsgs, ...priorMsgs];
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
    // answer is locked. Rehydrate the actual action taken from the
    // structured fields the handlers stamp onto the item — so a
    // client scrolling back sees "Applied $483.29 to BILL-566 (The
    // Home Depot)" instead of a generic "your answer was submitted".
    if (answered) {
      const money = (n) => `$${Math.abs(Number(n) || 0).toLocaleString("en-US", {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      })}`;

      // Receipt uploaded → surface as its own bubble BEFORE the
      // Answered bubble (matches the ordering when the client
      // originally uploaded).
      const receiptAtts = atts.filter((a) => {
        const ct = (a.content_type || a.mime_type || "").toLowerCase();
        return ct.startsWith("image/") || ct.includes("pdf");
      });

      // Try each answer shape in specificity order — richer wins.
      const action = (item.action_taken || "").toLowerCase();
      const detail = item.action_detail || "";
      const payload = item.answered_payload || {};
      const apps = payload.applications || [];
      let summary = null;

      if (item.deferred) {
        summary = "📮 Sent to your bookkeeper — they'll take it from here.";
      } else if (action === "receipt_dismissed") {
        summary = "✕ Marked as receipt-not-needed and dropped from the queue.";
      } else if (action.includes("payment_applied") && apps.length) {
        // Bill or invoice apply — enumerate each application with
        // number + amount so the client sees exactly what got posted.
        const isBill = !!apps[0].bill_id;
        const noun = isBill ? "bill" : "invoice";
        const lines = apps.map((a) => {
          const num = a.bill_number || a.invoice_number ||
                       String(a.bill_id || a.invoice_id || "").slice(0, 8);
          const bal = a.new_balance_due != null
            ? ` · balance now ${money(a.new_balance_due)}`
            : "";
          return `• ${money(a.amount)} → ${noun.toUpperCase()}-${num}${bal}`;
        });
        summary = `🔗 Linked to ${apps.length} ${noun}${apps.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
      } else if (action === "receipt_linked" || action === "linked_bill" || action === "linked_invoice") {
        // Legacy `/link-doc` single-doc shape.
        const isBill = action.includes("bill") || payload.doc_type === "bill";
        summary = `🔗 Linked to ${isBill ? "bill" : "invoice"}${detail ? ` — ${detail}` : ""}`;
      } else if (action === "deposit_classified" || action === "liability_split") {
        summary = detail || "Booked to your ledger.";
      } else if (action === "categorize" || action === "categorized") {
        summary = detail || `Booked to ${payload.account_name || "the picked category"}.`;
      } else if (action === "w9_email_sent") {
        summary = `📧 W-9 request emailed${payload.sent_to ? ` to ${payload.sent_to}` : ""}.`;
      }

      // If we have a receipt attachment AND no other richer summary,
      // lean on the attachment as the primary confirmation.
      if (!summary && receiptAtts.length) {
        const names = receiptAtts.map((a) => a.filename || "receipt").join(", ");
        summary = `📎 Receipt uploaded — ${names}`;
      }

      // Final fallback — the generic string, preserving whatever
      // detail the handler put on the item.
      const fallback = detail ||
                       item.client_answer ||
                       item.answer_summary ||
                       "Your answer was submitted to your bookkeeper.";

      hydrated.push({
        role: "assistant",
        content: `✓ Answered on ${(item.answered_at || "").slice(0, 10)}\n${summary || fallback}`,
        _readOnlyAnswered: true,
        // Inline "Undo" chip — client tapped an answer they didn't
        // want. The main onQuickReply handler intercepts this token
        // and calls POST /items/{id}/reopen which reverses the side
        // effects and reopens the item.
        quickReplies: ["↺ Undo — reopen this one"],
      });
    }
    return hydrated;
  };


  // Jump to a specific question by index. Keeps a light audit of
  // what they told us. Restores that item's chat history on jump.
  const jumpTo = (idx) => {
    if (idx < 0 || idx >= totalCount) return;
    setJustCompleted(null);
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
      // Uploads ARE the answer for W-9 (item 4) and liability split
      // (item 9). Advance immediately. Missing Receipt (item 3) used to
      // auto-answer too, but now runs GPT-4o vision (see below) so the
      // client can confirm the split just like Uncategorized.
      if ([4, 9].includes(currentItem.item_type)) {
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
      // (item 2) / missing receipt (item 3) — backend runs GPT-4o
      // vision on the receipt and returns a per-line-item Chart-of-
      // Accounts split. Render the grouped breakdown so the client
      // sees each line mapped to an account and can tap "Use this
      // split" or tweak an account before booking.
      if ([1, 2, 3].includes(currentItem.item_type) && r.data.categorization_analysis) {
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
      // bookkeeper still gets something. For Missing Receipt (type 3)
      // this is also our fallback: file the attachment as the answer
      // so the item still closes even without vision.
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
      if (currentItem.item_type === 3) {
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
  if (session?.status === "completed" || allDone || (embedded && totalCount === 0)) {
    if (embedded) {
      return (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 px-6 py-10 text-center" data-testid="embedded-review-all-done">
          <CheckCircle2 size={26} className="mx-auto text-emerald-600 mb-2" />
          <div className="text-base font-semibold text-slate-900">{embeddedTitle || "All caught up"}</div>
          <div className="text-sm text-slate-600 mt-1">Nothing is waiting on the client right now.</div>
        </div>
      );
    }
    return <SummaryScreen session={session} onComplete={complete} />;
  }
  if (doneForNow && activeIdx >= totalCount) {
    return <ParkedScreen session={session} parked={parkedItems} />;
  }

  const firmLabel = session?.firm_name || "your bookkeeping team";
  const firmInitials = (session?.firm_name || "NG")
    .split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  return (
    <div className={`${embedded ? "-m-4 md:-m-8 min-h-full md:h-[calc(100%+4rem)] md:overflow-auto" : "min-h-screen"} bg-[#F5F7FA] flex flex-col`} data-testid="client-review-page">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-4 py-3 sticky top-0 z-10">
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
          <div
            className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white grid place-items-center text-[11px] font-bold tracking-wide shrink-0 shadow-[0_6px_14px_-6px_rgba(79,70,229,0.55)]"
            aria-hidden="true"
            data-testid="review-firm-avatar"
          >
            {firmInitials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10.5px] text-slate-500 uppercase tracking-[0.15em] font-semibold">
              Quick check-in · {firmLabel}
            </div>
            <div className="text-sm text-slate-900 font-heading truncate">
              {activeGroup ? (
                <>
                  {activeGroup.label}
                  {" "}
                  <span className="text-slate-400 font-normal font-mono-num">
                    {(activeIdx - activeGroup.startIdx + 1)} of {activeGroup.items.length}
                  </span>
                </>
              ) : (
                <>Question {Math.min(activeIdx + 1, totalCount)} of {totalCount}</>
              )}
              {currentItem?.answered_at && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-[10px] font-mono-num uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200"
                  data-testid="review-item-answered-chip"
                >
                  <Check size={9} /> answered{currentItem?.answered_by ? ` by ${proToken ? currentItem.answered_by.name : "your bookkeeper"}` : ""}
                </span>
              )}
              {proToken && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-[10px] font-mono-num uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200"
                  data-testid="review-pro-mode-chip"
                >
                  answering as pro
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
              {isParked(currentItem) && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-[10px] font-mono-num uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200"
                  data-testid="review-item-parked-chip"
                >
                  <AlarmClock size={9} /> reminder set
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
        {/* Segmented progress bar — one segment per item TYPE (Sep 2026).
            Each segment fills proportional to the type's done ratio so
            the client sees "Uncategorized 3/4, Liability 0/2, W-9 1/1"
            at a glance. Falls back to a single bar for solo-type
            batches. */}
        {groups.length > 1 ? (
          <div className="max-w-2xl mx-auto mt-2 grid gap-1"
               style={{ gridTemplateColumns: groups.map((g) => g.items.length).join("fr ") + "fr" }}
               data-testid="review-progress-segments">
            {groups.map((g, gi) => {
              const isActive = activeGroup && activeGroup.item_type === g.item_type;
              return (
                <div key={g.item_type}
                     className="relative h-1.5 rounded-full bg-slate-200 overflow-hidden"
                     title={`${g.label} — ${g.done}/${g.items.length}`}>
                  <div
                    className={`h-full transition-all ${isActive
                      ? "bg-gradient-to-r from-emerald-500 to-indigo-600"
                      : "bg-indigo-600"}`}
                    style={{ width: `${(g.done / Math.max(1, g.items.length)) * 100}%` }}
                    data-testid={`review-progress-segment-${gi}`}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto mt-2 h-1 bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-indigo-600 transition-all"
              style={{ width: `${(finishedCount / Math.max(1, totalCount)) * 100}%` }}
              data-testid="review-progress"
            />
          </div>
        )}
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
          <ItemContextCard
            item={currentItem}
            token={token}
            onRowAction={(evt) => {
              if (evt.kind === "receipt") {
                setMessages((prev) => [
                  ...prev,
                  { role: "assistant",
                    content: `Receipt attached to that transaction. Chat below to categorize it (or the whole ${currentItem?.context?.count} together).` },
                ]);
              }
            }}
            onLinked={(res) => {
              setMessages((prev) => [
                ...prev,
                { role: "assistant",
                  content: `Linked to ${res.doc_type === "bill" ? "bill" : "invoice"}${res.doc_number ? " #" + res.doc_number : ""}. Keep going with the rest of the bundle.` },
              ]);
            }}
            onEdited={(res) => {
              if (res?.context) {
                setSession((s) => {
                  if (!s) return s;
                  const items = (s.items || []).map((it, i) => {
                    if (i !== activeIdx) return it;
                    const samples = (it.context?.samples || []).map((r) =>
                      r.id === res.id ? { ...r, ...res.context, description: res.context.description ?? r.description } : r,
                    );
                    return { ...it, context: { ...(it.context || {}), samples } };
                  });
                  return { ...s, items };
                });
              }
            }}
          />
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
                  // "Please contact them and get the info for me" — jump
                  // straight to the ready-to-send email draft (same flow
                  // as "Create an email for me"). If we don't have the
                  // contact's email on file, the W9EmailDraft component
                  // will prompt for one before actually sending.
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
                    role: "user", content: qr,
                  }, {
                    role: "assistant",
                    _w9EmailDraft: { subject, body: bodyTxt },
                    content: "Here's a ready-to-go message we can send on your behalf. Take a look — send it as-is, tweak it first, or copy it into your own email tool.",
                  }]);
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
            <LiabilityShortcuts
              currentItem={currentItem}
              onUploadStatement={() => {
                setMessages([
                  { role: "user", content: "Upload the statement" },
                  { role: "assistant",
                    content: "Great — tap the 📎 paperclip below and pick the statement (mortgage, credit card, or auto-loan). I'll read the payment breakdown line-by-line and propose the split. You can adjust any line before confirming." },
                ]);
                setTimeout(() => fileRef.current?.click(), 200);
              }}
              onNoStatement={() => {
                setMessages([
                  { role: "user", content: "I don't have the statement" },
                  { role: "assistant",
                    content: "No worries — what kind of liability is this (mortgage, credit card, auto loan, or business loan)? If you know the split — for example \"$812 principal, $1,104 interest\" — you can just type it and I'll book it." },
                ]);
              }}
            />
          )}
          {currentItem && currentItem.item_type === 12 && !currentItem.answered_at && !currentItem.deferred && (
            <DepositShortcuts
              currentItem={currentItem}
              token={token}
              onBooked={(res) => {
                setMessages((prev) => [
                  ...prev,
                  { role: "user", content: res.label },
                  { role: "assistant",
                    content: res.detail || `Booked as ${res.label}.` },
                ]);
                markCompleted({
                  label:  res.label || "Deposit booked",
                  detail: res.detail || `Booked as ${res.label}.`,
                });
              }}
            />
          )}

          {currentItem && currentItem.item_type === 1 && !currentItem?.context?.grouped && currentItem?.context?.suggested_category_account_id && (
            <SuggestedCategoryBanner
              currentItem={currentItem}
              token={token}
              onApplied={(res) => {
                setMessages((prev) => [
                  ...prev,
                  { role: "user", content: `Same as the receipt — ${res.account_name || "that category"}.` },
                  { role: "assistant",
                    content: `Booked to ${res.account_name}${res.contact_name ? ` (${res.contact_name})` : ""}. Nice — one down.` },
                ]);
                markCompleted({
                  label:  `Booked to ${res.account_name || "category"}`,
                  detail: `Booked to ${res.account_name}${res.contact_name ? ` (${res.contact_name})` : ""}.`,
                });
              }}
            />
          )}
          {currentItem && currentItem.item_type === 1 && !currentItem?.context?.grouped && (
            <UncategorizedShortcuts
              currentItem={currentItem}
              token={token}
              hideHelper={messages.length > 0}
              answered={messages.some((m) => m.role === "user")}
              onReceipt={() => fileRef.current?.click()}
              onTalk={() => toggleMic()}
              onLinked={(res) => {
                setMessages((prev) => [
                  ...prev,
                  { role: "user", content: res.message },
                  { role: "assistant",
                    content: `Got it — booked ${res.applied ? `$${res.applied.toFixed(2)}` : "the payment"} against ${res.contact_name || (res.doc_type === "bill" ? "the vendor" : "the customer")}. ${res.new_balance > 0.005 ? `Remaining balance: $${res.new_balance.toFixed(2)}.` : "Balance is now zero — nice."}` },
                ]);
                markCompleted({
                  label:  `Linked to ${res.contact_name || (res.doc_type === "bill" ? "bill" : "invoice")}`,
                  detail: res.new_balance > 0.005
                    ? `Remaining balance: $${res.new_balance.toFixed(2)}.`
                    : "Balance is now zero.",
                });
              }}
              onCompleted={(res) => {
                setMessages((prev) => [
                  ...prev,
                  { role: "user", content: res.message },
                  { role: "assistant",
                    content: `Booked to ${res.account_name}${res.contact_name ? ` (${res.contact_name})` : ""}. Nice — one down.` },
                ]);
                markCompleted({
                  label:  `Booked to ${res.account_name || "category"}`,
                  detail: res.contact_name ? `${res.account_name} · ${res.contact_name}` : null,
                });
              }}
              onEdited={(res) => {
                // Refresh the currentItem's context in-place so the ItemContextCard
                // reflects the client's edits without advancing.
                if (res?.context) {
                  setSession((s) => {
                    if (!s) return s;
                    const items = (s.items || []).map((it, i) =>
                      i === activeIdx
                        ? { ...it, context: { ...(it.context || {}), ...res.context } }
                        : it,
                    );
                    return { ...s, items };
                  });
                }
                setMessages((prev) => [
                  ...prev,
                  { role: "user", content: "Fixed the transaction details." },
                  { role: "assistant",
                    content: res?.category_account_name
                      ? `Updated — booked to ${res.category_account_name}${res.contact_name ? ` (${res.contact_name})` : ""}. Tap Complete when you're ready.`
                      : "Updated — the corrections are on the transaction. Tap Complete or keep chatting to finish it off." },
                ]);
              }}
            />
          )}
          {messages.length === 0 && currentItem && currentItem.item_type === 13 && (
            <ChecksAssignTable
              token={token}
              item={currentItem}
              onAllDone={() => markCompleted({ label: "All checks assigned" })}
            />
          )}
          {messages.length === 0 && currentItem && currentItem.item_type === 15 && (
            <AiCleanupTxnList item={currentItem} />
          )}
          {/* IRS §274 substantiation form — Meals (10) and Travel (14).
              Same form as the Cockpit IRS Compliance card, mounted
              inline here so the client can fill Attendees / Business
              Purpose / Destination / Trip Dates / Receipt without
              leaving the magic-link session. Voice-fill uses the
              token-authenticated Whisper → gpt-4o-mini pipeline. */}
          {currentItem && [10, 14].includes(currentItem.item_type) && !currentItem.answered_at && !currentItem.deferred && (
            <CheckinAnswerForm
              token={token}
              item={{
                ...currentItem,
                // Normalize the item shape for the shared form.
                // Cockpit uses `item.id`; magic-link uses `item.item_id`.
                id:          currentItem.item_id,
                description: currentItem.context?.description
                             || currentItem.context?.merchant
                             || currentItem.prompt,
                amount:      currentItem.context?.amount,
                date:        currentItem.context?.date,
              }}
              onSubmitted={(id, res) => {
                setMessages((prev) => [
                  ...prev,
                  { role: "user",
                    content: currentItem.item_type === 10
                      ? "Filled the meal substantiation."
                      : "Filled the trip substantiation." },
                  { role: "assistant",
                    content: (res && res.detail)
                      || "Got it — filed under IRS §274 substantiation. Nice." },
                ]);
                markCompleted({
                  label:  currentItem.item_type === 10
                    ? "Meal substantiation filed"
                    : "Trip substantiation filed",
                  detail: (res && res.detail) || "Filed under IRS §274.",
                });
              }}
            />
          )}
          {currentItem && currentItem.item_type === 11 && (
            <YesNoEditShortcuts
              currentItem={currentItem}
              token={token}
              hideHelper={messages.length > 0}
              yesLabel="Yes — it's an Owner's Draw"
              noLabel="No — it's something else"
              onYes={() => sendTurn("Yes — this is an Owner's Draw.")}
              onNo={() => sendTurn("No — this is not an Owner's Draw.")}
              onEdited={(res) => {
                if (res?.context) {
                  setSession((s) => {
                    if (!s) return s;
                    const items = (s.items || []).map((it, i) =>
                      i === activeIdx
                        ? { ...it, context: { ...(it.context || {}), ...res.context } }
                        : it,
                    );
                    return { ...s, items };
                  });
                }
                setMessages((prev) => [
                  ...prev,
                  { role: "user", content: "Fixed the transaction details." },
                  { role: "assistant",
                    content: "Updated — the corrections are on the transaction. Tap Yes or No to finish it off." },
                ]);
              }}
            />
          )}
          {currentItem && currentItem.item_type === 3 && (
            <MissingReceiptShortcuts
              currentItem={currentItem}
              token={token}
              onReceipt={() => fileRef.current?.click()}
              onLinked={(res) => {
                setMessages((prev) => [
                  ...prev,
                  { role: "user", content: res.message },
                  { role: "assistant",
                    content: `Got it — booked ${res.applied ? `$${res.applied.toFixed(2)}` : "the payment"} against ${res.contact_name || "the vendor"}. ${res.new_balance > 0.005 ? `Remaining balance: $${res.new_balance.toFixed(2)}.` : "Balance is now zero — nice."}` },
                ]);
                markCompleted({
                  label:  `Linked to ${res.contact_name || "vendor"}`,
                  detail: res.new_balance > 0.005
                    ? `Remaining balance: $${res.new_balance.toFixed(2)}.`
                    : "Balance is now zero.",
                });
              }}
              onDismissed={() => {
                setMessages((prev) => [
                  ...prev,
                  { role: "user", content: "Dismiss receipt" },
                  { role: "assistant",
                    content: "Done — I've marked this transaction as receipt-not-needed and dropped it from the queue." },
                ]);
                markCompleted({
                  label:  "Receipt dismissed",
                  detail: "Marked as receipt-not-needed.",
                });
              }}
            />
          )}
          {messages.filter((m) => !m.isTransition).length === 0 && currentItem && ![1, 3, 4, 8, 9, 11, 13].includes(currentItem.item_type) && (
            <div className="text-center text-xs text-slate-500 py-4">
              {currentItem.item_type === 15
                ? "Tap Yes / No below, or type an explanation."
                : "Type your answer below, or tap \"not sure\" to send this to your bookkeeper."}
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
              attachments={currentItem?.attachments}
              onW9Sent={(to) => {
                // Mark the DRAFT bubble as sent (so rehydrate shows the
                // green "Sent to …" state, not an empty draft form) AND
                // append the wrap-up bubble. The item is server-side
                // deferred by the endpoint.
                setMessages((prev) => {
                  const next = prev.map((mm, idx) =>
                    (idx === i && mm._w9EmailDraft)
                      ? { ...mm, _w9EmailSentTo: to || "them" }
                      : mm,
                  );
                  return [...next, {
                    role: "assistant",
                    content: `Locked in — email sent to ${to || "them"}. As soon as they reply with the completed W-9, you'll see it back in your books.`,
                  }];
                });
                setTimeout(() => markCompleted({
                  label:  `W-9 request sent to ${to || "them"}`,
                  detail: "You'll see the completed W-9 back in your books once they reply.",
                }), 1500);
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
                // "↺ Undo — reopen this one" chip on an answered
                // bubble. Reverses the side effects and reopens the
                // item. Placed first so a message that also carries
                // a "Use this split" reply can't shadow it.
                if (typeof t === "string" && t.startsWith("↺ Undo")) {
                  reopenItem();
                  return;
                }
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
                  // Hoist principal_account_id (stamped on the
                  // Principal bucket by the LoanAccountPickerModal
                  // inside LiabilityBreakdown) to a top-level field
                  // so the backend can route the paydown to the
                  // specific liability sub-account the client picked.
                  const principal = (a.buckets || []).find(
                    (b) => ((b.label || "").toLowerCase().includes("principal"))
                  );
                  const principalAcctId = principal?.principal_account_id || null;
                  applyAnswer(
                    {
                      flow: "liability_split",
                      statement_type: a.statement_type,
                      lender_name:    a.lender_name,
                      buckets:        a.buckets || [],
                      totals:         a.totals || null,
                      payment_amount: a.payment_amount,
                      principal_account_id: principalAcctId,
                    },
                    `Approved split: ${(a.buckets || [])
                      .map((b) => `${b.label} $${Number(b.amount || 0).toFixed(2)}`)
                      .join(", ")}`,
                  );
                  return;
                }
                // Receipt categorization (item 1/2/3) "Use this split" —
                // apply per-account subtotals so the bookkeeper posts
                // the transaction as a multi-line JE. For Missing
                // Receipt (type 3) the backend resolves the underlying
                // txn from the finding's meta and books the split
                // there identically to Uncategorized.
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
                // Owner's Draw No-branch escape hatches: three UI-only
                // quick_replies that don't round-trip through Haiku —
                // they open the mic, category picker, or file input
                // directly. Any of them works from any other item type
                // that emits the same labels.
                if (t === "Tell me") {
                  toggleMic();
                  return;
                }
                if (t === "Show categories") {
                  setReviewCatPickerOpen(true);
                  return;
                }
                if (t === "Upload receipt") {
                  fileRef.current?.click();
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
          {justCompleted ? (
            <div className="flex items-center gap-3 rounded-xl border-2 border-emerald-300 bg-emerald-50 px-4 py-3" data-testid="review-completed-gate">
              <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                <Check size={18} className="text-emerald-700" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-slate-800 truncate">
                  {justCompleted.label || "Done"}
                </div>
                {justCompleted.detail && (
                  <div className="text-[11px] text-slate-500 leading-tight truncate">
                    {justCompleted.detail}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={advance}
                autoFocus
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-[0_6px_14px_-6px_rgba(5,150,105,0.6)] shrink-0"
                data-testid="review-continue-btn"
              >
                {activeIdx >= totalCount - 1 ? "Finish →" : "Continue →"}
              </button>
            </div>
          ) : (
          <>
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
              className="p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 shadow-[0_6px_14px_-6px_rgba(79,70,229,0.55)]"
              data-testid="review-send-btn"
            >
              <Send size={16} />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
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
                onClick={() => setReminderMode("item")}
                disabled={busy || !currentItem}
                className="text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2 disabled:opacity-50 inline-flex items-center gap-1"
                data-testid="review-snooze-item-btn"
              >
                <AlarmClock size={11} />
                Don't have it now — remind me
              </button>
              <span className="text-slate-300">·</span>
              <button
                onClick={() => setReminderMode("follow_up")}
                disabled={busy}
                className="text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2 disabled:opacity-50 inline-flex items-center gap-1"
                data-testid="review-follow-up-btn"
              >
                {session?.follow_up_at
                  ? `Finishing ${new Date(session.follow_up_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · Change`
                  : "I'll finish later"}
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
              <span className="text-[11px] text-slate-400 shrink-0 whitespace-nowrap">
                {finishedCount} of {totalCount} done
              </span>
            )}
          </div>
          </>
          )}
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
      {reminderMode && (
        <ScheduleModal
          token={token}
          expiresAt={session?.expires_at}
          mode={reminderMode}
          itemId={reminderMode === "item" ? currentItem?.item_id : undefined}
          onClose={() => setReminderMode(null)}
          onScheduled={(iso) => {
            const when = new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
            if (reminderMode === "follow_up") {
              setSession((s) => ({ ...s, follow_up_at: iso }));
            } else {
              setSession((s) => {
                if (!s) return s;
                const items = [...(s.items || [])];
                items[activeIdx] = { ...items[activeIdx], snoozed_until: iso };
                return { ...s, items };
              });
              setJustCompleted({ label: "Parked for now", detail: `We'll remind you on ${when}.` });
            }
            setReminderMode(null);
          }}
        />
      )}
      {reviewCatPickerOpen && currentItem && (
        <CategoryQuickPicker
          token={token}
          itemId={currentItem.item_id}
          txnAmount={Math.abs(Number(currentItem?.context?.amount ?? currentItem?.context?.total ?? 0))}
          isMoneyOut={(currentItem?.context?.direction === "out") || (Number(currentItem?.context?.amount ?? currentItem?.context?.total ?? 0) < 0)}
          onClose={() => setReviewCatPickerOpen(false)}
          onCompleted={(res) => {
            setReviewCatPickerOpen(false);
            setMessages((prev) => [
              ...prev,
              { role: "user", content: res.message },
              { role: "assistant",
                content: `Booked to ${res.account_name}${res.contact_name ? ` (${res.contact_name})` : ""}. Nice — one down.` },
            ]);
            markCompleted({
              label:  `Booked to ${res.account_name || "category"}`,
              detail: res.contact_name ? `${res.account_name} · ${res.contact_name}` : null,
            });
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Uncategorized-txn shortcuts — two tap-and-done shortcut buttons the
// client sees above the composer when the current card is item_type 1
// (Uncategorized transaction).
//
//   • "Upload receipt" — triggers the same file picker the paperclip
//     already uses. Nothing new; just a friendlier surface.
//   • "Link to a bill/invoice" — opens a modal listing every open bill
//     (for money-out) or open invoice (for money-in). One tap applies
//     the payment: decrement doc's balance_due, stamp txn against AP/AR,
//     and mark the check-in item answered.
// -------------------------------------------------------------------------
function UncategorizedShortcuts({ currentItem, token, onReceipt, onLinked, onTalk, onCompleted, onEdited, hideHelper, answered }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [catPickerOpen, setCatPickerOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // For grouped items (Phase 2), direction is authoritative and
  // `context.amount` is absent — fall back to `context.total` and
  // honor `context.direction` when it's set.
  const ctx = currentItem?.context || {};
  const meta = ctx.meta || {};
  const amount = Number(ctx.amount ?? ctx.total ?? 0);
  const isMoneyOut = ctx.direction
    ? ctx.direction === "out"
    : amount < 0;
  const linkKind = isMoneyOut ? "bill" : "invoice";
  // Use the rich multi-select LinkModal when we have a single
  // underlying transaction id — it writes proper `db.payments`
  // docs via /receive-payment (so Payment History on the bill /
  // invoice actually reflects the applied amount, and the client
  // can split ONE payment across multiple bills/invoices). Grouped
  // items fall back to the simpler LinkDocPicker.
  // txn_id lives on `context.txn_id` for uncategorized items and
  // on `context.meta.txn_id` for missing-receipt / liability items —
  // check both locations.
  const singleTxnId = ctx.txn_id || meta.txn_id || null;
  const singleTxnAmount = Number(
    ctx.amount ?? meta.txn_amount ?? amount ?? 0
  );
  const singleTxnContactId = ctx.contact_id || meta.contact_id || null;
  return (
    <>
      <div className="grid grid-cols-4 gap-3 py-3" data-testid="uncat-shortcuts">
        <button
          type="button"
          onClick={onReceipt}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 hover:bg-indigo-50 hover:border-indigo-400 transition"
          data-testid="uncat-shortcut-receipt"
        >
          <div className="w-10 h-10 rounded-full bg-indigo-100 group-hover:bg-indigo-200 flex items-center justify-center transition">
            <Paperclip size={18} className="text-indigo-700" />
          </div>
          <div className="text-sm font-semibold text-slate-800">Upload a receipt</div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            Photo or PDF — I'll read it and file it.
          </div>
        </button>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50 hover:border-emerald-400 transition"
          data-testid="uncat-shortcut-link"
        >
          <div className="w-10 h-10 rounded-full bg-emerald-100 group-hover:bg-emerald-200 flex items-center justify-center transition">
            <LinkChain size={18} className="text-emerald-700" />
          </div>
          <div className="text-sm font-semibold text-slate-800">
            Link to a{isMoneyOut ? "" : "n"} {linkKind}
          </div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            {isMoneyOut
              ? "Pay down an open bill in one tap."
              : "Match this deposit to an open invoice."}
          </div>
        </button>
        <button
          type="button"
          onClick={onTalk}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-sky-200 bg-sky-50/40 hover:bg-sky-50 hover:border-sky-400 transition"
          data-testid="uncat-shortcut-talk"
        >
          <div className="w-10 h-10 rounded-full bg-sky-100 group-hover:bg-sky-200 flex items-center justify-center transition">
            <Mic size={18} className="text-sky-700" />
          </div>
          <div className="text-sm font-semibold text-slate-800">Talk</div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            Dictate the answer — I'll transcribe and file it.
          </div>
        </button>
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-violet-200 bg-violet-50/40 hover:bg-violet-50 hover:border-violet-400 transition"
          data-testid="uncat-shortcut-edit"
        >
          <div className="w-10 h-10 rounded-full bg-violet-100 group-hover:bg-violet-200 flex items-center justify-center transition">
            <Pencil size={18} className="text-violet-700" />
          </div>
          <div className="text-sm font-semibold text-slate-800">Edit</div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            Fix the date, amount, or details on this transaction.
          </div>
        </button>
      </div>
      {answered && (
        <div className="pb-3" data-testid="uncat-shortcuts-complete-row">
          <button
            type="button"
            onClick={() => setCatPickerOpen(true)}
            className="group w-full flex items-center justify-center gap-3 p-3 rounded-xl border-2 border-dashed border-amber-200 bg-amber-50/40 hover:bg-amber-50 hover:border-amber-400 transition"
            data-testid="uncat-shortcut-complete"
          >
            <div className="w-9 h-9 rounded-full bg-amber-100 group-hover:bg-amber-200 flex items-center justify-center transition shrink-0">
              <Check size={18} className="text-amber-700" />
            </div>
            <div className="text-left">
              <div className="text-sm font-semibold text-slate-800">Complete</div>
              <div className="text-[11px] text-slate-500 leading-tight">
                Pick a category and book it in one tap.
              </div>
            </div>
          </button>
        </div>
      )}
      {!hideHelper && (
        <div className="text-center text-xs text-slate-500 py-2">
          Or type your answer below — "not sure" sends it to your bookkeeper.
        </div>
      )}
      {pickerOpen && (singleTxnId ? (
        <LinkModal
          token={token}
          itemId={currentItem.item_id}
          currentId={""}  /* not used in token mode — endpoint is derived from token */
          txn={{ id: singleTxnId, amount: singleTxnAmount, contact_id: singleTxnContactId }}
          onClose={() => setPickerOpen(false)}
          onApplied={(res) => {
            setPickerOpen(false);
            const apps = res?.applications || [];
            const total = apps.reduce((s, a) => s + Number(a.amount || 0), 0);
            const isBill = !!apps.find((a) => a.bill_id);
            // Normalize LinkModal's `{applications: [...]}` shape to
            // the legacy `onLinked` contract the ChatBubble / Continue
            // gate expect: `{message, applied, new_balance,
            // contact_name, doc_type}`. `new_balance` is set to 0 when
            // fully paid (LinkModal's guard already refuses to submit
            // unless remaining ≈ 0); otherwise pass through if the
            // endpoint returned it.
            const remaining = Number(res?.remaining || 0);
            const contactName = apps[0]?.contact_name
              || res?.contact_name
              || (isBill ? "vendor" : "customer");
            onLinked({
              message:      `Linked to ${apps.length} ${isBill ? "bill" : "invoice"}${apps.length === 1 ? "" : "s"}`,
              applied:      total,
              new_balance:  remaining,
              contact_name: contactName,
              doc_type:     isBill ? "bill" : "invoice",
              applications: apps,
            });
          }}
        />
      ) : (
        <LinkDocPicker
          token={token}
          itemId={currentItem.item_id}
          linkKind={linkKind}
          txnAmount={Math.abs(amount)}
          onClose={() => setPickerOpen(false)}
          onLinked={(res) => { setPickerOpen(false); onLinked(res); }}
        />
      ))}
      {catPickerOpen && (
        <CategoryQuickPicker
          token={token}
          itemId={currentItem.item_id}
          txnAmount={Math.abs(amount)}
          isMoneyOut={isMoneyOut}
          onClose={() => setCatPickerOpen(false)}
          onCompleted={(res) => { setCatPickerOpen(false); onCompleted(res); }}
        />
      )}
      {editOpen && (
        <TxnEditModal
          token={token}
          item={currentItem}
          onClose={() => setEditOpen(false)}
          onSaved={(res) => { setEditOpen(false); onEdited?.(res); }}
        />
      )}
    </>
  );
}

// Three-tile action row for Missing Receipt (item_type=3) items.
// Mirrors the top row of UncategorizedShortcuts so the client can jump
// straight to "Upload a receipt", "Link to a bill", or "Dismiss" (mark
// the transaction as intentionally receipt-free) instead of hunting
// for the paperclip in the composer.
function MissingReceiptShortcuts({ currentItem, token, onReceipt, onLinked, onDismissed }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const meta = currentItem?.context?.meta || {};
  const amount = Math.abs(Number(meta.txn_amount ?? meta.amount ?? 0));
  const dismiss = async () => {
    if (dismissing) return;
    setDismissing(true);
    try {
      const r = await axios.post(
        `${API}/${token}/items/${currentItem.item_id}/dismiss-receipt`,
      );
      onDismissed?.(r.data);
    } catch (e) {
      setDismissing(false);
    }
  };
  return (
    <>
      <div className="grid grid-cols-3 gap-3 py-3" data-testid="missing-receipt-shortcuts">
        <button
          type="button"
          onClick={onReceipt}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 hover:bg-indigo-50 hover:border-indigo-400 transition"
          data-testid="missing-receipt-upload"
        >
          <div className="w-10 h-10 rounded-full bg-indigo-100 group-hover:bg-indigo-200 flex items-center justify-center transition">
            <Paperclip size={18} className="text-indigo-700" />
          </div>
          <div className="text-sm font-semibold text-slate-800">Upload a receipt</div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            Photo or PDF — I'll read it and file it.
          </div>
        </button>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50 hover:border-emerald-400 transition"
          data-testid="missing-receipt-link"
        >
          <div className="w-10 h-10 rounded-full bg-emerald-100 group-hover:bg-emerald-200 flex items-center justify-center transition">
            <LinkChain size={18} className="text-emerald-700" />
          </div>
          <div className="text-sm font-semibold text-slate-800">Link to a bill</div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            Pay down an open bill in one tap.
          </div>
        </button>
        <button
          type="button"
          onClick={dismiss}
          disabled={dismissing}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/60 hover:bg-slate-100 hover:border-slate-300 transition disabled:opacity-50"
          data-testid="missing-receipt-dismiss"
        >
          <div className="w-10 h-10 rounded-full bg-slate-100 group-hover:bg-slate-200 flex items-center justify-center transition">
            <Trash2 size={18} className="text-slate-600" />
          </div>
          <div className="text-sm font-semibold text-slate-800">{dismissing ? "Dismissing…" : "Dismiss receipt"}</div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            Skip this one — no receipt required.
          </div>
        </button>
      </div>
      {pickerOpen && (meta.txn_id ? (
        <LinkModal
          token={token}
          itemId={currentItem.item_id}
          currentId={""}
          txn={{
            id: meta.txn_id,
            amount: -Math.abs(Number(meta.txn_amount ?? amount ?? 0)),
            contact_id: meta.contact_id || null,
          }}
          onClose={() => setPickerOpen(false)}
          onApplied={(res) => {
            setPickerOpen(false);
            const apps = res?.applications || [];
            const total = apps.reduce((s, a) => s + Number(a.amount || 0), 0);
            const remaining = Number(res?.remaining || 0);
            const contactName = apps[0]?.contact_name
              || res?.contact_name || "vendor";
            onLinked({
              message:      `Linked to ${apps.length} bill${apps.length === 1 ? "" : "s"}`,
              applied:      total,
              new_balance:  remaining,
              contact_name: contactName,
              doc_type:     "bill",
              applications: apps,
            });
          }}
        />
      ) : (
        <LinkDocPicker
          token={token}
          itemId={currentItem.item_id}
          linkKind="bill"
          txnAmount={amount}
          onClose={() => setPickerOpen(false)}
          onLinked={(res) => { setPickerOpen(false); onLinked(res); }}
        />
      ))}
    </>
  );
}


// Two-tile action row for Liability Payment (item_type=9) items.
// Same tile styling as Missing Receipt / Uncategorized so every
// info-gathering step in Quick Check-in feels consistent. Functionally
// identical to the previous "Upload the statement / I don't have the
// statement" quick-reply pills — just visually promoted to full tiles.
function LiabilityShortcuts({ currentItem, onUploadStatement, onNoStatement }) {
  return (
    <div className="grid grid-cols-2 gap-3 py-3" data-testid="liability-shortcuts">
      <button
        type="button"
        onClick={onUploadStatement}
        className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 hover:bg-indigo-50 hover:border-indigo-400 transition"
        data-testid="liability-upload-statement"
      >
        <div className="w-10 h-10 rounded-full bg-indigo-100 group-hover:bg-indigo-200 flex items-center justify-center transition">
          <FileText size={18} className="text-indigo-700" />
        </div>
        <div className="text-sm font-semibold text-slate-800">Upload the statement</div>
        <div className="text-[11px] text-slate-500 leading-tight text-center">
          Mortgage / credit card / auto — I'll pull the split.
        </div>
      </button>
      <button
        type="button"
        onClick={onNoStatement}
        className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/60 hover:bg-slate-100 hover:border-slate-300 transition"
        data-testid="liability-no-statement"
      >
        <div className="w-10 h-10 rounded-full bg-slate-100 group-hover:bg-slate-200 flex items-center justify-center transition">
          <X size={18} className="text-slate-600" />
        </div>
        <div className="text-sm font-semibold text-slate-800">I don't have the statement</div>
        <div className="text-[11px] text-slate-500 leading-tight text-center">
          Type the split — I'll book each line.
        </div>
      </button>
    </div>
  );
}


// Four-tile action row for Deposit (item_type=12) items. Each tile
// posts one of the four classifications to `/answer` with a
// `flow` payload — `_handle_deposit` picks the semantic account
// (Sales Revenue / Owner's Contribution / Loans Payable / Refunds &
// Returns) and books the underlying transaction to it.
function DepositShortcuts({ currentItem, token, onBooked }) {
  const [busy, setBusy] = useState(null);   // holds the flow being posted
  const [error, setError] = useState(null);
  const [cpChooserOpen, setCpChooserOpen] = useState(false);   // "customer payment" branch chooser
  const [invoicePickerOpen, setInvoicePickerOpen] = useState(false);
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [refundChooserOpen, setRefundChooserOpen] = useState(false);
  const [refundBillPickerOpen, setRefundBillPickerOpen] = useState(false);
  const [refundCatPickerOpen, setRefundCatPickerOpen] = useState(false);
  const [loanAcctPickerOpen, setLoanAcctPickerOpen] = useState(false);
  const meta = currentItem?.context?.meta || {};
  const amount = Math.abs(Number(meta.txn_amount ?? meta.amount ?? 0));
  const txnId = meta.txn_id || null;

  const post = async (flow, label, extra = {}) => {
    if (busy) return;
    setBusy(flow); setError(null);
    try {
      const r = await axios.post(
        `${API}/${token}/items/${currentItem.item_id}/answer`,
        { answer: label, payload: { flow, ...extra } },
      );
      onBooked?.({ flow, label, ...(r.data || {}) });
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
      setBusy(null);
    }
  };

  const handleCustomerFromPicker = async ({ contact_id, contact_name, isNew }) => {
    setCustomerPickerOpen(false);
    await post(
      "customer_payment",
      isNew ? `Customer payment (new contact: ${contact_name})`
            : `Customer payment (${contact_name})`,
      { contact_id: contact_id || null,
        contact_name: contact_name || null,
        create_contact: isNew || false },
    );
  };

  const tiles = [
    // Customer payment opens the invoice/customer chooser instead of
    // booking immediately.
    { flow: "customer_payment",   label: "Customer payment",   sub: "Revenue — money earned",         color: "emerald", icon: "$", onClick: () => setCpChooserOpen(true) },
    { flow: "owner_contribution", label: "Owner contribution", sub: "Equity — you put money in",     color: "indigo",  icon: "◉", onClick: () => post("owner_contribution", "Owner contribution") },
    { flow: "loan_received",      label: "Loan received",      sub: "Liability — money you'll repay", color: "amber",   icon: "%", onClick: () => setLoanAcctPickerOpen(true) },
    { flow: "refund",             label: "Refund",             sub: "Money coming back from a vendor",color: "rose",    icon: "↩", onClick: () => setRefundChooserOpen(true) },
  ];

  const colorClass = {
    emerald: "border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50 hover:border-emerald-400",
    indigo:  "border-indigo-200  bg-indigo-50/40  hover:bg-indigo-50  hover:border-indigo-400",
    amber:   "border-amber-200   bg-amber-50/40   hover:bg-amber-50   hover:border-amber-400",
    rose:    "border-rose-200    bg-rose-50/40    hover:bg-rose-50    hover:border-rose-400",
  };
  const chipClass = {
    emerald: "bg-emerald-100 group-hover:bg-emerald-200 text-emerald-700",
    indigo:  "bg-indigo-100  group-hover:bg-indigo-200  text-indigo-700",
    amber:   "bg-amber-100   group-hover:bg-amber-200   text-amber-700",
    rose:    "bg-rose-100    group-hover:bg-rose-200    text-rose-700",
  };

  return (
    <div className="py-3" data-testid="deposit-shortcuts">
      <div className="text-[11px] uppercase tracking-wide text-slate-400 pb-2">
        What is this ${amount ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ""} deposit?
      </div>
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <button
            key={t.flow}
            type="button"
            onClick={t.onClick}
            disabled={!!busy}
            className={`group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed transition disabled:opacity-50 ${colorClass[t.color]}`}
            data-testid={`deposit-${t.flow.replace(/_/g, "-")}`}
          >
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold text-lg transition ${chipClass[t.color]}`}>
              {t.icon}
            </div>
            <div className="text-sm font-semibold text-slate-800">
              {busy === t.flow ? "Booking…" : t.label}
            </div>
            <div className="text-[11px] text-slate-500 leading-tight text-center">
              {t.sub}
            </div>
          </button>
        ))}
      </div>
      {error && <div className="text-xs text-rose-600 pt-2">{error}</div>}
      {cpChooserOpen && (
        <CustomerPaymentChooser
          amount={amount}
          onClose={() => setCpChooserOpen(false)}
          onLinkInvoice={() => { setCpChooserOpen(false); setInvoicePickerOpen(true); }}
          onLinkCustomer={() => { setCpChooserOpen(false); setCustomerPickerOpen(true); }}
        />
      )}
      {invoicePickerOpen && (
        <LinkModal
          token={token}
          itemId={currentItem.item_id}
          currentId={""}  /* not used in token mode — endpoint is derived from token */
          txn={{ id: txnId, amount: Number(meta.txn_amount ?? amount ?? 0), contact_id: null }}
          onClose={() => setInvoicePickerOpen(false)}
          onApplied={(res) => {
            setInvoicePickerOpen(false);
            const total = (res.applications || []).reduce((s, a) => s + (a.amount || 0), 0);
            const label = `Applied to ${(res.applications || []).length} invoice${(res.applications || []).length === 1 ? "" : "s"}`;
            onBooked?.({
              flow: "customer_payment_invoice",
              label,
              detail: total > 0
                ? `Booked $${total.toFixed(2)} across ${(res.applications || []).length} invoice${(res.applications || []).length === 1 ? "" : "s"}.`
                : "Applied to invoice.",
              ...res,
            });
          }}
        />
      )}
      {customerPickerOpen && (
        <CustomerPickerModal
          token={token}
          amount={amount}
          onClose={() => setCustomerPickerOpen(false)}
          onPicked={handleCustomerFromPicker}
        />
      )}
      {refundChooserOpen && (
        <RefundChooser
          amount={amount}
          onClose={() => setRefundChooserOpen(false)}
          onAgainstBill={() => { setRefundChooserOpen(false); setRefundBillPickerOpen(true); }}
          onAgainstCategory={() => { setRefundChooserOpen(false); setRefundCatPickerOpen(true); }}
        />
      )}
      {refundBillPickerOpen && (
        <RefundBillPickerModal
          token={token}
          amount={amount}
          onClose={() => setRefundBillPickerOpen(false)}
          onPicked={async (bill) => {
            setRefundBillPickerOpen(false);
            await post("refund", `Refund against ${bill.number ? "bill #" + bill.number : "a bill"}`, {
              category_account_id: bill.category_account_id || null,
              bill_id: bill.id,
              contact_id: bill.contact_id || null,
              contact_name: bill.contact_name || null,
            });
          }}
        />
      )}
      {refundCatPickerOpen && (
        <RefundCategoryPickerModal
          token={token}
          amount={amount}
          onClose={() => setRefundCatPickerOpen(false)}
          onPicked={async (acct) => {
            setRefundCatPickerOpen(false);
            await post("refund", `Refund to ${acct.name}`, {
              category_account_id: acct.id,
            });
          }}
        />
      )}
      {loanAcctPickerOpen && (
        <LoanAccountPickerModal
          token={token}
          amount={amount}
          onClose={() => setLoanAcctPickerOpen(false)}
          onPicked={async (acct) => {
            setLoanAcctPickerOpen(false);
            const label = acct?.name
              ? `Loan received (${acct.name})`
              : "Loan received";
            await post("loan_received", label, {
              category_account_id: acct.id,
            });
          }}
        />
      )}
    </div>
  );
}


// Two-option chooser shown after tapping the "Customer payment" tile
// on a Deposit. Client picks whether to apply the deposit against an
// open invoice (LinkDocPicker) or just tag it to a customer + book
// straight to revenue.
function CustomerPaymentChooser({ amount, onClose, onLinkInvoice, onLinkCustomer }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={onClose} data-testid="customer-payment-chooser">
      <div className="w-full max-w-md m-2 rounded-2xl bg-white shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Customer payment</div>
            <div className="text-sm font-semibold text-slate-800">
              ${amount ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ""} — how do you want to link it?
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
          <button
            type="button"
            onClick={onLinkInvoice}
            className="group flex flex-col items-center justify-center gap-1.5 p-4 rounded-xl border-2 border-dashed border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50 hover:border-emerald-400 transition"
            data-testid="cp-chooser-link-invoice"
          >
            <div className="w-10 h-10 rounded-full bg-emerald-100 group-hover:bg-emerald-200 flex items-center justify-center transition">
              <FileText size={18} className="text-emerald-700" />
            </div>
            <div className="text-sm font-semibold text-slate-800">Link to invoice</div>
            <div className="text-[11px] text-slate-500 leading-tight text-center">
              Applies against an open invoice.
            </div>
          </button>
          <button
            type="button"
            onClick={onLinkCustomer}
            className="group flex flex-col items-center justify-center gap-1.5 p-4 rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 hover:bg-indigo-50 hover:border-indigo-400 transition"
            data-testid="cp-chooser-link-customer"
          >
            <div className="w-10 h-10 rounded-full bg-indigo-100 group-hover:bg-indigo-200 flex items-center justify-center transition">
              <Check size={18} className="text-indigo-700" />
            </div>
            <div className="text-sm font-semibold text-slate-800">Link to customer</div>
            <div className="text-[11px] text-slate-500 leading-tight text-center">
              Just tag the customer — no invoice.
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}


// Customer picker modal used by the Deposit → Customer payment → Link
// to customer flow. Search box hits `/client-review/{token}/contacts`
// and offers an inline "+ Add new customer …" row when the query
// doesn't match. On pick, calls `onPicked({contact_id, contact_name,
// isNew})`.
function CustomerPickerModal({ token, amount, onClose, onPicked }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true); setErr(null);
    axios.get(`${API}/${token}/contacts`, { params: q.trim() ? { q: q.trim() } : {} })
      .then((r) => { if (!cancelled) setRows(r.data?.contacts || r.data || []); })
      .catch((e) => { if (!cancelled) setErr(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [q, token]);

  const trimmed = q.trim();
  const exact = rows.find((c) => (c.name || "").trim().toLowerCase() === trimmed.toLowerCase());
  const showAddNew = trimmed && !exact;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={onClose} data-testid="customer-picker-modal">
      <div className="w-full max-w-md m-2 rounded-2xl bg-white shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Customer payment</div>
            <div className="text-sm font-semibold text-slate-800">
              Who paid ${amount ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ""}?
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-4">
          <input
            autoFocus
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search customers…"
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-indigo-400 outline-none"
            data-testid="customer-picker-search"
          />
          <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-slate-100">
            {busy && <div className="p-3 text-xs text-slate-400">Loading…</div>}
            {err && <div className="p-3 text-xs text-rose-600">{err}</div>}
            {!busy && !err && rows.length === 0 && !trimmed && (
              <div className="p-3 text-xs text-slate-400">Type a name to find a customer.</div>
            )}
            {rows.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onPicked({ contact_id: c.id, contact_name: c.name, isNew: false })}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-50 last:border-0"
                data-testid={`customer-picker-row-${c.id}`}
              >
                <div className="text-sm text-slate-800">{c.name}</div>
                {c.type && <div className="text-[11px] text-slate-400">{c.type}</div>}
              </button>
            ))}
            {showAddNew && (
              <button
                type="button"
                onClick={() => onPicked({ contact_id: null, contact_name: trimmed, isNew: true })}
                className="w-full text-left px-3 py-2 hover:bg-indigo-50 text-indigo-700 font-medium border-t border-slate-100"
                data-testid="customer-picker-add-new"
              >
                + Add new customer "{trimmed}"
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}



// Chooser modal shown after tapping "Refund" — client picks whether to
// credit the refund back to a specific open bill or to a category
// (expense account).
function RefundChooser({ amount, onClose, onAgainstBill, onAgainstCategory }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={onClose} data-testid="refund-chooser">
      <div className="w-full max-w-md m-2 rounded-2xl bg-white shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Refund</div>
            <div className="text-sm font-semibold text-slate-800">
              ${amount ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ""} — where should this credit go?
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
          <button
            type="button"
            onClick={onAgainstBill}
            className="group flex flex-col items-center justify-center gap-1.5 p-4 rounded-xl border-2 border-dashed border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50 hover:border-emerald-400 transition"
            data-testid="refund-chooser-against-bill"
          >
            <div className="w-10 h-10 rounded-full bg-emerald-100 group-hover:bg-emerald-200 flex items-center justify-center transition">
              <FileText size={18} className="text-emerald-700" />
            </div>
            <div className="text-sm font-semibold text-slate-800">Against a bill</div>
            <div className="text-[11px] text-slate-500 leading-tight text-center">
              Credit back to a specific vendor bill.
            </div>
          </button>
          <button
            type="button"
            onClick={onAgainstCategory}
            className="group flex flex-col items-center justify-center gap-1.5 p-4 rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 hover:bg-indigo-50 hover:border-indigo-400 transition"
            data-testid="refund-chooser-against-category"
          >
            <div className="w-10 h-10 rounded-full bg-indigo-100 group-hover:bg-indigo-200 flex items-center justify-center transition">
              <Check size={18} className="text-indigo-700" />
            </div>
            <div className="text-sm font-semibold text-slate-800">To a category</div>
            <div className="text-[11px] text-slate-500 leading-tight text-center">
              Reduce a specific expense account.
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}


// Bill picker used by Refund → Against a bill. Lists open bills for
// the batch's company; on pick, extracts the bill's expense account
// so the deposit gets credited back to the original expense line.
function RefundBillPickerModal({ token, amount, onClose, onPicked }) {
  const [q, setQ] = useState("");
  const [bills, setBills] = useState([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    // Include recently-paid bills too — the "vendor refunded me for a
    // bill I already paid" case is common (returned inventory, dupe
    // invoice, warranty credit) and would otherwise leave the client
    // with an empty picker if no bills are open.
    axios.get(`${API}/${token}/bills/open?include_paid=1`)
      .then((r) => setBills(r.data?.bills || []))
      .finally(() => setBusy(false));
  }, [token]);

  const trimmed = q.trim().toLowerCase();
  // Amount search: strip $ / , from the query and match against the
  // bill's `balance_due` + `total` (both as raw and $-formatted
  // strings) so "241", "241.23", "$241", and "$241.23" all hit
  // BILL-19 · Brosnahan Insurance ($241.23).
  const stripped = trimmed.replace(/[$,\s]/g, "");
  const numeric = stripped && !Number.isNaN(Number(stripped)) ? stripped : null;
  const filtered = trimmed
    ? bills.filter((b) => {
        const hay = [
          b.number || "",
          b.contact_name || "",
        ].join(" ").toLowerCase();
        if (hay.includes(trimmed)) return true;
        if (!numeric) return false;
        const bal = String(Number(b.balance_due || 0));
        const tot = String(Number(b.total || 0));
        return bal.includes(numeric) || tot.includes(numeric);
      })
    : bills;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={onClose} data-testid="refund-bill-picker">
      <div className="w-full max-w-md m-2 rounded-2xl bg-white shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Refund against a bill</div>
            <div className="text-sm font-semibold text-slate-800">
              Pick the bill this ${amount ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ""} refund relates to
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-4">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search bill #, vendor, or amount…"
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-indigo-400 outline-none"
          />
          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-100">
            {busy && <div className="p-3 text-xs text-slate-400">Loading…</div>}
            {!busy && filtered.length === 0 && (
              <div className="p-3 text-xs text-slate-400">No open bills found.</div>
            )}
            {filtered.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => onPicked(b)}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-50 last:border-0"
                data-testid={`refund-bill-row-${b.id}`}
              >
                <div className="text-sm text-slate-800 flex items-center gap-2">
                  <span>{b.contact_name || "Vendor"}</span>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-400">#{b.number || b.id.slice(0, 6)}</span>
                  {b.is_paid && (
                    <span className="ml-auto text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">
                      Paid
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500">
                  {b.date} · {b.is_paid
                    ? `total $${Number(b.total || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                    : `balance $${Number(b.balance_due || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


// Category (expense-account) picker used by Refund → To a category.
function RefundCategoryPickerModal({ token, amount, onClose, onPicked }) {
  const [q, setQ] = useState("");
  const [accts, setAccts] = useState([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    axios.get(`${API}/${token}/accounts`)
      .then((r) => {
        const list = r.data?.accounts || r.data || [];
        // Refunds most commonly credit back to expense accounts.
        setAccts(list.filter((a) => (a.type || "").toLowerCase() === "expense"));
      })
      .finally(() => setBusy(false));
  }, [token]);

  const trimmed = q.trim().toLowerCase();
  const filtered = trimmed
    ? accts.filter((a) => `${a.code} ${a.name}`.toLowerCase().includes(trimmed))
    : accts;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={onClose} data-testid="refund-cat-picker">
      <div className="w-full max-w-md m-2 rounded-2xl bg-white shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Refund to a category</div>
            <div className="text-sm font-semibold text-slate-800">
              Pick the expense account to credit ${amount ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ""} back to
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-4">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search account name or code…"
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-indigo-400 outline-none"
          />
          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-100">
            {busy && <div className="p-3 text-xs text-slate-400">Loading…</div>}
            {!busy && filtered.length === 0 && (
              <div className="p-3 text-xs text-slate-400">No expense accounts found.</div>
            )}
            {filtered.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onPicked(a)}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-50 last:border-0"
                data-testid={`refund-cat-row-${a.id}`}
              >
                <div className="text-sm text-slate-800">{a.name}</div>
                <div className="text-[11px] text-slate-400">{a.code || ""}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


// Liability sub-types — mirrors DETAIL_TYPES.liability in
// /app/frontend/src/pages/ChartOfAccounts.jsx. Keep in sync when new
// keys are added there.
const _LIABILITY_SUBTYPES = [
  { key: "credit_card",                  label: "Credit Card" },
  { key: "loan_and_line_of_credit",      label: "Loan and Line of Credit" },
  { key: "expected_payments_to_vendors", label: "Accounts Payable" },
  { key: "due_for_payroll",              label: "Due For Payroll" },
  { key: "due_to_owners",                label: "Due to Owners" },
  { key: "customer_prepayments",         label: "Customer Prepayments & Credits" },
  { key: "sales_tax_payable",            label: "Sales Tax Payable" },
  { key: "other_short_term_liability",   label: "Other Short-Term Liability" },
  { key: "other_long_term_liability",    label: "Other Long-Term Liability" },
];


// Liability-account picker used by Deposit → Loan received. Lists the
// company's existing liability accounts (Loans Payable, Credit Cards
// Payable, specific loan sub-accts) and offers an inline
// "New Account" form so the client can mint a new liability CoA
// record (e.g. "Vehicle Loan — Toyota") without leaving the wizard.
// The inline form mirrors the firm-side CoA modal shape:
// Code / Name / Type (locked to Liability) / Sub-type / Sub-account of.
function LoanAccountPickerModal({ token, amount, onClose, onPicked }) {
  const [q, setQ] = useState("");
  const [accts, setAccts] = useState([]);
  const [busy, setBusy] = useState(true);
  const [creating, setCreating] = useState(false);
  // "New Account" form fields — matches ChartOfAccounts.jsx CreateAccount.
  const [newCode, setNewCode]         = useState("");
  const [newName, setNewName]         = useState("");
  const [newDetailType, setNewDetailType] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    axios.get(`${API}/${token}/accounts`)
      .then((r) => {
        const list = r.data?.accounts || r.data || [];
        setAccts(list.filter((a) => (a.type || "").toLowerCase() === "liability"));
      })
      .finally(() => setBusy(false));
  }, [token]);

  const submitNew = async () => {
    const name = newName.trim();
    if (!name || !newDetailType || saving) return;
    setSaving(true); setErr(null);
    try {
      const r = await axios.post(`${API}/${token}/accounts/liability`, {
        code: newCode.trim() || null,
        name,
        detail_type: newDetailType,
        parent_account_id: newParentId || null,
      });
      // Auto-select the just-created account so the deposit books
      // immediately — one less tap for the client.
      onPicked(r.data);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
      setSaving(false);
    }
  };

  const trimmed = q.trim().toLowerCase();
  const filtered = trimmed
    ? accts.filter((a) => `${a.code || ""} ${a.name || ""}`.toLowerCase().includes(trimmed))
    : accts;
  // Sub-account parents = top-level (no parent_account_id) liability
  // accounts. Same filter the firm-side modal uses.
  const eligibleParents = accts
    .filter((a) => !a.parent_account_id)
    .sort((x, y) => String(x.code || "").localeCompare(String(y.code || "")));

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={onClose} data-testid="loan-account-picker">
      <div className="w-full max-w-md m-2 rounded-2xl bg-white shadow-2xl overflow-hidden max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              {creating ? "New Account" : "Loan received"}
            </div>
            <div className="text-sm font-semibold text-slate-800">
              {creating
                ? "Create a liability account"
                : `Which liability account should $${amount ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ""} land in?`}
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600" data-testid="loan-picker-close"><X size={18} /></button>
        </div>
        <div className="p-4 overflow-y-auto">
          {!creating && (
            <>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search liability account name or code…"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-amber-400 outline-none"
                data-testid="loan-picker-search"
              />
              <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-slate-100">
                {busy && <div className="p-3 text-xs text-slate-400">Loading…</div>}
                {!busy && filtered.length === 0 && (
                  <div className="p-3 text-xs text-slate-400">No liability accounts yet. Create one below.</div>
                )}
                {filtered.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onPicked(a)}
                    className="w-full text-left px-3 py-2 hover:bg-amber-50 border-b border-slate-50 last:border-0"
                    data-testid={`loan-acct-row-${a.id}`}
                  >
                    <div className="text-sm text-slate-800">{a.name}</div>
                    <div className="text-[11px] text-slate-400">{a.code || ""}</div>
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => { setCreating(true); setErr(null); }}
                className="mt-3 w-full px-3 py-2 rounded-lg border-2 border-dashed border-amber-300 bg-amber-50/40 hover:bg-amber-50 text-sm font-medium text-amber-800 transition"
                data-testid="loan-picker-create-new"
              >
                + Create new liability account
              </button>
            </>
          )}
          {creating && (
            <div className="space-y-3">
              <input
                placeholder="Code (e.g. 2250)"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                maxLength={10}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono-num focus:border-amber-400 outline-none"
                data-testid="loan-picker-new-code"
              />
              <input
                autoFocus
                placeholder="Account name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={100}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:border-amber-400 outline-none"
                data-testid="loan-picker-new-name"
              />
              {/* Type — locked to Liability. Kept as a disabled select
                  so the layout matches the firm-side New Account modal
                  the user is trained on. */}
              <select
                value="liability"
                disabled
                className="w-full border rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-500 cursor-not-allowed"
                data-testid="loan-picker-new-type"
              >
                <option value="liability">Liability</option>
              </select>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Sub-type <span className="text-rose-500">*</span>
                </label>
                <select
                  value={newDetailType}
                  onChange={(e) => setNewDetailType(e.target.value)}
                  required
                  className={`w-full border rounded-lg px-3 py-2 text-sm bg-white focus:border-amber-400 outline-none ${newDetailType ? "text-slate-900" : "text-slate-400"}`}
                  data-testid="loan-picker-new-detail-type"
                >
                  <option value="" disabled>Select a sub-type…</option>
                  {_LIABILITY_SUBTYPES.map((dt) => (
                    <option key={dt.key} value={dt.key} className="text-slate-900">
                      {dt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Sub-account of (optional)
                </label>
                <select
                  value={newParentId}
                  onChange={(e) => setNewParentId(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-white focus:border-amber-400 outline-none"
                  data-testid="loan-picker-new-parent"
                >
                  <option value="">— None (top-level account) —</option>
                  {eligibleParents.map((par) => (
                    <option key={par.id} value={par.id}>
                      {par.code} · {par.name}
                    </option>
                  ))}
                </select>
                {eligibleParents.length === 0 && (
                  <div className="text-[10px] text-slate-500 mt-1">
                    No top-level liability accounts yet — this will be a top-level account.
                  </div>
                )}
              </div>
              {err && <div className="text-xs text-rose-600">{err}</div>}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={submitNew}
                  disabled={saving || !newName.trim() || !newDetailType}
                  className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="loan-picker-save-new"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => { setCreating(false); setNewName(""); setNewCode(""); setNewDetailType(""); setNewParentId(""); setErr(null); }}
                  className="flex-1 py-2 rounded-md border text-sm text-slate-700 hover:bg-slate-50"
                  data-testid="loan-picker-cancel-new"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}






// Cascade banner shown on Uncategorized items whose sibling Missing-Receipt
// upload already booked to a category — the client can tap "Same as the
// receipt" to apply the same category to this txn in one shot.
function SuggestedCategoryBanner({ currentItem, token, onApplied }) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState(null);
  const ctx = currentItem?.context || {};
  const acctName = ctx.suggested_category_account_name || "the same category";
  const acctCode = ctx.suggested_category_account_code || "";
  const source = ctx.suggested_from === "receipt" ? "receipt" : "the previous answer";
  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const r = await axios.post(
        `${API}/${token}/items/${currentItem.item_id}/categorize`,
        { category_account_id: ctx.suggested_category_account_id },
      );
      onApplied({
        account_name: acctName,
        contact_name: ctx.contact_name || ctx.merchant || "",
        ...r.data,
      });
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
      setApplying(false);
    }
  };
  return (
    <div
      className="py-3"
      data-testid="suggested-category-banner"
    >
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
          <Check size={18} className="text-emerald-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-800">
            Same as the {source} — {acctName}
            {acctCode ? <span className="text-slate-400 font-normal"> · {acctCode}</span> : null}?
          </div>
          <div className="text-[11px] text-slate-500">
            One tap books this transaction to the same category.
          </div>
        </div>
        <button
          type="button"
          onClick={apply}
          disabled={applying}
          className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 shrink-0"
          data-testid="suggested-category-apply"
        >
          {applying ? "Booking…" : "Yes, same"}
        </button>
      </div>
      {error && (
        <div className="text-xs text-rose-600 pt-1">{error}</div>
      )}
    </div>
  );
}




// Yes / No / Edit shortcut trio for item types that confirm an AI-drafted
// classification (Owner's Draw check, contact merge, etc.). "Yes"/"No"
// push a text answer through the standard turn endpoint; "Edit" opens
// the same TxnEditModal used by Uncategorized so the client can fix
// date / amount / category / links before confirming.
function YesNoEditShortcuts({ currentItem, token, onYes, onNo, onEdited, hideHelper, yesLabel, noLabel }) {
  const [editOpen, setEditOpen] = useState(false);
  return (
    <>
      <div className="grid grid-cols-3 gap-3 py-3" data-testid="yesno-shortcuts">
        <button
          type="button"
          onClick={onYes}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50 hover:border-emerald-400 transition"
          data-testid="yesno-yes"
        >
          <div className="w-10 h-10 rounded-full bg-emerald-100 group-hover:bg-emerald-200 flex items-center justify-center transition">
            <Check size={18} className="text-emerald-700" />
          </div>
          <div className="text-sm font-semibold text-slate-800">Yes</div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            {yesLabel || "Confirm — book it as suggested."}
          </div>
        </button>
        <button
          type="button"
          onClick={onNo}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-rose-200 bg-rose-50/40 hover:bg-rose-50 hover:border-rose-400 transition"
          data-testid="yesno-no"
        >
          <div className="w-10 h-10 rounded-full bg-rose-100 group-hover:bg-rose-200 flex items-center justify-center transition">
            <X size={18} className="text-rose-700" />
          </div>
          <div className="text-sm font-semibold text-slate-800">No</div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            {noLabel || "Not quite — I'll explain below."}
          </div>
        </button>
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="group flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 border-dashed border-violet-200 bg-violet-50/40 hover:bg-violet-50 hover:border-violet-400 transition"
          data-testid="yesno-edit"
        >
          <div className="w-10 h-10 rounded-full bg-violet-100 group-hover:bg-violet-200 flex items-center justify-center transition">
            <Pencil size={18} className="text-violet-700" />
          </div>
          <div className="text-sm font-semibold text-slate-800">Edit</div>
          <div className="text-[11px] text-slate-500 leading-tight text-center">
            Fix the date, amount, or details on this transaction.
          </div>
        </button>
      </div>
      {!hideHelper && (
        <div className="text-center text-xs text-slate-500 py-2">
          Tap Yes / No, or type an explanation below.
        </div>
      )}
      {editOpen && (
        <TxnEditModal
          token={token}
          item={currentItem}
          onClose={() => setEditOpen(false)}
          onSaved={(res) => { setEditOpen(false); onEdited?.(res); }}
        />
      )}
    </>
  );
}




// Modal picker for the "Link to a bill/invoice" shortcut. Lists every
// open bill (money-out) or invoice (money-in), filterable by search.
// One tap POSTs to /link-doc, which books the accounting and marks the
// check-in item answered — parent receives the {applied, new_balance,
// contact_name, doc_number} echo so it can render the confirmation.
function LinkDocPicker({ token, itemId, linkKind, txnAmount, onClose, onLinked, currentItem, txnIdOverride }) {
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState([]);
  const [q, setQ] = useState("");
  const [linkingId, setLinkingId] = useState(null);
  const [error, setError] = useState(null);
  // Support both call-sites: (itemId + linkKind) legacy shape AND the
  // (currentItem + txnIdOverride) grouped-row shape.
  const resolvedItemId = itemId || currentItem?.item_id;
  const resolvedLinkKind = linkKind || (
    currentItem?.context?.direction === "in" ? "invoice" : "bill"
  );
  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/${token}/pickable`);
        const arr = resolvedLinkKind === "bill"
          ? (r.data?.bills || [])
          : (r.data?.invoices || []);
        setDocs(arr);
      } catch (e) {
        setError(e?.response?.data?.detail || e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [token, resolvedLinkKind]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return docs;
    return docs.filter((d) =>
      (d.label || "").toLowerCase().includes(needle) ||
      (d.contact_name || "").toLowerCase().includes(needle) ||
      (d.number || "").toLowerCase().includes(needle),
    );
  }, [docs, q]);
  const link = async (doc) => {
    setLinkingId(doc.id);
    setError(null);
    try {
      const body = { doc_type: resolvedLinkKind, doc_id: doc.id };
      if (txnIdOverride) body.txn_id = txnIdOverride;
      const r = await axios.post(
        `${API}/${token}/items/${resolvedItemId}/link-doc`,
        body,
      );
      onLinked(r.data);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
      setLinkingId(null);
    }
  };
  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/50 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="link-doc-picker"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div>
            <div className="text-base font-semibold text-slate-800">
              Pick an open {linkKind}
            </div>
            <div className="text-xs text-slate-500">
              Payment amount: ${txnAmount.toFixed(2)}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            data-testid="link-doc-close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-slate-100">
          <input
            type="text"
            placeholder={`Search ${linkKind}s by number, vendor or amount…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            data-testid="link-doc-search"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="text-center text-sm text-slate-500 py-8">
              <Loader2 className="animate-spin inline-block mr-2" size={14} />
              Loading open {linkKind}s…
            </div>
          ) : error ? (
            <div className="text-center text-sm text-red-600 py-4">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-sm text-slate-500 py-8">
              {docs.length === 0
                ? `No open ${linkKind}s on file — try uploading a receipt instead.`
                : "No matches. Try a different search."}
            </div>
          ) : filtered.map((d) => (
            <button
              key={d.id}
              onClick={() => link(d)}
              disabled={!!linkingId}
              className={`w-full text-left px-3 py-2.5 rounded-lg hover:bg-emerald-50 border border-transparent hover:border-emerald-200 disabled:opacity-50 flex items-center justify-between gap-3 mb-1 ${linkingId === d.id ? "bg-emerald-50 border-emerald-200" : ""}`}
              data-testid={`link-doc-option-${d.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-800 truncate">
                  {d.contact_name || (linkKind === "bill" ? "Vendor" : "Customer")}
                  {d.number && <span className="text-slate-500 font-normal"> · #{d.number}</span>}
                </div>
                <div className="text-xs text-slate-500">
                  ${Number(d.balance_due).toFixed(2)} outstanding
                  {d.due_date && <> · due {d.due_date}</>}
                </div>
              </div>
              {linkingId === d.id ? (
                <Loader2 className="animate-spin text-emerald-600" size={16} />
              ) : (
                <ArrowRight size={16} className="text-emerald-600 shrink-0" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Modal picker for the "Complete" shortcut — lists categories the
// client can pick with a single tap. Expense/COGS/asset accounts for
// money-out; income/liability for money-in. One tap POSTs to
// /categorize which stamps the txn and marks the check-in item
// answered.
function CategoryQuickPicker({ token, itemId, txnAmount, isMoneyOut, onClose, onCompleted }) {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [q, setQ] = useState("");
  const [pickingId, setPickingId] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/${token}/pickable`);
        const all = r.data?.accounts || [];
        // Filter to the buckets that make sense for this direction of
        // money movement — expense/COGS/asset for out, income/liability
        // for in — so the client doesn't have to scroll past 40+ GL
        // accounts irrelevant to their situation.
        const allowed = isMoneyOut
          ? ["expense", "cogs", "asset", "cost_of_goods_sold"]
          : ["income", "revenue", "liability"];
        const filtered = all.filter((a) =>
          allowed.includes((a.type || "").toLowerCase()),
        );
        setAccounts(filtered);
      } catch (e) {
        setError(e?.response?.data?.detail || e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [token, isMoneyOut]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return accounts;
    return accounts.filter((a) =>
      (a.name || "").toLowerCase().includes(needle) ||
      String(a.code || "").includes(needle),
    );
  }, [accounts, q]);
  const complete = async (a) => {
    setPickingId(a.id);
    setError(null);
    try {
      const r = await axios.post(
        `${API}/${token}/items/${itemId}/categorize`,
        { category_account_id: a.id },
      );
      onCompleted(r.data);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
      setPickingId(null);
    }
  };
  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/50 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="category-quick-picker"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div>
            <div className="text-base font-semibold text-slate-800">
              Pick a category
            </div>
            <div className="text-xs text-slate-500">
              Amount: ${txnAmount.toFixed(2)} · {isMoneyOut ? "money out" : "money in"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            data-testid="category-quick-close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-slate-100">
          <input
            type="text"
            placeholder="Search categories by name or code…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
            data-testid="category-quick-search"
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="text-center text-sm text-slate-500 py-8">
              <Loader2 className="animate-spin inline-block mr-2" size={14} />
              Loading categories…
            </div>
          ) : error ? (
            <div className="text-center text-sm text-red-600 py-4">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-sm text-slate-500 py-8">
              {accounts.length === 0
                ? "No matching categories on file."
                : "No matches. Try a different search."}
            </div>
          ) : filtered.map((a) => (
            <button
              key={a.id}
              onClick={() => complete(a)}
              disabled={!!pickingId}
              className={`w-full text-left px-3 py-2 rounded-lg hover:bg-amber-50 border border-transparent hover:border-amber-200 disabled:opacity-50 flex items-center justify-between gap-3 mb-1 ${pickingId === a.id ? "bg-amber-50 border-amber-200" : ""}`}
              data-testid={`category-quick-option-${a.id}`}
            >
              <div className="min-w-0 flex-1 flex items-baseline gap-2">
                <span className="text-[11px] font-mono text-slate-400 tabular-nums shrink-0">
                  {a.code}
                </span>
                <span className="text-sm text-slate-800 truncate">{a.name}</span>
              </div>
              <span className="text-[11px] uppercase tracking-wide text-slate-400 shrink-0">
                {(a.type || "").replace("_", " ")}
              </span>
              {pickingId === a.id && (
                <Loader2 className="animate-spin text-amber-600 shrink-0" size={16} />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Full transaction editor for the client-review page — mirrors the
// CPA-side ManualTxnModal (Transactions.jsx) but talks to the
// token-scoped client-review endpoints so an unauth client can:
//   * fix date / amount / description / bank account / contact
//   * split into multiple categories
//   * link to an invoice or bill
//   * attach + remove receipts
// Saves via POST /{token}/items/{item_id}/edit-txn.
function TxnEditModal({ token, item, onClose, onSaved }) {
  const ctx = item?.context || {};
  const attachInputRef = useRef(null);

  // --- Data pickers ---
  const [accounts, setAccounts]   = useState([]);
  const [contacts, setContacts]   = useState([]);
  const [invoices, setInvoices]   = useState([]);
  const [bills,    setBills]      = useState([]);

  // --- Hydrated txn (splits, links, attachments) ---
  const [txnLoaded, setTxnLoaded] = useState(false);

  // --- Header fields ---
  const [date, setDate]                 = useState(ctx.date || "");
  const [description, setDescription]   = useState(ctx.description || "");
  const [amount, setAmount]             = useState(String(ctx.amount ?? ""));
  const [bankAccountId, setBankAccountId] = useState("");

  // --- Contact typeahead ---
  const [contactId, setContactId]           = useState("");
  const [contactQuery, setContactQuery]     = useState("");
  const [contactMenuOpen, setContactMenuOpen] = useState(false);
  const [initialContactName, setInitialContactName] = useState(ctx.merchant || "");

  // --- Category / Splits ---
  const [categoryAccountId, setCategoryAccountId] = useState("");
  const [splitsOn, setSplitsOn]  = useState(false);
  const [splitRows, setSplitRows] = useState([
    { amount: "", category_account_id: "", description: "" },
    { amount: "", category_account_id: "", description: "" },
  ]);

  // --- Link to invoice/bill ---
  const [linkKind, setLinkKind] = useState("invoice");
  const [linkDocId, setLinkDocId] = useState("");
  const [linkTouched, setLinkTouched] = useState(false);

  // --- Attachments ---
  const [attachments, setAttachments] = useState([]);
  const [attaching, setAttaching] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState(null);

  // Load pickable + contacts + fresh txn state on open
  useEffect(() => {
    (async () => {
      try {
        const [pickR, contR, txnR] = await Promise.all([
          axios.get(`${API}/${token}/pickable`),
          axios.get(`${API}/${token}/contacts`),
          axios.get(`${API}/${token}/items/${item.item_id}/txn${item.__rowTxnId ? `?txn_id=${item.__rowTxnId}` : ""}`),
        ]);
        setAccounts(pickR.data?.accounts || []);
        setInvoices(pickR.data?.invoices || []);
        setBills(pickR.data?.bills || []);
        setContacts(contR.data?.contacts || contR.data || []);

        const t = txnR.data || {};
        setDate(t.date || ctx.date || "");
        setDescription(t.description || ctx.description || "");
        setAmount(String(t.amount ?? ctx.amount ?? ""));
        setBankAccountId(t.bank_account_id || "");
        setContactId(t.contact_id || "");
        setInitialContactName(t.contact_name || ctx.merchant || "");
        setCategoryAccountId(t.category_account_id || "");
        setAttachments(t.attachments || []);

        if ((t.splits || []).length > 0) {
          setSplitsOn(true);
          setSplitRows(t.splits.map((s) => ({
            amount: String(s.amount ?? ""),
            category_account_id: s.category_account_id || "",
            description: s.description || "",
          })));
        }
        if (t.linked_invoice_id) { setLinkKind("invoice"); setLinkDocId(t.linked_invoice_id); }
        else if (t.linked_bill_id) { setLinkKind("bill"); setLinkDocId(t.linked_bill_id); }
        else {
          // Default toggle side matches money direction: expense → bill, income → invoice
          setLinkKind((Number(t.amount ?? ctx.amount ?? 0) < 0) ? "bill" : "invoice");
        }
        setTxnLoaded(true);
      } catch (e) {
        setError(e?.response?.data?.detail || e.message);
      } finally {
        setLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, item?.item_id]);

  // Group accounts like the CPA modal: bank-like assets vs. liabilities
  const bankAssets = useMemo(
    () => accounts.filter((a) => ["bank", "asset", "receivable"].includes((a.type || "").toLowerCase())),
    [accounts],
  );
  const bankLiabilities = useMemo(
    () => accounts.filter((a) => ["credit_card", "liability", "payable"].includes((a.type || "").toLowerCase())),
    [accounts],
  );
  const categoryAccounts = useMemo(
    () => accounts.filter((a) => !["bank", "asset", "receivable", "credit_card", "liability", "payable"].includes((a.type || "").toLowerCase())),
    [accounts],
  );

  // Contact typeahead — filter existing contacts by fuzzy substring on name.
  const filteredContacts = useMemo(() => {
    const needle = contactQuery.trim().toLowerCase();
    if (!needle) return contacts.slice(0, 40);
    return contacts.filter((c) => (c.name || "").toLowerCase().includes(needle)).slice(0, 40);
  }, [contacts, contactQuery]);
  const canCreateNewContact = contactQuery.trim().length > 1
    && !contacts.some((c) => (c.name || "").toLowerCase() === contactQuery.trim().toLowerCase());

  const contactDisplay = contactId
    ? ((contacts.find((c) => c.id === contactId) || {}).name || initialContactName || "")
    : contactQuery;

  // Splits helpers
  const amtNum = Number(amount || 0);
  const splitTotal = splitRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const splitsBalance = Math.abs(splitTotal - amtNum) <= 0.01 && splitRows.every((r) => r.category_account_id);

  // Link options — driven by toggle
  const linkOptions = linkKind === "bill" ? bills : invoices;

  const uploadAttachment = async (file) => {
    if (!file) return;
    setAttaching(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "receipt");
      const r = await axios.post(
        `${API}/${token}/items/${item.item_id}/upload`,
        form,
      );
      if (r.data?.attachment) {
        setAttachments((prev) => [...prev, r.data.attachment]);
      }
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setAttaching(false);
    }
  };

  const removeAttachment = async (aid) => {
    setError(null);
    try {
      await axios.delete(
        `${API}/${token}/items/${item.item_id}/attachments/${aid}`,
      );
      setAttachments((prev) => prev.filter((a) => a.id !== aid));
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    }
  };

  const save = async () => {
    // Guard: splits must balance when splitsOn
    if (splitsOn && !splitsBalance) {
      setError(`Splits total ${splitTotal.toFixed(2)} must equal amount ${amtNum.toFixed(2)}`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {};
      body.date        = date;
      body.description = description;
      body.amount      = Number(amount);
      if (bankAccountId) body.bank_account_id = bankAccountId;
      if (contactId) {
        body.contact_id = contactId;
      } else if (contactQuery.trim() && contactQuery.trim() !== initialContactName) {
        body.contact_name = contactQuery.trim();
        body.contact_id   = "";
      }
      if (splitsOn) {
        body.splits = splitRows
          .filter((r) => Number(r.amount || 0) !== 0 || r.category_account_id)
          .map((r) => ({
            amount: Number(r.amount || 0),
            category_account_id: r.category_account_id,
            description: r.description || "",
          }));
        body.category_account_id = "";
      } else {
        body.category_account_id = categoryAccountId || "";
        body.splits = [];
      }
      if (linkTouched) {
        body.link_kind   = linkKind;
        body.link_doc_id = linkDocId || "";
      }
      if (item.__rowTxnId) body.txn_id = item.__rowTxnId;
      const r = await axios.post(
        `${API}/${token}/items/${item.item_id}/edit-txn`,
        body,
      );
      onSaved(r.data);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/50 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="txn-edit-modal"
    >
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${splitsOn ? "max-w-2xl" : "max-w-md"} max-h-[90vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="text-base font-semibold text-slate-800">Edit transaction</div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-100 text-slate-500"
            data-testid="txn-edit-close"
          >
            <X size={18} />
          </button>
        </div>
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="animate-spin text-slate-400" size={20} />
          </div>
        ) : (
          <div className="p-5 space-y-3 text-sm overflow-y-auto">
            {/* Date */}
            <div>
              <label className="text-xs text-slate-600">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full border rounded px-2 py-1.5"
                data-testid="txn-edit-date"
              />
            </div>
            {/* Account (bank / credit card) */}
            <div>
              <label className="text-xs text-slate-600">Account</label>
              <select
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm bg-white"
                data-testid="txn-edit-bank"
              >
                <option value="">— Default ({ctx.account || "Business Checking"}) —</option>
                {bankAssets.length > 0 && (
                  <optgroup label="Assets (bank, cash, receivable…)">
                    {bankAssets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code ? `${a.code} · ` : ""}{a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {bankLiabilities.length > 0 && (
                  <optgroup label="Liabilities (credit cards, loans, payable…)">
                    {bankLiabilities.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code ? `${a.code} · ` : ""}{a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            {/* Contact typeahead */}
            <div className="relative" onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) {
                setTimeout(() => setContactMenuOpen(false), 150);
              }
            }}>
              <label className="text-xs text-slate-600">Contact</label>
              <input
                type="text"
                placeholder="Search or type a new name…"
                value={contactDisplay}
                onFocus={() => setContactMenuOpen(true)}
                onChange={(e) => {
                  setContactId("");
                  setContactQuery(e.target.value);
                  setContactMenuOpen(true);
                }}
                className="w-full border rounded px-2 py-1.5 text-sm"
                data-testid="txn-edit-contact-input"
              />
              {contactMenuOpen && (filteredContacts.length > 0 || canCreateNewContact) && (
                <div className="absolute z-30 left-0 right-0 top-[calc(100%+2px)] max-h-[240px] overflow-y-auto rounded-md border border-slate-200 bg-white shadow-xl">
                  {filteredContacts.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setContactId(c.id);
                        setContactQuery("");
                        setContactMenuOpen(false);
                      }}
                      className="w-full text-left px-2 py-1.5 text-xs hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                      data-testid={`txn-edit-contact-opt-${c.id}`}
                    >
                      {c.name}
                    </button>
                  ))}
                  {canCreateNewContact && (
                    <button
                      type="button"
                      onClick={() => setContactMenuOpen(false)}
                      className="w-full text-left px-2 py-1.5 text-xs text-cyan-700 font-semibold hover:bg-cyan-50 border-t border-slate-100"
                      data-testid="txn-edit-contact-add-new"
                    >
                      + Use new contact "{contactQuery.trim()}"
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* Description */}
            <div>
              <label className="text-xs text-slate-600">Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full border rounded px-2 py-1.5"
                data-testid="txn-edit-desc"
              />
            </div>
            {/* Amount */}
            <div>
              <label className="text-xs text-slate-600">Amount (negative = expense)</label>
              <input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full border rounded px-2 py-1.5 font-mono"
                data-testid="txn-edit-amount"
              />
            </div>
            {/* Split toggle */}
            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="txn-edit-splits-on"
                checked={splitsOn}
                onChange={(e) => setSplitsOn(e.target.checked)}
                className="rounded"
                data-testid="txn-edit-splits-toggle"
              />
              <label htmlFor="txn-edit-splits-on" className="text-xs text-slate-700 font-medium cursor-pointer">
                Split into multiple categories
              </label>
            </div>
            {splitsOn ? (
              <div className="space-y-2 border-t pt-3" data-testid="txn-edit-splits-panel">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                  Splits — must sum to {amtNum.toFixed(2)}
                </div>
                {splitRows.map((r, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center">
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Amount"
                      value={r.amount}
                      onChange={(e) => setSplitRows(splitRows.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                      className="col-span-3 border rounded px-2 py-1.5 font-mono text-xs"
                    />
                    <select
                      value={r.category_account_id}
                      onChange={(e) => setSplitRows(splitRows.map((x, j) => j === i ? { ...x, category_account_id: e.target.value } : x))}
                      className="col-span-6 border rounded px-2 py-1.5 text-xs bg-white"
                      data-testid={`txn-edit-split-cat-${i}`}
                    >
                      <option value="">— pick a category —</option>
                      {categoryAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.code ? `${a.code} · ` : ""}{a.name}</option>
                      ))}
                    </select>
                    <input
                      placeholder="Note"
                      value={r.description}
                      onChange={(e) => setSplitRows(splitRows.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                      className="col-span-2 border rounded px-2 py-1.5 text-xs"
                    />
                    <button
                      onClick={() => splitRows.length > 1 && setSplitRows(splitRows.filter((_, j) => j !== i))}
                      disabled={splitRows.length <= 1}
                      className="col-span-1 text-red-500 hover:text-red-600 disabled:opacity-30"
                      title="Remove split line"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-1">
                  <button
                    onClick={() => setSplitRows([...splitRows, { amount: "", category_account_id: "", description: "" }])}
                    className="text-xs text-slate-600 border border-dashed border-slate-300 rounded px-2 py-1 hover:bg-slate-50"
                    data-testid="txn-edit-split-add"
                  >
                    + Add split line
                  </button>
                  <div className={`text-xs ${splitsBalance ? "text-emerald-600" : "text-red-600"}`}>
                    Total: <span className="font-mono font-semibold">{splitTotal.toFixed(2)}</span>
                    {" · Target: "}
                    <span className="font-mono">{amtNum.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <label className="text-xs text-slate-600">Category (leave blank for AI)</label>
                <select
                  value={categoryAccountId}
                  onChange={(e) => setCategoryAccountId(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-sm bg-white"
                  data-testid="txn-edit-category"
                >
                  <option value="">— leave blank for AI —</option>
                  {categoryAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code ? `${a.code} · ` : ""}{a.name}</option>
                  ))}
                </select>
              </div>
            )}
            {/* Link to invoice or bill */}
            <div className="space-y-2 border-t pt-3" data-testid="txn-edit-link-section">
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-600 font-medium">Link to invoice or bill</label>
                {linkDocId && (
                  <button
                    type="button"
                    onClick={() => { setLinkDocId(""); setLinkTouched(true); }}
                    className="text-[10px] text-rose-600 hover:underline"
                    data-testid="txn-edit-link-clear"
                  >Unlink</button>
                )}
              </div>
              <div className="flex gap-2">
                <div className="inline-flex rounded-md border bg-slate-50 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => { setLinkKind("invoice"); setLinkDocId(""); setLinkTouched(true); }}
                    className={`px-2.5 py-1 rounded ${linkKind === "invoice" ? "bg-emerald-600 text-white" : "text-slate-600"}`}
                    data-testid="txn-edit-link-kind-invoice"
                  >Invoice</button>
                  <button
                    type="button"
                    onClick={() => { setLinkKind("bill"); setLinkDocId(""); setLinkTouched(true); }}
                    className={`px-2.5 py-1 rounded ${linkKind === "bill" ? "bg-rose-600 text-white" : "text-slate-600"}`}
                    data-testid="txn-edit-link-kind-bill"
                  >Bill</button>
                </div>
                <select
                  value={linkDocId}
                  onChange={(e) => { setLinkDocId(e.target.value); setLinkTouched(true); }}
                  className="flex-1 border rounded px-2 py-1.5 text-sm bg-white"
                  data-testid="txn-edit-link-select"
                >
                  <option value="">— None (not linked) —</option>
                  {linkOptions.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.number} · {x.contact_name || "no contact"} · {Number(x.total || 0).toFixed(2)}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-[10px] text-slate-400">
                Linking marks this transaction as the payment/receipt for the picked {linkKind}. Leave blank to un-link.
              </p>
            </div>
            {/* Attachments */}
            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-600 font-medium inline-flex items-center gap-2">
                  Attachments
                  {attachments.length > 0 && (
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                      {attachments.length} on file
                    </span>
                  )}
                </label>
                <input
                  ref={attachInputRef}
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadAttachment(f);
                    e.target.value = "";
                  }}
                  data-testid="txn-edit-attach-input"
                />
                <button
                  type="button"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={attaching}
                  className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  data-testid="txn-edit-attach-add"
                >
                  {attaching
                    ? <><Loader2 size={11} className="animate-spin" /> Uploading…</>
                    : <><Paperclip size={11} /> Add receipt</>}
                </button>
              </div>
              {attachments.length === 0 ? (
                <p className="text-[10px] text-slate-400">
                  No receipts on file. Drop a photo, scan, or PDF above and it'll live with this transaction forever.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {attachments.map((a) => {
                    const isImg = (a.mime || "").startsWith("image/");
                    const kb = a.size ? (a.size / 1024).toFixed(0) : "?";
                    return (
                      <div
                        key={a.id}
                        className="group relative flex flex-col rounded-md border border-slate-200 overflow-hidden bg-white"
                      >
                        <div className="h-20 flex items-center justify-center bg-slate-50 text-slate-400">
                          {isImg ? <Eye size={18} /> : <FileText size={18} />}
                        </div>
                        <div className="px-1.5 py-1 text-[10px] leading-tight">
                          <div className="truncate font-medium text-slate-800" title={a.filename}>
                            {a.filename}
                          </div>
                          <div className="flex items-center justify-between text-slate-400">
                            <span>{kb} KB</span>
                            {a.source && <span className="uppercase">{a.source}</span>}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeAttachment(a.id)}
                          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-1 rounded bg-white/90 text-rose-600 hover:bg-rose-50 shadow-sm transition"
                          title="Remove"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {error && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
          </div>
        )}
        <div className="px-5 py-3 border-t bg-slate-50 rounded-b-2xl">
          <button
            onClick={save}
            disabled={saving || loading || !txnLoaded}
            className="w-full py-2 rounded-md bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-40 flex items-center justify-center gap-2"
            data-testid="txn-edit-save"
          >
            {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}



// AI-cleanup renderer — the client is CONFIRMING that our nightly auto-
// relabel is correct, so we mirror the ChatReview "Tell me about X's
// deposits" scrollable list: money-direction badge, prompt, sample
// rows with date / amount / description. Answers ("yes" / "no" / free
// text) go through the standard textbox at the bottom.
function AiCleanupTxnList({ item }) {
  const ctx = item?.context || {};
  // Older batches (minted before samples were baked into `context`)
  // hydrate on-mount from a lightweight token-scoped endpoint.
  const [hydrated, setHydrated] = useState(null);
  // Per-row Edit state — the client can pull a stray row out of the
  // bundle before confirming the rest.
  const [editingTxn, setEditingTxn] = useState(null);
  const [pickerHits, setPickerHits] = useState([]);
  const [pickerQ, setPickerQ] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [rowBusy, setRowBusy] = useState(false);
  const [hiddenTxnIds, setHiddenTxnIds] = useState(() => new Set());
  // Multi-select state — powers the soft-slate toolbar that opens
  // above the transaction list when the client ticks ≥1 row and
  // exposes Approve / Bulk update / Make these rules.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkMode, setBulkMode] = useState(null);       // null | "reassign"
  const [bulkPickerHits, setBulkPickerHits] = useState([]);
  const [bulkPickerQ, setBulkPickerQ] = useState("");
  const [bulkConfirming, setBulkConfirming] = useState(null); // {id, name}
  const [bulkBusy, setBulkBusy] = useState(false);
  const [autoAnswered, setAutoAnswered] = useState(false);
  useEffect(() => {
    if ((ctx.samples || []).length > 0) return;
    const url = new URL(window.location.href);
    const parts = url.pathname.split("/").filter(Boolean);
    const token = parts[parts.indexOf("client-review") + 1];
    const applied_id = ctx.applied_id;
    if (!token || !applied_id) return;
    const base = (typeof process !== "undefined" && process.env?.REACT_APP_BACKEND_URL) || "";
    fetch(`${base}/api/client-review/${token}/ai-cleanup-samples/${applied_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setHydrated(d))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const _rawSamples = ctx.samples?.length ? ctx.samples : (hydrated?.samples || []);
  const samples  = _rawSamples.filter(s => !hiddenTxnIds.has(s.id));
  const txnIds  = ctx.txn_ids?.length ? ctx.txn_ids : (hydrated?.txn_ids || []);
  const count = (ctx.count || hydrated?.count || _rawSamples.length || 0) - hiddenTxnIds.size;
  const total = Number(ctx.total_dollars ?? hydrated?.total_dollars ?? 0);
  const beforeStr = ((ctx.before_labels?.length ? ctx.before_labels : hydrated?.before_labels) || []).slice(0, 2).join(", ") || "the old label";
  const contactName = ctx.contact_name || hydrated?.contact_name || "AI-picked contact";
  const appliedIds = ctx.applied_ids || (ctx.applied_id ? [ctx.applied_id] : []);
  const isMoneyIn = total >= 0;
  const fmt = (n) => Math.abs(Number(n || 0)).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  // Fire an answer by populating the textbox and clicking send — this
  // reuses the page's existing submit path (no dup API wiring needed).
  const answer = (text) => {
    const ta = document.querySelector('[data-testid="cr-input-textarea"], textarea, input[type="text"]');
    if (ta) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value")?.set
        || Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const btn = document.querySelector('[data-testid="cr-input-send"], button[type="submit"]');
    if (btn) setTimeout(() => btn.click(), 60);
  };
  const _tokenFromUrl = () => {
    const url = new URL(window.location.href);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[parts.indexOf("client-review") + 1];
  };
  const _apiBase = () => (typeof process !== "undefined" && process.env?.REACT_APP_BACKEND_URL) || "";
  const openEdit = async (row) => {
    setEditingTxn(row);
    setPickerQ("");
    setConfirming(null);
    try {
      const r = await fetch(`${_apiBase()}/api/client-review/${_tokenFromUrl()}/contacts`);
      if (r.ok) { const d = await r.json(); setPickerHits(d.contacts || []); }
    } catch { /* soft-fail */ }
  };
  const searchContacts = async (q) => {
    setPickerQ(q);
    try {
      const r = await fetch(
        `${_apiBase()}/api/client-review/${_tokenFromUrl()}/contacts?q=${encodeURIComponent(q)}`);
      if (r.ok) { const d = await r.json(); setPickerHits(d.contacts || []); }
    } catch { /* soft-fail */ }
  };
  const commitRowReassign = async () => {
    if (!editingTxn || !confirming) return;
    setRowBusy(true);
    try {
      const body = confirming.id
        ? { applied_id: appliedIds[0], txn_id: editingTxn.id, contact_id: confirming.id }
        : { applied_id: appliedIds[0], txn_id: editingTxn.id, contact_name: confirming.name };
      const r = await fetch(
        `${_apiBase()}/api/client-review/${_tokenFromUrl()}/ai-cleanup-row-reassign`,
        { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body) });
      if (r.ok) {
        setHiddenTxnIds(prev => { const n = new Set(prev); n.add(editingTxn.id); return n; });
        setEditingTxn(null);
        setConfirming(null);
      }
    } catch { /* soft-fail */ }
    finally { setRowBusy(false); }
  };
  // ── Bulk-selection helpers ────────────────────────────────────────
  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds(prev => {
      // If every visible row is selected, clear; otherwise select all
      // visible.
      const allSelected = samples.length > 0 && samples.every(s => prev.has(s.id));
      if (allSelected) return new Set();
      const n = new Set(prev);
      for (const s of samples) n.add(s.id);
      return n;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const applyPop = (ids) => {
    setHiddenTxnIds(prev => {
      const n = new Set(prev);
      for (const id of ids) n.add(id);
      return n;
    });
    setSelectedIds(new Set());
  };
  const bulkApprove = async () => {
    if (selectedIds.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    const ids = Array.from(selectedIds);
    try {
      const r = await fetch(
        `${_apiBase()}/api/client-review/${_tokenFromUrl()}/ai-cleanup-bulk-approve`,
        { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applied_id: appliedIds[0], txn_ids: ids }) });
      if (r.ok) applyPop(ids);
    } catch { /* soft-fail */ }
    finally { setBulkBusy(false); }
  };
  const bulkMakeRules = async () => {
    if (selectedIds.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    const ids = Array.from(selectedIds);
    try {
      const r = await fetch(
        `${_apiBase()}/api/client-review/${_tokenFromUrl()}/ai-cleanup-bulk-rule`,
        { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applied_id: appliedIds[0], txn_ids: ids }) });
      if (r.ok) applyPop(ids);
    } catch { /* soft-fail */ }
    finally { setBulkBusy(false); }
  };
  const openBulkReassign = async () => {
    if (selectedIds.size === 0) return;
    setBulkMode("reassign");
    setBulkPickerQ("");
    setBulkConfirming(null);
    try {
      const r = await fetch(`${_apiBase()}/api/client-review/${_tokenFromUrl()}/contacts`);
      if (r.ok) { const d = await r.json(); setBulkPickerHits(d.contacts || []); }
    } catch { /* soft-fail */ }
  };
  const searchBulkContacts = async (q) => {
    setBulkPickerQ(q);
    try {
      const r = await fetch(
        `${_apiBase()}/api/client-review/${_tokenFromUrl()}/contacts?q=${encodeURIComponent(q)}`);
      if (r.ok) { const d = await r.json(); setBulkPickerHits(d.contacts || []); }
    } catch { /* soft-fail */ }
  };
  const commitBulkReassign = async () => {
    if (!bulkConfirming || selectedIds.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selectedIds);
    try {
      const body = bulkConfirming.id
        ? { applied_id: appliedIds[0], txn_ids: ids, contact_id: bulkConfirming.id }
        : { applied_id: appliedIds[0], txn_ids: ids, contact_name: bulkConfirming.name };
      const r = await fetch(
        `${_apiBase()}/api/client-review/${_tokenFromUrl()}/ai-cleanup-bulk-reassign`,
        { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body) });
      if (r.ok) {
        applyPop(ids);
        setBulkMode(null);
        setBulkConfirming(null);
      }
    } catch { /* soft-fail */ }
    finally { setBulkBusy(false); }
  };
  // Auto-close the bundle when every row has been individually
  // acted upon — sends "yes" through the composer so the item
  // finalizes and the flow advances to the next check-in.
  useEffect(() => {
    if (autoAnswered) return;
    // Only fire once we've actually loaded samples AND the client
    // popped rows out (not the empty-initial-state case).
    if ((_rawSamples?.length || 0) === 0) return;
    if (hiddenTxnIds.size === 0) return;
    if (count > 0) return;
    setAutoAnswered(true);
    setTimeout(() => answer("yes"), 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, hiddenTxnIds.size, _rawSamples?.length]);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 max-w-2xl mx-auto"
         data-testid="ai-cleanup-txn-list">
      <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider rounded-full px-2 py-0.5 ${
        isMoneyIn ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                  : "bg-rose-50 text-rose-800 border border-rose-200"
      }`}>
        {isMoneyIn ? "↗ Money in" : "↘ Money out"}
      </span>
      <h2 className="mt-2 text-xl font-heading font-semibold text-slate-900">
        We updated {count} transaction{count === 1 ? "" : "s"} from{" "}
        <span className="text-slate-500">{beforeStr}</span> to{" "}
        <span className="text-emerald-800">{contactName}</span>
      </h2>
      <div className="mt-1 text-sm text-slate-500">
        {count} transaction{count === 1 ? "" : "s"} · ${fmt(total)} total
      </div>
      {samples.length > 0 && (
        <div className="mt-3">
          {selectedIds.size > 0 && (
            <div
              className="mb-2 rounded-xl bg-slate-100 border border-slate-200 px-3 py-2 flex flex-wrap items-center gap-2"
              data-testid="ai-cleanup-bulk-toolbar"
            >
              <span className="text-xs font-semibold text-slate-800 mr-1"
                    data-testid="ai-cleanup-bulk-count">
                {selectedIds.size} selected
              </span>
              <button
                type="button"
                onClick={bulkApprove}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5 disabled:opacity-40"
                data-testid="ai-cleanup-bulk-approve"
              >
                <Check size={12} /> Approve
              </button>
              <button
                type="button"
                onClick={openBulkReassign}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1 rounded-full bg-sky-600 hover:bg-sky-700 text-white text-xs px-3 py-1.5 disabled:opacity-40"
                data-testid="ai-cleanup-bulk-update"
              >
                Bulk update
              </button>
              <button
                type="button"
                onClick={bulkMakeRules}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1 rounded-full bg-violet-600 hover:bg-violet-700 text-white text-xs px-3 py-1.5 disabled:opacity-40"
                data-testid="ai-cleanup-bulk-rules"
              >
                Make these rules
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={bulkBusy}
                className="ml-auto text-[11px] text-slate-500 hover:text-slate-900 underline"
                data-testid="ai-cleanup-bulk-clear"
              >
                Clear
              </button>
            </div>
          )}
          <div className="rounded-lg border border-slate-100 max-h-72 overflow-y-auto"
               data-testid="ai-cleanup-txn-samples">
            <div className="sticky top-0 z-[1] bg-slate-50 border-b border-slate-100 px-3 py-1.5 flex items-center gap-3 text-[11px] uppercase tracking-wider text-slate-500">
              <input
                type="checkbox"
                onChange={toggleSelectAll}
                checked={samples.length > 0 && samples.every(s => selectedIds.has(s.id))}
                className="h-3.5 w-3.5 accent-slate-900"
                data-testid="ai-cleanup-select-all"
                aria-label="Select all visible transactions"
              />
              <span className="flex-1">Transaction</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {samples.map((s) => {
                const checked = selectedIds.has(s.id);
                return (
                <li key={s.id}
                    className={`px-3 py-2 flex items-center gap-3 text-xs font-mono ${
                      checked ? "bg-sky-50/60" : ""
                    }`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSelected(s.id)}
                    className="h-3.5 w-3.5 accent-slate-900 shrink-0"
                    data-testid={`ai-cleanup-row-checkbox-${s.id}`}
                    aria-label={`Select ${s.description}`}
                  />
                  <span className="text-slate-500 shrink-0 w-24">{s.date || ""}</span>
                  <span className={`shrink-0 w-24 text-right ${
                    Number(s.amount || 0) >= 0 ? "text-emerald-800" : "text-rose-800"
                  }`}>${fmt(s.amount)}</span>
                  <span className="text-slate-700 truncate flex-1">{s.description}</span>
                  <button
                    type="button"
                    onClick={() => openEdit(s)}
                    className="shrink-0 text-[11px] text-indigo-700 hover:text-indigo-900 underline font-sans"
                    data-testid={`ai-cleanup-row-edit-${s.id}`}
                  >
                    Edit
                  </button>
                </li>
                );
              })}
            </ul>
            {samples.length < (txnIds?.length || 0) && (
              <div className="text-center text-[11px] text-slate-500 py-1.5 bg-slate-50">
                Showing {samples.length} of {txnIds?.length || count} · scroll to see more
              </div>
            )}
          </div>
        </div>
      )}
      <div className="mt-4 text-sm text-slate-700">
        Is <b>{contactName}</b> the right contact for these?
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => answer("yes")}
          className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-1.5"
          data-testid="ai-cleanup-yes"
        >Yes, that's right</button>
        <button
          type="button"
          onClick={() => answer("no")}
          className="rounded-full border border-rose-300 bg-white text-rose-800 text-xs px-4 py-1.5 hover:bg-rose-50"
          data-testid="ai-cleanup-no"
        >No, that's wrong</button>
      </div>
      {editingTxn && !confirming && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
             onClick={() => setEditingTxn(null)}
             data-testid="ai-cleanup-row-picker">
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl p-4 max-h-[80vh] flex flex-col"
               onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold text-slate-900">
              Reassign this one transaction
            </div>
            <div className="mt-1 text-[11px] text-slate-500 font-mono truncate">
              {editingTxn.date} · ${fmt(editingTxn.amount)} · {editingTxn.description}
            </div>
            <input
              autoFocus
              className="mt-3 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              placeholder="Search contacts or type a new name…"
              value={pickerQ}
              onChange={e => searchContacts(e.target.value)}
              data-testid="ai-cleanup-row-picker-search"
            />
            <div className="mt-2 flex-1 overflow-y-auto rounded-lg border border-slate-100">
              {pickerQ && !pickerHits.some(c => c.name.toLowerCase() === pickerQ.toLowerCase()) && (
                <button
                  type="button"
                  onClick={() => setConfirming({ id: null, name: pickerQ.trim() })}
                  className="w-full text-left px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 border-b border-slate-100"
                  data-testid="ai-cleanup-row-picker-add-new"
                >
                  + Add new contact "<b>{pickerQ.trim()}</b>"
                </button>
              )}
              {pickerHits.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setConfirming({ id: c.id, name: c.name })}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-0"
                  data-testid={`ai-cleanup-row-picker-hit-${c.id}`}
                >
                  {c.name}
                </button>
              ))}
              {!pickerHits.length && !pickerQ && (
                <div className="p-3 text-xs text-slate-500">Loading contacts…</div>
              )}
            </div>
            <div className="mt-3 text-right">
              <button
                type="button"
                onClick={() => setEditingTxn(null)}
                className="text-xs text-slate-500 hover:text-slate-700"
              >Cancel</button>
            </div>
          </div>
        </div>
      )}
      {editingTxn && confirming && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
             data-testid="ai-cleanup-row-confirm">
          <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl p-5">
            <div className="text-sm font-semibold text-slate-900">
              Apply <span className="text-emerald-800">{confirming.name}</span> to this 1 transaction?
            </div>
            <div className="mt-2 rounded-lg bg-slate-50 border border-slate-100 p-2 text-[11px] font-mono text-slate-700">
              {editingTxn.date} · ${fmt(editingTxn.amount)}<br />
              <span className="text-slate-500 truncate block">{editingTxn.description}</span>
            </div>
            <div className="mt-3 text-[11px] text-slate-500">
              This row will be pulled out of the bundle — you can then confirm the rest with <b>Yes, that's right</b>.
            </div>
            <div className="mt-4 flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={rowBusy}
                className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-40"
                data-testid="ai-cleanup-row-confirm-cancel"
              >Cancel</button>
              <button
                type="button"
                onClick={commitRowReassign}
                disabled={rowBusy}
                className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-1.5 disabled:opacity-40"
                data-testid="ai-cleanup-row-confirm-apply"
              >
                {rowBusy ? "Applying…" : `Yes, apply to ${confirming.name}`}
              </button>
            </div>
          </div>
        </div>
      )}
      {bulkMode === "reassign" && !bulkConfirming && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
             onClick={() => setBulkMode(null)}
             data-testid="ai-cleanup-bulk-picker">
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl p-4 max-h-[80vh] flex flex-col"
               onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold text-slate-900">
              Reassign {selectedIds.size} transaction{selectedIds.size === 1 ? "" : "s"}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              Pick the correct contact — these rows will be pulled out of the bundle.
            </div>
            <input
              autoFocus
              className="mt-3 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              placeholder="Search contacts or type a new name…"
              value={bulkPickerQ}
              onChange={e => searchBulkContacts(e.target.value)}
              data-testid="ai-cleanup-bulk-picker-search"
            />
            <div className="mt-2 flex-1 overflow-y-auto rounded-lg border border-slate-100">
              {bulkPickerQ && !bulkPickerHits.some(c => c.name.toLowerCase() === bulkPickerQ.toLowerCase()) && (
                <button
                  type="button"
                  onClick={() => setBulkConfirming({ id: null, name: bulkPickerQ.trim() })}
                  className="w-full text-left px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 border-b border-slate-100"
                  data-testid="ai-cleanup-bulk-picker-add-new"
                >
                  + Add new contact "<b>{bulkPickerQ.trim()}</b>"
                </button>
              )}
              {bulkPickerHits.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setBulkConfirming({ id: c.id, name: c.name })}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-0"
                  data-testid={`ai-cleanup-bulk-picker-hit-${c.id}`}
                >
                  {c.name}
                </button>
              ))}
              {!bulkPickerHits.length && !bulkPickerQ && (
                <div className="p-3 text-xs text-slate-500">Loading contacts…</div>
              )}
            </div>
            <div className="mt-3 text-right">
              <button
                type="button"
                onClick={() => setBulkMode(null)}
                className="text-xs text-slate-500 hover:text-slate-700"
              >Cancel</button>
            </div>
          </div>
        </div>
      )}
      {bulkMode === "reassign" && bulkConfirming && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
             data-testid="ai-cleanup-bulk-confirm">
          <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl p-5">
            <div className="text-sm font-semibold text-slate-900">
              Apply <span className="text-emerald-800">{bulkConfirming.name}</span> to {selectedIds.size} transaction{selectedIds.size === 1 ? "" : "s"}?
            </div>
            <div className="mt-3 text-[11px] text-slate-500">
              These rows will be pulled out of the bundle and future imports matching them will auto-route to <b>{bulkConfirming.name}</b>.
            </div>
            <div className="mt-4 flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => setBulkConfirming(null)}
                disabled={bulkBusy}
                className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-40"
                data-testid="ai-cleanup-bulk-confirm-cancel"
              >Cancel</button>
              <button
                type="button"
                onClick={commitBulkReassign}
                disabled={bulkBusy}
                className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-1.5 disabled:opacity-40"
                data-testid="ai-cleanup-bulk-confirm-apply"
              >
                {bulkBusy ? "Applying…" : `Apply to ${selectedIds.size} row${selectedIds.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


const REMINDER_COPY = {
  schedule:  { title: "Pick a time",
               sub: "We'll email you a reminder so the questions are one tap away.",
               cta: "Set reminder" },
  follow_up: { title: "I'll finish later",
               sub: "We'll send one reminder at this time so you can pick up where you left off.",
               cta: "Remind me" },
  item:      { title: "Don't have it now?",
               sub: "We'll skip this question for now and remind you about it at this time.",
               cta: "Remind me about this one" },
};

function _presetDates() {
  const at = (d, h) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; };
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const in3 = new Date(); in3.setDate(in3.getDate() + 3);
  const nextMon = new Date(); nextMon.setDate(nextMon.getDate() + ((8 - nextMon.getDay()) % 7 || 7));
  return [
    { label: "Tomorrow 9 AM", d: at(tomorrow, 9) },
    { label: "In 3 days",     d: at(in3, 9) },
    { label: "Next Monday",   d: at(nextMon, 9) },
  ];
}

function ScheduleModal({ token, expiresAt, onClose, onScheduled, mode = "schedule", itemId }) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const copy = REMINDER_COPY[mode] || REMINDER_COPY.schedule;
  const presets = useMemo(_presetDates, []);
  const pickPreset = (d) => {
    const pad = (n) => String(n).padStart(2, "0");
    setDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    setTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  };

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
      if (mode === "follow_up") {
        await axios.post(`${API}/${token}/follow-up`, { follow_up_at: iso });
      } else if (mode === "item") {
        await axios.post(`${API}/${token}/items/${itemId}/snooze`, { remind_at: iso });
      } else {
        await axios.post(`${API}/${token}/schedule`, { scheduled_for: iso });
      }
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
            <h2 className="font-heading text-lg text-slate-900">{copy.title}</h2>
            <p className="text-xs text-slate-500 mt-1">{copy.sub}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1"
                  data-testid="schedule-close">
            <X size={18} />
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5" data-testid="schedule-presets">
          {presets.map(p => (
            <button key={p.label} type="button" onClick={() => pickPreset(p.d)}
                    data-testid={`schedule-preset-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
                    className="text-xs px-2.5 py-1 rounded-full border border-slate-300 text-slate-700 hover:bg-slate-50">
              {p.label}
            </button>
          ))}
        </div>
        <div className="mt-4 space-y-3">
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
            {copy.cta}
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

function LiabilityBreakdown({ breakdown, token, onChange, description, itemId, attachmentId }) {
  // Editable bucket list for mortgage / credit-card / auto-loan
  // statements. Each bucket has {label, amount, account_name}. The
  // client can tweak any amount inline AND swap the target account
  // on any row via the "Change" link (Principal → liability sub-
  // account picker; every other row → generic category picker).
  // `onChange` pushes the edited breakdown up so "Use this split"
  // applies it.
  const [buckets, setBuckets] = React.useState(() =>
    (breakdown.buckets || []).map((b, i) => ({ ...b, _idx: i })),
  );
  // pickerFor: null | { idx, kind: "principal" | "category" }
  const [pickerFor, setPickerFor] = React.useState(null);
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

  // "Principal" bucket detection — loose match (handles "Principal",
  // "Principal Payment", "Loan Principal", "Curtailment", etc.).
  const isPrincipal = (b) => {
    const k = (b?.label || "").toLowerCase();
    return k.includes("principal") || k.includes("curtailment")
      || k.includes("payoff adjustment");
  };
  const openPicker = (b) => {
    setPickerFor({ idx: b._idx, kind: isPrincipal(b) ? "principal" : "category" });
  };
  const activeBucket = pickerFor
    ? buckets.find((b) => b._idx === pickerFor.idx)
    : null;

  const typeStyle = {
    mortgage:     { label: "Mortgage statement",     accent: "text-rose-700",   bg: "bg-rose-50/60",   border: "border-rose-200"  },
    credit_card:  { label: "Credit card statement",  accent: "text-blue-700",   bg: "bg-blue-50/60",   border: "border-blue-200"  },
    auto_loan:    { label: "Auto loan statement",    accent: "text-indigo-700", bg: "bg-indigo-50/60", border: "border-indigo-200" },
    generic_loan: { label: "Loan statement",         accent: "text-slate-700",  bg: "bg-slate-50",     border: "border-slate-200" },
  }[breakdown.statement_type] || {
    label: "Loan statement", accent: "text-slate-700",
    bg: "bg-slate-50", border: "border-slate-200",
  };

  const grandTotal = buckets.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const pct = (n) => grandTotal > 0 ? Math.round((Math.abs(Number(n) || 0) / Math.abs(grandTotal)) * 100) : 0;
  const rowStyle = (b, i) => {
    const k = (b.label || "").toLowerCase();
    if (isPrincipal(b))                          return { Icon: Landmark,    bar: "bg-blue-500",    tint: "bg-blue-50 text-blue-600" };
    if (k.includes("interest"))                  return { Icon: Percent,     bar: "bg-violet-500",  tint: "bg-violet-50 text-violet-600" };
    if (k.includes("escrow"))                    return { Icon: Home,        bar: "bg-emerald-500", tint: "bg-emerald-50 text-emerald-600" };
    if (k.includes("pmi") || k.includes("insur")) return { Icon: ShieldAlert, bar: "bg-orange-500",  tint: "bg-orange-50 text-orange-600" };
    if (k.includes("tax"))                       return { Icon: ReceiptText, bar: "bg-amber-400",   tint: "bg-amber-50 text-amber-600" };
    if (k.includes("hoa") || k.includes("dues")) return { Icon: Users,       bar: "bg-pink-500",    tint: "bg-pink-50 text-pink-600" };
    if (k.includes("fee") || k.includes("late")) return { Icon: Clock,       bar: "bg-slate-400",   tint: "bg-slate-100 text-slate-600" };
    const fallback = ["bg-sky-500", "bg-teal-500", "bg-fuchsia-500", "bg-lime-500"];
    return { Icon: FileText, bar: fallback[i % fallback.length], tint: "bg-slate-100 text-slate-600" };
  };
  const statementUrl = token && itemId && attachmentId
    ? `${API}/${token}/items/${itemId}/attachments/${attachmentId}/file` : null;

  return (
    <div className="mt-1 space-y-3" data-testid="liability-breakdown">
      <div className={`rounded-2xl border ${typeStyle.border} ${typeStyle.bg} p-4 sm:p-5`}>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-white border border-rose-100 text-rose-500 grid place-items-center shrink-0 shadow-sm">
            <FileText size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold text-slate-900 leading-tight">
              {typeStyle.label}{breakdown.lender_name ? <span className="text-slate-400 font-normal"> · </span> : ""}{breakdown.lender_name}
            </div>
            {description && <div className="text-[12px] text-slate-500 mt-1 leading-snug">{description}</div>}
          </div>
          {statementUrl && (
            <a href={statementUrl} target="_blank" rel="noreferrer"
               className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-semibold text-indigo-700 bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm hover:bg-indigo-50"
               data-testid="liability-view-statement">
              <FileText size={13} /> View statement
            </a>
          )}
        </div>

        <div className="mt-4 divide-y divide-white/70">
          {buckets.map((b, i) => {
            const { Icon, bar, tint } = rowStyle(b, i);
            const p = pct(b.amount);
            return (
              <div key={b._idx} className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:grid-cols-[auto_minmax(0,1fr)_3rem_6.5rem_minmax(5rem,1fr)] items-center gap-x-3 py-2"
                   data-testid={`liability-bucket-${b._idx}`}>
                <div className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${tint}`}><Icon size={15} /></div>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-slate-800 truncate">{b.label}</div>
                  <div className="text-[11px] text-slate-500 truncate flex items-center gap-1.5">
                    {b.account_name
                      ? <span className="truncate">{b.account_name}</span>
                      : <span className="truncate italic text-slate-400">{isPrincipal(b) ? "Pick a liability account" : "Pick an account"}</span>}
                    {token && (
                      <button type="button" onClick={() => openPicker(b)}
                              className="text-[10px] font-semibold text-indigo-700 hover:text-indigo-900 underline underline-offset-2 shrink-0"
                              data-testid={`liability-bucket-change-${b._idx}`}>Change</button>
                    )}
                  </div>
                </div>
                <div className="hidden sm:block text-[12px] font-semibold text-slate-700 font-mono-num tabular-nums text-right">{p}%</div>
                <input
                  type="number"
                  step="0.01"
                  value={b.amount ?? 0}
                  onChange={(e) => editBucket(b._idx, { amount: parseFloat(e.target.value) || 0 })}
                  className="w-24 sm:w-full text-right font-mono-num tabular-nums border border-slate-200 rounded-md px-2 py-1 text-[12px] bg-white shrink-0 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  data-testid={`liability-bucket-amount-${b._idx}`}
                />
                <div className="hidden sm:block h-2.5 rounded-full bg-slate-200/80 overflow-hidden">
                  <div className={`h-full rounded-full ${bar} transition-[width] duration-500`} style={{ width: `${Math.max(p > 0 ? 3 : 0, p)}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-2 pt-3 border-t border-slate-300/60 grid grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:grid-cols-[auto_minmax(0,1fr)_3rem_6.5rem_minmax(5rem,1fr)] items-center gap-x-3">
          <div className="w-8" />
          <div className="text-[14px] font-semibold text-slate-900">Total</div>
          <div className="hidden sm:block text-[12px] font-semibold text-slate-800 font-mono-num tabular-nums text-right">100%</div>
          <div className="text-right font-mono-num tabular-nums text-[13px] font-semibold text-slate-900 bg-white border border-slate-200 rounded-md px-2 py-1 w-24 sm:w-full" data-testid="liability-grand-total">{money(grandTotal)}</div>
          <div className="hidden sm:block h-2.5 rounded-full bg-slate-800" />
        </div>
      </div>

      {/* Principal → liability sub-account picker (has inline
          "New liability account" form with parent auto-resolution). */}
      {pickerFor?.kind === "principal" && activeBucket && (
        <LoanAccountPickerModal
          token={token}
          amount={Number(activeBucket.amount || 0)}
          onClose={() => setPickerFor(null)}
          onPicked={(acct) => {
            setPickerFor(null);
            editBucket(activeBucket._idx, {
              // Stamp both keys so downstream code that reads either
              // one (backend handler accepts both) sees the override.
              account_id:            acct.id,
              principal_account_id:  acct.id,
              account_name:          acct.name,
            });
          }}
        />
      )}
      {/* All other buckets → generic category-account picker. */}
      {pickerFor?.kind === "category" && activeBucket && (
        <CategoryAccountPickerModal
          token={token}
          bucketLabel={activeBucket.label}
          amount={Number(activeBucket.amount || 0)}
          onClose={() => setPickerFor(null)}
          onPicked={(acct) => {
            setPickerFor(null);
            editBucket(activeBucket._idx, {
              account_id:   acct.id,
              account_name: acct.name,
            });
          }}
        />
      )}
    </div>
  );
}


// Generic category-account picker used by non-Principal rows of the
// LiabilityBreakdown. Shows the company's expense + asset accounts
// (the vast majority of legitimate targets for Interest / Escrow /
// PMI / Property Tax / HOA / Fees), plus an inline "New Account"
// form that accepts asset OR expense type. If a client needs to
// route to a liability sub-account, they'd use the Principal row's
// picker instead — this picker deliberately narrows the choices to
// avoid confusion.
function CategoryAccountPickerModal({ token, bucketLabel, amount, onClose, onPicked }) {
  const [q, setQ] = React.useState("");
  const [accts, setAccts] = React.useState([]);
  const [busy, setBusy] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [newCode, setNewCode] = React.useState("");
  const [newName, setNewName] = React.useState("");
  const [newType, setNewType] = React.useState("expense");
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState(null);

  React.useEffect(() => {
    axios.get(`${API}/${token}/accounts`)
      .then((r) => {
        const list = r.data?.accounts || r.data || [];
        // Show expense + asset by default — the two families that
        // cover the non-Principal buckets. Also include income and
        // cogs since some edge cases (e.g. loan-origination rebate
        // as income) may want them.
        const allowed = new Set(["expense", "asset", "cogs", "cost_of_goods_sold", "income", "revenue"]);
        setAccts(list.filter((a) => allowed.has((a.type || "").toLowerCase())));
      })
      .finally(() => setBusy(false));
  }, [token]);

  const submitNew = async () => {
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true); setErr(null);
    try {
      const r = await axios.post(`${API}/${token}/accounts`, {
        type: newType,
        code: newCode.trim() || null,
        name,
      });
      onPicked(r.data);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
      setSaving(false);
    }
  };

  const trimmed = q.trim().toLowerCase();
  const filtered = trimmed
    ? accts.filter((a) => `${a.code || ""} ${a.name || ""}`.toLowerCase().includes(trimmed))
    : accts;

  // Group by type header for scannability — the CoA can have 40+
  // rows and users would otherwise scroll blind.
  const grouped = React.useMemo(() => {
    const buckets = { expense: [], asset: [], cogs: [], income: [] };
    for (const a of filtered) {
      const t = (a.type || "").toLowerCase();
      if (t === "expense") buckets.expense.push(a);
      else if (t === "asset") buckets.asset.push(a);
      else if (t === "cogs" || t === "cost_of_goods_sold") buckets.cogs.push(a);
      else if (t === "income" || t === "revenue") buckets.income.push(a);
    }
    for (const k of Object.keys(buckets)) {
      buckets[k].sort((x, y) => String(x.code || "").localeCompare(String(y.code || "")));
    }
    return buckets;
  }, [filtered]);

  const sectionHeader = (label) => (
    <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-50 border-b border-slate-100">
      {label}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm" onClick={onClose} data-testid="category-account-picker">
      <div className="w-full max-w-md m-2 rounded-2xl bg-white shadow-2xl overflow-hidden max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              {creating ? "New Account" : (bucketLabel || "Change account")}
            </div>
            <div className="text-sm font-semibold text-slate-800">
              {creating
                ? "Create an account"
                : `Which account should ${amount ? `$${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "this line"} land in?`}
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600" data-testid="cat-picker-close"><X size={18} /></button>
        </div>
        <div className="p-4 overflow-y-auto">
          {!creating && (
            <>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search account name or code…"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-indigo-400 outline-none"
                data-testid="cat-picker-search"
              />
              <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-100">
                {busy && <div className="p-3 text-xs text-slate-400">Loading…</div>}
                {!busy && filtered.length === 0 && (
                  <div className="p-3 text-xs text-slate-400">No accounts match. Create one below.</div>
                )}
                {!busy && grouped.expense.length > 0 && (<>
                  {sectionHeader("Expense")}
                  {grouped.expense.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onPicked(a)}
                      className="w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-slate-50 last:border-0"
                      data-testid={`cat-acct-row-${a.id}`}
                    >
                      <div className="text-sm text-slate-800">{a.name}</div>
                      <div className="text-[11px] text-slate-400">{a.code || ""}</div>
                    </button>
                  ))}
                </>)}
                {!busy && grouped.asset.length > 0 && (<>
                  {sectionHeader("Asset")}
                  {grouped.asset.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onPicked(a)}
                      className="w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-slate-50 last:border-0"
                      data-testid={`cat-acct-row-${a.id}`}
                    >
                      <div className="text-sm text-slate-800">{a.name}</div>
                      <div className="text-[11px] text-slate-400">{a.code || ""}</div>
                    </button>
                  ))}
                </>)}
                {!busy && grouped.cogs.length > 0 && (<>
                  {sectionHeader("Cost of Goods Sold")}
                  {grouped.cogs.map((a) => (
                    <button key={a.id} type="button" onClick={() => onPicked(a)}
                      className="w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-slate-50 last:border-0"
                      data-testid={`cat-acct-row-${a.id}`}>
                      <div className="text-sm text-slate-800">{a.name}</div>
                      <div className="text-[11px] text-slate-400">{a.code || ""}</div>
                    </button>
                  ))}
                </>)}
                {!busy && grouped.income.length > 0 && (<>
                  {sectionHeader("Income")}
                  {grouped.income.map((a) => (
                    <button key={a.id} type="button" onClick={() => onPicked(a)}
                      className="w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-slate-50 last:border-0"
                      data-testid={`cat-acct-row-${a.id}`}>
                      <div className="text-sm text-slate-800">{a.name}</div>
                      <div className="text-[11px] text-slate-400">{a.code || ""}</div>
                    </button>
                  ))}
                </>)}
              </div>
              <button
                type="button"
                onClick={() => {
                  // Prefill the new-account name with the bucket
                  // label — client can tweak it. Saves a couple
                  // seconds of typing for the common case.
                  if (!newName && bucketLabel) setNewName(bucketLabel);
                  setCreating(true); setErr(null);
                }}
                className="mt-3 w-full px-3 py-2 rounded-lg border-2 border-dashed border-indigo-300 bg-indigo-50/40 hover:bg-indigo-50 text-sm font-medium text-indigo-800 transition"
                data-testid="cat-picker-create-new"
              >
                + Create new account
              </button>
            </>
          )}
          {creating && (
            <div className="space-y-3">
              <input
                placeholder="Code (e.g. 6250)"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                maxLength={10}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono-num focus:border-indigo-400 outline-none"
                data-testid="cat-picker-new-code"
              />
              <input
                autoFocus
                placeholder="Account name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={100}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:border-indigo-400 outline-none"
                data-testid="cat-picker-new-name"
              />
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Type <span className="text-rose-500">*</span>
                </label>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-white focus:border-indigo-400 outline-none"
                  data-testid="cat-picker-new-type"
                >
                  <option value="expense">Expense</option>
                  <option value="asset">Asset</option>
                  <option value="cogs">Cost of Goods Sold</option>
                  <option value="income">Income</option>
                </select>
              </div>
              {err && <div className="text-xs text-rose-600">{err}</div>}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={submitNew}
                  disabled={saving || !newName.trim()}
                  className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="cat-picker-save-new"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => { setCreating(false); setNewName(""); setNewCode(""); setErr(null); }}
                  className="flex-1 py-2 rounded-md border text-sm text-slate-700 hover:bg-slate-50"
                  data-testid="cat-picker-cancel-new"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function W9EmailDraft({ draft, token, itemId, sentTo: initialSentTo, onSent }) {
  const [subject, setSubject] = useState(draft?.subject || "");
  const [body,    setBody]    = useState(draft?.body    || "");
  const [sending, setSending] = useState(false);
  const [copied,  setCopied]  = useState(false);
  const [needsEmail, setNeedsEmail] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [emailErr,   setEmailErr]   = useState("");
  const [sentTo, setSentTo] = useState(initialSentTo || "");

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

function ChatBubble({ message, onQuickReply, onBreakdownChange, onRemoveAttachment, w9Token, w9ItemId, onW9Sent, attachments }) {
  const isUser = message.role === "user";
  const hasBreakdown = !isUser && message._splitBreakdown;
  const hasLiability = !isUser && message._liabilityBreakdown;
  const hasCategorization = !isUser && message._categorizationBreakdown;
  const wide = hasBreakdown || hasLiability || hasCategorization;
  const isAttachment = isUser && message._attachmentId;
  const isAnswered = !isUser && message._readOnlyAnswered;
  const liabilityReplyStyle = (qr) => qr === "Use this split"
    ? "inline-flex items-center gap-1.5 text-[13px] font-semibold px-5 py-2.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm"
    : "inline-flex items-center gap-1.5 text-[13px] font-medium px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50";
  if (hasLiability) {
    const latestAtt = (attachments || []).slice(-1)[0];
    return (
      <div className="flex justify-start group">
        <div className="w-full">
          <LiabilityBreakdown
            breakdown={message._liabilityBreakdown}
            token={w9Token}
            itemId={w9ItemId}
            attachmentId={latestAtt?.id}
            description={message.content}
            onChange={(next) => onBreakdownChange?.(next)}
          />
          {(message.quickReplies || []).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {(message.quickReplies || []).slice(0, 8).map((qr, i) => (
                <button key={i} onClick={() => onQuickReply?.(qr)} className={liabilityReplyStyle(qr)} data-testid={`review-quick-reply-${i}`}>
                  {qr === "Use this split" ? <CheckCircle2 size={15} /> : qr === "Something's off" ? <AlertTriangle size={15} /> : null}
                  {qr}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} group`}>
      <div
        className={`${wide ? "max-w-[92%]" : "max-w-[85%]"} rounded-2xl px-4 py-2 text-sm ${
          isUser ? "bg-slate-900 text-white rounded-br-sm"
                 : isAnswered
                   ? "bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-bl-sm"
                   : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm"
        } ${isAttachment ? "pr-8 relative" : ""}`}
        style={{ whiteSpace: "pre-wrap" }}
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
            sentTo={message._w9EmailSentTo}
            token={w9Token}
            itemId={w9ItemId}
            onSent={(to) => onW9Sent?.(to)}
          />
        )}
        {!isUser && (message.quickReplies || []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(message.quickReplies || []).slice(0, 8).map((qr, i) => (
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

// -----------------------------------------------------------------------
// Q2 — Descriptor Bindings review UI. See PRD entry (Sep 2026).
//
// One row per unique bank-feed descriptor. Client picks the correct
// contact (from a text input that filters existing contacts + falls
// back to auto-create on Enter). "Confirm all" fires a single
// applyAnswer call with the aggregated bindings payload. Rows the
// client explicitly clears get marked `skip: true` server-side so no
// alias is created for those ambiguous descriptors.
// -----------------------------------------------------------------------

function DescriptorBindingsList({ bindings, itemId }) {
  // Local state — one row per descriptor. Each row tracks the picked
  // contact (id + name) OR a create-new-name string. Also `skip` for
  // ambiguous descriptors the client doesn't want a rule for.
  const initial = bindings.map((b) => ({
    descriptor:      b.descriptor,
    descriptor_key:  b.descriptor_key,
    contact_id:      b.suggested_contact_id || "",
    contact_name:    b.suggested_contact_name || "",
    create_name:     b.suggested_contact_id ? "" : (b.suggested_contact_name || ""),
    confidence:      b.confidence,
    seen_count:      b.seen_count,
    total_amount:    b.total_amount,
    skip:            false,
    // If AI wasn't confident (no suggested_contact_id), start unlocked
    // so the client can pick without having to clear first.
    edited:          !b.suggested_contact_id,
  }));
  const [rows, setRows] = useState(initial);
  // Contact directory for the dropdown — fetched once via the batch
  // token so the client sees real contacts from their own company.
  const [contactOptions, setContactOptions] = useState([]);
  const [openIdx, setOpenIdx] = useState(-1);  // which row's dropdown is open
  const [query,   setQuery]   = useState("");
  const { token: reviewToken } = useParams();
  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/${reviewToken}/contacts`);
        setContactOptions(r.data?.contacts || []);
      } catch { /* silent */ }
    })();
  }, [reviewToken]);

  const setRow = (i, patch) => {
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  };
  const money = (n) => `$${Math.abs(Number(n || 0)).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide font-semibold text-slate-600">
        Contact confirmations · {rows.length} descriptors
      </div>
      <ul className="divide-y divide-slate-100">
        {rows.map((r, i) => {
          const currentDisplay = r.skip
            ? "— ambiguous, ask each time —"
            : (r.contact_id ? r.contact_name : r.create_name);
          const q = (openIdx === i ? query : "").toLowerCase();
          const filtered = contactOptions
            .filter((c) => !q || (c.name || "").toLowerCase().includes(q))
            .slice(0, 40);
          const canCreate = openIdx === i
            && query.trim().length > 1
            && !contactOptions.some((c) => (c.name || "").trim().toLowerCase()
                                         === query.trim().toLowerCase());
          return (
            <li key={r.descriptor_key + i}
                className={`px-4 py-3 ${r.skip ? "bg-slate-50 opacity-70" : ""}`}
                data-testid={`descriptor-row-${i}`}>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-3 items-start">
                {/* Descriptor + activity */}
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">
                    Bank descriptor
                  </div>
                  <div className="mt-0.5 text-sm text-slate-900 font-mono-num truncate"
                       title={r.descriptor}>
                    {r.descriptor}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                    <span>{r.seen_count}× this cycle</span>
                    <span>{money(r.total_amount)} total</span>
                    {r.confidence != null && (
                      <span className={
                        r.confidence >= 0.85 ? "text-emerald-700"
                          : r.confidence >= 0.70 ? "text-amber-700"
                            : "text-rose-700"
                      }>
                        AI {Math.round(r.confidence * 100)}%
                      </span>
                    )}
                  </div>
                </div>

                {/* Contact picker — searchable dropdown with "Add new" */}
                <div className="min-w-0 relative">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">
                    Contact
                  </div>
                  <input
                    type="text"
                    value={openIdx === i ? query : currentDisplay}
                    disabled={r.skip}
                    placeholder="Search contacts or type a new name…"
                    onFocus={() => {
                      setOpenIdx(i);
                      setQuery(currentDisplay || "");
                    }}
                    onBlur={() => {
                      // Close on blur, but wait a tick so click on
                      // menu items registers first.
                      setTimeout(() => setOpenIdx((prev) => prev === i ? -1 : prev), 150);
                    }}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      // Any edit means the AI suggestion is stale.
                      setRow(i, {
                        contact_id:   "",
                        contact_name: "",
                        create_name:  e.target.value,
                        edited:       true,
                        skip:         false,
                      });
                    }}
                    className={`mt-0.5 w-full text-sm border rounded px-2 py-1.5 ${
                      r.contact_id && !r.edited
                        ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                        : "bg-white border-slate-300"
                    } ${r.skip ? "italic text-slate-500" : ""}`}
                    data-testid={`descriptor-contact-input-${i}`}
                  />
                  {r.contact_id && !r.edited && !r.skip && (
                    <div className="text-[10px] text-emerald-700 mt-0.5">
                      ✓ AI matched — click to change
                    </div>
                  )}
                  {!r.contact_id && !r.skip && r.create_name && (
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      Will create a new contact
                    </div>
                  )}

                  {/* Dropdown menu */}
                  {openIdx === i && !r.skip && (
                    <div className="absolute z-20 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg text-sm"
                         data-testid={`descriptor-contact-menu-${i}`}>
                      {filtered.length === 0 && !canCreate && (
                        <div className="px-3 py-2 text-slate-500 text-xs italic">
                          No matching contacts.
                        </div>
                      )}
                      {filtered.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setRow(i, {
                              contact_id:   c.id,
                              contact_name: c.name,
                              create_name:  "",
                              edited:       true,
                              skip:         false,
                            });
                            setOpenIdx(-1);
                          }}
                          className="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center justify-between"
                          data-testid={`descriptor-contact-option-${i}-${c.id}`}
                        >
                          <span className="text-slate-900 truncate">{c.name}</span>
                          {c.email && <span className="text-[10px] text-slate-400 ml-2 truncate">{c.email}</span>}
                        </button>
                      ))}
                      {canCreate && (
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setRow(i, {
                              contact_id:   "",
                              contact_name: "",
                              create_name:  query.trim(),
                              edited:       true,
                              skip:         false,
                            });
                            setOpenIdx(-1);
                          }}
                          className="w-full text-left px-3 py-2 border-t border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-800"
                          data-testid={`descriptor-contact-create-${i}`}
                        >
                          <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mr-2">Add new</span>
                          <span className="font-medium">"{query.trim()}"</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Row actions */}
                <div className="flex flex-col gap-1 items-end">
                  <button
                    type="button"
                    onClick={() => setRow(i, {
                      skip: !r.skip,
                      contact_id: r.skip ? r.contact_id : "",
                      create_name: r.skip ? r.create_name : "",
                    })}
                    className={`text-[10px] px-2 py-1 rounded-full border ${
                      r.skip
                        ? "border-slate-400 text-slate-700 bg-white"
                        : "border-slate-200 text-slate-500 hover:bg-slate-50"
                    }`}
                    data-testid={`descriptor-ambiguous-${i}`}
                    title="This descriptor represents different vendors each time — don't create a permanent rule"
                  >
                    {r.skip ? "Un-skip" : "Ambiguous"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3">
        <div className="text-[11px] text-slate-500">
          Confirmed contacts become permanent aliases — matching past &
          future transactions will auto-link.
        </div>
        <button
          type="button"
          data-testid="descriptor-confirm-all"
          onClick={() => {
            const bindingsOut = rows.map((r) => ({
              descriptor:     r.descriptor,
              descriptor_key: r.descriptor_key,
              contact_id:     r.contact_id || null,
              create_name:    !r.contact_id && !r.skip ? r.create_name : null,
              skip:           r.skip,
            }));
            window.dispatchEvent(new CustomEvent("client-review:confirm-descriptor-bindings", {
              detail: { itemId, bindings: bindingsOut },
            }));
          }}
          className="px-4 py-1.5 rounded-full bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 shadow-[0_6px_14px_-6px_rgba(79,70,229,0.55)]"
        >
          Confirm all
        </button>
      </div>
    </div>
  );
}


// Review-Chat-style bundle list for a grouped batch item — used by
// Uncategorized (Phase 2) and future Vendor Confirmation grouped
// items. Renders header (Money-In/Out chip + question), contact
// summary, filter box, per-row action cluster (📎 receipt · 🔗 bill ·
// ✏️ edit), and a "Show all N" footer.
function GroupedTxnListCard({ item, token, onRowAction, onEdited, onLinked }) {
  const ctx = item.context || {};
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [rowEdit, setRowEdit] = useState(null);   // txn_id of row being edited
  const [rowLink, setRowLink] = useState(null);   // txn_id of row being linked
  const rowFileRef = useRef(null);
  const [rowUpload, setRowUpload] = useState(null);
  const samples = ctx.samples || [];
  const filtered = filter.trim()
    ? samples.filter((s) => (s.description || "").toLowerCase().includes(filter.toLowerCase()))
    : samples;
  const visible = showAll ? filtered : filtered.slice(0, 6);
  const money = (n) => (n == null ? "" : `$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`);
  const fmtDate = (d) => {
    if (!d) return "";
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return d;
  };
  const chipColor = ctx.direction === "in"
    ? "text-emerald-700 bg-emerald-50 border-emerald-100"
    : "text-rose-700 bg-rose-50 border-rose-100";
  const chipLabel = ctx.direction === "in" ? "↗ MONEY IN" : "↙ MONEY OUT";

  const handleUpload = async (file, txnId) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("kind", "receipt");
    form.append("txn_id", txnId);
    try {
      await axios.post(`${API}/${token}/items/${item.item_id}/upload`, form);
      onRowAction?.({ txn_id: txnId, kind: "receipt" });
    } catch (e) {
      onRowAction?.({ txn_id: txnId, kind: "receipt-error",
                       error: e?.response?.data?.detail || e.message });
    }
  };

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-[0_8px_20px_-14px_rgba(15,23,42,0.12)]"
      data-testid="grouped-txn-card"
    >
      <div className={`inline-flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.14em] px-2.5 py-1 rounded-full border ${chipColor}`}>
        {chipLabel}
      </div>
      <div className="mt-2 text-[19px] leading-snug font-heading font-semibold text-slate-900">
        {item.prompt}
      </div>
      <div className="mt-1 text-sm text-slate-600">
        <span className="font-semibold">{ctx.contact_name || "Unknown"}</span>
        {" · "}{ctx.count} transaction{ctx.count === 1 ? "" : "s"}
        {" · "}
        <span className="font-mono">{money(ctx.total)}</span>
        {" total"}
      </div>

      <div className="mt-4 relative">
        <input
          type="text"
          placeholder="Filter these transactions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          data-testid="grouped-filter"
        />
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="15" y2="15" />
        </svg>
      </div>

      <div className="mt-3 rounded-lg border border-slate-100 divide-y divide-slate-100 text-[13px]">
        {visible.map((r) => (
          <div key={r.id}
               className="grid grid-cols-[110px_100px_1fr_auto] gap-3 px-3 py-2 hover:bg-slate-50 items-center"
               data-testid={`grouped-row-${r.id}`}>
            <span className="text-slate-500 font-mono">{fmtDate(r.date)}</span>
            <span className={`text-right font-mono ${(r.amount || 0) < 0 ? "text-rose-700" : "text-emerald-700"}`}>
              {money(r.amount)}
            </span>
            <span className="text-slate-700 truncate font-mono" title={r.description}>{r.description}</span>
            <span className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                title="Attach a receipt to this transaction"
                onClick={() => { setRowUpload(r.id); rowFileRef.current?.click(); }}
                className="p-1.5 rounded-md text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 transition"
                data-testid={`grouped-row-receipt-${r.id}`}
              >
                <Paperclip size={14} />
              </button>
              <button
                type="button"
                title="Link this transaction to a bill / invoice"
                onClick={() => setRowLink(r.id)}
                className="p-1.5 rounded-md text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 transition"
                data-testid={`grouped-row-link-${r.id}`}
              >
                <LinkChain size={14} />
              </button>
              <button
                type="button"
                title="Edit this transaction"
                onClick={() => setRowEdit(r.id)}
                className="p-1.5 rounded-md text-slate-500 hover:text-violet-700 hover:bg-violet-50 transition"
                data-testid={`grouped-row-edit-${r.id}`}
              >
                <Pencil size={14} />
              </button>
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-slate-400">No matches</div>
        )}
      </div>

      {filtered.length < ctx.count && !showAll && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs text-indigo-600 hover:text-indigo-700 hover:underline"
            data-testid="grouped-show-all"
          >
            Show all {ctx.count}
          </button>
        </div>
      )}

      <input
        ref={rowFileRef}
        type="file"
        accept="image/*,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && rowUpload) handleUpload(f, rowUpload);
          setRowUpload(null);
          e.target.value = "";
        }}
      />
      {rowLink && (
        <LinkDocPicker
          token={token}
          currentItem={item}
          txnIdOverride={rowLink}
          onClose={() => setRowLink(null)}
          onLinked={(res) => { setRowLink(null); onLinked?.(res); }}
        />
      )}
      {rowEdit && (
        <TxnEditModal
          token={token}
          item={{ ...item, __rowTxnId: rowEdit }}
          onClose={() => setRowEdit(null)}
          onSaved={(res) => { setRowEdit(null); onEdited?.(res); }}
        />
      )}
    </div>
  );
}


function ItemContextCard({ item, token, onRowAction, onEdited, onLinked }) {
  const ctx = item.context || {};
  const meta = ctx.meta || {};
  if (ctx.grouped === true && Array.isArray(ctx.txn_ids)) {
    return (
      <GroupedTxnListCard
        item={item}
        token={token}
        onRowAction={onRowAction}
        onEdited={onEdited}
        onLinked={onLinked}
      />
    );
  }
  // Q2 (Vendor confirmation) rides on a `descriptor_bindings` array:
  // one row per unique bank-feed descriptor. Renders the alias-review
  // table INSTEAD of the single-transaction card so the client
  // confirms in bulk and every binding becomes a permanent alias.
  const bindings = Array.isArray(meta.descriptor_bindings) ? meta.descriptor_bindings : null;
  if (bindings && bindings.length > 0) {
    return (
      <div className="space-y-2">
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-[0_8px_20px_-14px_rgba(15,23,42,0.12)]">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-full">
            {ITEM_TYPE_LABELS[item.item_type] || "Item"}
          </div>
          <div className="mt-2 text-[17px] leading-snug font-heading font-semibold text-slate-900">
            {item.prompt}
          </div>
        </div>
        <DescriptorBindingsList bindings={bindings} itemId={item.item_id} />
      </div>
    );
  }
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
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-[0_8px_20px_-14px_rgba(15,23,42,0.12)]">
        <div className="flex items-center justify-between mb-1.5">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-full">
            {ITEM_TYPE_LABELS[item.item_type] || "Item"}
          </div>
          <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
            AI Junior
          </div>
        </div>
        <div className="mt-1 text-[17px] leading-snug font-heading font-semibold text-slate-900">
          {item.prompt}
        </div>
      </div>

      {hasLineItem && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3"
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
                  isNegative ? "text-rose-600" : "text-emerald-700"
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

function ParkedScreen({ session, parked }) {
  const fmt = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const answered = (session?.items || []).filter(i => i.answered_at).length;
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4" data-testid="review-parked-screen">
      <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 p-6 text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-sky-100 flex items-center justify-center">
          <AlarmClock className="text-sky-700" size={22} />
        </div>
        <h1 className="mt-4 font-heading text-xl text-slate-900">That's everything for now.</h1>
        <p className="mt-2 text-sm text-slate-600">
          {answered > 0 && <><strong>{answered}</strong> answer{answered === 1 ? "" : "s"} updated your books. </>}
          <strong>{parked.length}</strong> question{parked.length === 1 ? "" : "s"} parked — we'll remind you:
        </p>
        <ul className="mt-3 text-left text-[13px] text-slate-700 divide-y divide-slate-100 border border-slate-100 rounded-lg">
          {parked.map(i => (
            <li key={i.item_id} className="px-3 py-2 flex items-center justify-between gap-2">
              <span className="truncate">{i.prompt || ITEM_TYPE_LABELS[i.item_type] || "Question"}</span>
              <span className="text-sky-700 text-[11px] shrink-0">{fmt(i.snoozed_until)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 text-[11px] text-slate-400">You can close this window.</div>
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


// ---------------------------------------------------------------------
// ChecksAssignTable — item_type=13 renderer.
// Per-check CARDS (not a table) so we can fit inside the narrow chat
// pane without horizontal scrolling. Each card supports:
//   * Payee typeahead (existing contacts + inline-create by name)
//   * Multiple category lines (Add another line / X delete)
//   * A grouped dropdown that mixes OPEN BILLS with GL accounts, so
//     the client can apply the check straight to an outstanding bill
//     (backend decrements the bill's balance_due) or book it to a
//     category as usual.
// ---------------------------------------------------------------------
function ChecksAssignTable({ token, item, onAllDone }) {
  const checks = (item?.context?.checks) || [];
  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [bills, setBills] = useState([]);
  const [edits, setEdits] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [resolved, setResolved] = useState(
    new Set(item?.resolved_txn_ids || []),
  );
  const [errorFor, setErrorFor] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const [cR, pR] = await Promise.all([
          axios.get(`${API}/${token}/contacts`),
          axios.get(`${API}/${token}/pickable`),
        ]);
        setContacts(cR.data?.contacts || []);
        setAccounts(pR.data?.accounts || []);
        setBills(pR.data?.bills || []);
      } catch (e) {
        setErrorFor({ _load: e?.response?.data?.detail || e.message });
      }
    })();
  }, [token]);

  const getEdit = (id, row) =>
    edits[id] || {
      payeeQuery: "",
      contact_id: null,
      lines: [{ pick: "", amount: Math.abs(row.amount || 0), desc: "" }],
    };
  const setEdit = (id, patch, row) =>
    setEdits((prev) => ({
      ...prev,
      [id]: { ...getEdit(id, row), ...patch },
    }));
  const setLine = (id, i, patch, row) => {
    const cur = getEdit(id, row);
    const lines = cur.lines.map((l, idx) => idx === i ? { ...l, ...patch } : l);
    setEdit(id, { lines }, row);
  };
  const addLine = (id, row) => {
    const cur = getEdit(id, row);
    // Amount defaults to remaining (check total - sum of existing lines).
    const used = cur.lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    const remaining = Math.max(0, Math.abs(row.amount || 0) - used);
    setEdit(id, {
      lines: [...cur.lines, { pick: "", amount: remaining, desc: "" }],
    }, row);
  };
  const removeLine = (id, i, row) => {
    const cur = getEdit(id, row);
    if (cur.lines.length <= 1) return;
    setEdit(id, { lines: cur.lines.filter((_, idx) => idx !== i) }, row);
  };

  const matchedContact = (payeeQuery) => {
    const q = (payeeQuery || "").trim().toLowerCase();
    if (!q) return null;
    return contacts.find((c) => (c.name || "").toLowerCase() === q) || null;
  };
  const filteredSuggestions = (payeeQuery) => {
    const q = (payeeQuery || "").trim().toLowerCase();
    if (!q) return [];
    return contacts
      .filter((c) => (c.name || "").toLowerCase().includes(q))
      .slice(0, 5);
  };

  const save = async (row) => {
    const edit = getEdit(row.id, row);
    const lines = (edit.lines || []).filter((l) => l.pick);
    if (!lines.length) {
      setErrorFor((e) => ({ ...e, [row.id]: "Pick at least one category or bill" }));
      return;
    }
    const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    if (Math.abs(total - Math.abs(row.amount || 0)) > 0.005) {
      setErrorFor((e) => ({
        ...e,
        [row.id]: `Line total $${total.toFixed(2)} must equal check amount $${Math.abs(row.amount).toFixed(2)}`,
      }));
      return;
    }
    // At least one payee needed unless every line is a bill (in which
    // case backend auto-adopts the bill's vendor).
    const anyBill = lines.some((l) => l.pick.startsWith("bill:"));
    const anyAcct = lines.some((l) => l.pick.startsWith("acct:"));
    const hasPayee = !!edit.contact_id ||
      (edit.addingNew && (edit.payeeQuery || "").trim());
    if (!anyBill && !hasPayee) {
      setErrorFor((e) => ({ ...e, [row.id]: "Payee is required" }));
      return;
    }
    if (anyAcct && !hasPayee) {
      setErrorFor((e) => ({ ...e, [row.id]: "Payee is required for GL-category lines" }));
      return;
    }
    setSavingId(row.id);
    setErrorFor((e) => ({ ...e, [row.id]: null }));
    try {
      const body = {
        txn_id: row.id,
        contact_id: edit.contact_id || null,
        create_contact_name: (!edit.contact_id && edit.addingNew)
          ? (edit.payeeQuery || "").trim() || null
          : null,
        line_items: lines.map((l) => ({
          category_account_id: l.pick.startsWith("acct:") ? l.pick.slice(5) : null,
          bill_id:             l.pick.startsWith("bill:") ? l.pick.slice(5) : null,
          amount:              Number(l.amount || 0),
          description:         l.desc || `Check #${row.number || ""}`.trim(),
        })),
      };
      const r = await axios.post(
        `${API}/${token}/items/${item.item_id}/check-assign`,
        body,
      );
      setResolved((prev) => new Set([...prev, row.id]));
      // Refresh contacts list so a newly-created contact appears in
      // subsequent dropdowns.
      if (r.data?.contact_id && !contacts.some((c) => c.id === r.data.contact_id)) {
        setContacts((prev) => [
          ...prev,
          { id: r.data.contact_id, name: r.data.contact_name, email: "" },
        ]);
      }
      if (r.data?.all_done && typeof onAllDone === "function") onAllDone();
    } catch (e) {
      setErrorFor((prev) => ({
        ...prev,
        [row.id]: e?.response?.data?.detail || e.message,
      }));
    } finally {
      setSavingId(null);
    }
  };

  const total = checks.length;
  const done = resolved.size;
  const remaining = total - done;

  return (
    <div className="mt-4 -mx-2 sm:-mx-6 rounded-xl bg-white ring-1 ring-slate-200 overflow-hidden"
         data-testid="checks-assign-table">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50">
        <div>
          <div className="text-sm font-semibold text-slate-900">
            {remaining} check{remaining !== 1 ? "s" : ""} still need a payee
          </div>
          <div className="text-xs text-slate-500">
            Fill in who each check was for, or apply it to an outstanding bill.
          </div>
        </div>
        <div className="text-xs text-slate-500 tabular-nums">
          {done} of {total} saved
        </div>
      </div>
      {errorFor._load && (
        <div className="px-4 py-2 text-xs text-rose-700 bg-rose-50 border-b border-rose-100">
          Could not load payees/categories/bills: {errorFor._load}
        </div>
      )}
      <ul className="space-y-3 p-3 bg-slate-50/60">
        {checks.map((row) => {
          const isSaved = resolved.has(row.id);
          const edit = getEdit(row.id, row);
          const err = errorFor[row.id];
          const lineTotal = edit.lines.reduce((s, l) => s + Number(l.amount || 0), 0);
          const target = Math.abs(Number(row.amount || 0));
          const diff = Number((lineTotal - target).toFixed(2));
          return (
            <li key={row.id}
                className={`rounded-xl bg-white ring-1 ring-slate-200 shadow-sm hover:shadow-md transition-shadow px-4 py-4 ${isSaved ? "bg-emerald-50/40 ring-emerald-200" : ""}`}
                data-testid={`check-row-${row.id}`}>
              {/* Header row: check meta + Save + Not a check */}
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-mono-num text-slate-500 text-sm">
                    #{row.number || "—"}
                  </span>
                  <span className="text-slate-700 text-sm">{row.date}</span>
                  <span className="font-mono-num tabular-nums font-semibold text-slate-900 text-base">
                    ${target.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {isSaved ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-semibold">
                      <Check className="h-3.5 w-3.5" /> Saved
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => save(row)}
                      disabled={savingId === row.id}
                      className="rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-1.5 disabled:opacity-60"
                      data-testid={`check-save-${row.id}`}
                    >
                      {savingId === row.id ? "Saving…" : "Save"}
                    </button>
                  )}
                </div>
              </div>

              {/* Payee — contacts dropdown with inline "+ Add new" option */}
              {!isSaved && (
                <div className="mb-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                    Payee
                  </div>
                  {edit.addingNew ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        autoFocus
                        placeholder="New payee name…"
                        value={edit.payeeQuery || ""}
                        onChange={(e) => setEdit(row.id, {
                          payeeQuery: e.target.value,
                          contact_id: null,
                        }, row)}
                        className="flex-1 min-w-0 rounded-md border border-indigo-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400"
                        data-testid={`check-payee-new-${row.id}`}
                      />
                      <button
                        type="button"
                        onClick={() => setEdit(row.id, {
                          addingNew: false,
                          payeeQuery: "",
                          contact_id: null,
                        }, row)}
                        className="text-slate-400 hover:text-slate-700 text-xs"
                        aria-label="Cancel new payee"
                      >
                        cancel
                      </button>
                    </div>
                  ) : (
                    <select
                      value={edit.contact_id || ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "__NEW__") {
                          setEdit(row.id, {
                            addingNew: true,
                            payeeQuery: "",
                            contact_id: null,
                          }, row);
                        } else {
                          const c = contacts.find((x) => x.id === v);
                          setEdit(row.id, {
                            contact_id:  v || null,
                            payeeQuery:  c?.name || "",
                            addingNew:   false,
                          }, row);
                        }
                      }}
                      className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400"
                      data-testid={`check-payee-${row.id}`}
                    >
                      <option value="">Select payee…</option>
                      {contacts.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      <option value="__NEW__">+ Add new contact…</option>
                    </select>
                  )}
                </div>
              )}

              {/* Line items */}
              {!isSaved && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                    Categories & amounts
                  </div>
                  <div className="space-y-2">
                    {edit.lines.map((l, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <select
                          value={l.pick || ""}
                          onChange={(e) => setLine(row.id, i, { pick: e.target.value }, row)}
                          className="flex-1 min-w-0 rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          data-testid={`check-pick-${row.id}-${i}`}
                        >
                          <option value="">Select category or bill…</option>
                          {bills.length > 0 && (
                            <optgroup label="Apply to a bill">
                              {bills.map((b) => (
                                <option key={b.id} value={`bill:${b.id}`}>
                                  {b.label}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label="Or book to a category">
                            {accounts.map((a) => (
                              <option key={a.id} value={`acct:${a.id}`}>
                                {a.code ? `${a.code} · ` : ""}{a.name}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                        <input
                          type="number"
                          step="0.01"
                          value={l.amount}
                          onChange={(e) => setLine(row.id, i, { amount: Number(e.target.value) }, row)}
                          className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono-num tabular-nums text-right focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          data-testid={`check-amount-${row.id}-${i}`}
                        />
                        <button
                          type="button"
                          onClick={() => removeLine(row.id, i, row)}
                          disabled={edit.lines.length <= 1}
                          className="text-slate-400 hover:text-rose-600 disabled:opacity-30"
                          aria-label="Remove line"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between mt-2 text-xs">
                    <button
                      type="button"
                      onClick={() => addLine(row.id, row)}
                      className="text-indigo-600 hover:text-indigo-700 font-semibold"
                      data-testid={`check-add-line-${row.id}`}
                    >
                      + Add another line
                    </button>
                    <div className={`tabular-nums ${
                      Math.abs(diff) < 0.005 ? "text-emerald-700"
                        : diff > 0 ? "text-rose-700" : "text-amber-700"
                    }`}>
                      Total ${lineTotal.toFixed(2)}
                      {" "}
                      {Math.abs(diff) < 0.005
                        ? <Check className="h-3 w-3 inline align-baseline" />
                        : diff > 0 ? `· $${diff.toFixed(2)} over`
                                   : `· $${Math.abs(diff).toFixed(2)} to go`}
                    </div>
                  </div>
                </div>
              )}
              {err && (
                <div className="mt-2 text-xs text-rose-700">
                  {err}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
