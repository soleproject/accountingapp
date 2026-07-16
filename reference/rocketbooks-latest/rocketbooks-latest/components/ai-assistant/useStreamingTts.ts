'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ensureRunning, getAudioContext } from '@/lib/audio/context';

export type OpenAITtsVoice =
  | 'alloy'
  | 'echo'
  | 'fable'
  | 'onyx'
  | 'nova'
  | 'shimmer';

export const OPENAI_TTS_VOICES: OpenAITtsVoice[] = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
];

const VOICE_KEY = 'rs_ai_tts_openai_voice';

export interface StreamingTtsApi {
  /** True when AudioContext (or its prefixed Safari alias) is available. */
  supported: boolean;
  voice: OpenAITtsVoice;
  setVoice: (v: OpenAITtsVoice) => void;
  /** Active whenever a sentence is being fetched OR audio is playing. */
  speaking: boolean;
  /** Push streaming text. Splits on sentence boundaries; each complete
   *  sentence triggers a TTS fetch and is enqueued for playback. */
  feed: (text: string) => void;
  /** Drain any trailing partial sentence in the buffer. Call when the
   *  upstream chat stream signals it's done. */
  flush: () => void;
  /** Cancel in-flight fetches, stop current playback, clear queue and
   *  buffer. Safe to call when idle. */
  stop: () => void;
}

// Find sentence boundaries in a buffer. Returns the completed sentences plus
// any trailing partial that should stay buffered until the next feed/flush.
//
// Rules:
// - `.` `!` `?` followed by whitespace or end-of-string commits a split.
// - `\n\n` commits a split (paragraph break).
// - `.` between two digits (e.g. `$1,234.56`) does NOT split.
// - Ellipses are handled naturally: `Wait...` splits at the final `.` when
//   followed by whitespace.
// - Single `\n` does NOT split — markdown soft breaks shouldn't fragment a
//   sentence mid-flight.
function splitSentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let lastEnd = 0;
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    let boundary = false;
    let sliceEndOffset = 0;
    let skipAhead = 0;
    if (c === '.' || c === '!' || c === '?') {
      const prev = buffer[i - 1];
      const next = buffer[i + 1];
      if (c === '.' && /\d/.test(prev ?? '') && /\d/.test(next ?? '')) continue;
      if (next === undefined || /\s/.test(next)) {
        boundary = true;
        sliceEndOffset = 1;
      }
    } else if (c === '\n' && buffer[i + 1] === '\n') {
      boundary = true;
      skipAhead = 1; // skip past the second \n; trailing whitespace scan does the rest
    }
    if (!boundary) continue;
    const slice = buffer.slice(lastEnd, i + sliceEndOffset).trim();
    if (slice) sentences.push(slice);
    let cursor = i + sliceEndOffset + skipAhead;
    while (cursor < buffer.length && /\s/.test(buffer[cursor])) cursor++;
    lastEnd = cursor;
    i = cursor - 1;
  }
  return { sentences, remainder: buffer.slice(lastEnd) };
}

/**
 * Sentence-streaming TTS via OpenAI tts-1. Each completed sentence in the
 * fed text becomes a separate fetch to /api/ai/tts and is decoded into an
 * AudioBuffer. Buffers are played in stream order through a shared
 * AudioContext, so the user hears speech ~500ms after the first sentence
 * completes rather than waiting for the full assistant reply.
 *
 * Routing the audio through Web Audio (rather than speechSynthesis) lets the
 * browser's AEC subtract TTS output from mic input — prerequisite for any
 * future barge-in without echo bleed.
 */
