'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { useTextToSpeech } from '@/components/ai-assistant/useTextToSpeech';
import { dismissWelcomeAction } from '../_actions/welcome';

// Minimal SpeechRecognition shape, accessed via a type assertion so we don't
// have to augment the global Window (ChatBox already does that with its own
// internal type and TS doesn't love two competing augmentations).
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [i: number]: { readonly transcript: string };
}
interface SpeechRecognitionEventLike extends Event {
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
  readonly resultIndex: number;
}
interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const AUTO_SUBMIT_SILENCE_MS = 1500;

interface Props {
  firstName: string;
}

/**
 * Full-page welcome takeover that lifts a centered card over a dimmed
 * dashboard. Shown to users whose `users.welcome_dismissed_at` is null, or
 * when the dashboard URL carries `?welcome=fresh` (the post-addBusiness path).
 *
 * Three chips: tour (renders GuidedTour), set up my company (creates the
 * onboarding row and routes to /ai-chat), and tell me what you can do (seeds
 * a prompt into the floating sidecar). Any chip pick or the X button calls
 * dismissWelcomeAction so the takeover doesn't auto-fire again.
 *
 * After the card slides in, the heading and subtitle type out character by
 * character and the full greeting is spoken via the same speech-synthesis
 * path the chat box uses -- so a first-time user sees and hears the
 * assistant talking to them, not just a static modal.
 */
