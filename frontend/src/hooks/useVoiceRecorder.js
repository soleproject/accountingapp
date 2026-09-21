/**
 * useVoiceRecorder — small hook that captures a short webm/opus blob
 * via the browser MediaRecorder API. Returns imperative controls +
 * derived state so the button component can stay dumb.
 *
 * Contract:
 *   const { recording, elapsedMs, start, stop, error } = useVoiceRecorder(onBlob)
 *
 * `onBlob(blob)` fires on successful stop with an audio/webm Blob.
 * Auto-stops after 90 seconds as a safety cap (Whisper WER climbs
 * past that on a single utterance).
 */
import { useCallback, useEffect, useRef, useState } from "react";

const MAX_MS = 90_000;

export default function useVoiceRecorder(onBlob) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError]         = useState(null);
  const mediaRef  = useRef(null);
  const chunksRef = useRef([]);
  const startRef  = useRef(0);
  const rafRef    = useRef(0);
  const streamRef = useRef(null);

  const cleanup = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    mediaRef.current = null;
    chunksRef.current = [];
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setElapsedMs(0);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Mic not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Prefer opus in webm; browsers pick the best available codec.
      const mimeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ];
      const mime = mimeCandidates.find(m => MediaRecorder.isTypeSupported?.(m)) || "";
      const mr = mime ? new MediaRecorder(stream, { mimeType: mime })
                      : new MediaRecorder(stream);
      mediaRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        cleanup();
        setRecording(false);
        setElapsedMs(0);
        if (blob.size > 0) onBlob?.(blob);
      };
      mr.start();
      startRef.current = performance.now();
      setRecording(true);
      const tick = () => {
        const ms = performance.now() - startRef.current;
        setElapsedMs(ms);
        if (ms >= MAX_MS) {
          try { mr.stop(); } catch (_) {}
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setError(e?.message || "Mic permission denied.");
      cleanup();
    }
  }, [onBlob, cleanup]);

  const stop = useCallback(() => {
    const mr = mediaRef.current;
    if (mr && mr.state !== "inactive") {
      try { mr.stop(); } catch (_) {}
    } else {
      cleanup();
      setRecording(false);
      setElapsedMs(0);
    }
  }, [cleanup]);

  useEffect(() => () => cleanup(), [cleanup]);

  return { recording, elapsedMs, start, stop, error };
}
