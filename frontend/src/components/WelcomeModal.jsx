// WelcomeModal — first-time SmartBooks welcome overlay with typewriter
// animation + TTS narration. Fires once per user on their first landing
// at /dashboard (persisted via localStorage `smartbooks_welcome_seen`),
// and re-fires on demand via the "Replay welcome" button on the
// Dashboard.
//
// Speech uses the browser's built-in `speechSynthesis` API — no server
// round-trip, no LLM cost, no muted-tab issues. If speech is unavailable
// (older Firefox, some enterprise-locked-down browsers) we still show
// the typewriter — the modal degrades gracefully to a text-only tour.
//
// The typewriter revs at a fixed 22 chars/sec so the reveal reads at a
// comfortable pace independent of the TTS voice speed (which varies
// wildly by OS + language). Skip button pins to top-right so a user
// who's seen it before can bail out instantly.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { X, Play, ChevronRight, Sparkles, Volume2, MessageSquare } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";

const SLIDES = [
  {
    title: (name, brand) => `Hello ${name || "there"}, welcome to ${brand}!`,
    body:
      "I'm your AI-powered accountant — think of me as a bookkeeper who never sleeps, minus the billable hours.",
  },
  {
    title: () => "Here's what I do all day",
    body:
      "I categorize every transaction, post the journal entries, chase down statements you haven't uploaded, and flag anything that doesn't look right — all before your first cup of coffee.",
  },
  {
    // Last slide is action-only — the user chooses how they want to
    // continue instead of the tour auto-closing. Copy is intentionally
    // short so it doesn't dwarf the two big CTAs.
    title: () => "Ready? Let's onboard your company",
    body:
      "Next up: a quick company setup. I'll be right there every step of the way — you pick how loud I should be.",
    isCta: true,
  },
];

const TYPE_SPEED_MS = 45; // ~22 chars/sec, matches natural speaking cadence
// Extra pause after a slide finishes reading before we auto-advance —
// gives the user a beat to absorb before the next line drops in.
const AUTO_ADVANCE_PAUSE_MS = 1200;
// The voice picker in AiPanel writes this key. Reusing it means the
// welcome tour speaks in whatever voice the client has chosen for the
// day-to-day assistant — no separate UI to configure twice.
const VOICE_LS_KEY = "axiom_tts_voice";

function pickVoice() {
  if (!("speechSynthesis" in window)) return null;
  const prefName = (() => {
    try { return localStorage.getItem(VOICE_LS_KEY) || "Google UK English Female"; }
    catch { return "Google UK English Female"; }
  })();
  const voices = window.speechSynthesis.getVoices() || [];
  // Exact match wins, then case-insensitive contains, then any en-GB
  // female-ish fallback so we're still on the same continent if the
  // preferred voice isn't installed on this device.
  const exact = voices.find((v) => v.name === prefName);
  if (exact) return exact;
  const nameCI = voices.find((v) => v.name.toLowerCase().includes(prefName.toLowerCase()));
  if (nameCI) return nameCI;
  const gb = voices.find((v) => (v.lang || "").toLowerCase().startsWith("en-gb"));
  if (gb) return gb;
  return voices[0] || null;
}

export function markWelcomeSeen(uid) {
  try { localStorage.setItem(`smartbooks_welcome_seen:${uid}`, "1"); } catch { /* quota */ }
}
export function hasSeenWelcome(uid) {
  try { return localStorage.getItem(`smartbooks_welcome_seen:${uid}`) === "1"; } catch { return false; }
}

