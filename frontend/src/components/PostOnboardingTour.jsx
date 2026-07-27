// PostOnboardingTour — Phases A (congrats) + B (auto-tour of the 3
// dashboard views) fired the first time a client hits /dashboard after
// their company's onboarding flipped to complete. Persists a per-user +
// per-company flag so it never fires twice. Skippable at every phase.
// Reuses the same TTS voice + typewriter cadence as WelcomeModal so it
// feels like a continuation, not a second tour.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { X, Sparkles, Volume2, VolumeX, Landmark, FileUp, ArrowRight, ListChecks } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useBranding } from "@/lib/branding";

const TYPE_MS = 45;
const TOUR_HOLD_MS = 5500; // how long each view stays visible

const seenKey = (uid, cid) => `smartbooks_post_onboarding:${uid}:${cid}`;
export const hasSeenPostOnboarding = (uid, cid) => {
  try { return localStorage.getItem(seenKey(uid, cid)) === "1"; } catch { return false; }
};
export const markPostOnboardingSeen = (uid, cid) => {
  try { localStorage.setItem(seenKey(uid, cid), "1"); } catch { /* quota */ }
};

function pickVoice() {
  if (!("speechSynthesis" in window)) return null;
  const pref = (() => { try { return localStorage.getItem("axiom_tts_voice") || "Google UK English Female"; } catch { return "Google UK English Female"; } })();
  const vs = window.speechSynthesis.getVoices() || [];
  return vs.find(v => v.name === pref) || vs.find(v => v.name.toLowerCase().includes(pref.toLowerCase())) || vs.find(v => (v.lang || "").toLowerCase().startsWith("en-gb")) || vs[0] || null;
}

// Speak `text` and invoke `onDone` when the utterance finishes. When
// muted or speechSynthesis isn't available, returns null and the
// caller falls back to a timing-based advance. Callers should still
// install a length-based safety-net timeout in case `onend` never
// fires (some browsers drop it silently on tab-hide etc).
function speak(text, muted, onDone) {
  if (!("speechSynthesis" in window) || muted) return null;
  try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang || "en-GB"; }
  u.rate = 1.0; u.pitch = 1.0;
  if (typeof onDone === "function") u.onend = onDone;
  try { window.speechSynthesis.speak(u); } catch { /* ignore */ }
  return u;
}

