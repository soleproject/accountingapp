'use client';

// Lazy singleton AudioContext shared across hooks that play decoded audio
// (currently useStreamingTts; future VAD/barge-in will share it). Browsers
// enforce an autoplay policy — a freshly-created AudioContext starts in
// 'suspended' state until a user gesture resumes it. We expose ensureRunning()
// for callers to await right before scheduling playback.

let ctx: AudioContext | null = null;

function pickAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  // Safari/iOS still ships only the prefixed name on some versions.
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

export function getAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = pickAudioContextCtor();
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export async function ensureRunning(): Promise<AudioContext | null> {
  const c = getAudioContext();
  if (!c) return null;
  if (c.state === 'suspended') {
    try {
      await c.resume();
    } catch {
      // Resume can throw if called outside a user gesture; caller will
      // observe state !== 'running' and decide whether to retry.
    }
  }
  return c;
}
