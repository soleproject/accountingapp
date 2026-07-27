// Step2Tour — walks a first-time client through the "AI Transaction
// Questions" page (Let's Review, one contact at a time). Highlights the
// contact info box, the AI mic, the category dropdown, the Approve
// button, and the split-in-chat workflow. Mirrors the CleanupCopilot
// tour's shape: narration bubbles get streamed into the AI panel while
// this component paints per-step highlights on the target elements.
//
// Auto-fires when the parent page is loaded with `?tour=1` AND this
// user × company hasn't seen it yet (localStorage `step2_tour_seen:
// {uid}:{cid}`). Skippable at any time via the toolbar Stop button
// rendered inside the tour pill.
import { useEffect, useRef, useState } from "react";
import { X, Volume2, VolumeX, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";
import { emitAction } from "@/lib/createBus";

const STEPS = [
  {
    text: "Welcome to Step 2 — the one-contact-at-a-time queue. I'll show you every uncategorized transaction for a single contact so you can knock them all out in one shot.",
    targetTestId: "lets-review-info-box",
  },
  {
    text: "The contact box in the top-right is who we're on right now. It shows the contact name, how many transactions they have, and the total dollar amount they represent.",
    targetTestId: "lets-review-info-box",
  },
  {
    text: "Fastest way to categorize? Just talk to me. Tap this microphone in the assistant panel and tell me what this contact does — say 'this is our landscaper', or 'this is a Walmart purchase for office supplies' — and I'll categorize every one of their transactions for you.",
    targetTestId: "ai-chat-mic",
  },
  {
    text: "Prefer to pick manually? Use this category dropdown right in the contact box. I'll preview the change across every row before you save.",
    targetTestId: "lets-review-bulk-category",
  },
  {
    text: "Happy with the category? Hit Approve — every row for this contact gets stamped at once. Or if you prefer, approve individual rows in the table below.",
    targetTestId: "lets-review-bulk-approve",
  },
  {
    text: "Got a mix? Say this contact has four transactions — three are income and one is a loan repayment. Just tell me in the chat, 'these three are income, the last one is a loan payment', and I'll split the categorization automatically. No copy-pasting.",
    targetTestId: "ai-chat-input",
  },
  {
    text: "When you're done with this contact, click Next to jump to the next one. Prev walks you back. You can rip through dozens of contacts in minutes.",
    targetTestId: "lets-review-next",
  },
  {
    text: "That's the whole flow. Talk to me, or pick from the dropdown — either way I'll do the heavy lifting. Ready when you are.",
    targetTestId: "lets-review-info-box",
  },
];

const HIGHLIGHT_STYLE = "0 0 0 3px rgba(6,182,212,0.75), 0 8px 24px -4px rgba(6,182,212,0.55)";

function stripMd(s) { return (s || "").replace(/[*_`~#>]/g, ""); }

function speakAsync(text, minMs = 3200) {
  return new Promise(resolve => {
    const start = Date.now();
    const finish = () => {
      const elapsed = Date.now() - start;
      setTimeout(resolve, Math.max(0, minMs - elapsed));
    };
    let muted = false;
    try { muted = localStorage.getItem("axiom_tts") === "0"; } catch { /* ignore */ }
    if (typeof window === "undefined" || !window.speechSynthesis || muted) return finish();
    const clean = stripMd(text);
    if (!clean) return finish();
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.02; u.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices() || [];
    const pref = (() => { try { return localStorage.getItem("axiom_tts_voice") || "Google UK English Female"; } catch { return "Google UK English Female"; } })();
    const pick =
      voices.find(v => v.name === pref) ||
      voices.find(v => v.name.toLowerCase().includes(pref.toLowerCase())) ||
      voices.find(v => v.lang === "en-GB" && /female/i.test(v.name)) ||
      voices.find(v => v.lang === "en-GB") ||
      voices.find(v => v.lang?.startsWith("en") && /female/i.test(v.name)) ||
      null;
    if (pick) { u.voice = pick; u.lang = pick.lang || "en-GB"; }
    u.onend = finish; u.onerror = finish;
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    try { window.speechSynthesis.speak(u); } catch { /* ignore */ }
  });
}

export function hasSeenStep2Tour(uid, cid) {
  if (!uid || !cid) return false;
  try { return localStorage.getItem(`step2_tour_seen:${uid}:${cid}`) === "1"; }
  catch { return false; }
}
export function markStep2TourSeen(uid, cid) {
  if (!uid || !cid) return;
  try { localStorage.setItem(`step2_tour_seen:${uid}:${cid}`, "1"); } catch { /* ignore */ }
}

// Applies a temporary cyan halo to the DOM element identified by
// `data-testid`. Snapshots the previous inline styles so we can restore
// them cleanly when the tour advances (React re-renders would otherwise
// clobber our imperative changes).
function highlight(testId) {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) return () => {};
  const prev = {
    boxShadow: el.style.boxShadow,
    transition: el.style.transition,
    borderRadius: el.style.borderRadius,
    outline: el.style.outline,
  };
  el.style.transition = "box-shadow 0.4s ease-out";
  el.style.borderRadius = el.style.borderRadius || "10px";
  el.style.boxShadow = HIGHLIGHT_STYLE;
  try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* ignore */ }
  return () => {
    el.style.boxShadow = prev.boxShadow;
    el.style.transition = prev.transition;
    el.style.borderRadius = prev.borderRadius;
    el.style.outline = prev.outline;
  };
}

export default function Step2Tour({ open, onDone }) {
  const { user } = useAuth();
  const { currentId } = useCompany();
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("axiom_tts") === "0"; } catch { return false; } });
  const abortRef = useRef(false);
  const cleanupRef = useRef(() => {});

  const toggleMute = () => {
    setMuted(m => {
      const nm = !m;
      try { localStorage.setItem("axiom_tts", nm ? "0" : "1"); } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent("axiom-tts-changed", { detail: { on: !nm } }));
      if (nm && "speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
      return nm;
    });
  };

  useEffect(() => {
    if (!open) return;
    setRunning(true);
    abortRef.current = false;
    // Make sure the AI panel is visible so the narration bubbles land somewhere.
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
        await new Promise(r => setTimeout(r, 400));
      }
      cleanupRef.current();
      cleanupRef.current = () => {};
      if (!abortRef.current) {
        emitAction("ai-chat-say-with-cta", {
          message: "That's Step 2 in a nutshell. Ready to categorize your first contact?",
          cta: { label: "Re-play tour", action: "chat-cta:restart-step2-tour" },
        });
      }
      setRunning(false);
      if (user?.id && currentId) markStep2TourSeen(user.id, currentId);
      onDone && onDone();
    })();
    return () => {
      abortRef.current = true;
      cleanupRef.current();
      cleanupRef.current = () => {};
      try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || !running) return null;

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[900] rounded-xl bg-slate-900 text-white shadow-2xl px-4 py-3 border border-slate-700 max-w-md"
      data-testid="step2-tour-pill"
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="text-[10px] uppercase tracking-widest text-cyan-300 font-semibold inline-flex items-center gap-1">
          <Sparkles size={11} /> Step 2 tour · {step + 1} of {STEPS.length}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleMute}
            className={`p-1 rounded ${muted ? "text-slate-400" : "text-cyan-300"}`}
            title={muted ? "Turn narration on" : "Turn narration off"}
            data-testid="step2-tour-mute"
          >
            {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </button>
          <button
            onClick={() => { abortRef.current = true; setRunning(false); cleanupRef.current(); try { window.speechSynthesis?.cancel(); } catch {} if (user?.id && currentId) markStep2TourSeen(user.id, currentId); onDone && onDone(); }}
            className="p-1 rounded text-slate-300 hover:text-white"
            title="Skip tour"
            data-testid="step2-tour-skip"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <p className="text-sm leading-snug">{STEPS[step]?.text}</p>
    </div>
  );
}
