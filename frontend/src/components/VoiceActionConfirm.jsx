/**
 * VoiceActionConfirm — global overlay for confirming AI-parsed CRM
 * voice actions (Phase 1, Feb 2026).
 *
 * Mounted once at the app root. Listens for `axiom:voice-action` events
 * dispatched by the AI panel (which shipped the transcript to
 * /api/voice/actions/parse). Shows the parsed action as an editable
 * card, handles clarifying questions inline, and executes on Confirm.
 *
 * The user never leaves the current page — they can be in Accounting,
 * a client's book review, or the CRM Kanban and this popover overlays
 * on top of whatever they're doing.
 */
import { useEffect, useRef, useState } from "react";
import { CheckSquare, CalendarPlus, User, Clock, Loader2,
         X, Send, MessageCircle, Link as LinkIcon,
         PhoneCall, TrendingUp, BellRing, Timer, FileText } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { fastParse, mergeParse, looksCompound } from "@/lib/fastParse";

// ── Local time context helpers ───────────────────────────────────
function _tzName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return null; }
}
function _nowLocalIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
       + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
       + `${sign}${oh}:${om}`;
}

// ------ event bus ---------------------------------------------------
export const VOICE_ACTION_EVENT = "axiom:voice-action";

/**
 * Fire this from any tier of the voice pipeline to open the modal.
 *   emitVoiceAction({ text: "create a task for Alice tomorrow" })
 */
export function emitVoiceAction(payload) {
  window.dispatchEvent(new CustomEvent(VOICE_ACTION_EVENT, { detail: payload }));
}


