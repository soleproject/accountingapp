// Step3BTour — first-time walkthrough for the No-Contact Review page
// (route `/accounting/no-contact-review`). Opens with a "Congrats — 3A
// done!" beat and explains how the AI groups no-contact rows by
// description signature so the CPA can bulk-categorize a whole group
// at once. Ends with a scripted mini-demo showing 3 fake "AMZN Mktp"
// rows getting stamped as Software Subscriptions in one shot.

import { useEffect, useRef, useState } from "react";
import { X, Volume2, VolumeX, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";
import { emitAction } from "@/lib/createBus";
import Step3BGroupDemo from "@/components/Step3BGroupDemo";

const STEPS = [
  {
    text: "Congratulations — Step 3A is done, every intercompany transfer is booked! Time for the final phase: Step 3B, individual review.",
    targetTestId: null,
  },
  {
    text: "These are the leftover transactions that never got tagged with a contact — bank fees, subscription charges, one-off purchases. I've grouped them by similar description so you don't have to categorize them one at a time.",
    targetTestId: "no-contact-review-info-box",
  },
  {
    text: "The group header shows the description signature we found, the number of rows in the group, and the total dollar amount.",
    targetTestId: "no-contact-review-info-box",
  },
  {
    text: "Pick a category from the dropdown, hit Approve, and every row in the group gets stamped at once — same pattern as Step 2, just without a contact name.",
    targetTestId: "no-contact-review-bulk-category",
  },
  {
    text: "Let me show you what that looks like on a real-world example — a batch of Amazon charges.",
    targetTestId: null,
  },
  {
    text: "When you're done with this group, click Next to jump to the next one. Rip through them and you're officially done with the setup checklist.",
    targetTestId: "no-contact-review-next",
  },
];

const HIGHLIGHT_STYLE = "0 0 0 3px rgba(6,182,212,0.75), 0 8px 24px -4px rgba(6,182,212,0.55)";

function stripMd(s) { return (s || "").replace(/[*_`~#>]/g, ""); }
function speakAsync(text, minMs = 3400) {
  return new Promise(resolve => {
    const start = Date.now();
    const finish = () => setTimeout(resolve, Math.max(0, minMs - (Date.now() - start)));
    let muted = false;
    try { muted = localStorage.getItem("axiom_tts") === "0"; } catch {}
    if (typeof window === "undefined" || !window.speechSynthesis || muted) return finish();
    const clean = stripMd(text); if (!clean) return finish();
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.02; u.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices() || [];
    const pref = (() => { try { return localStorage.getItem("axiom_tts_voice") || "Google UK English Female"; } catch { return "Google UK English Female"; } })();
    const pick = voices.find(v => v.name === pref) || voices.find(v => v.lang === "en-GB" && /female/i.test(v.name)) || voices.find(v => v.lang === "en-GB") || voices.find(v => v.lang?.startsWith("en") && /female/i.test(v.name)) || null;
    if (pick) { u.voice = pick; u.lang = pick.lang || "en-GB"; }
    u.onend = finish; u.onerror = finish;
    try { window.speechSynthesis.cancel(); } catch {}
    try { window.speechSynthesis.speak(u); } catch {}
  });
}

export function hasSeenStep3BTour(uid, cid) {
  if (!uid || !cid) return false;
  try { return localStorage.getItem(`step3b_tour_seen:${uid}:${cid}`) === "1"; } catch { return false; }
}
export function markStep3BTourSeen(uid, cid) {
  if (!uid || !cid) return;
  try { localStorage.setItem(`step3b_tour_seen:${uid}:${cid}`, "1"); } catch {}
}

function highlight(testId) {
  if (!testId) return () => {};
  const style = document.createElement("style");
  style.setAttribute("data-step3b-tour-highlight", "1");
  style.textContent = `[data-testid="${testId}"] { box-shadow: ${HIGHLIGHT_STYLE} !important; transition: box-shadow 0.4s ease-out !important; border-radius: 10px !important; }`;
  document.head.appendChild(style);
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (el) { try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* ignore */ } }
  return () => { try { style.remove(); } catch { /* ignore */ } };
}

export default function Step3BTour({ open, onDone }) {
  const { user } = useAuth();
  const { currentId } = useCompany();
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("axiom_tts") === "0"; } catch { return false; } });
  const [demoOpen, setDemoOpen] = useState(false);
  const demoResolverRef = useRef(null);
  const abortRef = useRef(false);
  const cleanupRef = useRef(() => {});

  const toggleMute = () => {
    setMuted(m => {
      const nm = !m;
      try { localStorage.setItem("axiom_tts", nm ? "0" : "1"); } catch {}
      window.dispatchEvent(new CustomEvent("axiom-tts-changed", { detail: { on: !nm } }));
      if (nm && "speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch {} }
      return nm;
    });
  };

  useEffect(() => {
    if (!open) return;
    setRunning(true);
    abortRef.current = false;
    emitAction("ai-open");
    (async () => {
      for (let i = 0; i < STEPS.length; i++) {
        if (abortRef.current) break;
        setStep(i);
        cleanupRef.current();
        cleanupRef.current = highlight(STEPS[i].targetTestId);
        emitAction("ai-chat-say", { message: STEPS[i].text });
        const minMs = Math.max(3400, STEPS[i].text.length * 55);
        await speakAsync(STEPS[i].text, minMs);
        if (abortRef.current) break;
        // Fire the group demo modal after step 4 ("Let me show you...")
        if (i === 4) {
          cleanupRef.current(); cleanupRef.current = () => {};
          try { window.speechSynthesis?.cancel(); } catch {}
          setDemoOpen(true);
          await new Promise(r => { demoResolverRef.current = r; });
          if (abortRef.current) break;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      cleanupRef.current(); cleanupRef.current = () => {};
      setRunning(false);
      if (user?.id && currentId) markStep3BTourSeen(user.id, currentId);
      onDone && onDone();
    })();
    return () => {
      abortRef.current = true;
      cleanupRef.current();
      try { window.speechSynthesis?.cancel(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const closeDemo = () => {
    setDemoOpen(false);
    const r = demoResolverRef.current; demoResolverRef.current = null;
    if (r) r();
  };

  if (!open) return null;
  return (
    <>
      {running && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[900] rounded-xl bg-slate-900 text-white shadow-2xl px-4 py-3 border border-slate-700 max-w-md" data-testid="step3b-tour-pill">
          <div className="flex items-center justify-between gap-3 mb-1">
            <div className="text-[10px] uppercase tracking-widest text-cyan-300 font-semibold inline-flex items-center gap-1">
              <Sparkles size={11} /> Step 3B tour · {step + 1} of {STEPS.length}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={toggleMute} className={`p-1 rounded ${muted ? "text-slate-400" : "text-cyan-300"}`} data-testid="step3b-tour-mute">
                {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
              </button>
              <button onClick={() => { abortRef.current = true; setRunning(false); cleanupRef.current(); try { window.speechSynthesis?.cancel(); } catch {} if (user?.id && currentId) markStep3BTourSeen(user.id, currentId); onDone && onDone(); const r = demoResolverRef.current; demoResolverRef.current = null; if (r) r(); setDemoOpen(false); }} className="p-1 rounded text-slate-300 hover:text-white" data-testid="step3b-tour-skip">
                <X size={12} />
              </button>
            </div>
          </div>
          <p className="text-sm leading-snug">{STEPS[step]?.text}</p>
        </div>
      )}
      <Step3BGroupDemo open={demoOpen} onDone={closeDemo} />
    </>
  );
}
