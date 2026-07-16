'use client';

import { useCallback, useState } from 'react';

export type TtsEngine = 'local' | 'openai';

const ENGINE_KEY = 'rs_ai_tts_engine';
const BARGE_IN_KEY = 'rs_ai_tts_barge_in';
const OPEN_MIC_KEY = 'rs_ai_tts_open_mic';

/**
 * Persisted preference for which TTS engine is active:
 *  - 'local'  → window.speechSynthesis (free, OS voices, no echo cancellation)
 *  - 'openai' → /api/ai/tts (paid, consistent voice, Web Audio playback)
 * Default is 'local' so existing users see no behavior change until they opt in.
 */
export function useTtsEngine(): {
  engine: TtsEngine;
  setEngine: (e: TtsEngine) => void;
} {
  const [engine, setEngineState] = useState<TtsEngine>(() => {
    if (typeof window === 'undefined') return 'local';
    return window.localStorage.getItem(ENGINE_KEY) === 'openai' ? 'openai' : 'local';
  });
  const setEngine = useCallback((e: TtsEngine) => {
    setEngineState(e);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ENGINE_KEY, e);
    }
  }, []);
  return { engine, setEngine };
}

/**
 * Persisted opt-in for keep-the-mic-open-between-turns. When on, send() does
 * NOT close SpeechRecognition; the user can keep talking turn after turn
 * without re-tapping the mic. Engine-agnostic — TTS-bleed during the AI's
 * reply is suppressed by ChatBox's ttsSpeakingRef + audio-tail grace.
 */
export function useOpenMicPreference(): {
  openMic: boolean;
  setOpenMic: (next: boolean) => void;
} {
  const [openMic, setOpenMicState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(OPEN_MIC_KEY) === '1';
  });
  const setOpenMic = useCallback((next: boolean) => {
    setOpenMicState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(OPEN_MIC_KEY, next ? '1' : '0');
    }
  }, []);
  return { openMic, setOpenMic };
}

/**
 * Persisted opt-in for barge-in: while the AI is speaking, VAD listens on
 * the AEC'd mic stream and the user can interrupt by speaking. Only
 * meaningful when engine='openai' (speechSynthesis playback bypasses the
 * browser's AEC reference signal) AND open-mic is enabled (no mic to listen
 * on otherwise).
 */
export function useBargeInPreference(): {
  bargeIn: boolean;
  setBargeIn: (next: boolean) => void;
} {
  const [bargeIn, setBargeInState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(BARGE_IN_KEY) === '1';
  });
  const setBargeIn = useCallback((next: boolean) => {
    setBargeInState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(BARGE_IN_KEY, next ? '1' : '0');
    }
  }, []);
  return { bargeIn, setBargeIn };
}
