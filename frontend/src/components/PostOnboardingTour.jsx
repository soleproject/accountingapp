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

function speak(text, muted) {
  if (!("speechSynthesis" in window) || muted) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang || "en-GB"; }
  u.rate = 1.0; u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

// Slide 0 = congrats modal; slides 1-3 are the tour narrations, rendered
// as a small floating pill on top of the actual dashboard view (which
// switches underneath via `onSwitchView`). Slide 4 = final CTA — shows
// the client's to-dos (if any) or fallback Connect / Upload buttons.
export default function PostOnboardingTour({ open, companyName, companyId, todos, onSwitchView, onDone }) {
  const { user } = useAuth();
  const { branding } = useBranding();
  const [phase, setPhase] = useState(0); // 0=congrats, 1=classic, 2=firm, 3=business, 4=cta, 5=done
  const [typed, setTyped] = useState("");
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem("axiom_tts") === "0"; } catch { return false; } });
  const typerRef = useRef(null);

  const firstName = (user?.name || "").split(" ")[0] || "there";
  const brand = branding?.firm_name || "SmartBooks";
  const co = companyName || "your company";

  const hasTodos = !!(todos && todos.visible && Array.isArray(todos.items) && todos.items.length > 0);

  const scripts = [
    `Congratulations ${firstName}! You've officially onboarded ${co}. Take a quick look around — I'll show you what's here.`,
    `This is your Classic dashboard — everything at a glance.`,
    `Here's Firm at a Glance — the view I recommend for month-end close.`,
    `And Business Overview — for pattern-spotting across your year.`,
    hasTodos
      ? `You've got a few action items waiting — knock these out and your books will be picture-perfect.`
      : `You're all set up. Next step: load your bank data so I can start categorizing.`,
  ];
  const script = scripts[phase] || "";

  // Whenever phase changes, restart typewriter + speech and switch the
  // underlying dashboard view accordingly.
  useEffect(() => {
    if (!open) return;
    if (phase >= 5) return;
    setTyped("");
    let i = 0;
    typerRef.current && clearInterval(typerRef.current);
    typerRef.current = setInterval(() => {
      i++; setTyped(script.slice(0, i));
      if (i >= script.length) clearInterval(typerRef.current);
    }, TYPE_MS);
    speak(script, muted);
    // Switch the parent's viewMode for phases 1..3
    if (phase === 1) onSwitchView && onSwitchView("classic");
    if (phase === 2) onSwitchView && onSwitchView("firm");
    if (phase === 3) onSwitchView && onSwitchView("business");
    if (phase === 4) onSwitchView && onSwitchView("classic");
    // Auto-advance phases 0..3. Phase 4 (final CTA) waits for user click.
    if (phase >= 4) return () => { typerRef.current && clearInterval(typerRef.current); };
    const t = setTimeout(() => setPhase(p => p + 1), phase === 0 ? 6500 : TOUR_HOLD_MS);
    return () => { clearTimeout(t); typerRef.current && clearInterval(typerRef.current); };
  }, [open, phase, script, muted, onSwitchView]);

  // Snap back to Classic + call onDone when the tour finishes.
  useEffect(() => {
    if (!open) return;
    if (phase < 5) return;
    onSwitchView && onSwitchView("classic");
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    onDone && onDone();
  }, [phase, open, onDone, onSwitchView]);

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

  // Phase 4 — final CTA. Shows To-Dos link if there are any, otherwise
  // falls back to "Connect bank accounts" + "Upload bank statements".
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
            <Sparkles size={11} /> {brand} · Next step
          </div>
          <h2 className="font-heading text-2xl font-bold text-slate-900 mb-3 leading-tight">
            {hasTodos ? "You've got action items" : "Load your data"}
          </h2>
          <p className="text-sm text-slate-600 leading-relaxed mb-5 min-h-[48px]">
            {typed}
            <span className="inline-block w-[1px] h-[14px] bg-slate-700 align-middle animate-pulse ml-[1px]" />
          </p>
          {hasTodos ? (
            <div className="space-y-2">
              <button
                onClick={finish}
                data-testid="post-onboarding-goto-todos"
                className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-colors"
              >
                <span className="inline-flex items-center gap-2"><ListChecks size={16} /> Review my to-dos</span>
                <ArrowRight size={16} />
              </button>
              <button
                onClick={finish}
                data-testid="post-onboarding-skip-cta"
                className="w-full text-xs text-slate-500 hover:text-slate-700 py-1"
              >
                Explore on my own
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