// ==================================================================
// Modal
// ==================================================================
export default function VoiceActionConfirm() {
  const { currentId } = useCompany();
  const [open, setOpen]           = useState(false);
  const [phase, setPhase]         = useState("parsing"); // parsing | ready | executing | done
  const [parsed, setParsed]       = useState(null);
  const [originalText, setOrigT]  = useState("");
  const [followUp, setFollowUp]   = useState("");
  const [enriching, setEnriching] = useState(false);
  // Compound-utterance queue: multiple actions parsed from a single dump.
  const [queue, setQueue] = useState([]);          // remaining actions AFTER current
  const [queueTotal, setQueueTotal] = useState(0); // total N (>1 means show "1 of N")
  const [queueIndex, setQueueIndex] = useState(0); // 0-based index of the current action
  const rootRef = useRef(null);
  const followUpRef = useRef(null);

  useEffect(() => {
    const onEvent = async (e) => {
      const text = (e.detail?.text || "").trim();
      if (!text || !currentId) return;
      setOrigT(text); setParsed(null); setFollowUp("");
      setQueue([]); setQueueIndex(0); setQueueTotal(0);

      const compound = looksCompound(text);

      // Tier-0 fast-path only for SINGLE-action utterances. Compound
      // dumps go straight to the splitter (chrono would pick the wrong
      // time and the overlay would flash bad state).
      if (!compound) {
        const fast = fastParse(text);
        if (fast) {
          setParsed(fast);
          setOpen(true);
          setPhase("ready");
          setEnriching(true);
        } else {
          setOpen(true);
          setPhase("parsing");
        }
      } else {
        setOpen(true);
        setPhase("parsing");
      }

      // LLM enrichment (single) OR splitter+parse-multi (compound).
      try {
        if (compound) {
          const r = await api.post("/voice/actions/parse-multi", {
            text, company_id: currentId,
            current_iso: new Date().toISOString(),
            tz: _tzName(),
            now_local: _nowLocalIso(),
          });
          const actions = r.data.actions || [];
          if (actions.length === 0) {
            toast.error("I didn't catch a task in there.");
            setOpen(false);
            setEnriching(false);
            return;
          }
          // Show the first action; queue the rest.
          setQueueTotal(actions.length);
          setQueueIndex(0);
          setQueue(actions.slice(1));
          setParsed(actions[0]);
          setOrigT(actions[0].original_text || text);
          setPhase("ready");
        } else {
          const r = await api.post("/voice/actions/parse", {
            text, company_id: currentId,
            current_iso: new Date().toISOString(),
            tz: _tzName(),
            now_local: _nowLocalIso(),
          });
          if (r.data.intent === "unknown") {
            toast.error("I didn't catch a task or appointment there.");
            setOpen(false);
            setEnriching(false);
            return;
          }
          setParsed(prev => mergeParse(prev, r.data));
          setPhase("ready");
        }
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Parse failed");
        setOpen(false);
      } finally {
        setEnriching(false);
      }
    };
    window.addEventListener(VOICE_ACTION_EVENT, onEvent);
    return () => window.removeEventListener(VOICE_ACTION_EVENT, onEvent);
  }, [currentId]);

  // Voice keywords: "confirm/yes/looks good" and "cancel/no/nope".
  // Web SpeechRecognition is bootstrapped by AiPanel; we listen for
  // its normalized text events on the same page.
  useEffect(() => {
    if (!open || phase !== "ready") return;
    const onSpeech = (e) => {
      const t = ((e.detail?.text || "") + "").trim().toLowerCase();
      if (!t) return;
      if (/\b(confirm|yes|looks good|do it|send it|go ahead)\b/.test(t)) {
        void confirmAction();
      } else if (/\b(cancel|no|nope|scratch that|abort)\b/.test(t)) {
        closeModal();
      }
    };
    window.addEventListener("axiom:speech", onSpeech);
    return () => window.removeEventListener("axiom:speech", onSpeech);
    // eslint-disable-next-line
  }, [open, phase, parsed]);

  // Outside click / Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, [open]);

  const closeModal = () => {
    setOpen(false); setParsed(null); setPhase("parsing");
    setQueue([]); setQueueIndex(0); setQueueTotal(0);
  };

  const advanceQueue = () => {
    // Move to the next queued action, if any.
    if (queue.length === 0) {
      closeModal();
      return;
    }
    const [next, ...rest] = queue;
    setParsed(next);
    setOrigT(next.original_text || originalText);
    setQueue(rest);
    setQueueIndex(i => i + 1);
    setFollowUp("");
    setPhase("ready");
  };

  const skipCurrent = () => {
    // User doesn't want this one — just move to the next without executing.
    if (queue.length === 0) closeModal();
    else advanceQueue();
  };

  const askFollowUp = async () => {
    if (!followUp.trim() || !parsed) return;
    setPhase("parsing");
    try {
      const merged = `${originalText}. ${followUp.trim()}`;
      const r = await api.post("/voice/actions/parse", {
        text: merged, company_id: currentId,
        current_iso: new Date().toISOString(),
        tz: _tzName(),
        now_local: _nowLocalIso(),
      });
      if (r.data.intent === "unknown") {
        toast.error("Still not clear — try again.");
        setPhase("ready");
        return;
      }
      // MERGE — don't blow away entities the user already saw/edited.
      setParsed(prev => {
        const next = mergeParse(prev, r.data);
        // For entity fields already set on `prev`, prefer prev's value
        // (esp. iso_datetime, contact — the user may have picked them).
        const p = prev?.entities || {};
        const n = next.entities || {};
        for (const k of ["title", "iso_datetime", "duration_min",
                          "contact_hint", "assignee_hint", "priority",
                          "notes", "amount", "currency",
                          "new_stage", "task_hint", "snooze_by_days"]) {
          if (p[k] != null && p[k] !== "" && (n[k] == null || n[k] === "")) {
            n[k] = p[k];
          }
        }
        next.entities = n;
        // Preserve prior resolution too.
        next.resolution = { ...(prev?.resolution || {}), ...(next.resolution || {}) };
        return next;
      });
      setOrigT(merged);
      setFollowUp("");
      setPhase("ready");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Parse failed");
      setPhase("ready");
    }
  };

  const patchEntity = (key, value) => {
    setParsed(p => ({ ...p, entities: { ...(p.entities || {}), [key]: value, _dirty: true } }));
  };

  const createContactInline = async (nameHint) => {
    if (!nameHint || !currentId) return;
    try {
      const r = await api.post(`/companies/${currentId}/contacts`, {
        name: nameHint.trim(),
        type: "customer",
      });
      const newId = r.data?.id;
      // Splice the new contact into the current parse's resolution so
      // the field flips from "not in your CRM" to a real chip without
      // a full re-parse.
      setParsed(p => ({
        ...p,
        resolution: {
          ...(p.resolution || {}),
          contact: { id: newId, name: nameHint.trim(), email: null },
        },
      }));
      toast.success(`Created "${nameHint}" in your CRM`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't create contact");
    }
  };

  const EMAIL_DRAFT_INTENTS = ["send_email", "send_meeting_link",
                                 "send_calendar_link", "draft_proposal"];
  const isEmailIntent = parsed && EMAIL_DRAFT_INTENTS.includes(parsed.intent);

  const confirmAction = async ({ sendNow = false } = {}) => {
    if (!parsed || phase === "executing") return;
    setPhase("executing");
    try {
      // Strip internal-only bookkeeping fields.
      const { _dirty, ...cleanEntities } = parsed.entities || {};
      // If the user edited the email in the popup, pass it through so
      // execute() honours their edits instead of re-drafting.
      const draft = (parsed.resolution || {}).email_draft;
      const emailOverride = (isEmailIntent && draft) ? {
        subject:  draft.subject,
        body:     draft.body,
        to_email: draft.to_email,
      } : null;
      const r = await api.post("/voice/actions/execute", {
        company_id:    currentId,
        intent:        parsed.intent,
        entities:      cleanEntities,
        resolution:    parsed.resolution || {},
        original_text: originalText,
        send_now:      !!sendNow,
        email_override: emailOverride,
      });
      const action = r.data.action;
      setPhase("done");
      toast.success(action.summary, {
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await api.post(`/voice/actions/${action.id}/undo`);
              toast.success("Undone");
            } catch (err) {
              toast.error(err?.response?.data?.detail || "Undo failed");
            }
          },
        },
        duration: sendNow ? 12000 : 8000,
      });
      // Auto-close (or advance queue) after execute.
      setTimeout(() => {
        if (queue.length > 0) advanceQueue();
        else closeModal();
      }, 600);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Execute failed");
      setPhase("ready");
    }
  };

  // Voice keyword handler needs to reference confirmAction — kept
  // simple: any recognized "confirm" phrase saves-as-draft.  Users
  // must click "Send Now" for actual sends (safety).
  // (Handler wired in useEffect above; no code change needed here.)

  const patchEmailField = (key, value) => {
    setParsed(p => {
      const cur = ((p.resolution || {}).email_draft) || {};
      return {
        ...p,
        resolution: {
          ...(p.resolution || {}),
          email_draft: { ...cur, [key]: value },
        },
      };
    });
  };

  // Broadcast the open state so the AI-panel's speech pipeline can
  // suppress the user's "confirm"/"cancel" utterances from leaking
  // into the chat input while this overlay is up. (Must live above
  // the early return so hook order stays stable.)
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.__voiceActionOpen = open;
    }
    return () => {
      if (typeof window !== "undefined") window.__voiceActionOpen = false;
    };
  }, [open]);

  if (!open) return null;

  const ent   = parsed?.entities   || {};
  const res   = parsed?.resolution || {};
  const clars = parsed?.clarifications || [];
  const intentIconMap = {
    create_appointment:  CalendarPlus,
    send_meeting_link:   LinkIcon,
    send_calendar_link:  LinkIcon,
    send_email:          Send,
    log_call:            PhoneCall,
    move_deal_stage:     TrendingUp,
    follow_up_reminder:  BellRing,
    snooze_task:         Timer,
    draft_proposal:      FileText,
  };
  const IntentIcon = intentIconMap[parsed?.intent] || CheckSquare;
  const intentTone = {
    create_appointment: "amber",
    send_meeting_link:  "cyan",
    send_calendar_link: "cyan",
    send_email:         "cyan",
    log_call:           "emerald",
    move_deal_stage:    "sky",
    follow_up_reminder: "amber",
    snooze_task:        "slate",
    draft_proposal:     "cyan",
  }[parsed?.intent] || "violet";
  const toneClass = {
    amber:   "bg-amber-50 text-amber-600",
    cyan:    "bg-cyan-50 text-cyan-600",
    emerald: "bg-emerald-50 text-emerald-600",
    sky:     "bg-sky-50 text-sky-600",
    slate:   "bg-slate-50 text-slate-600",
    violet:  "bg-violet-50 text-violet-600",
  }[intentTone];

  const intentLabelMap = {
    create_appointment:  "Create appointment",
    create_task:         "Create task",
    send_meeting_link:   "Draft: send meeting link",
    send_calendar_link:  "Draft: send calendar link",
    send_email:          "Email",
    log_call:            "Log a call",
    move_deal_stage:     "Move deal stage",
    follow_up_reminder:  "Set follow-up",
    snooze_task:         "Snooze task",
    draft_proposal:      "Draft proposal",
  };
  const headerLabel = phase === "parsing"
    ? "Reading you…"
    : intentLabelMap[parsed?.intent] || "Voice action";

  return (
    <div className="fixed z-[80] flex items-start justify-center pt-24 pointer-events-none"
         style={{
           top: 0, bottom: 0, left: 0,
           // Leave the AI-panel column free on the right so the user
           // can still see chat + keep barking commands.
           right: "calc(var(--ai-panel-width, 0px))",
         }}
         data-testid="voice-action-modal">
      {/* light dim only over the main content area */}
      <div className="absolute inset-0 bg-black/25 pointer-events-auto"
           onClick={closeModal}/>
      <div ref={rootRef}
            onClick={e => e.stopPropagation()}
            className="relative pointer-events-auto bg-white rounded-xl w-full max-w-lg mx-3 shadow-2xl p-5">
        {/* header */}
        <div className="flex items-center gap-2 mb-3">
          <div className={`w-8 h-8 rounded-md flex items-center justify-center ${toneClass}`}>
            <IntentIcon size={16}/>
          </div>
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold flex items-center gap-1.5">
              Voice action
              {queueTotal > 1 && (
                <span className="text-violet-600 tracking-normal normal-case"
                       data-testid="voice-action-queue-badge">
                  · {queueIndex + 1} of {queueTotal}
                </span>
              )}
            </div>
            <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
              {headerLabel}
              {enriching && phase === "ready" && (
                <span className="inline-flex items-center gap-1 text-[10px] text-slate-400 font-normal"
                       data-testid="voice-action-enriching">
                  <Loader2 size={10} className="animate-spin"/> enriching
                </span>
              )}
            </div>
          </div>
          {queueTotal > 1 && phase === "ready" && (
            <button onClick={skipCurrent}
                     data-testid="voice-action-skip"
                     className="text-xs text-slate-500 hover:text-slate-800 px-2 py-1 rounded hover:bg-slate-100">
              Skip →
            </button>
          )}
          <button onClick={closeModal}
                  data-testid="voice-action-close"
                  className="p-1 rounded hover:bg-slate-100 text-slate-400">
            <X size={16}/>
          </button>
        </div>

        {/* body */}
        {phase === "parsing" && (
          <div className="text-center py-8 text-slate-500">
            <Loader2 size={20} className="animate-spin mx-auto mb-2 text-violet-500"/>
            <div className="text-xs">
              {looksCompound(originalText)
                ? "Breaking your dump into separate actions…"
                : "Reading you…"}
            </div>
            <div className="text-[11px] italic mt-1 max-w-xs mx-auto text-slate-400">
              "{originalText.length > 140 ? originalText.slice(0, 140) + "…" : originalText}"
            </div>
            {looksCompound(originalText) && (
              <div className="text-[10px] mt-3 text-slate-400">
                This can take up to 20 seconds for long dumps
              </div>
            )}
          </div>
        )}

        {phase !== "parsing" && parsed && (
          <>
            {/* transcript */}
            <div className="text-[11px] text-slate-500 mb-3 italic">
              You said: "{originalText}"
            </div>

            {/* clarifications first */}
            {clars.length > 0 && (
              <div className="mb-3 rounded-md bg-violet-50 border border-violet-200 p-3"
                   data-testid="voice-action-clarifications">
                <div className="flex items-center gap-1.5 mb-1.5 text-violet-800 text-xs font-semibold">
                  <MessageCircle size={12}/> Quick question
                </div>
                <ul className="space-y-0.5 mb-2">
                  {clars.map((c, i) => (
                    <li key={i} className="text-xs text-slate-700">• {c.question}</li>
                  ))}
                </ul>
                <div className="flex items-center gap-2">
                  <input value={followUp}
                          ref={followUpRef}
                          onChange={e => setFollowUp(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") askFollowUp(); }}
                          placeholder="Answer here…"
                          data-testid="voice-action-followup-input"
                          className="flex-1 text-xs px-2 py-1.5 rounded border border-slate-300 bg-white"/>
                  <button onClick={askFollowUp}
                          data-testid="voice-action-followup-send"
                          className="text-xs px-2.5 py-1.5 rounded bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center gap-1">
                    <Send size={11}/> Send
                  </button>
                </div>
              </div>
            )}

            {/* editable fields */}
            <div className="space-y-2.5" data-testid="voice-action-fields">
              <FieldRow label="Title">
                <input value={ent.title || ""}
                        onChange={e => patchEntity("title", e.target.value)}
                        data-testid="voice-action-title"
                        className="w-full text-sm px-2.5 py-1.5 rounded border border-slate-300"/>
              </FieldRow>

              <FieldRow label="Assignee" icon={User}>
                <div className="text-sm text-slate-800">
                  {res.assignee?.name || "You"}
                  {res.assignee?.email && (
                    <span className="ml-1 text-xs text-slate-400">· {res.assignee.email}</span>
                  )}
                </div>
              </FieldRow>

              {(res.contact || ent.contact_hint) && (
                <FieldRow label="Contact" icon={User}>
                  {res.contact ? (
                    <div className="text-sm text-slate-800">
                      {res.contact.name}
                      {res.contact.email && (
                        <span className="ml-1 text-xs text-slate-400">· {res.contact.email}</span>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-xs italic text-slate-500">
                        "{ent.contact_hint}" — not in your CRM
                      </div>
                      <button onClick={() => createContactInline(ent.contact_hint)}
                              data-testid="voice-action-create-contact"
                              className="text-[11px] px-2 py-1 rounded bg-violet-100 text-violet-700 hover:bg-violet-200 font-medium">
                        + Create in CRM
                      </button>
                    </div>
                  )}
                </FieldRow>
              )}

              {(parsed.intent === "create_appointment"
                 || parsed.intent === "follow_up_reminder"
                 || ent.iso_datetime) && (
                <FieldRow label="When" icon={Clock}>
                  <input
                    type="datetime-local"
                    value={toLocalInput(ent.iso_datetime)}
                    onChange={e => patchEntity("iso_datetime", fromLocalInput(e.target.value))}
                    data-testid="voice-action-when"
                    className="text-sm px-2.5 py-1.5 rounded border border-slate-300"/>
                </FieldRow>
              )}

              {parsed.intent === "create_appointment" && (
                <FieldRow label="Duration">
                  <select value={ent.duration_min || 30}
                          onChange={e => patchEntity("duration_min", parseInt(e.target.value, 10))}
                          data-testid="voice-action-duration"
                          className="text-sm px-2.5 py-1.5 rounded border border-slate-300">
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={45}>45 min</option>
                    <option value={60}>1 hour</option>
                    <option value={90}>1.5 hours</option>
                  </select>
                </FieldRow>
              )}

              {(parsed.intent === "create_task"
                 || parsed.intent === "follow_up_reminder") && (
                <FieldRow label="Priority">
                  <select value={ent.priority || "medium"}
                          onChange={e => patchEntity("priority", e.target.value)}
                          data-testid="voice-action-priority"
                          className="text-sm px-2.5 py-1.5 rounded border border-slate-300">
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </FieldRow>
              )}

              {/* Phase 3: log_call — outcome + notes */}
              {parsed.intent === "log_call" && (
                <>
                  <FieldRow label="Outcome">
                    <select value={ent.outcome || ""}
                            onChange={e => patchEntity("outcome", e.target.value || null)}
                            data-testid="voice-action-outcome"
                            className="text-sm px-2.5 py-1.5 rounded border border-slate-300">
                      <option value="">—</option>
                      <option value="connected">Connected</option>
                      <option value="left_voicemail">Left voicemail</option>
                      <option value="no_answer">No answer</option>
                      <option value="callback">Callback needed</option>
                    </select>
                  </FieldRow>
                  <FieldRow label="Notes">
                    <textarea value={ent.notes || ""}
                              onChange={e => patchEntity("notes", e.target.value)}
                              rows={3}
                              data-testid="voice-action-notes"
                              className="w-full text-sm px-2.5 py-1.5 rounded border border-slate-300"/>
                  </FieldRow>
                </>
              )}

              {/* Phase 3: move_deal_stage — deal preview + stage picker */}
              {parsed.intent === "move_deal_stage" && (
                <>
                  <FieldRow label="Deal">
                    {res.deal ? (
                      <div className="text-sm text-slate-800">
                        {res.deal.title}
                        <span className="ml-2 text-xs text-slate-400">
                          currently <b>{res.deal.stage}</b>
                        </span>
                      </div>
                    ) : (
                      <div className="text-xs italic text-slate-500">
                        {ent.deal_hint ? `"${ent.deal_hint}" — no match` : "no deal resolved"}
                      </div>
                    )}
                  </FieldRow>
                  <FieldRow label="New stage">
                    <select value={(ent.new_stage || "").toLowerCase()}
                            onChange={e => patchEntity("new_stage", e.target.value)}
                            data-testid="voice-action-new-stage"
                            className="text-sm px-2.5 py-1.5 rounded border border-slate-300">
                      <option value="">Pick a stage…</option>
                      {["lead","qualified","proposal","negotiation","won","lost"].map(s =>
                        <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>
                      )}
                    </select>
                  </FieldRow>
                </>
              )}

              {/* Phase 3: snooze_task — task preview + delta */}
              {parsed.intent === "snooze_task" && (
                <>
                  <FieldRow label="Task">
                    {res.task ? (
                      <div className="text-sm text-slate-800">
                        {res.task.title}
                        {res.task.due_date && (
                          <span className="ml-2 text-xs text-slate-400">
                            due {res.task.due_date}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs italic text-slate-500">
                        {ent.task_hint ? `"${ent.task_hint}" — no open task` : "no task resolved"}
                      </div>
                    )}
                  </FieldRow>
                  <FieldRow label="Snooze by">
                    <select value={ent.snooze_by_days ?? ""}
                            onChange={e => patchEntity("snooze_by_days", e.target.value ? parseInt(e.target.value,10) : null)}
                            data-testid="voice-action-snooze-by"
                            className="text-sm px-2.5 py-1.5 rounded border border-slate-300">
                      <option value="">Pick offset…</option>
                      <option value={1}>1 day</option>
                      <option value={2}>2 days</option>
                      <option value={3}>3 days</option>
                      <option value={7}>1 week</option>
                      <option value={14}>2 weeks</option>
                    </select>
                  </FieldRow>
                </>
              )}

              {/* Phase 3: draft_proposal — amount + notes */}
              {parsed.intent === "draft_proposal" && (
                <>
                  <FieldRow label="Amount">
                    <div className="flex gap-2">
                      <select value={ent.currency || "USD"}
                              onChange={e => patchEntity("currency", e.target.value)}
                              data-testid="voice-action-currency"
                              className="text-sm px-2 py-1.5 rounded border border-slate-300">
                        {["USD","EUR","GBP","CAD","AUD","INR"].map(c =>
                          <option key={c} value={c}>{c}</option>
                        )}
                      </select>
                      <input type="number" step="0.01"
                             value={ent.amount ?? ""}
                             onChange={e => patchEntity("amount", e.target.value ? parseFloat(e.target.value) : null)}
                             data-testid="voice-action-amount"
                             placeholder="0.00"
                             className="flex-1 text-sm px-2.5 py-1.5 rounded border border-slate-300"/>
                    </div>
                  </FieldRow>
                  <FieldRow label="Scope">
                    <textarea value={ent.notes || ""}
                              onChange={e => patchEntity("notes", e.target.value)}
                              rows={3}
                              data-testid="voice-action-notes"
                              placeholder="Deliverables, timeline, terms…"
                              className="w-full text-sm px-2.5 py-1.5 rounded border border-slate-300"/>
                  </FieldRow>
                </>
              )}
            </div>

            {/* Email draft panel — visible for email-producing intents */}
            {isEmailIntent && (parsed.resolution?.email_draft) && (
              <div className="mt-3 rounded-md border border-cyan-200 bg-cyan-50/40 p-3"
                    data-testid="voice-action-email-panel">
                <div className="flex items-center gap-1.5 mb-1.5 text-cyan-800 text-xs font-semibold">
                  <Send size={12}/> Draft email
                  {parsed.resolution.email_draft.to_email ? (
                    <span className="ml-1 text-[10px] font-normal text-slate-500">
                      → {parsed.resolution.email_draft.to_email}
                    </span>
                  ) : (
                    <span className="ml-1 text-[10px] font-normal text-amber-600">
                      no email on file — will save as draft only
                    </span>
                  )}
                </div>
                <input value={parsed.resolution.email_draft.subject || ""}
                        onChange={e => patchEmailField("subject", e.target.value)}
                        data-testid="voice-action-email-subject"
                        placeholder="Subject"
                        className="w-full mb-1.5 text-sm font-medium px-2 py-1.5 rounded border border-slate-300 bg-white"/>
                <textarea value={parsed.resolution.email_draft.body || ""}
                          onChange={e => patchEmailField("body", e.target.value)}
                          rows={6}
                          data-testid="voice-action-email-body"
                          placeholder="Email body — edit before sending"
                          className="w-full text-sm px-2 py-1.5 rounded border border-slate-300 bg-white font-mono leading-snug"/>
                <div className="text-[10px] text-slate-400 mt-1">
                  You edit this before it goes. Nothing is sent unless you click <b>Send now</b>.
                </div>
              </div>
            )}

            {parsed.preview && (
              <div className="mt-3 text-[11px] text-slate-500 italic border-t border-slate-100 pt-2">
                {parsed.preview}
              </div>
            )}

            {/* actions */}
            <div className="flex items-center gap-2 mt-4">
              <button onClick={closeModal}
                      data-testid="voice-action-cancel"
                      disabled={phase === "executing"}
                      className="text-sm text-slate-600 hover:text-slate-900">
                Cancel
              </button>
              <div className="flex-1"/>
              <button onClick={() => confirmAction({ sendNow: false })}
                      disabled={phase === "executing" || clars.length > 0}
                      data-testid="voice-action-confirm"
                      title={clars.length > 0 ? "Answer the question first" : "Confirm"}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-50">
                {phase === "executing" ? <Loader2 size={13} className="animate-spin"/> : <CheckSquare size={13}/>}
                {isEmailIntent ? "Save draft" : "Confirm"}
              </button>
              {isEmailIntent && parsed.resolution?.email_draft?.to_email && (
                <button onClick={() => confirmAction({ sendNow: true })}
                        disabled={phase === "executing" || clars.length > 0}
                        data-testid="voice-action-send-now"
                        title="Send this email via Gmail right now"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-sm disabled:opacity-50">
                  <Send size={13}/> Send now
                </button>
              )}
            </div>
            <div className="text-[10px] text-slate-400 mt-2 text-center">
              Tip: you can also say <b>"confirm"</b> or <b>"cancel"</b>
              {parsed?.cached ? " · 🗲 cached" : ""}
            </div>
          </>
        )}
      </div>
    </div>
  );
}


// ==================================================================
// Bits
// ==================================================================
function FieldRow({ label, icon: Icon, children }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-20 shrink-0 text-[10px] uppercase tracking-widest text-slate-400 font-semibold pt-1.5 flex items-center gap-1">
        {Icon && <Icon size={11}/>}
        {label}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

// datetime-local <input> wants "YYYY-MM-DDTHH:MM"; our API gives ISO w/ tz.
function toLocalInput(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ""; }
}
function fromLocalInput(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}