export function DashboardWelcome({ firstName }: Props) {
  const router = useRouter();
  const { seedPrompt, requestSidecarOpen, startCoolTour, startRegularTour } = useAssistant();
  const tts = useTextToSpeech();
  const [phase, setPhase] = useState<'welcome' | 'closed'>('welcome');
  const [busy, setBusy] = useState(false);
  // Mount-time flag flips on next frame so the CSS transition fires (rather
  // than the card appearing already in its final position).
  const [entered, setEntered] = useState(false);

  // Text + mic input. STT only enables when the browser exposes the
  // SpeechRecognition API; everything else falls back to typing.
  const [input, setInput] = useState('');
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [sttSupported, setSttSupported] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const listeningRef = useRef(false);
  const silenceTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);

  useEffect(() => {
    setSttSupported(getSpeechRecognitionCtor() !== null);
  }, []);

  const heading = `Hello${firstName ? ` ${firstName}` : ''}, welcome to RocketBooks!`;
  const para1 =
    "I'm excited to help you and your business streamline your accounting, your billing, and your invoices!";
  const para2 = 'Think of me as your accountant — minus the billable hours.';
  const para3 =
    'Ok, how would you like to start? I can walk you through the app, help you set up your company, or tell you what I can do.';
  // TTS reads the text but stray punctuation / em-dashes can produce weird
  // utterances on some engines, so feed it a clean concatenation with
  // periods between paragraphs for natural pauses.
  const spoken = `${heading}. ${para1} ${para2}. ${para3}`;

  // Typing starts after the entrance animation (500ms slide-in) so the user
  // sees an empty card glide up first. Heading types once and stays. The
  // three body paragraphs cycle through the same row -- each one types out,
  // holds long enough for the reader to take it in, then the next paragraph
  // replaces it. Chips only appear after the final paragraph completes.
  const ENTER_MS = 600;
  const HEAD_CPS_MS = 50;
  const BODY_CPS_MS = 18;
  const PARA_GAP_MS = 150;
  const HOLD_MS = 2200;
  const headingStart = ENTER_MS;
  const bodyStartMs = headingStart + heading.length * HEAD_CPS_MS + PARA_GAP_MS;
  const typedHeading = useTypewriter(entered ? heading : '', {
    startMs: headingStart,
    cpsMs: HEAD_CPS_MS,
  });
  const paragraphs = [para1, para2, para3];
  const [bodyIdx, setBodyIdx] = useState(0);
  const [bodyReady, setBodyReady] = useState(false);
  useEffect(() => {
    if (!entered) return;
    const t = window.setTimeout(() => setBodyReady(true), bodyStartMs);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered]);
  const currentParagraph = paragraphs[bodyIdx] ?? '';
  const typedBody = useTypewriter(bodyReady ? currentParagraph : '', {
    startMs: 0,
    cpsMs: BODY_CPS_MS,
  });
  // Advance to the next paragraph after the current one finishes typing and
  // the read-hold elapses. Stops at the last paragraph so the chips can
  // come in.
  useEffect(() => {
    if (!typedBody.done) return;
    if (bodyIdx >= paragraphs.length - 1) return;
    const t = window.setTimeout(() => setBodyIdx((i) => i + 1), HOLD_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typedBody.done, bodyIdx]);
  const lastBodyDone = bodyIdx >= paragraphs.length - 1 && typedBody.done;

  useEffect(() => {
    const t = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(t);
  }, []);

  // Speak the greeting as soon as the card finishes entering. Always speaks
  // on this surface regardless of the user's autoSpeak preference -- the
  // takeover is a deliberate first-impression moment and TTS off is meant
  // for in-conversation chat, not the welcome. Falls through silently on
  // browsers that don't support speechSynthesis.
  useEffect(() => {
    if (!entered) return;
    if (!tts.supported) return;
    const t = window.setTimeout(() => tts.speak(spoken), ENTER_MS);
    return () => {
      window.clearTimeout(t);
      tts.stop();
    };
    // tts identity flips during voice load -- we only want to speak once per
    // mount; the heading/subtitle text is closed over from props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered, tts.supported]);

  // Strip ?welcome=fresh from the URL on mount so a refresh doesn't re-show
  // the takeover after dismissal.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.has('welcome')) {
      url.searchParams.delete('welcome');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const dismiss = async () => {
    setBusy(true);
    tts.stop();
    try {
      await dismissWelcomeAction();
    } finally {
      setBusy(false);
    }
  };

  const onClose = async () => {
    await dismiss();
    setPhase('closed');
  };

  const onTour = async () => {
    await dismiss();
    // Closing the welcome card here -- the cool tour takes over from the
    // app-shell-mounted CoolTourRunner, which drives the sidecar and
    // navigation on its own.
    setPhase('closed');
    startCoolTour();
  };

  // The cool tour's end card can hand off to the layout/spotlight tour by
  // routing back to /dashboard with ?welcome=fresh&start=tour. When we see
  // that flag, jump directly into GuidedTour without re-showing the
  // takeover card.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('start') === 'tour') {
      url.searchParams.delete('start');
      window.history.replaceState({}, '', url.toString());
      setPhase('closed');
      startRegularTour();
    }
  }, [startRegularTour]);

  const onSetup = async () => {
    await dismiss();
    // The ?onboarding=start flag tells AiChatWorkspace to eagerly load
    // get_onboarding_status and render the OnboardingPanel even for fresh
    // orgs whose state row doesn't exist yet.
    router.push('/ai-chat?onboarding=start');
  };

  const onAbout = async () => {
    await dismiss();
    requestSidecarOpen('bar');
    seedPrompt('What can you do for me?', { mode: 'bar' });
    setPhase('closed');
  };

  // Mic input plumbing. Stops TTS on mic-on (so the engine doesn't transcribe
  // our own utterance) and arms a silence timer so the user doesn't have to
  // manually press submit -- the typed-or-spoken text auto-submits once they
  // pause speaking. Mirrors ChatBox's pattern at a smaller scope: no
  // barge-in / no AEC grace / no engine-restart loop, just enough for the
  // one-shot welcome moment.
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    setInterim('');
    clearSilenceTimer();
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore -- recognition may already be stopped
    }
    recognitionRef.current = null;
  }, [clearSilenceTimer]);

  // Defined after submit so the silence timer can call into it. We declare
  // the ref first and patch it in submitRef.current = submit below.
  const submitRef = useRef<(text: string) => void>(() => {});

  const armSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = window.setTimeout(() => {
      const merged = inputRef.current?.value.trim() ?? '';
      if (merged) {
        stopListening();
        submitRef.current(merged);
      }
    }, AUTO_SUBMIT_SILENCE_MS);
  }, [clearSilenceTimer, stopListening]);

  const startListening = useCallback(() => {
    setInputError(null);
    // Cut TTS so we don't transcribe our own greeting playing out of the
    // speakers (echo via the system audio path is enough for the recognizer
    // to pick up).
    if (tts.speaking) tts.stop();
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setInputError('Microphone input is not supported in this browser');
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    r.onresult = (e) => {
      let finalChunk = '';
      let interimChunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interimChunk += res[0].transcript;
      }
      if (finalChunk) {
        setInput((prev) => (prev ? prev + ' ' : '') + finalChunk.trim());
        setInterim('');
      }
      if (interimChunk) setInterim(interimChunk);
      if (finalChunk || interimChunk) armSilenceTimer();
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setInputError('Microphone permission denied');
        stopListening();
        return;
      }
      setInputError(`Speech recognition: ${e.error}`);
    };
    r.onend = () => {
      setInterim('');
      // If the user is still in listening mode, restart -- Chrome ends
      // continuous recognition on its own after periods of quiet.
      if (listeningRef.current) {
        try {
          r.start();
        } catch {
          // ignore -- next user toggle will retry
        }
      }
    };
    try {
      r.start();
    } catch {
      setInputError('Could not start microphone');
      return;
    }
    recognitionRef.current = r;
    listeningRef.current = true;
    setListening(true);
  }, [tts, armSilenceTimer, stopListening]);

  const toggleMic = useCallback(() => {
    if (listening) {
      stopListening();
    } else {
      startListening();
    }
  }, [listening, stopListening, startListening]);

  // Tear down recognition if the takeover unmounts (chip click, close).
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        // ignore
      }
      clearSilenceTimer();
    };
  }, [clearSilenceTimer]);

  // Map the user's freeform input to a chip handler when it clearly matches
  // one of the three intents, so a user who types "tour me" doesn't have to
  // also click the button. Anything else seeds the sidecar with their
  // actual message -- preserves the freeform AI affordance.
  const submit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      stopListening();
      const lower = text.toLowerCase();
      if (/\b(tour|walk\s*me|walk\s*through|show\s*me\s*around)\b/.test(lower)) {
        void onTour();
        return;
      }
      if (/\b(set\s*up|setup|company|business|onboard)\b/.test(lower)) {
        void onSetup();
        return;
      }
      if (/\b(what\s+can\s+you\s+do|capabilities|about\s+you|tell\s+me\s+about)\b/.test(lower)) {
        void onAbout();
        return;
      }
      // Freeform -- treat as a question for the AI. Same path as the About
      // chip but seed the user's exact text.
      void dismiss().then(() => {
        requestSidecarOpen('bar');
        seedPrompt(text, { mode: 'bar' });
        setPhase('closed');
      });
    },
    // onTour/onSetup/onAbout/dismiss reference state setters that are stable;
    // re-deriving the callback on every keystroke would be wasteful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Keep the ref pointing at the latest submit so the silence timer's
  // closure picks up the current handlers.
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  if (phase === 'closed') return null;

  const chipsReady = lastBodyDone;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome"
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
        <button
          type="button"
          onClick={onClose}
          aria-label="Close welcome"
          className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div className="px-6 pb-6 pt-7">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            ✨ Assistant
          </div>
          {/* Reserve space for the final heading/subtitle heights so the chip
              row doesn't jump up while text is still typing. Visually hidden
              ghost text holds the box; the typed text is overlaid. */}
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
          {/* Single body row: reserves space for the longest paragraph so
              the chip area below doesn't jump when shorter paragraphs cycle
              through. The humor beat (bodyIdx === 1) renders in italic for
              a subtle visual cue. */}
          <div className="relative mt-3">
            <p className="invisible text-base leading-relaxed">{para3}</p>
            <p
              aria-live="polite"
              className={`absolute inset-0 text-base leading-relaxed transition-opacity duration-200 ${
                bodyIdx === 1
                  ? 'italic text-zinc-500 dark:text-zinc-400'
                  : 'text-zinc-700 dark:text-zinc-300'
              }`}
            >
              {typedBody.shown}
              {typedHeading.done && !lastBodyDone && <Caret />}
            </p>
          </div>
          <div
            className={`mt-5 flex flex-col gap-2 transition-opacity duration-300 ${
              chipsReady ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <button
              type="button"
              onClick={onTour}
              disabled={busy || !chipsReady}
              className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
            >
              🧭 Give me a tour
            </button>
            <button
              type="button"
              onClick={onSetup}
              disabled={busy || !chipsReady}
              className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
            >
              🚀 Set up my company
            </button>
            <button
              type="button"
              onClick={onAbout}
              disabled={busy || !chipsReady}
              className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
            >
              💬 Tell me what you can do
            </button>
          </div>
          <div
            className={`mt-4 transition-opacity duration-300 ${
              chipsReady ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              or ask me anything
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit(input);
              }}
              className="flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1.5 focus-within:border-violet-400 focus-within:bg-white dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-violet-500 dark:focus-within:bg-zinc-950"
            >
              {sttSupported && (
                <button
                  type="button"
                  onClick={toggleMic}
                  disabled={busy || !chipsReady}
                  aria-label={listening ? 'Stop listening' : 'Speak'}
                  aria-pressed={listening}
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors ${
                    listening
                      ? 'border-red-500 bg-red-100 text-red-700 dark:border-red-500 dark:bg-red-950/40 dark:text-red-300'
                      : 'border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
                  } disabled:opacity-50`}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                </button>
              )}
              <input
                ref={inputRef}
                type="text"
                value={listening && interim ? `${input}${input ? ' ' : ''}${interim}` : input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setInputError(null);
                }}
                disabled={busy || !chipsReady}
                placeholder={listening ? 'Listening…' : 'Type or speak your answer…'}
                className="flex-1 bg-transparent px-2 text-sm text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                autoComplete="off"
              />
              <button
                type="submit"
                disabled={busy || !chipsReady || !input.trim()}
                aria-label="Send"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </form>
            {inputError && (
              <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{inputError}</p>
            )}
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
