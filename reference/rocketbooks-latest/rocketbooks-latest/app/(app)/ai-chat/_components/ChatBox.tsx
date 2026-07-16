'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { InvoicePreview, type InvoiceDraftView } from './InvoicePreview';
import { TransactionsPanel, type TransactionsResult } from './TransactionsPanel';
import { InvoicesPanel, type InvoicesResult } from './InvoicesPanel';
import { BillsPanel, type BillsResult } from './BillsPanel';
import { type OnboardingStatusView } from './OnboardingPanel';
import { ChatActivityIndicator } from './ChatActivityIndicator';
import { useTextToSpeech, type TtsApi } from '@/components/ai-assistant/useTextToSpeech';
import {
  useStreamingTts,
  OPENAI_TTS_VOICES,
  type StreamingTtsApi,
} from '@/components/ai-assistant/useStreamingTts';
import {
  useTtsEngine,
  useBargeInPreference,
  useOpenMicPreference,
  type TtsEngine,
} from '@/components/ai-assistant/useTtsEngine';
import { useBargeIn } from '@/components/ai-assistant/useBargeIn';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { normalizeLanguage } from '@/lib/i18n/languages';

/** Imperative handle exposed to AiChatWorkspace so the cards panel can inject
 *  AI prompts into the text surface as if the user typed them. */
export interface ChatBoxHandle {
  inject(prompt: string): void;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** Sent to the model but NOT rendered — used for proactive onboarding nudges
   *  that trigger a coaching turn without showing a fake user prompt. */
  hidden?: boolean;
  tools?: string[];
  invoice?: InvoiceDraftView;
  transactions?: TransactionsResult;
  invoices?: InvoicesResult;
  bills?: BillsResult;
}

