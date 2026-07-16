'use client';

import { useCallback, useEffect, useState } from 'react';

// Tour narration (picker greeting, cool-tour beats, GuidedTour spotlight) is
// independent of the assistant's autoSpeak preference -- the tour is a
// "hear the AI" experience by default, so we use a separate key that only
// flips when the user explicitly hits the mute button on a tour surface.
const KEY = 'rs_tour_muted';
const EVENT = 'rs-tour-muted-changed';

function readMuted(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(KEY) === '1';
}

/** Read the tour-mute state directly from localStorage, bypassing React.
 *  Use this at speak-time so an in-flight effect closure can't carry stale
 *  state across a mute toggle and let the next narration leak through. */
export function isTourMutedNow(): boolean {
  return readMuted();
}

export function useTourMuted(): { muted: boolean; setMuted: (next: boolean) => void } {
  const [muted, setMutedState] = useState<boolean>(() => readMuted());

  // Sync across mounts within the same tab (picker → runner handoff) via a
  // custom event, and across tabs via the standard storage event.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onChange = () => setMutedState(readMuted());
    window.addEventListener(EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(KEY, next ? '1' : '0');
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return { muted, setMuted };
}
