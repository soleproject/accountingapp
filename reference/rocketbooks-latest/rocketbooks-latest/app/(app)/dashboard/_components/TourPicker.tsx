'use client';

import { useEffect, useState } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { useTextToSpeech } from '@/components/ai-assistant/useTextToSpeech';
import { useTourMuted } from '@/components/ai-assistant/useTourMuted';

interface Props {
  firstName: string;
  /** Caller-provided handler to start the regular spotlight tour. The
   *  takeover doesn't render GuidedTour itself -- that lives on the
   *  DashboardWelcome path -- so we kick the picker closed and let the
   *  parent (the dashboard page) hand off. */
  onStartRegularTour: () => void;
}

/**
 * Tour-specific takeover triggered by the TopBar "Tour" button (and any
 * other surface that navigates to /dashboard?tour=pick). Visually identical
 * to the welcome takeover -- same dim overlay, gradient-bordered card,
 * typewriter heading + body, TTS -- but the content is tour-focused and
 * there are only two chips:
 *
 *   1. AI capabilities  → starts the cool tour (CoolTourRunner)
 *   2. Platform pages   → starts the regular spotlight GuidedTour
 *
 * No text/mic input on this surface -- it's a focused picker, not a
 * freeform welcome.
 */
export function TourPicker({ firstName, onStartRegularTour }: Props) {
  const { startCoolTour } = useAssistant();
  const tts = useTextToSpeech();
  const tourMute = useTourMuted();
  const [phase, setPhase] = useState<'open' | 'closed'>('open');
  const [entered, setEntered] = useState(false);

  const heading = `I'd love to take you on a tour${firstName ? `, ${firstName}` : ''}!`;
  const para1 = 'Are you interested in seeing my AI capabilities, or would you like to see the pages of the platform and what they each do?';
  const spoken = `${heading}. ${para1}`;

  // Same pacing as the welcome takeover so the two surfaces feel sibling.
  const ENTER_MS = 600;
  const HEAD_CPS_MS = 50;
  const BODY_CPS_MS = 18;
  const PARA_GAP_MS = 150;

  const headingStart = ENTER_MS;
  const bodyStartMs = headingStart + heading.length * HEAD_CPS_MS + PARA_GAP_MS;
  const typedHeading = useTypewriter(entered ? heading : '', {
    startMs: headingStart,
    cpsMs: HEAD_CPS_MS,
  });
  const typedBody = useTypewriter(entered ? para1 : '', {
    startMs: bodyStartMs,
    cpsMs: BODY_CPS_MS,
  });

  useEffect(() => {
    const t = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(t);
  }, []);

  // Speak the picker greeting once the card has slid in. Speaks by default --
  // matches the welcome takeover's "deliberate first impression" rule -- and
  // only goes silent if the user hits the mute toggle on this card.
  useEffect(() => {
    if (!entered) return;
    if (!tts.supported) return;
    if (tourMute.muted) return;
    const t = window.setTimeout(() => tts.speak(spoken), ENTER_MS);
    return () => {
      window.clearTimeout(t);
      tts.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered, tts.supported, tourMute.muted]);

  // Strip ?tour=pick from the URL on mount so a refresh doesn't re-show it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.has('tour')) {
      url.searchParams.delete('tour');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const onClose = () => {
    tts.stop();
    setPhase('closed');
  };

  const onCool = () => {
    tts.stop();
    setPhase('closed');
    startCoolTour();
  };

  const onRegular = () => {
    tts.stop();
    setPhase('closed');
    onStartRegularTour();
  };

  if (phase === 'closed') return null;

  const chipsReady = typedBody.done;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tour picker"
      className={`fixed inset-0 z-[60] flex items-center justify-center px-4 transition-opacity duration-500 ${
        entered ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        className={`relative w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl transition-all duration-500 ease-out dark:border-zinc-800 dark:bg-zinc-950 ${
          entered ? 'translate-y-0 opacity-100' : 'translate-y-40 opacity-0'
        }`}
        style={{
          backgroundImage:
            'linear-gradient(white, white), linear-gradient(120deg, #fb7185, #a78bfa, #38bdf8, #4ade80)',
          backgroundOrigin: 'border-box',
          backgroundClip: 'padding-box, border-box',
          border: '1px solid transparent',
        }}
      >
        <div className="absolute right-3 top-3 flex items-center gap-1">
          {tts.supported && (
            <button
              type="button"
              onClick={() => {
                const nextMuted = !tourMute.muted;
                tourMute.setMuted(nextMuted);
                if (nextMuted) tts.stop();
              }}
              aria-label={tourMute.muted ? 'Unmute narration' : 'Mute narration'}
              title={tourMute.muted ? 'Unmute narration' : 'Mute narration'}
              className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              {tourMute.muted ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tour picker"
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="px-6 pb-6 pt-7">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            ✨ Assistant
          </div>
          <div className="relative mt-1">
            <div className="invisible text-2xl font-semibold">{heading}</div>
            <div
              aria-live="polite"
              className="absolute inset-0 text-2xl font-semibold text-zinc-900 dark:text-zinc-50"
            >
              {typedHeading.shown}
              {!typedHeading.done && <Caret />}
            </div>
          </div>
          <div className="relative mt-3">
            <p className="invisible text-base leading-relaxed">{para1}</p>
            <p
              aria-live="polite"
              className="absolute inset-0 text-base leading-relaxed text-zinc-700 dark:text-zinc-300"
            >
              {typedBody.shown}
              {typedHeading.done && !typedBody.done && <Caret />}
            </p>
          </div>
          <div
            className={`mt-5 flex flex-col gap-2 transition-opacity duration-300 ${
              chipsReady ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <button
              type="button"
              onClick={onCool}
              disabled={!chipsReady}
              className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
            >
              ✨ Show me your AI capabilities
            </button>
            <button
              type="button"
              onClick={onRegular}
              disabled={!chipsReady}
              className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
            >
              🧭 Show me around the platform
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[1em] w-[2px] -translate-y-[2px] animate-pulse bg-zinc-500 align-middle dark:bg-zinc-400"
    />
  );
}

function useTypewriter(
  text: string,
  opts: { startMs?: number; cpsMs?: number } = {},
): { shown: string; done: boolean } {
  const { startMs = 0, cpsMs = 30 } = opts;
  const [shown, setShown] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!text) {
      setShown('');
      setDone(false);
      return;
    }
    setShown('');
    setDone(false);
    let cancelled = false;
    const timers: number[] = [];
    const startTimer = window.setTimeout(() => {
      if (cancelled) return;
      const tick = (i: number) => {
        if (cancelled) return;
        const next = text.slice(0, i + 1);
        setShown(next);
        if (i + 1 >= text.length) {
          setDone(true);
          return;
        }
        const id = window.setTimeout(() => tick(i + 1), cpsMs);
        timers.push(id);
      };
      tick(0);
    }, startMs);
    timers.push(startTimer);
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [text, startMs, cpsMs]);

  return { shown, done };
}
