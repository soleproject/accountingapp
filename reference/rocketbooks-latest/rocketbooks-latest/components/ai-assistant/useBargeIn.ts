'use client';

import { useEffect, useRef } from 'react';
import { ensureRunning } from '@/lib/audio/context';
import { acquireMic, releaseMic } from '@/lib/audio/mic';

interface UseBargeInArgs {
  /** Run VAD only while this is true. Typically: TTS is speaking + user
   *  enabled the toggle + dictation isn't already capturing. */
  active: boolean;
  /** Fires once when sustained voice activity is detected above the
   *  calibrated noise floor. After firing, VAD shuts down until the caller
   *  flips `active` false then true again. */
  onBarge: () => void;
}

// VAD config — small enough that tuning lives here rather than in props.
const CALIBRATION_MS = 800;        // listen to ambient noise to learn the floor
const TRIGGER_HOLD_MS = 150;       // sustained loudness required (filters coughs)
const TRIGGER_MULTIPLIER = 4;      // how many × the noise floor counts as speech
const TRIGGER_MIN_ABSOLUTE = 0.04; // floor for the floor — protects against silent rooms

/**
 * Voice-activity barge-in. While `active`, listens to the shared mic stream
 * and fires `onBarge` once when the user starts talking over in-progress TTS.
 *
 * Requires the TTS to be playing through AudioContext (not speechSynthesis)
 * so the browser's AEC can subtract it from the mic input — otherwise the
 * AI's own voice triggers a false barge-in.
 */
export function useBargeIn({ active, onBarge }: UseBargeInArgs): void {
  const onBargeRef = useRef(onBarge);
  useEffect(() => {
    onBargeRef.current = onBarge;
  }, [onBarge]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let rafId = 0;
    let source: MediaStreamAudioSourceNode | null = null;
    let micAcquired = false;

    (async () => {
      const ctx = await ensureRunning();
      if (!ctx || cancelled) return;
      const stream = await acquireMic();
      if (!stream) return;
      if (cancelled) {
        releaseMic();
        return;
      }
      micAcquired = true;
      source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      // Deliberately don't connect to destination — we're observing, not playing.

      const data = new Uint8Array(analyser.fftSize);
      let calibrationSum = 0;
      let calibrationCount = 0;
      const calibrationEnd = performance.now() + CALIBRATION_MS;
      let calibrating = true;
      let triggerThreshold = TRIGGER_MIN_ABSOLUTE;
      let triggerStart = 0;

      const tick = () => {
        if (cancelled) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);

        if (calibrating) {
          calibrationSum += rms;
          calibrationCount++;
          if (performance.now() >= calibrationEnd) {
            const floor = calibrationSum / Math.max(1, calibrationCount);
            triggerThreshold = Math.max(TRIGGER_MIN_ABSOLUTE, floor * TRIGGER_MULTIPLIER);
            calibrating = false;
          }
        } else if (rms > triggerThreshold) {
          if (!triggerStart) {
            triggerStart = performance.now();
          } else if (performance.now() - triggerStart > TRIGGER_HOLD_MS) {
            cancelled = true;
            onBargeRef.current();
            return;
          }
        } else {
          triggerStart = 0;
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (source) {
        try {
          source.disconnect();
        } catch {
          // OK if already disconnected.
        }
      }
      if (micAcquired) releaseMic();
    };
  }, [active]);
}