export default function WelcomeModal({ open, onClose }) {
  const { user } = useAuth();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const [slideIdx, setSlideIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState(false);
  const typerRef = useRef(null);
  const speakRef = useRef(null);

  const firstName = (user?.name || "").split(" ")[0];
  const brandName = branding?.firm_name || "SmartBooks";
  const slide = SLIDES[slideIdx];
  const fullBody = slide ? slide.body : "";
  const title = slide ? slide.title(firstName, brandName) : "";
  const isCtaSlide = !!slide?.isCta;

  // Whenever the modal transitions from closed → open, snap back to
  // slide 0 so "Replay welcome" always plays from the top instead of
  // resuming wherever the previous session was dismissed.
  useEffect(() => {
    if (open) setSlideIdx(0);
  }, [open]);

  // Reset state whenever the modal opens or the current slide changes.
  useEffect(() => {
    if (!open) return;
    setTyped("");
    setDone(false);
    // Kick off typing + speaking together.
    let i = 0;
    typerRef.current && clearInterval(typerRef.current);
    typerRef.current = setInterval(() => {
      i += 1;
      setTyped(fullBody.slice(0, i));
      if (i >= fullBody.length) {
        clearInterval(typerRef.current);
        setDone(true);
      }
    }, TYPE_SPEED_MS);

    // Speak title + body. Cancel any prior utterance so slide-jumps
    // don't stack up. Voice choice mirrors the user's assistant-panel
    // preference (`localStorage.axiom_tts_voice`) so the welcome sounds
    // the same as the day-to-day AI replies.
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(`${title}. ${fullBody}`);
      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang || "en-GB"; }
      speakRef.current = u;
      // Some browsers (Chromium) fire `voiceschanged` async — if the
      // voice list wasn't ready, retry once after ~120ms.
      if (!v) {
        setTimeout(() => {
          const late = pickVoice();
          if (late) { u.voice = late; u.lang = late.lang || "en-GB"; }
          window.speechSynthesis.speak(u);
        }, 120);
      } else {
        window.speechSynthesis.speak(u);
      }
    }
    return () => {
      typerRef.current && clearInterval(typerRef.current);
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [open, slideIdx, fullBody, title]);

  // Auto-advance to the next slide once BOTH the typewriter finished
  // AND the TTS utterance ended (or the pause elapsed if speech isn't
  // available). On the CTA slide we do NOT auto-close — the user must
  // pick "Onboard with sound" or "Onboard with chat only" so they've
  // made an intentional decision about the audio companion.
  useEffect(() => {
    if (!open || !done) return;
    if (isCtaSlide) return;
    const isLast = slideIdx === SLIDES.length - 1;
    const startAt = Date.now();
    const ttsIdle = () =>
      !("speechSynthesis" in window)
      || (!window.speechSynthesis.speaking && !window.speechSynthesis.pending);
    let advTimer = null;
    const tick = setInterval(() => {
      if (ttsIdle() && Date.now() - startAt >= AUTO_ADVANCE_PAUSE_MS) {
        clearInterval(tick);
        if (isLast) onClose();
        else setSlideIdx((i) => i + 1);
      }
    }, 200);
    return () => { clearInterval(tick); advTimer && clearTimeout(advTimer); };
  }, [open, done, slideIdx, onClose, isCtaSlide]);

  // Stop TTS + cleanup when the modal itself closes.
  useEffect(() => {
    if (open) return;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    typerRef.current && clearInterval(typerRef.current);
  }, [open]);

  if (!open) return null;

  const isLast = slideIdx === SLIDES.length - 1;
  const handleNext = () => {
    if (!done && slide) {
      // Fast-forward the current slide instead of skipping — nicer UX
      // than an abrupt "you missed my line" jump.
      setTyped(fullBody);
      setDone(true);
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      return;
    }
    if (isLast) onClose();
    else setSlideIdx((i) => i + 1);
  };

  // CTA buttons on the final slide. Persists the user's TTS choice via
  // the same localStorage key AiPanel uses (`axiom_tts`), then closes
  // the welcome + navigates straight to /onboarding so the transition
  // is one click.
  const startOnboarding = (withSound) => {
    try { localStorage.setItem("axiom_tts", withSound ? "1" : "0"); } catch { /* quota */ }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    onClose();
    navigate("/onboarding");
  };

  return (
    <div
      className="fixed inset-0 z-[900] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
      data-testid="welcome-modal"
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1 rounded-full hover:bg-slate-100 text-slate-500"
          data-testid="welcome-modal-close"
          aria-label="Close welcome"
        >
          <X size={16} />
        </button>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-cyan-700 mb-3">
          <Sparkles size={11} /> Assistant
        </div>
        <h2 className="font-heading text-2xl font-bold text-slate-900 mb-3 leading-tight">
          {title}
        </h2>
        <p className="text-sm text-slate-600 leading-relaxed min-h-[72px]" data-testid="welcome-modal-body">
          {typed}
          {!done && <span className="inline-block w-[1px] h-[14px] bg-slate-700 align-middle animate-pulse ml-[1px]" />}
        </p>
        <div className="mt-6 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1" data-testid="welcome-modal-dots">
            {SLIDES.map((_, i) => (
              <span
                key={i}
                className={`w-1.5 h-1.5 rounded-full transition ${
                  i === slideIdx ? "bg-slate-900 w-4" : "bg-slate-300"
                }`}
              />
            ))}
          </div>
          {isCtaSlide ? (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => startOnboarding(true)}
                data-testid="welcome-onboard-sound"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-800"
                title="Continue with the AI narration turned on"
              >
                <Volume2 size={13} /> Onboard with sound
              </button>
              <button
                onClick={() => startOnboarding(false)}
                data-testid="welcome-onboard-chat-only"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50"
                title="Continue with chat only — I'll stop reading things out loud"
              >
                <MessageSquare size={13} /> Onboard with chat only
              </button>
            </div>
          ) : (
            <button
              onClick={handleNext}
              data-testid="welcome-modal-next"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-800"
            >
              {!done ? "Skip line" : "Next"}
              <ChevronRight size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Small header button clients can click to re-play the welcome tour.
export function ReplayWelcomeButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      data-testid="welcome-replay-btn"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-600 hover:text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50 text-xs"
      title="Replay the welcome tour"
    >
      <Play size={11} /> Replay welcome
    </button>
  );
}
