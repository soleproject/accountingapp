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
import { X, ChevronLeft, ChevronRight, MousePointer2 } from "lucide-react";
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

// Track a DOM rect for an anchor testid; re-measure on scroll/resize.
function useAnchorRect(anchorTestId, beatIdx) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    if (!anchorTestId) {
      setRect(null);
      return;
    }
    let cancelled = false;
    const measure = () => {
      const el = document.querySelector(`[data-testid="${anchorTestId}"]`);
      if (!el) {
        if (!cancelled) setRect(null);
        return;
      }
      // Bring the anchor into view smoothly if it's off-screen.
      const r = el.getBoundingClientRect();
      const outOfView =
        r.top < 60 || r.bottom > window.innerHeight - 200;
      if (outOfView) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      // Re-measure after any smooth scroll settles.
      setTimeout(() => {
        if (cancelled) return;
        const el2 = document.querySelector(
          `[data-testid="${anchorTestId}"]`
        );
        if (!el2) return;
        setRect(el2.getBoundingClientRect());
      }, outOfView ? 350 : 0);
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorTestId, beatIdx]);
  return rect;
}

export default function ChatReviewTour({ onClose }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [clicking, setClicking] = useState(false);
  const timerRef = useRef(null);
  const reducedMotion = usePrefersReducedMotion();

  const beat = CHAT_REVIEW_BEATS[idx];
  const rect = useAnchorRect(beat?.anchor, idx);

  // Auto-advance timer.
  useEffect(() => {
    if (paused) return;
    if (!beat) return;
    if (beat.finale) return; // finale waits for the button
    const wait = beat.wait ?? 3600;
    timerRef.current = setTimeout(() => {
      setIdx((k) => Math.min(k + 1, CHAT_REVIEW_BEATS.length - 1));
    }, wait);
    return () => clearTimeout(timerRef.current);
  }, [idx, paused, beat]);

  // Ripple pulse for cursor "click" beats.
  useEffect(() => {
    if (!beat?.cursor?.click) {
      setClicking(false);
      return;
    }
    const t = setTimeout(() => setClicking(true), 500);
    const t2 = setTimeout(() => setClicking(false), 1400);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [idx, beat]);

  // Esc to close, arrow keys to nav.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      else if (e.key === "ArrowRight")
        setIdx((k) => Math.min(k + 1, CHAT_REVIEW_BEATS.length - 1));
      else if (e.key === "ArrowLeft") setIdx((k) => Math.max(0, k - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cursorPos = useMemo(() => {
    if (!rect) return null;
    return {
      x: rect.right - 12,
      y: rect.bottom - 8,
    };
  }, [rect]);

  const chapterIdx = useMemo(
    () => CHAPTERS.findIndex((c) => c.key === beat?.chapter),
    [beat]
  );
  const beatsInChapter = useMemo(
    () =>
      CHAT_REVIEW_BEATS.filter((b) => b.chapter === beat?.chapter),
    [beat]
  );
  const beatIdxInChapter = useMemo(
    () => beatsInChapter.findIndex((b) => b.key === beat?.key),
    [beat, beatsInChapter]
  );

  if (!beat) return null;

  const spotlightPad = 12;
  const spotlightRect =
    rect && !beat.center
      ? {
          x: Math.max(0, rect.left - spotlightPad),
          y: Math.max(0, rect.top - spotlightPad),
          w: rect.width + spotlightPad * 2,
          h: rect.height + spotlightPad * 2,
        }
      : null;

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
            {spotlightRect && (
              <rect
                x={spotlightRect.x}
                y={spotlightRect.y}
                width={spotlightRect.w}
                height={spotlightRect.h}
                rx="10"
                ry="10"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(2, 6, 23, 0.55)"
          mask="url(#chat-review-tour-mask)"
        />
        {/* Pulse ring around the spotlight */}
        {spotlightRect && (
          <rect
            x={spotlightRect.x - 2}
            y={spotlightRect.y - 2}
            width={spotlightRect.w + 4}
            height={spotlightRect.h + 4}
            rx="12"
            ry="12"
            fill="none"
            stroke="rgb(217, 70, 239)"
            strokeWidth="2"
            style={{
              filter: "drop-shadow(0 0 12px rgba(217,70,239,0.6))",
            }}
          />
        )}
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

      {/* Narrator dock — centered on welcome/finale, otherwise bottom */}
      <div
        className={`fixed z-[10003] px-4 ${
          beat.center
            ? "inset-0 flex items-center justify-center pointer-events-none"
            : "left-4 right-4 bottom-6 md:left-6 md:right-auto md:max-w-md pointer-events-none"
        }`}
      >
        <div
          className="pointer-events-auto bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 md:p-6"
          style={{ maxWidth: 480 }}
          data-testid="chat-review-tour-v2-narrator"
        >
          {/* Chapter header */}
          <div className="flex items-center gap-2 mb-3">
            <div className="text-[10px] uppercase tracking-wider text-fuchsia-600 font-semibold">
              {chapterIdx >= 0
                ? `Chapter ${chapterIdx + 1} · ${CHAPTERS[chapterIdx].title}`
                : "Tour"}
            </div>
            <div className="ml-auto flex items-center gap-1">
              {CHAT_REVIEW_BEATS.map((b, i) => (
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
                      Math.min(k + 1, CHAT_REVIEW_BEATS.length - 1)
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