// Minimal SpeechRecognition typing — the DOM lib doesn't ship these on all
// targets, but Chrome/Edge/Safari expose webkitSpeechRecognition.
interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(i: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(i: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
declare global {
  interface Window {
    SpeechRecognition?: { new (): SpeechRecognitionLike };
    webkitSpeechRecognition?: { new (): SpeechRecognitionLike };
  }
}

const AUTO_SUBMIT_SILENCE_MS = 1800;

interface SuggestionChip {
  label: string;
  prompt: string;
}

interface ChatBoxProps {
  /** Lifted shared state — workspace owns it; ChatBox writes via tool-result handler. */
  onboarding: OnboardingStatusView | null;
  setOnboarding: (next: OnboardingStatusView | null) => void;
  /** Notifies parent when a request is in flight, so the cards panel can disable
   *  click handlers and prevent duplicate prompt injections. */
  onPendingChange?: (pending: boolean) => void;
  /** When true (onboarding flow is active), the conversation area collapses
   *  to show only the latest turn, mirroring the floating sidecar's bar mode.
   *  A "Show more" toggle expands the full history. Off → normal full view. */
  onboardingMode?: boolean;
  /** Proactive, books-grounded opening message (from /api/ai/opener). Rendered
   *  once as the first assistant turn for completed-onboarding orgs; null while
   *  onboarding (the onboarding greeting leads instead). */
  openerGreeting?: string | null;
  /** Dynamic suggestion chips derived from the client's situation. Shown under
   *  the conversation until the user starts chatting. */
  chips?: SuggestionChip[];
}

export const ChatBox = forwardRef<ChatBoxHandle, ChatBoxProps>(function ChatBox(
  { onboarding, setOnboarding, onPendingChange, onboardingMode = false, openerGreeting = null, chips = [] },
  ref,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [interim, setInterim] = useState('');
  const [pending, setPending] = useState(false);
  const [chatActivity, setChatActivity] = useState<'idle' | 'thinking' | 'tool' | 'speaking'>('idle');
  const [chatActivityLabel, setChatActivityLabel] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [sttSupported, setSttSupported] = useState(false);
  const [silenceCountdown, setSilenceCountdown] = useState(0);
  // When true, the input pill is replaced by a small sparkle button. In-memory
  // only — the pill is back on every page load.
  const [collapsed, setCollapsed] = useState(false);
  // The floating composer needs to escape this page's transformed wrapper
  // (app/(app)/ai-chat/page.tsx applies lg:translate-x-[...] which creates a
  // containing block for fixed descendants — pinning would be relative to
  // that wrapper instead of the viewport). We portal it to document.body
  // instead. `mounted` gates the portal so SSR renders nothing and the
  // hydrated tree matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  // Onboarding-mode only: when false (default), conversation area shows just
  // the most recent turn. "Show more" expands. Resets to false on every send
  // so the user always sees the freshest AI reply.
  const [barExpanded, setBarExpanded] = useState(false);
  const tts = useTextToSpeech();
  const streamingTts = useStreamingTts();
  const { engine: ttsEngine, setEngine: setTtsEngine } = useTtsEngine();
  const { openMic, setOpenMic } = useOpenMicPreference();
  const { bargeIn, setBargeIn } = useBargeInPreference();
  const { requestSidecarOpen, dispatchToolResult } = useAssistant();
  // Index of the last assistant message we auto-spoke, so a re-render of the
  // same content doesn't replay speech.
  const autoSpokenIdxRef = useRef<number>(-1);
  const greetedPhasesRef = useRef<Set<string>>(new Set());
  const openerInjectedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Root of the floating composer card (or the collapsed sparkle button —
  // whichever is currently mounted). Measured into the body's
  // --rs-sidecar-bar-height var so the inline conversation panel can reserve
  // bottom padding and not hide messages behind the floating composer.
  const composerRef = useRef<HTMLElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const inputBeforeListenRef = useRef('');
  const silenceTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const listeningRef = useRef(false);
  const pendingRef = useRef(false);
  const sendRef = useRef<(overrideText?: string, opts?: { hidden?: boolean }) => void>(() => {});

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSttSupported(!!Ctor);
  }, []);

  // ChatBox owns the only chat composer on /ai-chat (the floating sidecar is
  // hidden on this route). Pin it to bottom-center like the sidecar's bar mode
  // and mirror its body-class + CSS-var contract so anything that reserves
  // space for the floating bar globally keeps working. ResizeObserver tracks
  // height changes — "Show more" in onboarding mode, growing input, etc.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const cls = 'rs-sidecar-bar';
    const varName = '--rs-sidecar-bar-height';
    const el = composerRef.current;
    if (!el) return;
    document.body.classList.add(cls);
    const update = () => {
      document.body.style.setProperty(varName, `${el.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.body.classList.remove(cls);
      document.body.style.removeProperty(varName);
    };
  }, [collapsed]);

  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setSilenceCountdown(0);
  };

  const armSilenceTimer = () => {
    clearSilenceTimer();
    if (!listeningRef.current) return;
    if (pendingRef.current) return;
    // Don't fire silence-send while the AI is still talking — if our AEC
    // didn't scrub the TTS audio, the next "silence" would dispatch
    // contaminated input as a user turn.
    if (ttsSpeakingRef.current) return;
    if (!inputBeforeListenRef.current.trim()) return;

    const startedAt = Date.now();
    setSilenceCountdown(AUTO_SUBMIT_SILENCE_MS);
    countdownIntervalRef.current = window.setInterval(() => {
      const remaining = Math.max(0, AUTO_SUBMIT_SILENCE_MS - (Date.now() - startedAt));
      setSilenceCountdown(remaining);
    }, 100);
    silenceTimerRef.current = window.setTimeout(() => {
      clearSilenceTimer();
      sendRef.current();
    }, AUTO_SUBMIT_SILENCE_MS);
  };

  const buildRecognition = (): SpeechRecognitionLike | null => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return null;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';

    r.onresult = (e: SpeechRecognitionEvent) => {
      // Discard transcripts while TTS is playing — SpeechRecognition's
      // internal capture path may not benefit from the AEC we set up on
      // getUserMedia, so its output during TTS is likely AEC leakage of
      // our own voice. VAD is the authoritative "user spoke" signal in
      // that window. After VAD fires, onBarge zeros ttsSpeakingRef
      // synchronously so the user's words right after the trigger land
      // in the input normally.
      if (ttsSpeakingRef.current) return;
      // Also discard during the post-stop audio tail, even though
      // ttsSpeakingRef has already flipped false — the OS audio path is
      // still emitting our prior utterance for a beat.
      if (Date.now() < ttsTailGraceEndRef.current) return;
      let finalChunk = '';
      let interimChunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interimChunk += res[0].transcript;
      }
      if (finalChunk) {
        const base = inputBeforeListenRef.current;
        const merged = (base ? base + ' ' : '') + finalChunk.trim();
        inputBeforeListenRef.current = merged;
        setInput(merged);
        setInterim('');
      }
      if (interimChunk) setInterim(interimChunk);
      // Any speech activity (interim or final) resets the silence timer
      if (finalChunk || interimChunk) armSilenceTimer();
    };
    r.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Microphone permission denied');
        listeningRef.current = false;
        setListening(false);
        clearSilenceTimer();
        return;
      }
      setError(`Speech recognition: ${e.error}`);
    };
    r.onend = () => {
      // Browsers (Chrome especially) end continuous recognition periodically
      // even when continuous=true. Auto-restart while the user has the mic on.
      setInterim('');
      if (listeningRef.current) {
        window.setTimeout(() => {
          if (!listeningRef.current) return;
          const fresh = buildRecognition();
          if (!fresh) return;
          try {
            fresh.start();
            recognitionRef.current = fresh;
          } catch {
            // start can throw if engine hasn't fully released; one retry
            window.setTimeout(() => {
              if (!listeningRef.current) return;
              try {
                fresh.start();
                recognitionRef.current = fresh;
              } catch {
                listeningRef.current = false;
                setListening(false);
              }
            }, 200);
          }
        }, 50);
      } else {
        clearSilenceTimer();
      }
    };
    return r;
  };

  const startListening = () => {
    // Cut TTS the moment the user picks up the mic. Both engines stop
    // unconditionally — cheap no-op when idle.
    const interruptedTts = tts.speaking || streamingTts.speaking;
    if (tts.speaking) tts.stop();
    streamingTts.stop();
    if (interruptedTts) {
      // Hold a 250ms grace so the OS audio tail doesn't get transcribed.
      ttsTailGraceEndRef.current = Date.now() + 250;
    }
    const r = buildRecognition();
    if (!r) return;
    inputBeforeListenRef.current = input;
    try {
      r.start();
      recognitionRef.current = r;
      setError(null);
      listeningRef.current = true;
      setListening(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start mic');
      listeningRef.current = false;
      setListening(false);
    }
  };

  const stopListening = () => {
    listeningRef.current = false;
    setListening(false);
    clearSilenceTimer();
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setInterim('');
  };

  const toggleListening = () => {
    if (listening) stopListening();
    else startListening();
  };

  // Barge-in VAD: while OpenAI TTS is playing and the user opted in, run a
  // volume detector on the AEC'd getUserMedia stream. When they start
  // speaking, cut the AI off. In barge mode the mic stays open across turns
  // (see send() below), so VAD runs even while SpeechRecognition is active —
  // they consume independent capture paths.
  useBargeIn({
    active:
      openMic &&
      bargeIn &&
      ttsEngine === 'openai' &&
      streamingTts.speaking,
    onBarge: () => {
      streamingTts.stop();
      if (tts.speaking) tts.stop();
      // Zero the ref synchronously — the useEffect that mirrors
      // streamingTts.speaking into ttsSpeakingRef won't run until the next
      // render, and we want SpeechRecognition's onresult to unblock now so
      // the user's first post-trigger words land in the input.
      ttsSpeakingRef.current = false;
      // Only spin up SpeechRecognition if it isn't already capturing.
      if (!listeningRef.current) startListening();
    },
  });

  // SpeechRecognition's silence-timer can fire on TTS-bleed if the browser's
  // AEC fails to scrub our TTS audio from its internal capture path. Block
  // the timer while TTS is speaking; it re-arms naturally on the next
  // post-TTS onresult chunk. Keep the ref in sync via effect so the timer's
  // captured closure reads current state.
  const ttsSpeakingRef = useRef(false);
  // Audio-tail grace window. tts.stop() / streamingTts.stop() halt the
  // source synchronously, but the OS audio path keeps emitting for
  // ~100–250ms. Same thing happens at the end of a natural utterance.
  // Whenever speaking goes from true to false we stamp a deadline; onresult
  // discards transcript chunks until it passes.
  const ttsTailGraceEndRef = useRef(0);
  useEffect(() => {
    const wasSpeaking = ttsSpeakingRef.current;
    const nowSpeaking = streamingTts.speaking || tts.speaking;
    ttsSpeakingRef.current = nowSpeaking;
    if (wasSpeaking && !nowSpeaking) {
      ttsTailGraceEndRef.current = Math.max(
        ttsTailGraceEndRef.current,
        Date.now() + 250,
      );
    }
  }, [streamingTts.speaking, tts.speaking]);

  const send = async (overrideText?: string, opts?: { hidden?: boolean }) => {
    clearSilenceTimer();
    const text = (overrideText ?? input).trim();
    if (!text || pending) return;
    // Cut off any in-progress TTS so the previous answer doesn't bleed into
    // the new turn. Stop both engines unconditionally — they're cheap no-ops
    // when idle, and this avoids gating on the active engine setting.
    if (tts.speaking) tts.stop();
    streamingTts.stop();
    // Open-mic mode leaves SpeechRecognition running across turns so the
    // user doesn't have to re-tap the mic. TTS-bleed is suppressed by the
    // ttsSpeakingRef + audio-tail grace logic above; barge-in (separate
    // toggle) layers VAD on top when engine='openai'.
    if (listeningRef.current && !openMic) stopListening();
    setError(null);
    const userMsg: Message = { role: 'user', content: text, hidden: opts?.hidden };
    const next = [...messages, userMsg];
    setMessages([...next, { role: 'assistant', content: '' }]);
    if (overrideText === undefined) {
      // Only clear input when the message came from the input field. Card-
      // injected prompts don't touch the input, so the user's in-progress
      // typing (if any) stays preserved.
      setInput('');
      setInterim('');
      inputBeforeListenRef.current = '';
    }
    setPending(true);
    setChatActivity('thinking');
    setChatActivityLabel('');
    // New turn → collapse history view so the answer starts on a clean slate.
    // Only meaningful in onboarding mode; harmless otherwise.
    setBarExpanded(false);

    try {
      const r = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next,
          language: normalizeLanguage(window.localStorage.getItem('rs_language')),
        }),
      });
      if (!r.ok || !r.body) throw new Error(`Chat failed: ${r.status}`);

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as {
              delta?: string;
              error?: string;
              tool_use?: { name: string; args: string };
              tool_result?: { name: string; ok: boolean; output: unknown };
              done?: boolean;
            };
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.tool_use) {
              setChatActivity('tool');
              setChatActivityLabel(parsed.tool_use.name);
              setMessages((cur) => {
                const copy = [...cur];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = { ...last, tools: [...(last.tools ?? []), parsed.tool_use!.name] };
                return copy;
              });
            }
            if (parsed.tool_result) {
              setChatActivity('thinking');
              setChatActivityLabel('');
            }
            if (parsed.tool_result?.ok) {
              const { name, output } = parsed.tool_result;
              // Broadcast on the generic channel so the cool-tour runner can
              // await specific tools by name. Mirrors the AIAssistantSidecar
              // dispatch path so subscribers see results from either surface.
              dispatchToolResult(name, output);
              if (name === 'save_invoice_draft' || name === 'post_invoice') {
                const view = output as InvoiceDraftView;
                if (view?.draftId) {
                  setMessages((cur) => {
                    const copy = [...cur];
                    const last = copy[copy.length - 1];
                    copy[copy.length - 1] = { ...last, invoice: view };
                    return copy;
                  });
                }
              } else if (name === 'cancel_invoice_draft') {
                setMessages((cur) => {
                  const copy = [...cur];
                  const last = copy[copy.length - 1];
                  copy[copy.length - 1] = { ...last, invoice: undefined };
                  return copy;
                });
              } else if (name === 'query_transactions') {
                const view = output as TransactionsResult;
                setMessages((cur) => {
                  const copy = [...cur];
                  const last = copy[copy.length - 1];
                  copy[copy.length - 1] = { ...last, transactions: view };
                  return copy;
                });
              } else if (name === 'query_invoices') {
                const view = output as InvoicesResult;
                setMessages((cur) => {
                  const copy = [...cur];
                  const last = copy[copy.length - 1];
                  copy[copy.length - 1] = { ...last, invoices: view };
                  return copy;
                });
              } else if (name === 'query_bills') {
                const view = output as BillsResult;
                setMessages((cur) => {
                  const copy = [...cur];
                  const last = copy[copy.length - 1];
                  copy[copy.length - 1] = { ...last, bills: view };
                  return copy;
                });
              } else if (
                name === 'get_onboarding_status' ||
                name === 'set_business_info' ||
                name === 'advance_onboarding'
              ) {
                const view = output as OnboardingStatusView;
                if (view?.phase) {
                  // When the assistant itself advanced (set_business_info /
                  // advance_onboarding), it's already coaching the new step in
                  // THIS turn — mark the phase greeted so the proactive per-phase
                  // kickoff doesn't fire a duplicate. Panel-button advances go
                  // through onChanged (not here), so those still get the kickoff.
                  if (name !== 'get_onboarding_status') greetedPhasesRef.current.add(view.phase);
                  setOnboarding(view);
                }
              }
            }
            if (parsed.delta) {
              setChatActivity('speaking');
              acc += parsed.delta;
              setMessages((cur) => {
                const copy = [...cur];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = { ...last, content: acc };
                return copy;
              });
              // OpenAI-engine path: feed deltas into the sentence-streaming
              // pipeline so audio starts ~500ms after the first sentence
              // completes. The local engine still uses the post-stream
              // useEffect below — gated to avoid double-speaking.
              if (ttsEngine === 'openai' && tts.autoSpeak) {
                streamingTts.feed(parsed.delta);
              }
            }
            if (parsed.done) {
              setChatActivity('idle');
              setChatActivityLabel('');
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
      // Stream finished cleanly. Drain any trailing partial sentence in the
      // streaming-TTS buffer so the last few words don't get stuck.
      if (ttsEngine === 'openai' && tts.autoSpeak) {
        streamingTts.flush();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setPending(false);
      setChatActivity('idle');
      setChatActivityLabel('');
    }
  };

  // Keep a stable ref so the silence timer and the imperative inject() can
  // fire send() without stale closures.
  useEffect(() => {
    sendRef.current = send;
  });

  // Notify parent when pending changes — drives the cards panel's busy gate.
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  useImperativeHandle(
    ref,
    () => ({
      inject(prompt: string) {
        sendRef.current(prompt);
      },
    }),
    [],
  );

  // Kick off step 1 of onboarding with a real assistant message asking for
  // the company's name and what it does. Fires exactly once when we land on
  // /ai-chat with a fresh org (phase=business_info, no business info yet)
  // and an empty conversation -- so the experience for users arriving via
  // the "Add business" path or the welcome takeover's "Set up my company"
  // chip is the AI proactively starting the conversation. Voiced through
  // tts.speak() regardless of the user's autoSpeak preference (same
  // reasoning as the dashboard welcome takeover -- this is a deliberate
  // "hear the AI" moment); we mark the message as already-spoken so the
  // auto-speak effect below doesn't double up.
  useEffect(() => {
    if (!onboardingMode || !onboarding || pending) return;
    const phase = onboarding.phase;
    if (!phase || greetedPhasesRef.current.has(phase)) return;
    // business_info only kicks off for a genuinely fresh business on an empty
    // thread — an already-filled business or an in-progress chat is covered.
    if (phase === 'business_info' && (onboarding.signals?.hasBusinessInfo || messages.length > 0)) {
      greetedPhasesRef.current.add(phase);
      return;
    }
    greetedPhasesRef.current.add(phase);
    // Trigger a DYNAMIC coaching turn for this step (once per phase). A HIDDEN
    // nudge (not rendered) prompts the assistant to lead this step contextually.
    // IMPORTANT: coach-only — it must NOT call tools or advance. The user
    // advances by acting in the panel, which fires the next clean coaching turn.
    // (Letting the kickoff call advance_onboarding/get_onboarding_status changed
    // the phase mid-turn and cascaded: guidance appeared, got erased, repeated.)
    sendRef.current(
      `The user just reached the "${phase}" onboarding step. In ONE or two short, friendly sentences, tell them plainly what to do on THIS step. Do NOT call any tools, do NOT advance the step, and do NOT re-check status — just describe this step and wait for the user to act in the panel. Don't re-introduce yourself.`,
      { hidden: true },
    );
  }, [onboardingMode, onboarding, messages.length, pending]);

  // Proactive opener: drop the books-grounded greeting in as the first
  // assistant turn for completed-onboarding orgs. Mirrors the onboarding
  // greeting effect but only fires when onboarding is NOT active (the two never
  // collide — the opener endpoint returns null while onboarding). Kept silent
  // (not force-spoken) since the user didn't initiate a turn; voice mode has
  // its own spoken greeting.
  useEffect(() => {
    if (openerInjectedRef.current) return;
    if (onboardingMode) return;
    if (!openerGreeting) return;
    if (messages.length > 0) return;
    openerInjectedRef.current = true;
    setMessages([{ role: 'assistant', content: openerGreeting }]);
    autoSpokenIdxRef.current = 0;
  }, [openerGreeting, onboardingMode, messages.length]);

  // Local-engine auto-speak: fires once per completed assistant message.
  // OpenAI engine is fed sentence-by-sentence during the stream itself (see
  // the parsed.delta branch above), so this effect is gated to local-only
  // to avoid double-speaking.
  useEffect(() => {
    if (ttsEngine !== 'local') return;
    if (!tts.autoSpeak || pending) return;
    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];
    if (!last || last.role !== 'assistant' || !last.content.trim()) return;
    if (autoSpokenIdxRef.current === lastIdx) return;
    autoSpokenIdxRef.current = lastIdx;
    tts.speak(last.content);
  }, [pending, messages, tts, ttsEngine]);

  useEffect(() => {
    return () => {
      clearSilenceTimer();
      listeningRef.current = false;
      recognitionRef.current?.abort();
    };
  }, []);

  const displayValue = listening && interim ? `${input}${input ? ' ' : ''}${interim}` : input;
  // Onboarding-mode collapsed: only the last message is rendered; everything
  // else is filtered out so panel close handlers still get the real index.
  const compactView = onboardingMode && !barExpanded;

  // Conversation content (scroll area + messages + show-more + activity +
  // error). Rendered either inside the standalone white card (default) or
  // inside the rainbow pill (onboarding mode) — never both, so the single
  // scrollRef attaches to whichever branch is mounted.
  const conversationContent = (
    <>
      <div
        ref={scrollRef}
        className={
          onboardingMode
            ? 'max-h-[320px] overflow-y-auto px-3 py-2'
            : 'flex-1 overflow-y-auto p-4'
        }
      >
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Start a conversation with your AI accounting assistant.
          </div>
        )}
        <div className="flex flex-col gap-3">
          {messages.map((m, i) => {
            if (m.hidden) return null;
            if (compactView && i < messages.length - 1) return null;
            const hasPanel = m.transactions || m.invoice || m.invoices || m.bills;
            return (
              <div
                key={i}
                className={`flex flex-col gap-2 ${
                  m.role === 'user' ? 'max-w-[85%] self-end' : hasPanel ? 'w-full self-start' : 'max-w-[85%] self-start'
                }`}
              >
                {m.tools && m.tools.length > 0 && (
                  <div className="text-xs text-zinc-500">⚙ {m.tools.join(' → ')}</div>
                )}
                <div
                  className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                  } ${hasPanel ? 'self-start max-w-[85%]' : ''}`}
                >
                  {m.content || <span className="text-zinc-400">…</span>}
                </div>
                {m.transactions && (
                  <TransactionsPanel
                    result={m.transactions}
                    onClose={() => {
                      setMessages((cur) => {
                        const copy = [...cur];
                        copy[i] = { ...copy[i], transactions: undefined };
                        return copy;
                      });
                    }}
                  />
                )}
                {m.invoices && (
                  <InvoicesPanel
                    result={m.invoices}
                    onClose={() => {
                      setMessages((cur) => {
                        const copy = [...cur];
                        copy[i] = { ...copy[i], invoices: undefined };
                        return copy;
                      });
                    }}
                  />
                )}
                {m.bills && (
                  <BillsPanel
                    result={m.bills}
                    onClose={() => {
                      setMessages((cur) => {
                        const copy = [...cur];
                        copy[i] = { ...copy[i], bills: undefined };
                        return copy;
                      });
                    }}
                  />
                )}
                {m.invoice && (
                  <InvoicePreview
                    draft={m.invoice}
                    onClose={() => {
                      setMessages((cur) => {
                        const copy = [...cur];
                        copy[i] = { ...copy[i], invoice: undefined };
                        return copy;
                      });
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {!onboardingMode && chips.length > 0 && messages.length <= 1 && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {chips.map((chip, i) => (
            <button
              key={i}
              type="button"
              disabled={pending}
              onClick={() => send(chip.prompt)}
              className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {onboardingMode && messages.length > 1 && (
        <div className="flex justify-end px-3 pb-1">
          <button
            type="button"
            onClick={() => setBarExpanded((v) => !v)}
            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            {barExpanded ? 'Show less' : 'Show more'}
          </button>
        </div>
      )}

      <ChatActivityIndicator activity={chatActivity} label={chatActivityLabel} />

      {error && <div className="px-4 pb-3 text-sm text-red-600">{error}</div>}
    </>
  );

  return (
    <div
      className={
        onboardingMode
          ? 'flex flex-col gap-3'
          : 'flex h-[70vh] flex-col gap-3 lg:h-auto lg:min-h-[420px] lg:flex-1'
      }
    >
      {!onboardingMode && (
        <div
          className="flex flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          // Cap the conversation card so it never slides under the floating
          // composer. The grid row stretches the center column to match the
          // tallest sibling (Outlook), which would otherwise push the card
          // beneath the bar. We deliberately don't include
          // var(--rs-sidecar-bar-height) here — when the user collapses and
          // re-opens the composer, the var briefly desyncs from the actual
          // measured height (portal unmount/mount race against the
          // ResizeObserver), and the card would jump to a much shorter size.
          // 26rem covers ~6rem composer + ~20rem of top chrome/gaps and
          // stays stable across collapse toggles.
          style={{ maxHeight: 'calc(100vh - 26rem)' }}
        >
          {conversationContent}
        </div>
      )}

      {mounted && createPortal(
        collapsed ? (
        <button
          ref={composerRef as React.RefObject<HTMLButtonElement | null>}
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Open AI assistant input"
          className="rs-rainbow-border fixed bottom-4 left-1/2 z-40 flex h-10 w-16 -translate-x-1/2 items-center justify-center rounded-full bg-white text-zinc-700 shadow-md transition hover:shadow-lg dark:bg-zinc-950 dark:text-zinc-200"
        >
          <SparkleIcon />
        </button>
      ) : (
      <div
        ref={composerRef as React.RefObject<HTMLDivElement | null>}
        className="rs-rainbow-border fixed bottom-4 left-1/2 z-40 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl bg-white shadow-xl dark:bg-zinc-950"
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <SparkleIcon className="h-3.5 w-3.5 text-blue-500" />
            <span className="font-medium">Assistant</span>
          </div>
          <div className="flex items-center gap-1">
            <VoiceMenu
              tts={tts}
              streamingTts={streamingTts}
              engine={ttsEngine}
              setEngine={setTtsEngine}
              openMic={openMic}
              setOpenMic={setOpenMic}
              bargeIn={bargeIn}
              setBargeIn={setBargeIn}
            />
            <IconButton
              onClick={() => requestSidecarOpen('side')}
              title="Open floating assistant in side panel"
            >
              <SidePanelIcon />
            </IconButton>
            <IconButton
              onClick={() => {
                if (tts.speaking) tts.stop();
                streamingTts.stop();
                if (listeningRef.current) stopListening();
                setCollapsed(true);
              }}
              title="Collapse"
            >
              <XIcon />
            </IconButton>
          </div>
        </header>
        {onboardingMode && conversationContent}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex items-end gap-2 px-3 py-2"
        >
          {sttSupported && (
            <button
              type="button"
              onClick={toggleListening}
              title={listening ? 'Stop dictation (auto-submits on silence)' : 'Dictate (speech to text)'}
              aria-label={listening ? 'Stop dictation' : 'Start dictation'}
              className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition ${
                listening
                  ? 'animate-pulse border-red-300 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900'
              }`}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <path d="M12 19v3" />
              </svg>
              {silenceCountdown > 0 && (
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
                  viewBox="0 0 36 36"
                  aria-hidden="true"
                >
                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={`${(silenceCountdown / AUTO_SUBMIT_SILENCE_MS) * 100} 100`}
                    pathLength={100}
                    className="opacity-60"
                  />
                </svg>
              )}
            </button>
          )}
          <input
            type="text"
            value={displayValue}
            onChange={(e) => {
              setInput(e.target.value);
              inputBeforeListenRef.current = e.target.value;
            }}
            placeholder={listening ? 'Listening… speak now' : 'Ask anything…'}
            disabled={pending}
            className={`flex-1 rounded-md border bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:outline-none dark:bg-zinc-950 dark:placeholder:text-zinc-500 ${
              listening
                ? 'border-red-300 focus:border-red-400 dark:border-red-900'
                : 'border-zinc-200 focus:border-zinc-400 dark:border-zinc-800'
            }`}
          />
          <button
            type="submit"
            disabled={!input.trim() || pending}
            aria-label="Send"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"
          >
            {pending ? (
              <svg viewBox="0 0 24 24" className="h-3 w-3 animate-spin" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.2" />
                <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            )}
          </button>
        </form>
      </div>
      ),
      document.body,
      )}
    </div>
  );
});

function IconButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      {children}
    </button>
  );
}

function SpeakerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? 'h-4 w-4'}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function SidePanelIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? 'h-4 w-4'}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * Voice picker popover. Auto-speak toggle is shared across engines (lives on
 * the local-TTS hook). The Engine selector decides which voice picker is
 * shown and which TTS pipeline drives playback for the preview button.
 */
function VoiceMenu({
  tts,
  streamingTts,
  engine,
  setEngine,
  openMic,
  setOpenMic,
  bargeIn,
  setBargeIn,
}: {
  tts: TtsApi;
  streamingTts: StreamingTtsApi;
  engine: TtsEngine;
  setEngine: (e: TtsEngine) => void;
  openMic: boolean;
  setOpenMic: (next: boolean) => void;
  bargeIn: boolean;
  setBargeIn: (next: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!tts.supported && !streamingTts.supported) return null;
  const grouped = new Map<string, SpeechSynthesisVoice[]>();
  for (const v of tts.voices) {
    const lang = v.lang || 'unknown';
    if (!grouped.has(lang)) grouped.set(lang, []);
    grouped.get(lang)!.push(v);
  }
  const sortedLangs = Array.from(grouped.keys()).sort((a, b) => {
    if (a.startsWith('en') && !b.startsWith('en')) return -1;
    if (b.startsWith('en') && !a.startsWith('en')) return 1;
    return a.localeCompare(b);
  });
  const preview = () => {
    const sample = 'Hi, this is how I sound.';
    if (engine === 'openai') {
      streamingTts.stop();
      streamingTts.feed(sample);
      streamingTts.flush();
    } else {
      tts.speak(sample);
    }
  };
  return (
    <div className="relative">
      <IconButton
        onClick={() => setOpen((o) => !o)}
        title={tts.autoSpeak ? 'Voice (auto-speak on)' : 'Voice settings'}
      >
        <SpeakerIcon className={tts.autoSpeak ? 'h-4 w-4 text-blue-500' : 'h-4 w-4'} />
      </IconButton>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-full z-50 mb-1 max-h-[min(70vh,520px)] w-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
            <label className="mb-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={tts.autoSpeak}
                onChange={(e) => tts.setAutoSpeak(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span>Read responses aloud automatically</span>
            </label>
            <div className="mb-1 text-zinc-500 dark:text-zinc-400">Engine</div>
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value as TtsEngine)}
              className="mb-2 block w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900"
            >
              <option value="local">Local (free)</option>
              <option value="openai">OpenAI TTS (premium)</option>
            </select>
            <div className="mb-1 text-zinc-500 dark:text-zinc-400">Voice</div>
            {engine === 'openai' ? (
              <select
                value={streamingTts.voice}
                onChange={(e) =>
                  streamingTts.setVoice(e.target.value as typeof OPENAI_TTS_VOICES[number])
                }
                className="block w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900"
              >
                {OPENAI_TTS_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={tts.selectedVoiceName ?? ''}
                onChange={(e) => tts.setSelectedVoiceName(e.target.value || null)}
                className="block max-h-64 w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900"
              >
                <option value="">System default</option>
                {sortedLangs.map((lang) => (
                  <optgroup key={lang} label={lang}>
                    {grouped.get(lang)!.map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.name}
                        {v.default ? ' · default' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={preview}
              className="mt-2 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              Preview
            </button>
            <label className="mt-3 flex items-start gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              <input
                type="checkbox"
                checked={openMic}
                onChange={(e) => setOpenMic(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <span>
                Open mic
                <span className="block text-zinc-500 dark:text-zinc-400">
                  Mic stays on between turns; no need to re-tap.
                </span>
              </span>
            </label>
            {openMic && engine === 'openai' && (
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={bargeIn}
                  onChange={(e) => setBargeIn(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5"
                />
                <span>
                  Allow voice interrupt
                  <span className="block text-zinc-500 dark:text-zinc-400">
                    Speak while the AI talks to cut it off.
                  </span>
                </span>
              </label>
            )}
            {engine === 'local' && tts.voices.length === 0 && (
              <div className="mt-2 text-zinc-500 dark:text-zinc-400">
                Loading voices…
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className ?? 'h-5 w-5'} aria-hidden="true">
      <path d="M12 2l1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7L12 2z" />
      <path d="M5 17l.7 2L8 20l-2.3.7L5 23l-.7-2.3L2 20l2.3-1L5 17z" />
    </svg>
  );
}
