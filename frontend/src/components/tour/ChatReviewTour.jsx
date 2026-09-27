// ChatReviewTour — a live-page, animated cursor walkthrough with a
// friendly bookkeeper narrator. Renders on top of the real ChatReview
// UI: dims the page, cuts a spotlight hole around the current beat's
// anchor, glides an SVG cursor to it, and pins a narrator card that
// tracks progress + provides Skip / Prev / Next controls.
//
// The tour is intentionally read-only on real user data:
//   - beats that "click" (cursor: {click: true}) — none in the MVP —
//     dispatch synthetic events on real DOM elements. For anchors that
//     open menus/modals we keep click=false and just point at them
//     (safer, less disruptive).
//   - beats that "type" or "tick checkboxes" render a floating ghost
//     UI (kind: "typing" / "checkboxes") next to the anchor instead
//     of touching the user's inputs.
//
// Trigger: managed by the parent (ChatReview). Parent decides when to
// mount this overlay. On close, parent writes to localStorage so the
// auto-tour doesn't fire again.

import { useEffect, useMemo, useRef, useState } from "react";
import { X, ChevronLeft, ChevronRight, MousePointer2, Volume2, VolumeX } from "lucide-react";
import {
  CHAT_REVIEW_BEATS,
  CHAPTERS,
  TOTAL_BEATS,
} from "@/tours/chatReviewBeats";

// Cursor SVG follows the target anchor's centre via CSS transform.
function DemoCursor({ x, y, clicking }) {
  return (
    <div
      className="fixed pointer-events-none z-[10001] transition-transform duration-700 ease-out"
      style={{
        transform: `translate3d(${x - 8}px, ${y - 6}px, 0)`,
        transitionProperty: "transform",
      }}
      aria-hidden
    >
      <MousePointer2
        size={28}
        strokeWidth={2}
        className="drop-shadow-md"
        style={{ color: "#0f172a", fill: "#ffffff" }}
      />
      {clicking && (
        <span
          className="absolute -left-3 -top-3 w-14 h-14 rounded-full border-2 border-fuchsia-400 animate-ping"
          aria-hidden
        />
      )}
    </div>
  );
}

// Ghost overlays — floating mock UI that demos an interaction without
// touching real inputs.
function TypingGhost({ rect, text }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (!text) return;
    const id = setInterval(() => {
      setN((k) => (k >= text.length ? k : k + 1));
    }, 60);
    return () => clearInterval(id);
  }, [text]);
  if (!rect) return null;
  return (
    <div
      className="fixed z-[10002] pointer-events-none"
      style={{
        left: rect.left + 12,
        top: rect.top + 6,
        width: Math.max(rect.width - 24, 240),
      }}
    >
      <div className="bg-white/95 rounded px-3 py-2 shadow-lg border border-fuchsia-200">
        <div className="text-[10px] uppercase tracking-wide text-fuchsia-600 font-semibold mb-0.5">
          Example answer
        </div>
        <div className="text-sm text-slate-800 font-medium">
          {text.slice(0, n)}
          <span className="inline-block w-[1px] h-4 align-middle bg-slate-800 animate-pulse ml-0.5" />
        </div>
      </div>
    </div>
  );
}

function CheckboxesGhost({ rect }) {
  if (!rect) return null;
  const rows = [
    { label: "Client deposit — Acme LLC", checked: true },
    { label: "Client deposit — BTC Corp", checked: true },
    { label: "Owner contribution", checked: false },
  ];
  return (
    <div
      className="fixed z-[10002] pointer-events-none"
      style={{
        left: rect.left + 16,
        top: rect.top + 8,
        width: Math.max(rect.width - 32, 260),
      }}
    >
      <div className="bg-white/95 rounded-lg px-3 py-2 shadow-lg border border-fuchsia-200 space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-fuchsia-600 font-semibold">
          Split mode preview
        </div>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span
              className={`inline-block w-3.5 h-3.5 rounded border ${
                r.checked
                  ? "bg-fuchsia-500 border-fuchsia-500"
                  : "bg-white border-slate-300"
              }`}
            />
            <span className="text-slate-700 truncate">{r.label}</span>
          </div>
        ))}
        <div className="pt-1 text-[11px] text-fuchsia-700 font-medium">
          → Ask separately
        </div>
      </div>
    </div>
  );
}

