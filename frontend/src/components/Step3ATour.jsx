// Step3ATour — first-time walkthrough for the Intercompany Transfer
// Review page (route `/accounting/transfer-review`). Opens with a
// "Congratulations, Step 2 is done!" beat and walks the client through
// what an intercompany transfer is, how the confidence badge works,
// Inspect vs bulk-approve, and finishes with a scripted mini-demo
// showing a fake $1,000 Chase → Wells pair being booked. Same shape
// and shell as `Step2Tour` — see it for architectural notes.

import { useEffect, useRef, useState } from "react";
import { X, Volume2, VolumeX, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";
import { emitAction } from "@/lib/createBus";
import Step3ATransferDemo from "@/components/Step3ATransferDemo";

const STEPS = [
  {
    text: "Congratulations — Step 2 is behind you! Every contact with real data is now categorized. Time for Step 3A: intercompany transfers.",
    targetTestId: null,
  },
  {
    text: "An intercompany transfer is money moving between two of your OWN bank accounts — Chase to Wells, or your business checking to your savings. It should never hit your Profit & Loss.",
    targetTestId: "transfer-review-info-box",
  },
  {
    text: "I've scanned your unreviewed transactions for matching pairs — same amount, opposite sign, different bank accounts, within a three-day window. Each pair gets a confidence score.",
    targetTestId: "transfer-conf-badge",
  },
  {
    text: "Green pairs — 95%+ confidence, same-day — are safe to bulk-approve. Amber ones want a second look before you book them.",
    targetTestId: "transfer-conf-badge",
  },
  {
    text: "Let me show you what happens when you approve one — I'll walk through a fake pair so you can see both sides of the booking.",
    targetTestId: null,
  },
  {
    text: "Once you're happy, use the checkboxes to book multiple pairs at once, or hit Inspect for a side-by-side view. When Step 3A is done we'll move to Step 3B — your no-contact rows.",
    targetTestId: "transfer-approve-all-group",
  },
];

const HIGHLIGHT_STYLE = "0 0 0 3px rgba(6,182,212,0.75), 0 8px 24px -4px rgba(6,182,212,0.55)";

function stripMd(s) { return (s || "").replace(/[*_`~#>]/g, ""); }
function speakAsync(text, minMs = 3400) {
  return new Promise(resolve => {
    const start = Date.now();
    const finish = () => setTimeout(resolve, Math.max(0, minMs - (Date.now() - start)));
    let muted = false;
    try { muted = localStorage.getItem("axiom_tts") === "0"; } catch { /* ignore */ }
    if (typeof window === "undefined" || !window.speechSynthesis || muted) return finish();
    const clean = stripMd(text); if (!clean) return finish();
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.02; u.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices() || [];
    const pref = (() => { try { return localStorage.getItem("axiom_tts_voice") || "Google UK English Female"; } catch { return "Google UK English Female"; } })();
    const pick =
      voices.find(v => v.name === pref) ||
      voices.find(v => v.lang === "en-GB" && /female/i.test(v.name)) ||
      voices.find(v => v.lang === "en-GB") ||
      voices.find(v => v.lang?.startsWith("en") && /female/i.test(v.name)) || null;
    if (pick) { u.voice = pick; u.lang = pick.lang || "en-GB"; }
    u.onend = finish; u.onerror = finish;
    try { window.speechSynthesis.cancel(); } catch {}
    try { window.speechSynthesis.speak(u); } catch {}
  });
}

export function hasSeenStep3ATour(uid, cid) {
  if (!uid || !cid) return false;
  try { return localStorage.getItem(`step3a_tour_seen:${uid}:${cid}`) === "1"; } catch { return false; }
}
export function markStep3ATourSeen(uid, cid) {
  if (!uid || !cid) return;
  try { localStorage.setItem(`step3a_tour_seen:${uid}:${cid}`, "1"); } catch {}
}

function highlight(testId) {
  if (!testId) return () => {};
  const style = document.createElement("style");
  style.setAttribute("data-step3a-tour-highlight", "1");
  style.textContent = `[data-testid="${testId}"] { box-shadow: ${HIGHLIGHT_STYLE} !important; transition: box-shadow 0.4s ease-out !important; border-radius: 10px !important; }`;
  document.head.appendChild(style);
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (el) { try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* ignore */ } }
  return () => { try { style.remove(); } catch { /* ignore */ } };
}

export default function Step3ATour({ open, onDone }) {
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
        // Fire the transfer demo modal after step index 4 ("Let me show you...")
        if (i === 4) {
          cleanupRef.current();
          cleanupRef.current = () => {};
          try { window.speechSynthesis?.cancel(); } catch {}
          setDemoOpen(true);
          await new Promise(r => { demoResolverRef.current = r; });
          if (abortRef.current) break;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      cleanupRef.current(); cleanupRef.current = () => {};
      setRunning(false);
      if (user?.id && currentId) markStep3ATourSeen(user.id, currentId);
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
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[900] rounded-xl bg-slate-900 text-white shadow-2xl px-4 py-3 border border-slate-700 max-w-md" data-testid="step3a-tour-pill">
          <div className="flex items-center justify-between gap-3 mb-1">
            <div className="text-[10px] uppercase tracking-widest text-cyan-300 font-semibold inline-flex items-center gap-1">
              <Sparkles size={11} /> Step 3A tour · {step + 1} of {STEPS.length}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={toggleMute} className={`p-1 rounded ${muted ? "text-slate-400" : "text-cyan-300"}`} title={muted ? "Narration off" : "Narration on"} data-testid="step3a-tour-mute">
                {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
              </button>
              <button onClick={() => { abortRef.current = true; setRunning(false); cleanupRef.current(); try { window.speechSynthesis?.cancel(); } catch {} if (user?.id && currentId) markStep3ATourSeen(user.id, currentId); onDone && onDone(); const r = demoResolverRef.current; demoResolverRef.current = null; if (r) r(); setDemoOpen(false); }} className="p-1 rounded text-slate-300 hover:text-white" title="Skip tour" data-testid="step3a-tour-skip">
                <X size={12} />
              </button>
            </div>
          </div>
          <p className="text-sm leading-snug">{STEPS[step]?.text}</p>
        </div>
      )}
      <Step3ATransferDemo open={demoOpen} onDone={closeDemo} />
    </>
  );
}
