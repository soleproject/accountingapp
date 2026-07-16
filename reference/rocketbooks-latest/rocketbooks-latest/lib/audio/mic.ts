'use client';

// Singleton mic stream with the constraints the browser's AEC needs to subtract
// our own TTS audio (played through AudioContext) from the captured mic input.
// SpeechRecognition's internal capture path is separate, so this stream is
// primarily for VAD/barge-in detection rather than transcription.
//
// Refcounted so multiple consumers (VAD, future analyzers) can share one
// stream without re-prompting the user for permission or duplicating the
// browser's recording indicator.

let stream: MediaStream | null = null;
let refCount = 0;
let inFlight: Promise<MediaStream | null> | null = null;

const CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

export async function acquireMic(): Promise<MediaStream | null> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return null;
  }
  if (stream && stream.active) {
    refCount++;
    return stream;
  }
  // Coalesce concurrent acquires so we only call getUserMedia once.
  if (inFlight) {
    const s = await inFlight;
    if (s) refCount++;
    return s;
  }
  inFlight = navigator.mediaDevices
    .getUserMedia(CONSTRAINTS)
    .then((s) => {
      stream = s;
      refCount = 1;
      return s;
    })
    .catch((err) => {
      stream = null;
      refCount = 0;
      console.warn('[mic] getUserMedia failed', err);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function releaseMic(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
}

export function isMicActive(): boolean {
  return !!(stream && stream.active);
}