// Utility — reduced motion pref.
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cb = () => setReduced(mq.matches);
    cb();
    mq.addEventListener?.("change", cb);
    return () => mq.removeEventListener?.("change", cb);
  }, []);
  return reduced;
}

// Resolve a beat target — either a plain `data-testid` (default) or
// a raw CSS selector when the id starts with `css:` (e.g. targeting
// the first N rows in the show-all modal without knowing sample IDs
// at author time).
function resolveTarget(idOrSelector) {
  if (!idOrSelector) return null;
  if (idOrSelector.startsWith("css:")) {
    return document.querySelector(idOrSelector.slice(4));
  }
  return document.querySelector(`[data-testid="${idOrSelector}"]`);
}

// Track a DOM rect for an anchor testid; re-measure on scroll/resize.
// Since some anchors mount asynchronously (a modal that just opened
// after a synthetic click on the previous beat), we retry for up to
// ~1.5 s with a short interval until the element is found.
function useAnchorRect(anchorTestId, beatIdx) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    if (!anchorTestId) {
      setRect(null);
      return;
    }
    let cancelled = false;
    let interval = null;
    const measure = () => {
      const el = resolveTarget(anchorTestId);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const outOfView =
        r.top < 60 || r.bottom > window.innerHeight - 200;
      if (outOfView) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setTimeout(() => {
        if (cancelled) return;
        const el2 = resolveTarget(anchorTestId);
        if (el2) setRect(el2.getBoundingClientRect());
      }, outOfView ? 350 : 0);
      return el;
    };
    // Try immediately; if not found, poll up to ~1.5 s.
    if (!measure()) {
      let tries = 0;
      interval = setInterval(() => {
        tries += 1;
        if (measure() || tries > 15) clearInterval(interval);
      }, 100);
    }
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (interval) clearInterval(interval);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorTestId, beatIdx]);
  return rect;
}

// Track DOM rects for a list of anchor testids. Same retry semantics
// as `useAnchorRect` — polls up to ~1.5 s for elements that mount
// asynchronously. Returns an array of {testid, rect} in input order,
// filtering out testids we still couldn't find. Used by beats that
// spotlight more than one element at once (e.g. the samples list AND
// the "Update selected" / "Ask separately" toolbar).
function useAnchorRects(anchorTestIds, beatIdx) {
  const [rects, setRects] = useState([]);
  // Serialize the ids to compare in deps — array identity varies per
  // render but content is what we care about.
  const key = (anchorTestIds || []).join("|");
  useEffect(() => {
    if (!anchorTestIds || anchorTestIds.length === 0) {
      setRects([]);
      return;
    }
    let cancelled = false;
    let interval = null;
    const measure = () => {
      const out = [];
      let allFound = true;
      for (const tid of anchorTestIds) {
        const el = resolveTarget(tid);
        if (el) out.push({ testid: tid, rect: el.getBoundingClientRect() });
        else allFound = false;
      }
      if (!cancelled) setRects(out);
      return allFound;
    };
    if (!measure()) {
      let tries = 0;
      interval = setInterval(() => {
        tries += 1;
        if (measure() || tries > 15) clearInterval(interval);
      }, 100);
    }
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (interval) clearInterval(interval);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, beatIdx]);
  return rects;
}

