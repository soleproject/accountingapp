/**
 * VoiceRecapReview — multi-section review panel for AI meeting recaps
 * (Phase 1.5, Feb 2026).
 *
 * User: "I just had a call with Bob at Nexxsuite. He's pushing back
 * on pricing. I need to send him a multi-year quote by Friday and
 * loop Sarah in on the CS plan."
 *
 * We parse the whole monologue with Sonnet 4.6 and show:
 *   • Meeting card  — auto-linked to today's GCal event if possible
 *   • Tasks         — each editable (title/due/priority/assignee)
 *   • Emails        — draft body previewed; per-email Save-as-Draft (default) / Send
 *
 * NEVER auto-sends. Send only fires when the user explicitly picks it
 * per-email; ambiguous → Save-as-Draft.
 */
import { useEffect, useRef, useState } from "react";
import {
  CalendarCheck, CheckSquare, Mail, User, Clock, Loader2, X, Send,
  MessageCircle, Sparkles, Save, Trash2, Link as LinkIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

export const VOICE_RECAP_EVENT = "axiom:voice-recap";
export function emitVoiceRecap(payload) {
  window.dispatchEvent(new CustomEvent(VOICE_RECAP_EVENT, { detail: payload }));
}


export default function VoiceRecapReview() {
  const { currentId } = useCompany();
  const [open, setOpen]     = useState(false);
  const [phase, setPhase]   = useState("parsing");
  const [orig, setOrig]     = useState("");
  const [data, setData]     = useState(null);
  const [savingIx, setSaving] = useState(null);

  useEffect(() => {
    const onEvent = async (e) => {
      const text = (e.detail?.text || "").trim();
      if (!text || !currentId) return;
      setOrig(text); setData(null);
      setOpen(true); setPhase("parsing");
      try {
        const r = await api.post("/voice/actions/parse-recap", {
          text, company_id: currentId,
          current_iso: new Date().toISOString(),
        });
        if (!r.data.meeting || Object.keys(r.data.meeting || {}).length === 0) {
          toast.error("Couldn't extract anything from that recap.");
          setOpen(false);
          return;
        }
        // Add per-email disposition defaulting to draft
        const emails = (r.data.emails || []).map(e => ({ ...e, disposition: "draft", skip: false }));
        const tasks  = (r.data.tasks || []).map(t => ({ ...t, skip: false }));
        setData({ ...r.data, tasks, emails });
        setPhase("ready");
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Parse failed");
        setOpen(false);
      }
    };
    window.addEventListener(VOICE_RECAP_EVENT, onEvent);
    return () => window.removeEventListener(VOICE_RECAP_EVENT, onEvent);
  }, [currentId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line
  }, [open]);

  const close = () => { setOpen(false); setData(null); setPhase("parsing"); };

  const patchMeeting = (k, v) => setData(d => ({ ...d, meeting: { ...d.meeting, [k]: v } }));
  const patchTask = (ix, k, v) => setData(d => {
    const tasks = d.tasks.slice(); tasks[ix] = { ...tasks[ix], [k]: v };
    return { ...d, tasks };
  });
  const patchEmail = (ix, k, v) => setData(d => {
    const emails = d.emails.slice(); emails[ix] = { ...emails[ix], [k]: v };
    return { ...d, emails };
  });

  const confirm = async () => {
    if (!data || phase === "executing") return;
    setPhase("executing");
    try {
      const tasks = (data.tasks || []).filter(t => !t.skip);
      const emails = (data.emails || []).filter(e => !e.skip);
      const r = await api.post("/voice/actions/execute-recap", {
        company_id: currentId,
        meeting:    data.meeting,
        tasks:      tasks.map(t => ({
          title:    t.title,
          assignee: t.assignee || null,
          due_iso:  t.due_iso || null,
          priority: t.priority || "medium",
        })),
        emails: emails.map(e => ({
          recipient:   e.recipient || null,
          subject:     e.subject,
          body:        e.body,
          disposition: e.disposition || "draft",
        })),
        original_text: orig,
      });
      const a = r.data.action;
      toast.success(a.summary || "Recap saved");
      setTimeout(close, 800);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Save failed");
      setPhase("ready");
    }
  };

  if (!open) return null;

  const meeting = data?.meeting || {};
  const tasks   = data?.tasks || [];
  const emails  = data?.emails || [];
  const questions = data?.questions || [];
  const linked  = meeting.linked_gcal_event;

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40"
         data-testid="voice-recap-modal"
         onClick={close}>
      <div onClick={e => e.stopPropagation()}
            className="bg-white rounded-xl w-full max-w-2xl mx-3 shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* header */}
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-3 flex items-center gap-2 z-10">
          <div className="w-8 h-8 rounded-md bg-violet-100 text-violet-600 flex items-center justify-center">
            <Sparkles size={16}/>
          </div>
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
              Meeting recap
            </div>
            <div className="text-sm font-semibold text-slate-900">
              {phase === "parsing" ? "Extracting your recap…" : "Review & save"}
            </div>
          </div>
          <button onClick={close}
                  data-testid="voice-recap-close"
                  className="p-1 rounded hover:bg-slate-100 text-slate-400">
            <X size={16}/>
          </button>
        </div>

        {phase === "parsing" && (
          <div className="p-8 text-center text-slate-500">
            <Loader2 size={22} className="animate-spin mx-auto mb-3 text-violet-500"/>
            <div className="text-xs italic max-w-md mx-auto">"{orig}"</div>
          </div>
        )}

        {phase !== "parsing" && data && (
          <div className="p-5 space-y-4">
            <div className="text-[11px] text-slate-500 italic">
              You said: "{orig}"
            </div>

            {/* MEETING CARD */}
            <section data-testid="voice-recap-meeting"
                      className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-6 h-6 rounded bg-emerald-50 text-emerald-600 flex items-center justify-center">
                  <CalendarCheck size={13}/>
                </div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold flex-1">
                  Meeting
                </div>
                {linked?.id ? (
                  <a href={linked.html_link || "#"} target="_blank" rel="noreferrer"
                      className="text-[10px] text-cyan-600 hover:text-cyan-700 inline-flex items-center gap-0.5">
                    <LinkIcon size={10}/> Linked to GCal event
                  </a>
                ) : (
                  <span className="text-[10px] text-slate-400 italic">Not linked</span>
                )}
              </div>
              <input value={meeting.title || ""}
                      onChange={e => patchMeeting("title", e.target.value)}
                      data-testid="voice-recap-title"
                      placeholder="Meeting title"
                      className="w-full text-sm font-medium px-2.5 py-1.5 border border-slate-300 rounded mb-2"/>
              <textarea value={meeting.summary || ""}
                          onChange={e => patchMeeting("summary", e.target.value)}
                          data-testid="voice-recap-summary"
                          placeholder="Summary (2-4 sentences)"
                          rows={3}
                          className="w-full text-xs px-2.5 py-1.5 border border-slate-300 rounded"/>
              {meeting.resolved_contact ? (
                <div className="mt-2 text-[11px] text-slate-500">
                  <User size={10} className="inline mr-1"/>
                  {meeting.resolved_contact.name}
                  {meeting.resolved_contact.email && (
                    <span className="text-slate-400"> · {meeting.resolved_contact.email}</span>
                  )}
                </div>
              ) : meeting.contact_hint ? (
                <div className="mt-2 text-[11px] italic text-amber-600">
                  "{meeting.contact_hint}" — not in your CRM
                </div>
              ) : null}
            </section>

            {/* CLARIFICATIONS */}
            {questions.length > 0 && (
              <div className="rounded-lg bg-violet-50 border border-violet-200 p-3">
                <div className="flex items-center gap-1.5 mb-1 text-violet-800 text-xs font-semibold">
                  <MessageCircle size={12}/> Quick questions
                </div>
                <ul className="space-y-0.5">
                  {questions.map((q, i) => (
                    <li key={i} className="text-xs text-slate-700">• {q}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* TASKS */}
            {tasks.length > 0 && (
              <section data-testid="voice-recap-tasks">
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2 flex items-center gap-1.5">
                  <CheckSquare size={11}/> Tasks · {tasks.filter(t => !t.skip).length}
                </div>
                <ol className="space-y-2">
                  {tasks.map((t, ix) => (
                    <li key={ix}
                        data-testid={`voice-recap-task-${ix}`}
                        className={`rounded-lg border p-2.5 ${t.skip ? "opacity-40 border-slate-200" : "border-slate-200"}`}>
                      <div className="flex items-start gap-2">
                        <input type="checkbox"
                                checked={!t.skip}
                                onChange={e => patchTask(ix, "skip", !e.target.checked)}
                                className="mt-1"/>
                        <div className="flex-1 space-y-1.5">
                          <input value={t.title || ""}
                                  onChange={e => patchTask(ix, "title", e.target.value)}
                                  placeholder="Task"
                                  className="w-full text-sm px-2 py-1 rounded border border-slate-300"/>
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="text-slate-500">Due</span>
                            <input type="datetime-local"
                                    value={toLocal(t.due_iso)}
                                    onChange={e => patchTask(ix, "due_iso", fromLocal(e.target.value))}
                                    className="px-1.5 py-0.5 rounded border border-slate-300"/>
                            <span className="text-slate-500 ml-2">Priority</span>
                            <select value={t.priority || "medium"}
                                    onChange={e => patchTask(ix, "priority", e.target.value)}
                                    className="px-1.5 py-0.5 rounded border border-slate-300">
                              <option>low</option><option>medium</option><option>high</option>
                            </select>
                            {t.assignee?.name && (
                              <span className="ml-auto text-slate-400">
                                <User size={9} className="inline"/> {t.assignee.name}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {/* EMAILS */}
            {emails.length > 0 && (
              <section data-testid="voice-recap-emails">
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2 flex items-center gap-1.5">
                  <Mail size={11}/> Emails · {emails.filter(e => !e.skip).length}
                  <span className="ml-1 text-[9px] text-slate-400 normal-case tracking-normal italic font-normal">
                    review before send — draft by default
                  </span>
                </div>
                <ol className="space-y-2">
                  {emails.map((em, ix) => (
                    <li key={ix}
                        data-testid={`voice-recap-email-${ix}`}
                        className={`rounded-lg border p-2.5 ${em.skip ? "opacity-40 border-slate-200" : "border-slate-200"}`}>
                      <div className="flex items-start gap-2 mb-2">
                        <input type="checkbox"
                                checked={!em.skip}
                                onChange={e => patchEmail(ix, "skip", !e.target.checked)}
                                className="mt-1"/>
                        <div className="flex-1 space-y-1.5">
                          <div className="text-[11px] text-slate-500">
                            To: {em.recipient?.email
                              ? <><b className="text-slate-700">{em.recipient.email}</b>{em.recipient.name ? ` (${em.recipient.name})` : ""}</>
                              : <span className="italic text-amber-600">missing email — will save as draft</span>}
                          </div>
                          <input value={em.subject || ""}
                                  onChange={e => patchEmail(ix, "subject", e.target.value)}
                                  placeholder="Subject"
                                  className="w-full text-sm font-medium px-2 py-1 rounded border border-slate-300"/>
                          <textarea value={em.body || ""}
                                      onChange={e => patchEmail(ix, "body", e.target.value)}
                                      rows={4}
                                      placeholder="Body"
                                      className="w-full text-xs px-2 py-1 rounded border border-slate-300 font-mono"/>
                          <div className="flex items-center gap-1.5">
                            <label className="flex items-center gap-1 text-[11px]">
                              <input type="radio"
                                      checked={em.disposition === "draft"}
                                      onChange={() => patchEmail(ix, "disposition", "draft")}
                                      data-testid={`voice-recap-email-${ix}-draft`}/>
                              <Save size={10}/> Save as draft
                            </label>
                            <label className="flex items-center gap-1 text-[11px] ml-3">
                              <input type="radio"
                                      checked={em.disposition === "send"}
                                      onChange={() => patchEmail(ix, "disposition", "send")}
                                      disabled={!em.recipient?.email}
                                      data-testid={`voice-recap-email-${ix}-send`}/>
                              <Send size={10}/> Send now
                            </label>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {/* footer */}
            <div className="border-t border-slate-100 pt-3 -mx-5 px-5 flex items-center gap-2">
              <button onClick={close}
                      disabled={phase === "executing"}
                      className="text-sm text-slate-600 hover:text-slate-900">
                Cancel
              </button>
              <div className="flex-1"/>
              <button onClick={confirm}
                      disabled={phase === "executing"}
                      data-testid="voice-recap-confirm"
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-50">
                {phase === "executing"
                  ? <Loader2 size={13} className="animate-spin"/>
                  : <CheckSquare size={13}/>}
                Confirm all
              </button>
            </div>
            <div className="text-[10px] text-slate-400 text-center pb-3">
              {data?.model ? <>Parsed by {data.model} · </> : ""}
              Emails default to <b>Save as draft</b> — nothing sends unless you pick it
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// datetime-local helpers
function toLocal(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ""; }
}
function fromLocal(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