// Slide 0 = congrats modal; slides 1-3 are the tour narrations, rendered
// as a small floating pill on top of the actual dashboard view (which
// switches underneath via `onSwitchView`). Slide 4 = final CTA — shows
// the client's to-dos (if any), an "all set" pat-on-the-back (if the
// company already has data loaded), or a Connect / Upload nudge for
// truly-empty accounts.
export default function PostOnboardingTour({ open, companyName, companyId, todos, hasData, onSwitchView, onDone }) {
  const { user } = useAuth();
  const { branding } = useBranding();
  const [phase, setPhase] = useState(0); // 0=congrats, 1=classic, 2=firm, 3=business, 4=cta, 5=done
  const [typed, setTyped] = useState("");
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("axiom_tts") === "0"; } catch { return false; } });
  const typerRef = useRef(null);
  // Latest-value refs so the phase-advance effect can depend ONLY on
  // `phase`. This prevents React from re-firing the effect (which
  // restarts TTS + typewriter mid-phase) every time the parent
  // dashboard re-renders and passes a new `onSwitchView` reference or
  // the `todos` payload changes.
  const switchRef = useRef(onSwitchView);
  const mutedRef = useRef(muted);
  useEffect(() => { switchRef.current = onSwitchView; }, [onSwitchView]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const firstName = (user?.name || "").split(" ")[0] || "there";
  const brand = branding?.firm_name || "SmartBooks";
  const co = companyName || "your company";

  // Setup-checklist "next step" detection — matches the same logic
  // DashboardTodos uses for its rainbow highlight (first step with
  // count > 0 during Setup mode). When present, Phase 4 spotlights
  // that tile instead of showing a modal.
  const setupSteps = [todos?.step1, todos?.step2, todos?.step3];
  const activeStepIdx = (todos?.visible && todos?.mode === "setup")
    ? setupSteps.findIndex(s => (s?.count ?? 0) > 0)
    : -1;
  const activeStep = activeStepIdx >= 0 ? setupSteps[activeStepIdx] : null;
  const hasSpotlightStep = activeStepIdx >= 0;

  // Fallback mode when there's no active setup step to spotlight.
  const ctaMode = hasData ? "allset" : "connect";

  const scripts = [
    `Congratulations ${firstName}! You've officially onboarded ${co}. Now look to the top-right — I'll walk you through the three dashboard views available to you.`,
    `This is your Classic dashboard — everything at a glance.`,
    `Here's Firm at a Glance — the view I recommend for month-end close.`,
    `And Business Overview — for pattern-spotting across your year.`,
    hasSpotlightStep
      ? `And this is the next step in getting your books done — ${activeStep?.title || "let's tackle this one first"}. Click Review when you're ready and I'll show you what to do next.`
      : ctaMode === "allset"
      ? `You're all set. Your data is loaded — happy accounting.`
      : `You're all set up. Next step: load your bank data so I can start categorizing.`,
  ];
  const script = scripts[phase] || "";

  // Whenever phase changes, restart typewriter + speech and switch the
  // underlying dashboard view accordingly. The auto-advance is driven
  // by the TTS `onend` event (with a length-based safety-net timeout
  // in case the browser drops onend, or the client is muted), so a
  // long narration never gets cut off mid-sentence anymore.
  useEffect(() => {
    if (!open) return;
    if (phase >= 5) return;
    const text = scripts[phase] || "";
    setTyped("");
    let i = 0;
    typerRef.current && clearInterval(typerRef.current);
    typerRef.current = setInterval(() => {
      i++; setTyped(text.slice(0, i));
      if (i >= text.length) clearInterval(typerRef.current);
    }, TYPE_MS);
    // Switch the parent's viewMode for phases 1..3 (and snap back to
    // Classic for the CTA slide).
    const sw = switchRef.current;
    if (phase === 1) sw && sw("classic");
    if (phase === 2) sw && sw("firm");
    if (phase === 3) sw && sw("business");
    if (phase === 4) sw && sw("classic");

    // Glow-highlight the corresponding view-toggle button (Classic /
    // Firm at a Glance / Business Overview) so the client SEES where
    // the current view is being selected from.
    const glowKey = phase === 1 ? "classic" : phase === 2 ? "firm" : phase === 3 ? "business" : null;
    const glowEl = glowKey ? document.querySelector(`[data-testid="dashboard-view-${glowKey}"]`) : null;
    let prevGlow = null;
    if (glowEl) {
      prevGlow = {
        boxShadow: glowEl.style.boxShadow,
        transition: glowEl.style.transition,
        borderRadius: glowEl.style.borderRadius,
      };
      glowEl.style.transition = "box-shadow 0.4s ease-out";
      glowEl.style.borderRadius = "9999px";
      glowEl.style.boxShadow = "0 0 0 3px rgba(6,182,212,0.75), 0 8px 24px -4px rgba(6,182,212,0.55)";
    }

    // Auto-advance for phases 0..3. Phase 4 (final CTA / spotlight)
    // waits for user click or its own auto-fade.
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      if (phase < 4) setPhase(p => p + 1);
    };
    let utt = null;
    let fallbackId = null;
    if (phase < 4) {
      // TTS onend → advance shortly after narration finishes. When
      // muted, fall back to a length-derived timeout that guarantees
      // the typewriter had time to render + a beat to read.
      const holdAfterTtsMs = 600;
      const readMs = 1400; // muted breathing room after typewriter finishes
      const typewriterMs = text.length * TYPE_MS;
      const mutedFallbackMs = Math.max(typewriterMs + readMs, phase === 0 ? 7000 : 5500);
      // Estimate an upper bound for TTS length too (browsers rarely
      // take >120ms/char at rate=1.0). Used as the safety-net if onend
      // silently drops.
      const ttsSafetyMs = Math.max(text.length * 140, 8000);
      if (mutedRef.current) {
        fallbackId = setTimeout(advance, mutedFallbackMs);
      } else {
        utt = speak(text, false, () => setTimeout(advance, holdAfterTtsMs));
        // Safety-net: browsers sometimes never fire onend (tab hide,
        // Chrome idle, etc). Guarantee an advance within a generous
        // window derived from the script length.
        fallbackId = setTimeout(advance, ttsSafetyMs);
      }
    } else {
      // Phase 4 — still narrate but don't schedule an advance.
      speak(text, mutedRef.current);
    }

    return () => {
      typerRef.current && clearInterval(typerRef.current);
      if (fallbackId) clearTimeout(fallbackId);
      if (utt) utt.onend = null;
      // Restore the previous toggle-button style.
      if (glowEl && prevGlow) {
        glowEl.style.boxShadow = prevGlow.boxShadow;
        glowEl.style.transition = prevGlow.transition;
        glowEl.style.borderRadius = prevGlow.borderRadius;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase]);

  // Snap back to Classic + call onDone when the tour finishes.
  useEffect(() => {
    if (!open) return;
    if (phase < 5) return;
    const sw = switchRef.current;
    sw && sw("classic");
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    onDone && onDone();
  }, [phase, open, onDone]);

  // Reset to phase 0 on every open (used for "Replay welcome" too).
  useEffect(() => { if (open) setPhase(0); }, [open]);

  const skip = () => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setPhase(5);
  };
  const finish = () => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setPhase(5);
  };
  const toggleMute = () => {
    setMuted(m => {
      const next = !m;
      try { localStorage.setItem("axiom_tts", next ? "0" : "1"); } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent("axiom-tts-changed", { detail: { on: !next } }));
      if (next && "speechSynthesis" in window) window.speechSynthesis.cancel();
      return next;
    });
  };

  if (!open || phase >= 5) return null;

  // Phase 0 — full-page congrats modal (matches WelcomeModal styling).
  if (phase === 0) {
    return (
      <div className="fixed inset-0 z-[900] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4" data-testid="post-onboarding-congrats">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 relative">
          <div className="absolute top-3 right-3 flex items-center gap-1">
            <button onClick={toggleMute} title={muted ? "Turn narration on" : "Turn narration off"} className={`p-1.5 rounded-full ${muted ? "text-slate-400 hover:bg-slate-100" : "text-cyan-700 hover:bg-cyan-50"}`}>
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <button onClick={skip} className="p-1.5 rounded-full hover:bg-slate-100 text-slate-500" aria-label="Skip"><X size={16} /></button>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 mb-3">
            <Sparkles size={11} /> {brand} · Onboarding complete
          </div>
          <h2 className="font-heading text-2xl font-bold text-slate-900 mb-3 leading-tight">
            Congratulations, {firstName}! 🎉
          </h2>
          <p className="text-sm text-slate-600 leading-relaxed min-h-[72px]">
            {typed}
            <span className="inline-block w-[1px] h-[14px] bg-slate-700 align-middle animate-pulse ml-[1px]" />
          </p>
        </div>
      </div>
    );
  }

  // Phase 4 — either:
  //   • A spotlight over the current setup-checklist step, blurring the
  //     rest of the dashboard while the AI narrates "This is the next
  //     step in getting your books done — {title}." Auto-dismisses
  //     after ~6s so the blur fades away and the user can start clicking.
  //   • Fallback modal for `all set` (data loaded, no todos) or empty
  //     accounts (Connect / Upload CTAs).
  if (phase === 4 && hasSpotlightStep) {
    return (
      <Spotlight
        stepIndex={activeStepIdx + 1}
        typed={typed}
        muted={muted}
        onSkip={finish}
        onToggleMute={toggleMute}
        onFinish={finish}
      />
    );
  }
  if (phase === 4) {
    return (
      <div className="fixed inset-0 z-[900] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4" data-testid="post-onboarding-cta">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 relative">
          <div className="absolute top-3 right-3 flex items-center gap-1">
            <button onClick={toggleMute} title={muted ? "Turn narration on" : "Turn narration off"} className={`p-1.5 rounded-full ${muted ? "text-slate-400 hover:bg-slate-100" : "text-cyan-700 hover:bg-cyan-50"}`}>
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <button onClick={finish} className="p-1.5 rounded-full hover:bg-slate-100 text-slate-500" aria-label="Close"><X size={16} /></button>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-cyan-700 mb-3">
            <Sparkles size={11} /> {brand} · {ctaMode === "allset" ? "All set" : "Next step"}
          </div>
          <h2 className="font-heading text-2xl font-bold text-slate-900 mb-3 leading-tight">
            {ctaMode === "allset" ? "You're all set" : "Load your data"}
          </h2>
          <p className="text-sm text-slate-600 leading-relaxed mb-5 min-h-[48px]">
            {typed}
            <span className="inline-block w-[1px] h-[14px] bg-slate-700 align-middle animate-pulse ml-[1px]" />
          </p>
          {ctaMode === "allset" ? (
            <div className="space-y-2">
              <button
                onClick={finish}
                data-testid="post-onboarding-close-allset"
                className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white font-medium transition-colors"
              >
                <span className="inline-flex items-center gap-2"><Sparkles size={16} /> Let me at my books</span>
                <ArrowRight size={16} />
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <Link
                to="/connections"
                onClick={finish}
                data-testid="post-onboarding-connect-bank"
                className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white font-medium transition-colors"
              >
                <span className="inline-flex items-center gap-2"><Landmark size={16} /> Connect bank accounts</span>
                <ArrowRight size={16} />
              </Link>
              <Link
                to="/connections?tab=statements"
                onClick={finish}
                data-testid="post-onboarding-upload-statements"
                className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-lg bg-white hover:bg-slate-50 text-slate-900 font-medium border border-slate-200 transition-colors"
              >
                <span className="inline-flex items-center gap-2"><FileUp size={16} /> Upload bank statements</span>
                <ArrowRight size={16} />
              </Link>
              <button
                onClick={finish}
                data-testid="post-onboarding-skip-cta"
                className="w-full text-xs text-slate-500 hover:text-slate-700 py-1"
              >
                I'll do this later
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Phases 1-3 — floating caption pill in top-right; underlying dashboard
  // view is what's actually switching. `.post-tour-hide-todos` class on
  // <body> keeps the To Do popover suppressed (see CSS).
  return (
    <div className="fixed top-24 right-8 z-[900] max-w-sm bg-slate-900 text-white rounded-xl shadow-2xl p-4 border border-slate-700" data-testid="post-onboarding-caption">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-[10px] uppercase tracking-widest text-emerald-300 font-semibold">Tour · {phase} of 3</div>
        <div className="flex items-center gap-1">
          <button onClick={toggleMute} className={`p-1 rounded ${muted ? "text-slate-400" : "text-cyan-300"}`}>{muted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button>
          <button onClick={skip} className="p-1 rounded text-slate-300 hover:text-white" aria-label="Skip tour"><X size={12} /></button>
        </div>
      </div>
      <p className="text-sm leading-snug">
        {typed}
        <span className="inline-block w-[1px] h-[12px] bg-white align-middle animate-pulse ml-[1px]" />
      </p>
    </div>
  );
}

// Spotlight overlay for the "next step" phase — dims + blurs everything
// on the page except the currently-active setup-checklist tile
// (identified by data-testid="dashboard-todo-step-{N}"). The step tile
// is elevated via inline style + z-index so it "pops through" the
// backdrop-filter'd overlay. After ~6 seconds the overlay fades away
// and the parent tour completes.
function Spotlight({ stepIndex, typed, muted, onSkip, onToggleMute, onFinish }) {
  const [fading, setFading] = useState(false);
  const [rect, setRect] = useState(null);

  // Elevate the target step above the overlay while the spotlight is
  // active. Snapshot its original inline styles so we can restore them
  // on unmount (React's own re-render would clobber our changes
  // otherwise — DashboardTodos owns this element).
  useEffect(() => {
    const el = document.querySelector(`[data-testid="dashboard-todo-step-${stepIndex}"]`);
    if (!el) return;
    const prevPos = el.style.position;
    const prevZ = el.style.zIndex;
    const prevBoxShadow = el.style.boxShadow;
    const prevBorderRadius = el.style.borderRadius;
    const prevTransition = el.style.transition;
    el.style.position = "relative";
    el.style.zIndex = "902";
    el.style.borderRadius = "12px";
    el.style.transition = "box-shadow 0.4s ease-out";
    // Soft cyan halo so the pop-out reads as "look here" rather than
    // "this element is broken".
    el.style.boxShadow = "0 0 0 4px rgba(6,182,212,0.55), 0 20px 60px -10px rgba(6,182,212,0.4)";
    const update = () => setRect(el.getBoundingClientRect());
    update();
    // Scroll the tile into view softly so a client on a small screen
    // doesn't miss the spotlight.
    try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* ignore */ }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      el.style.position = prevPos;
      el.style.zIndex = prevZ;
      el.style.boxShadow = prevBoxShadow;
      el.style.borderRadius = prevBorderRadius;
      el.style.transition = prevTransition;
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [stepIndex]);

  // Auto-fade after 9s so the tour clears itself once the client's had
  // a chance to hear the narration + read the pill (Phase 4 copy is
  // longer than the earlier phases because it also tells them what to
  // click next).
  useEffect(() => {
    const fadeAt = setTimeout(() => setFading(true), 9000);
    const doneAt = setTimeout(() => onFinish && onFinish(), 9800);
    return () => { clearTimeout(fadeAt); clearTimeout(doneAt); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Position the narration pill above (preferred) or below the target
  // rect so it never covers the tile the AI is talking about.
  const pillStyle = (() => {
    if (!rect) return { top: 96, right: 32, position: "fixed" };
    const gap = 16;
    const pillWidth = 360;
    const wantAbove = rect.top > 200;
    const top = wantAbove ? rect.top - 130 : rect.bottom + gap;
    let left = rect.left + rect.width / 2 - pillWidth / 2;
    left = Math.max(16, Math.min(left, window.innerWidth - pillWidth - 16));
    return { position: "fixed", top: Math.max(16, top), left, width: pillWidth };
  })();

  return (
    <div
      className={`fixed inset-0 z-[900] bg-slate-950/55 backdrop-blur-[3px] transition-opacity duration-700 ${fading ? "opacity-0 pointer-events-none" : "opacity-100"}`}
      data-testid="post-onboarding-spotlight"
      onClick={(e) => {
        // Clicking on the dim area itself skips the spotlight — the
        // step tile is elevated above and stays clickable.
        if (e.target === e.currentTarget) onSkip && onSkip();
      }}
    >
      <div
        className="rounded-xl bg-slate-900 text-white shadow-2xl p-4 border border-slate-700"
        style={pillStyle}
        data-testid="post-onboarding-spotlight-pill"
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="text-[10px] uppercase tracking-widest text-emerald-300 font-semibold">
            Your next step
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onToggleMute}
              className={`p-1 rounded ${muted ? "text-slate-400" : "text-cyan-300"}`}
              aria-label={muted ? "Unmute narration" : "Mute narration"}
            >
              {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>
            <button
              onClick={onSkip}
              className="p-1 rounded text-slate-300 hover:text-white"
              aria-label="Skip tour"
              data-testid="post-onboarding-spotlight-skip"
            >
              <X size={12} />
            </button>
          </div>
        </div>
        <p className="text-sm leading-snug">
          {typed}
          <span className="inline-block w-[1px] h-[12px] bg-white align-middle animate-pulse ml-[1px]" />
        </p>
      </div>
    </div>
  );
}
