'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

interface UseDictationArgs {
  /** Current input value — read at toggle time so interim chunks append. */
  input: string;
  /** Setter for the input value. */
  setInput: (v: string) => void;
  /** Called once the silence timer fires (or the caller can call manually). */
  onAutoSubmit: () => void;
  /** Pending state of the parent — pauses the silence timer while in flight. */
  pending: boolean;
}

export interface DictationApi {
  /** Whether the browser exposes webSpeech APIs. */
  supported: boolean;
  /** Whether mic is currently active. */
  listening: boolean;
  /** Interim (not-yet-final) transcript, useful as a placeholder. */
  interim: string;
  /** Last error message (mic perm denied, etc), or null. */
  error: string | null;
  /** Start / stop / toggle. */
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Clear the current error so the UI hides it. */
  clearError: () => void;
  /**
   * Reset the dictation buffer (called after a successful send) so the next
   * spoken phrase starts a new message instead of appending to the one the
   * user just sent. Keeps the mic open — only the local accumulator resets.
   */
  reset: () => void;
}

/**
 * Web SpeechRecognition wrapper that mirrors the AiChat ChatBox dictation
 * behavior: continuous capture, browser-end auto-restart, append final
 * chunks to the input, and auto-submit after a beat of silence.
 *
 * The hook does NOT submit on its own — it calls `onAutoSubmit` once silence
 * fires. The caller decides what that means (typically: send current input).
 */
export function useDictation(args: UseDictationArgs): DictationApi {
  const { input, setInput, onAutoSubmit, pending } = args;
  // Lazy init: SpeechRecognition feature-detect once, no effect-driven setState.
  const [supported] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);
  });
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const listeningRef = useRef(false);
  const pendingRef = useRef(false);
  const inputBaseRef = useRef('');
  const silenceTimerRef = useRef<number | null>(null);
  const onAutoSubmitRef = useRef(onAutoSubmit);
  // Mutable handle to buildRecognition so r.onend can restart without
  // referencing the function before its declaration.
  const buildRef = useRef<() => SpeechRecognitionLike | null>(() => null);

  useEffect(() => {
    onAutoSubmitRef.current = onAutoSubmit;
  }, [onAutoSubmit]);

  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const armSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    if (!listeningRef.current) return;
    if (pendingRef.current) return;
    if (!inputBaseRef.current.trim()) return;
    silenceTimerRef.current = window.setTimeout(() => {
      clearSilenceTimer();
      onAutoSubmitRef.current();
    }, AUTO_SUBMIT_SILENCE_MS);
  }, [clearSilenceTimer]);

  const buildRecognition = useCallback((): SpeechRecognitionLike | null => {
    if (typeof window === 'undefined') return null;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return null;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';

    r.onresult = (e: SpeechRecognitionEvent) => {
      let finalChunk = '';
      let interimChunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interimChunk += res[0].transcript;
      }
      if (finalChunk) {
        const base = inputBaseRef.current;
        const merged = (base ? base + ' ' : '') + finalChunk.trim();
        inputBaseRef.current = merged;
        setInput(merged);
        setInterim('');
      }
      if (interimChunk) setInterim(interimChunk);
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
      // Chrome/Edge auto-end continuous recognition every ~60s. Re-arm while
      // the user still has the mic on; otherwise tear down cleanly.
      setInterim('');
      if (!listeningRef.current) {
        clearSilenceTimer();
        return;
      }
      window.setTimeout(() => {
        if (!listeningRef.current) return;
        const fresh = buildRef.current();
        if (!fresh) return;
        try {
          fresh.start();
          recognitionRef.current = fresh;
        } catch {
          // start() can throw if the engine hasn't released yet — one retry.
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
    };
    return r;
  }, [armSilenceTimer, clearSilenceTimer, setInput]);

  // Keep the ref pointing at the latest buildRecognition closure so r.onend's
  // restart path always sees the fresh callbacks.
  useEffect(() => {
    buildRef.current = buildRecognition;
  }, [buildRecognition]);

  const start = useCallback(() => {
    if (typeof window === 'undefined') return;
    const r = buildRecognition();
    if (!r) return;
    inputBaseRef.current = input;
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
  }, [buildRecognition, input]);

  const stop = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    clearSilenceTimer();
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setInterim('');
  }, [clearSilenceTimer]);

  const toggle = useCallback(() => {
    if (listeningRef.current) stop();
    else start();
  }, [start, stop]);

  const clearError = useCallback(() => setError(null), []);

  const reset = useCallback(() => {
    inputBaseRef.current = '';
    setInterim('');
    clearSilenceTimer();
  }, [clearSilenceTimer]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      listeningRef.current = false;
      clearSilenceTimer();
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, [clearSilenceTimer]);

  return { supported, listening, interim, error, start, stop, toggle, clearError, reset };
}
