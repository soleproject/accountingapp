/*
 * VoiceActionReview — Round 7 (Feb 2026)
 * One popup, one review, one confirm. Replaces the queue-based
 * VoiceActionConfirm flow with a single structured plan.
 */
import { useEffect, useRef, useState } from "react";
import {
  X, Loader2, CheckSquare, PhoneCall, CalendarPlus,
  ListChecks, Send, ChevronDown, ChevronRight, User,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

export const VOICE_ACTION_EVENT = "axiom:voice-action";
// Emitted BY the popup to the AI chat when the plan needs clarification.
export const VOICE_CLARIFY_ASK_EVENT = "axiom:voice-clarify-ask";
// Emitted BY the AI chat to the popup with the user's answer.
export const VOICE_CLARIFY_ANSWER_EVENT = "axiom:voice-clarify-answer";
// Emitted BY the popup when it closes (so chat can retire any pending
// clarification card / restore normal chat routing).
export const VOICE_CLARIFY_CLEAR_EVENT = "axiom:voice-clarify-clear";
export function emitVoiceAction(detail) {
  try { window.dispatchEvent(new CustomEvent(VOICE_ACTION_EVENT, { detail })); }
  catch { /* no CustomEvent */ }
}

function _tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } }
function _nowLocalIso() {
  const d = new Date(); const pad = n => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(); const s = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off)/60)), om = pad(Math.abs(off)%60);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${oh}:${om}`;
}
function isoToLocalInput(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ""; }
}

export default function VoiceActionReview() {
  const { currentId } = useCompany();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState("parsing");    // parsing | ready | executing
  const [plan, setPlan] = useState(null);
  const [originalText, setOrigT] = useState("");
  // Checkbox state — indexes to include from each section.
  const [inc, setInc] = useState({ meeting_notes: true, appointments: [], tasks: [], emails: [] });
  const [sendNow, setSendNow] = useState([]);       // email indexes user wants sent
  const [expanded, setExpanded] = useState({ notes: true, appts: true, tasks: true, emails: true });
  const rootRef = useRef(null);

  useEffect(() => {
    const runPlan = async ({ text, clarification }) => {
      setPhase("parsing");
      try {
        const r = await api.post("/voice/actions/plan", {
          text, company_id: currentId, tz: _tz(),
          now_local: _nowLocalIso(), origin: window.location.origin,
          ...(clarification ? { clarification } : {}),
        });
        const p = r.data || {};
        setPlan(p);
        setInc({
          meeting_notes: !!p.meeting_notes,
          appointments: (p.appointments || []).map((_, i) => i),
          tasks:        (p.tasks || []).map((_, i) => i),
          emails:       (p.emails || []).map((_, i) => i),
        });
        setPhase("ready");
        // Surface any clarifying questions in the AI chat (not inline).
        const qs = (p.questions || []).filter(Boolean);
        if (qs.length) {
          try {
            window.dispatchEvent(new CustomEvent(VOICE_CLARIFY_ASK_EVENT, {
              detail: { questions: qs, originalText: text },
            }));
          } catch { /* CustomEvent unsupported */ }
        } else {
          try {
            window.dispatchEvent(new CustomEvent(VOICE_CLARIFY_CLEAR_EVENT));
          } catch { /* ignore */ }
        }
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Parse failed");
        setOpen(false);
      }
    };

    const onOpen = async (e) => {
      const text = (e.detail?.text || "").trim();
      if (!text || !currentId) return;
      setOrigT(text); setPlan(null); setOpen(true);
      setInc({ meeting_notes: true, appointments: [], tasks: [], emails: [] });
      setSendNow([]);
      await runPlan({ text });
    };

    const onClarifyAnswer = async (e) => {
      const answer = (e.detail?.answer || "").trim();
      if (!answer || !originalText) return;
      await runPlan({ text: originalText, clarification: answer });
    };

    window.addEventListener(VOICE_ACTION_EVENT, onOpen);
    window.addEventListener(VOICE_CLARIFY_ANSWER_EVENT, onClarifyAnswer);
    return () => {
      window.removeEventListener(VOICE_ACTION_EVENT, onOpen);
      window.removeEventListener(VOICE_CLARIFY_ANSWER_EVENT, onClarifyAnswer);
    };
  }, [currentId, originalText]);

  // Broadcast open state to AiPanel so it stops routing "confirm" to chat.
  useEffect(() => {
    if (typeof window !== "undefined") window.__voiceActionOpen = open;
    return () => { if (typeof window !== "undefined") window.__voiceActionOpen = false; };
  }, [open]);

  const closeModal = () => {
    setOpen(false); setPlan(null); setPhase("parsing");
    try { window.dispatchEvent(new CustomEvent(VOICE_CLARIFY_CLEAR_EVENT)); }
    catch { /* ignore */ }
  };
  const toggleInc = (section, idx) => {
    setInc(prev => {
      const arr = new Set(prev[section]);
      if (arr.has(idx)) arr.delete(idx); else arr.add(idx);
      return { ...prev, [section]: Array.from(arr).sort((a,b)=>a-b) };
    });
  };
  const toggleNotes = () => setInc(p => ({ ...p, meeting_notes: !p.meeting_notes }));
  const patchItem = (section, idx, key, value) => {
    setPlan(p => {
      const arr = [...(p[section] || [])];
      arr[idx] = { ...arr[idx], [key]: value };
      return { ...p, [section]: arr };
    });
  };
  const patchNotes = (key, value) =>
    setPlan(p => ({ ...p, meeting_notes: { ...(p.meeting_notes || {}), [key]: value } }));

  const totalIncluded = () =>
    (inc.meeting_notes && plan?.meeting_notes ? 1 : 0)
    + (inc.appointments?.length || 0)
    + (inc.tasks?.length || 0)
    + (inc.emails?.length || 0);

  const confirmAll = async ({ withSends = false } = {}) => {
    if (!plan || phase === "executing") return;
    setPhase("executing");
    try {
      const r = await api.post("/voice/actions/commit", {
        company_id: currentId, original_text: originalText,
        plan, include: inc,
        send_now: withSends ? sendNow : [],
      });
      const batchId = r.data.batch_id;
      const created = r.data.created || [];
      const sent = created.filter(c => c.type === "email" && c.status === "sent").length;
      toast.success(
        `Saved ${created.length} action${created.length !== 1 ? "s" : ""}${sent ? ` · ${sent} sent` : ""}`,
        {
          action: {
            label: "Undo",
            onClick: async () => {
              try { await api.post(`/voice/actions/undo-batch/${batchId}`); toast.success("Undone"); }
              catch (e) { toast.error(e?.response?.data?.detail || "Undo failed"); }
            },
          }, duration: 10000,
        },
      );
      closeModal();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Commit failed");
      setPhase("ready");
    }
  };

  if (!open) return null;

  const mn = plan?.meeting_notes;
  const appts = plan?.appointments || [];
  const tasks = plan?.tasks || [];
  const emails = plan?.emails || [];

  return (
    <div className="fixed z-[80] flex items-start justify-center pt-16 pointer-events-none"
         style={{ top: 0, bottom: 0, left: 0, right: "calc(var(--ai-panel-width, 0px))" }}
         data-testid="voice-review-modal">
      <div className="absolute inset-0 bg-black/25 pointer-events-auto" onClick={closeModal}/>
      <div ref={rootRef} onClick={e => e.stopPropagation()}
            className="relative pointer-events-auto bg-white rounded-xl w-full max-w-2xl mx-3 shadow-2xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-100">
          <div className="w-8 h-8 rounded-md bg-violet-100 flex items-center justify-center text-violet-600">
            <ListChecks size={16}/>
          </div>
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Voice action</div>
            <div className="text-sm font-semibold text-slate-900">
              {phase === "parsing" ? "Reading you…" : `Review ${totalIncluded()} action${totalIncluded()!==1?"s":""}`}
            </div>
          </div>
          <button onClick={closeModal} className="p-1 rounded hover:bg-slate-100 text-slate-400"
                  data-testid="voice-review-close"><X size={16}/></button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {phase === "parsing" && (
            <div className="text-center py-8 text-slate-500">
              <Loader2 size={20} className="animate-spin mx-auto mb-2 text-violet-500"/>
              <div className="text-xs">Extracting notes, tasks, and emails from your voice…</div>
              <div className="text-[11px] italic mt-1 max-w-md mx-auto text-slate-400">
                "{originalText.length > 200 ? originalText.slice(0,200)+"…" : originalText}"
              </div>
              <div className="text-[10px] mt-3 text-slate-400">This can take 30–40 seconds for long dumps</div>
            </div>
          )}

          {phase !== "parsing" && (
            <>
              {/* MEETING NOTES */}
              {mn && (
                <Section title="Meeting notes" icon={PhoneCall} tone="emerald"
                          checked={inc.meeting_notes} onCheck={toggleNotes}
                          count={inc.meeting_notes ? 1 : 0}
                          expanded={expanded.notes} onToggle={() => setExpanded(x => ({...x, notes: !x.notes}))}
                          testid="section-notes">
                  {expanded.notes && (
                    <div className="space-y-1.5">
                      <ContactChip contact={mn.contact} hint={mn.contact_hint}/>
                      <input className="w-full text-sm px-2 py-1 rounded border border-slate-300"
                              value={mn.title || ""} onChange={e => patchNotes("title", e.target.value)}
                              placeholder="Title"/>
                      <textarea className="w-full text-sm px-2 py-1.5 rounded border border-slate-300 font-mono leading-snug"
                                 rows={4}
                                 value={mn.notes || ""} onChange={e => patchNotes("notes", e.target.value)}
                                 placeholder="Your full transcript of what happened"/>
                    </div>
                  )}
                </Section>
              )}

              {/* APPOINTMENTS */}
              {appts.length > 0 && (
                <Section title="Appointments" icon={CalendarPlus} tone="amber"
                          count={inc.appointments.length} total={appts.length}
                          expanded={expanded.appts} onToggle={() => setExpanded(x => ({...x, appts: !x.appts}))}
                          testid="section-appts">
                  {expanded.appts && appts.map((a, i) => (
                    <Row key={i} idx={i} section="appointments" inc={inc} toggle={toggleInc}>
                      <input className="flex-1 text-sm px-2 py-1 rounded border border-slate-300"
                              value={a.title || ""} onChange={e => patchItem("appointments", i, "title", e.target.value)}/>
                      <input type="datetime-local" className="text-sm px-2 py-1 rounded border border-slate-300"
                              value={isoToLocalInput(a.iso_datetime)}
                              onChange={e => patchItem("appointments", i, "iso_datetime",
                                new Date(e.target.value).toISOString())}/>
                    </Row>
                  ))}
                </Section>
              )}

              {/* TASKS */}
              {tasks.length > 0 && (
                <Section title="Tasks & follow-ups" icon={ListChecks} tone="sky"
                          count={inc.tasks.length} total={tasks.length}
                          expanded={expanded.tasks} onToggle={() => setExpanded(x => ({...x, tasks: !x.tasks}))}
                          testid="section-tasks">
                  {expanded.tasks && tasks.map((t, i) => (
                    <Row key={i} idx={i} section="tasks" inc={inc} toggle={toggleInc}>
                      <input className="flex-1 text-sm px-2 py-1 rounded border border-slate-300"
                              value={t.title || ""} onChange={e => patchItem("tasks", i, "title", e.target.value)}/>
                      <input type="datetime-local" className="text-sm px-2 py-1 rounded border border-slate-300"
                              value={isoToLocalInput(t.due_iso)}
                              onChange={e => patchItem("tasks", i, "due_iso",
                                e.target.value ? new Date(e.target.value).toISOString() : null)}/>
                      {t.is_follow_up && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">follow-up</span>}
                    </Row>
                  ))}
                </Section>
              )}

              {/* EMAILS */}
              {emails.length > 0 && (
                <Section title="Emails" icon={Send} tone="cyan"
                          count={inc.emails.length} total={emails.length}
                          expanded={expanded.emails} onToggle={() => setExpanded(x => ({...x, emails: !x.emails}))}
                          testid="section-emails">
                  {expanded.emails && emails.map((e, i) => (
                    <div key={i} className="rounded border border-slate-200 p-2 space-y-1.5"
                         data-testid={`email-item-${i}`}>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" checked={inc.emails.includes(i)}
                                onChange={() => toggleInc("emails", i)}
                                data-testid={`email-check-${i}`}/>
                        <ContactChip contact={e.contact} hint={e.contact_hint}/>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-700">
                          {e.kind || "custom"}
                        </span>
                        {e.to_email && <span className="text-[10px] text-slate-500">→ {e.to_email}</span>}
                      </div>
                      <input className="w-full text-sm font-medium px-2 py-1 rounded border border-slate-300"
                              value={e.subject || ""} onChange={ev => patchItem("emails", i, "subject", ev.target.value)}
                              placeholder="Subject"/>
                      <textarea className="w-full text-sm px-2 py-1.5 rounded border border-slate-300 font-mono leading-snug"
                                 rows={5} value={e.body || ""}
                                 onChange={ev => patchItem("emails", i, "body", ev.target.value)}
                                 placeholder="Body"/>
                      {e.to_email && (
                        <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
                          <input type="checkbox" checked={sendNow.includes(i)}
                                  onChange={() => setSendNow(prev =>
                                    prev.includes(i) ? prev.filter(x=>x!==i) : [...prev, i])}
                                  data-testid={`email-sendnow-${i}`}/>
                          Send now via Gmail (otherwise saved as draft)
                        </label>
                      )}
                      {e.needs_booking_setup && (
                        <div className="text-[10px] text-amber-700">
                          ⚠ Set up your calendar link in CRM → Settings → Meeting links first
                        </div>
                      )}
                    </div>
                  ))}
                </Section>
              )}

              {!mn && appts.length === 0 && tasks.length === 0 && emails.length === 0 && (
                <div className="text-center py-6 text-sm text-slate-500">
                  I couldn't extract any actionable items from what you said.
                </div>
              )}
            </>
          )}
        </div>

        {/* footer */}
        {phase !== "parsing" && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-100 bg-slate-50/50">
            <button onClick={closeModal} className="text-sm text-slate-600 hover:text-slate-900"
                     disabled={phase === "executing"} data-testid="voice-review-cancel">
              Cancel
            </button>
            <div className="flex-1"/>
            <button onClick={() => confirmAll({ withSends: true })}
                     disabled={phase === "executing" || totalIncluded() === 0}
                     data-testid="voice-review-confirm"
                     className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-50">
              {phase === "executing" ? <Loader2 size={13} className="animate-spin"/> : <CheckSquare size={13}/>}
              Confirm all
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── little primitives ─────────────────────────────────────────
const TONES = {
  emerald: "bg-emerald-50 text-emerald-700",
  amber:   "bg-amber-50 text-amber-700",
  sky:     "bg-sky-50 text-sky-700",
  cyan:    "bg-cyan-50 text-cyan-700",
};
function Section({ title, icon: Icon, tone, count, total, checked, onCheck,
                    expanded, onToggle, testid, children }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white" data-testid={testid}>
      <button onClick={onToggle}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 rounded-lg">
        {onCheck !== undefined ? (
          <input type="checkbox" checked={!!checked} onClick={e => e.stopPropagation()}
                  onChange={onCheck}
                  data-testid={`${testid}-check`}/>
        ) : null}
        <div className={`w-6 h-6 rounded flex items-center justify-center ${TONES[tone]}`}><Icon size={13}/></div>
        <div className="flex-1 text-sm font-medium text-slate-800">{title}</div>
        <span className="text-[11px] text-slate-500">
          {total !== undefined ? `${count}/${total}` : count > 0 ? "1 selected" : "not selected"}
        </span>
        {expanded ? <ChevronDown size={14} className="text-slate-400"/> : <ChevronRight size={14} className="text-slate-400"/>}
      </button>
      {expanded && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
}
function Row({ idx, section, inc, toggle, children }) {
  return (
    <div className="flex items-center gap-2">
      <input type="checkbox" checked={inc[section].includes(idx)}
              onChange={() => toggle(section, idx)}
              data-testid={`${section}-check-${idx}`}/>
      {children}
    </div>
  );
}
function ContactChip({ contact, hint }) {
  if (contact) return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-700">
      <User size={11}/> {contact.name}
      {contact.email && <span className="text-slate-400">· {contact.email}</span>}
    </span>
  );
  if (hint) return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-700 italic">
      <User size={11}/> "{hint}" — not in CRM
    </span>
  );
  return null;
}