export default function ChatReviewTour({ onClose, beats: propBeats, title }) {
  const BEATS = propBeats || CHAT_REVIEW_BEATS;
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [clicking, setClicking] = useState(false);
  // Voice narration — Web Speech API. Default ON per product ask; the
  // CPA can mute from the narrator card and we remember the choice in
  // localStorage. Browsers gate autoplay behind a user gesture — the
  // tour is opened via a click (Tour button or auto-trigger just after
  // the CPA lands on the page), which usually clears that hurdle.
  const VOICE_KEY = "chat-review-tour-voice";
  const [voiceOn, setVoiceOn] = useState(() => {
    try {
      const v = localStorage.getItem(VOICE_KEY);
      return v === null ? true : v === "1";
    } catch (_) {
      return true;
    }
  });
  const timerRef = useRef(null);
  const reducedMotion = usePrefersReducedMotion();

  const beat = BEATS[idx];
  // Track sequential-click progress within a single beat (used by
  // `cursor.clicks` — e.g. "tick 3 checkboxes"). Resets whenever the
  // beat changes so the previous progression doesn't leak forward.
  const [clickStep, setClickStep] = useState(0);
  useEffect(() => setClickStep(0), [idx]);
  // Which testid the cursor is pointing at right this moment. For
  // multi-click beats it advances through cursor.clicks; for single-
  // click / point-only beats it defaults to cursor.move or anchor.
  const cursorTarget = useMemo(() => {
    if (!beat) return null;
    if (beat.cursor?.clicks?.length) {
      return beat.cursor.clicks[Math.min(clickStep, beat.cursor.clicks.length - 1)];
    }
    return beat.cursor?.move || beat.anchor || null;
  }, [beat, clickStep]);
  const rect = useAnchorRect(beat?.anchor, idx);
  const cursorRect = useAnchorRect(cursorTarget, `${idx}-${clickStep}`);
  // Extra spotlight anchors — cut additional holes in the dim mask
  // for beats that need to highlight more than one element at once.
  const extraSpotlights = useAnchorRects(beat?.spotlights || [], idx);

  // Voice narration completion — auto-advance waits for it (below).
  const [voiceComplete, setVoiceComplete] = useState(true);
  // Click sequence completion — for beats with `cursor.click` or
  // `cursor.clicks`, auto-advance also waits until every click has
  // been dispatched. Reset whenever the beat changes.
  const [clicksComplete, setClicksComplete] = useState(true);
  useEffect(() => {
    const hasClicks = !!(beat?.cursor?.clicks?.length || beat?.cursor?.click);
    setClicksComplete(!hasClicks);
  }, [idx, beat]);

  // Auto-advance timer. When voice is on we wait until the narrator
  // has finished speaking, THEN we wait for any pending clicks, THEN
  // hold for `beat.wait` ms so the CPA can read + look at what
  // happened on-screen. When voice is off, `beat.wait` is the total
  // post-click dwell time. This ordering (voice → click → hold) is
  // deliberate: the narrator sets up what's about to happen, THEN
  // the cursor demonstrates it, THEN the user has time to absorb.
  useEffect(() => {
    if (paused) return;
    if (!beat) return;
    if (beat.finale && !beat.autoClose) return; // finale waits for the button (unless autoClose)
    if (voiceOn && !voiceComplete) return; // hold until voice ends
    if (!clicksComplete) return; // wait for click sequence
    const wait = beat.wait ?? 2600;
    timerRef.current = setTimeout(() => {
      if (beat.finale && beat.autoClose) {
        onClose?.({ completed: true });
      } else {
        setIdx((k) => Math.min(k + 1, BEATS.length - 1));
      }
    }, wait);
    return () => clearTimeout(timerRef.current);
  }, [idx, paused, beat, voiceOn, voiceComplete, clicksComplete, onClose]);

  // Cursor "click" beats — dispatch a real .click() on the target
  // testid so the underlying UI actually reacts (opens Show-all,
  // toggles Split mode, ticks a checkbox, etc). Safe because the tour
  // swaps in a fixture; nothing writes to the user's real data.
  //
  // Click fires ~1 s into the beat so the user's eye follows the
  // cursor to the target. Voice keeps speaking through the action —
  // the narrator text is written to describe what's about to happen
  // AND what just happened. Auto-advance below waits for BOTH voice
  // and clicks to complete before moving on.
  useEffect(() => {
    if (!beat?.cursor) {
      setClicking(false);
      return;
    }
    const clicks = beat.cursor.clicks || (beat.cursor.click ? [beat.cursor.move || beat.anchor] : []);
    if (!clicks.length) { setClicking(false); return; }
    // Cursor lands, ripple, then real click, then advance step (for
    // multi-click sequences) so the next testid gets targeted.
    // Beats can override the click delay via `cursor.delay` — used
    // e.g. when we want the click to fire only after the narrator has
    // spoken the specific word describing the action.
    const clickDelayMs = beat.cursor?.delay ?? 1050;
    const t1 = setTimeout(() => setClicking(true), Math.max(0, clickDelayMs - 550));
    const t2 = setTimeout(() => {
      const testid = clicks[Math.min(clickStep, clicks.length - 1)];
      const el = resolveTarget(testid);
      if (el) {
        try { el.click(); } catch (_) { /* ignore */ }
      }
      setClicking(false);
      if (clickStep + 1 < clicks.length) {
        setClickStep((s) => s + 1);
      } else {
        setClicksComplete(true);
      }
    }, clickDelayMs);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [idx, beat, clickStep]);

  // Esc to close, arrow keys to nav.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      else if (e.key === "ArrowRight")
        setIdx((k) => Math.min(k + 1, BEATS.length - 1));
      else if (e.key === "ArrowLeft") setIdx((k) => Math.max(0, k - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Voice narration. Cancels any prior utterance whenever the beat
  // changes, the voice is muted, the tour is paused, or the component
  // unmounts. `voiceComplete` gates auto-advance — nothing moves on
  // until the narrator has actually finished speaking (or errored),
  // so users get to actually HEAR the whole beat.
  //
  // A ref-based utterance identity ("currentUtterance") is essential
  // because window.speechSynthesis.cancel() fires the previous
  // utterance's onend/onerror ASYNCHRONOUSLY — without the ref check,
  // a stale callback flips voiceComplete=true on the next beat and
  // auto-advance runs way too early. The ref is set right before
  // speak() and only the callback owning the current ref is allowed
  // to mark the beat complete.
  const currentUtteranceRef = useRef(null);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setVoiceComplete(true);
      return;
    }
    // Invalidate any callbacks bound to a previous utterance.
    currentUtteranceRef.current = null;
    if (!voiceOn) {
      window.speechSynthesis.cancel();
      setVoiceComplete(true);
      return;
    }
    if (paused || !beat?.narrator) {
      window.speechSynthesis.cancel();
      // Don't flip voiceComplete — we're paused mid-beat, or waiting
      // for narrator to be defined.
      return;
    }
    setVoiceComplete(false);
    const speak = () => {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(beat.narrator);
      const voices = window.speechSynthesis.getVoices() || [];
      // Prefer warm, natural voices in this order. User asked for
      // Google UK English Female specifically.
      const preferred = [
        "Google UK English Female",
        "Microsoft Libby Online (Natural) - English (United Kingdom)",
        "Microsoft Sonia Online (Natural) - English (United Kingdom)",
        "Samantha",
        "Google US English",
        "Karen",
        "Microsoft Aria Online",
        "Microsoft Jenny Online",
      ];
      const pick =
        preferred
          .map((name) => voices.find((v) => v.name === name))
          .find(Boolean) ||
        voices.find((v) => v.lang === "en-GB" && /female|libby|sonia|karen/i.test(v.name)) ||
        voices.find((v) => v.lang === "en-GB") ||
        voices.find((v) => v.lang?.startsWith("en") && /female|samantha|zira|aria|jenny|karen/i.test(v.name)) ||
        voices.find((v) => v.lang?.startsWith("en"));
      if (pick) u.voice = pick;
      u.rate = 0.95;
      u.pitch = 1.05;
      u.volume = 1.0;
      currentUtteranceRef.current = u;
      u.onend = () => {
        if (currentUtteranceRef.current === u) setVoiceComplete(true);
      };
      u.onerror = () => {
        // Only treat errors on THIS utterance as completion. Ignore
        // "canceled" errors from a previous utterance that was
        // superseded by a beat change.
        if (currentUtteranceRef.current === u) setVoiceComplete(true);
      };
      window.speechSynthesis.speak(u);
    };
    // Chrome pauses SpeechSynthesis after ~15 s of continuous speech.
    // A short pause+resume ping every 5 s keeps it alive so longer
    // narrator beats don't get chopped in the middle of a sentence.
    const keepAlive = setInterval(() => {
      const ss = window.speechSynthesis;
      if (ss && ss.speaking && !ss.paused) {
        try {
          ss.pause();
          ss.resume();
        } catch (_) { /* ignore */ }
      }
    }, 5000);
    // Voice list is async in Chrome — retry once if it's empty.
    if (window.speechSynthesis.getVoices().length === 0) {
      const handler = () => {
        window.speechSynthesis.removeEventListener("voiceschanged", handler);
        speak();
      };
      window.speechSynthesis.addEventListener("voiceschanged", handler);
      const t = setTimeout(speak, 400);
      return () => {
        clearInterval(keepAlive);
        clearTimeout(t);
        window.speechSynthesis.removeEventListener("voiceschanged", handler);
        currentUtteranceRef.current = null;
        window.speechSynthesis.cancel();
      };
    }
    speak();
    return () => {
      clearInterval(keepAlive);
      currentUtteranceRef.current = null;
      window.speechSynthesis.cancel();
    };
  }, [idx, voiceOn, paused, beat]);

  // Persist voice preference + always stop speaking on unmount.
  useEffect(() => {
    try { localStorage.setItem(VOICE_KEY, voiceOn ? "1" : "0"); } catch (_) {}
  }, [voiceOn]);
  useEffect(() => () => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const cursorPos = useMemo(() => {
    const r = cursorRect || rect;
    if (!r) return null;
    return {
      x: r.right - 12,
      y: r.bottom - 8,
    };
  }, [cursorRect, rect]);

  const chapterIdx = useMemo(
    () => CHAPTERS.findIndex((c) => c.key === beat?.chapter),
    [beat]
  );
  const beatsInChapter = useMemo(
    () =>
      BEATS.filter((b) => b.chapter === beat?.chapter),
    [beat]
  );
  const beatIdxInChapter = useMemo(
    () => beatsInChapter.findIndex((b) => b.key === beat?.key),
    [beat, beatsInChapter]
  );

  if (!beat) return null;

  const spotlightPad = 12;
  const primarySpotlight =
    rect && !beat.center
      ? {
          x: Math.max(0, rect.left - spotlightPad),
          y: Math.max(0, rect.top - spotlightPad),
          w: rect.width + spotlightPad * 2,
          h: rect.height + spotlightPad * 2,
        }
      : null;
  // Merge spotlights that touch (or nearly touch) into one bounding
  // box so we don't render a stray "ghost" pulse ring in the gap
  // between two adjacent buttons — the drop-shadow on adjacent rings
  // used to bleed into each other and read as a third small halo.
  const mergeGap = 16;
  const mergeRects = (rects) => {
    if (rects.length <= 1) return rects;
    const remaining = rects.map((r) => ({ ...r }));
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < remaining.length; i++) {
        for (let j = i + 1; j < remaining.length; j++) {
          const a = remaining[i];
          const b = remaining[j];
          const hOverlap =
            a.x <= b.x + b.w + mergeGap && b.x <= a.x + a.w + mergeGap;
          const vOverlap =
            a.y <= b.y + b.h + mergeGap && b.y <= a.y + a.h + mergeGap;
          if (hOverlap && vOverlap) {
            const nx = Math.min(a.x, b.x);
            const ny = Math.min(a.y, b.y);
            const nr = Math.max(a.x + a.w, b.x + b.w);
            const nb = Math.max(a.y + a.h, b.y + b.h);
            remaining[i] = { x: nx, y: ny, w: nr - nx, h: nb - ny };
            remaining.splice(j, 1);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }
    return remaining;
  };
  const allSpotlights = beat.center
    ? []
    : mergeRects([
        ...(primarySpotlight ? [primarySpotlight] : []),
        ...extraSpotlights.map(({ rect: r }) => ({
          x: Math.max(0, r.left - spotlightPad),
          y: Math.max(0, r.top - spotlightPad),
          w: r.width + spotlightPad * 2,
          h: r.height + spotlightPad * 2,
        })),
      ]);

  return (
    <div
      className="fixed inset-0 z-[10000]"
      data-testid="chat-review-tour-v2"
      aria-live="polite"
    >
      {/* Dim backdrop with a spotlight hole cut via SVG mask */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-auto"
        onClick={(e) => {
          // Click on the dim area = pause (not close, avoid accidental
          // dismissal). Real close requires the X button.
          if (e.target === e.currentTarget) setPaused((p) => !p);
        }}
      >
        <defs>
          <mask id="chat-review-tour-mask">
            <rect width="100%" height="100%" fill="white" />
            {allSpotlights.map((s, i) => (
              <rect
                key={i}
                x={s.x}
                y={s.y}
                width={s.w}
                height={s.h}
                rx="10"
                ry="10"
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(2, 6, 23, 0.55)"
          mask="url(#chat-review-tour-mask)"
        />
        {/* Pulse ring around each spotlight */}
        {allSpotlights.map((s, i) => (
          <rect
            key={i}
            x={s.x - 2}
            y={s.y - 2}
            width={s.w + 4}
            height={s.h + 4}
            rx="12"
            ry="12"
            fill="none"
            stroke="rgb(217, 70, 239)"
            strokeWidth="2"
            style={{
              filter: "drop-shadow(0 0 12px rgba(217,70,239,0.6))",
            }}
          />
        ))}
      </svg>

      {/* Demo cursor */}
      {cursorPos && !reducedMotion && !beat.center && (
        <DemoCursor x={cursorPos.x} y={cursorPos.y} clicking={clicking} />
      )}

      {/* Ghost overlays */}
      {beat.ghost?.kind === "typing" && (
        <TypingGhost rect={rect} text={beat.ghost.text} />
      )}
      {beat.ghost?.kind === "checkboxes" && (
        <CheckboxesGhost rect={rect} />
      )}

      {/* Narrator dock — centered on welcome/finale, otherwise pinned
          to the RIGHT edge of the transaction column so it doesn't
          collide with the AI panel that lives at the far right on
          /accounting/review-chat. Falls back to a bottom sheet on
          mobile / narrow viewports. */}
      <div
        className={`fixed z-[10003] px-4 ${
          beat.center
            ? "inset-0 flex items-center justify-center pointer-events-none"
            : "left-4 right-4 bottom-6 md:left-auto md:right-6 md:max-w-md pointer-events-none"
        }`}
      >
        <div
          className="pointer-events-auto bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 md:p-6"
          style={{ maxWidth: 480 }}
          data-testid="chat-review-tour-v2-narrator"
        >
          {/* Chapter header + voice mute */}
          <div className="flex items-center gap-2 mb-3">
            <div className="text-[10px] uppercase tracking-wider text-fuchsia-600 font-semibold">
              {chapterIdx >= 0
                ? `Chapter ${chapterIdx + 1} · ${CHAPTERS[chapterIdx].title}`
                : "Tour"}
            </div>
            <button
              type="button"
              onClick={() => setVoiceOn((v) => !v)}
              className="ml-1 w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              data-testid="chat-review-tour-v2-voice"
              title={voiceOn ? "Mute narrator" : "Unmute narrator"}
              aria-label={voiceOn ? "Mute narrator" : "Unmute narrator"}
              aria-pressed={voiceOn}
            >
              {voiceOn ? <Volume2 size={12} /> : <VolumeX size={12} />}
            </button>
            <div className="ml-auto flex items-center gap-1">
              {BEATS.map((b, i) => (
                <span
                  key={b.key}
                  className={`inline-block w-1.5 h-1.5 rounded-full ${
                    i === idx
                      ? "bg-fuchsia-500 w-4"
                      : i < idx
                      ? "bg-fuchsia-300"
                      : "bg-slate-200"
                  } transition-all`}
                />
              ))}
            </div>
          </div>

          {/* Narrator copy */}
          <div className="text-slate-800 text-[15px] leading-relaxed">
            {beat.narrator}
          </div>

          {/* Controls */}
          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIdx((k) => Math.max(0, k - 1))}
              disabled={idx === 0}
              className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800 disabled:opacity-30 px-2 py-1 text-sm"
              data-testid="chat-review-tour-v2-prev"
            >
              <ChevronLeft size={14} /> Back
            </button>
            <button
              type="button"
              onClick={() => onClose?.({ completed: false })}
              className="text-xs text-slate-400 hover:text-slate-700 px-2 py-1"
              data-testid="chat-review-tour-v2-skip"
            >
              Skip tour
            </button>
            <div className="ml-auto">
              {beat.finale ? (
                <button
                  type="button"
                  onClick={() => onClose?.({ completed: true })}
                  className="inline-flex items-center gap-1 px-4 py-2 rounded-full bg-fuchsia-600 text-white text-sm font-semibold hover:bg-fuchsia-700 shadow-md"
                  data-testid="chat-review-tour-v2-finish"
                >
                  Start reviewing 🎉
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    setIdx((k) =>
                      Math.min(k + 1, BEATS.length - 1)
                    )
                  }
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-slate-900 text-white text-sm font-medium hover:bg-slate-800"
                  data-testid="chat-review-tour-v2-next"
                >
                  Next <ChevronRight size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Progress footnote */}
          <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400">
            <span>
              Beat {idx + 1} of {TOTAL_BEATS}
              {beatIdxInChapter >= 0 && beatsInChapter.length > 0 && (
                <>
                  {" "}
                  · {beatIdxInChapter + 1}/{beatsInChapter.length} this chapter
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className="hover:text-slate-700"
              data-testid="chat-review-tour-v2-pause"
            >
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </div>
      </div>

      {/* Close (X) — floats top-right */}
      <button
        type="button"
        onClick={() => onClose?.({ completed: false })}
        className="fixed top-4 right-4 z-[10003] w-9 h-9 rounded-full bg-white/95 border border-slate-200 shadow-md flex items-center justify-center text-slate-600 hover:bg-slate-100"
        aria-label="Close tour"
        data-testid="chat-review-tour-v2-close"
      >
        <X size={16} />
      </button>
    </div>
  );
}