export function useStreamingTts(): StreamingTtsApi {
  const [supported] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return !!getAudioContext();
  });
  const [voice, setVoiceState] = useState<OpenAITtsVoice>(() => {
    if (typeof window === 'undefined') return 'nova';
    const stored = window.localStorage.getItem(VOICE_KEY);
    return (OPENAI_TTS_VOICES as string[]).includes(stored ?? '')
      ? (stored as OpenAITtsVoice)
      : 'nova';
  });
  const [speaking, setSpeaking] = useState(false);

  const bufferRef = useRef('');
  const inFlightRef = useRef(new Set<AbortController>());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const stoppedRef = useRef(false);
  const activeRef = useRef(0);
  const voiceRef = useRef(voice);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  const bump = useCallback((delta: number) => {
    activeRef.current = Math.max(0, activeRef.current + delta);
    setSpeaking(activeRef.current > 0);
  }, []);

  const setVoice = useCallback((v: OpenAITtsVoice) => {
    setVoiceState(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VOICE_KEY, v);
    }
  }, []);

  const playBuffer = useCallback((audioBuffer: AudioBuffer): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (stoppedRef.current) return resolve();
      void (async () => {
        const ctx = await ensureRunning();
        if (!ctx || stoppedRef.current) return resolve();
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        currentSourceRef.current = source;
        source.onended = () => {
          if (currentSourceRef.current === source) {
            currentSourceRef.current = null;
          }
          resolve();
        };
        try {
          source.start(0);
        } catch {
          resolve();
        }
      })();
    });
  }, []);

  const enqueueSentence = useCallback(
    async (text: string) => {
      if (stoppedRef.current) return;
      bump(1);
      const ac = new AbortController();
      inFlightRef.current.add(ac);
      let audioBuffer: AudioBuffer | null = null;
      try {
        const res = await fetch('/api/ai/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: voiceRef.current }),
          signal: ac.signal,
        });
        if (res.ok) {
          const ab = await res.arrayBuffer();
          const ctx = getAudioContext();
          if (ctx) {
            // decodeAudioData transfers the buffer in some browsers; slice
            // gives us a detached copy we own.
            audioBuffer = await ctx.decodeAudioData(ab.slice(0));
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          console.warn('[tts] sentence fetch failed', err);
        }
      } finally {
        inFlightRef.current.delete(ac);
      }
      if (stoppedRef.current || !audioBuffer) {
        bump(-1);
        return;
      }
      // Chain after the existing queue tail. `myPlay` resolves only when our
      // own play finishes, so the bump(-1) below correctly tracks this
      // sentence's lifecycle even if more sentences are appended later.
      const buf = audioBuffer;
      const myPlay = queueRef.current.then(() => playBuffer(buf));
      queueRef.current = myPlay;
      try {
        await myPlay;
      } finally {
        bump(-1);
      }
    },
    [bump, playBuffer],
  );

  const feed = useCallback(
    (text: string) => {
      if (!text) return;
      // A feed after stop() implies the consumer is starting fresh — clear
      // the stopped flag so new sentences play instead of being dropped.
      if (stoppedRef.current) stoppedRef.current = false;
      bufferRef.current += text;
      const { sentences, remainder } = splitSentences(bufferRef.current);
      bufferRef.current = remainder;
      for (const s of sentences) {
        void enqueueSentence(s);
      }
    },
    [enqueueSentence],
  );

  const flush = useCallback(() => {
    const tail = bufferRef.current.trim();
    bufferRef.current = '';
    if (tail) void enqueueSentence(tail);
  }, [enqueueSentence]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    for (const ac of inFlightRef.current) ac.abort();
    inFlightRef.current.clear();
    try {
      currentSourceRef.current?.stop();
    } catch {
      // OK if already ended.
    }
    currentSourceRef.current = null;
    queueRef.current = Promise.resolve();
    bufferRef.current = '';
    activeRef.current = 0;
    setSpeaking(false);
  }, []);

  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      for (const ac of inFlightRef.current) ac.abort();
      try {
        currentSourceRef.current?.stop();
      } catch {
        // OK if already ended.
      }
    };
  }, []);

  return useMemo(
    () => ({ supported, voice, setVoice, speaking, feed, flush, stop }),
    [supported, voice, setVoice, speaking, feed, flush, stop],
  );
}
