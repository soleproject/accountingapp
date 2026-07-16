'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const VOICE_KEY = 'rs_ai_sidecar_tts_voice';
const AUTOSPEAK_KEY = 'rs_ai_sidecar_tts_autospeak';
const DEFAULT_VOICE_NAME = 'Google UK English Female';

// The assistant streams Markdown (bold via **, headings, bullets, links, code
// spans). SpeechSynthesisUtterance reads the raw characters — `**$25,395**`
// becomes "asterisk asterisk dollar..." on most voices. Strip the syntax
// before speaking while preserving the inner text and natural pauses.
function stripMarkdownForSpeech(input: string): string {
  return input
    // Fenced code blocks — drop entirely; reading code aloud is noise.
    .replace(/```[\s\S]*?```/g, ' ')
    // Inline code spans — keep the inner text without the backticks.
    .replace(/`([^`]+)`/g, '$1')
    // Images ![alt](url) — speak the alt text only.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Links [text](url) — speak the visible text.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Bold/italic **text**, __text__, *text*, _text_ — keep the inner text.
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<!\w)[*_]([^*_\n]+)[*_](?!\w)/g, '$1')
    // Strikethrough ~~text~~ — keep inner.
    .replace(/~~(.+?)~~/g, '$1')
    // Heading markers at line start.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // Blockquote markers.
    .replace(/^\s{0,3}>\s?/gm, '')
    // Bullet markers (-, *, +) at line start — leave numbered lists; "1." is
    // fine for speech and conveys the list structure.
    .replace(/^\s*[-*+]\s+/gm, '')
    // Horizontal rules.
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
    // Collapse 3+ newlines to a paragraph break; trim trailing whitespace per line.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface TtsApi {
  /** Whether the browser exposes the speechSynthesis API. */
  supported: boolean;
  /** All voices the OS / browser makes available. */
  voices: SpeechSynthesisVoice[];
  /** Currently selected voice's name (matches voice.name); null until user picks. */
  selectedVoiceName: string | null;
  setSelectedVoiceName: (name: string | null) => void;
  /** Whether new assistant messages should be spoken automatically. */
  autoSpeak: boolean;
  setAutoSpeak: (next: boolean) => void;
  /** Whether the synth is currently uttering. */
  speaking: boolean;
  /** Speak the given text using the selected voice. Cancels any active utterance. */
  speak: (text: string) => void;
  /** Stop any active speech. */
  stop: () => void;
}

/**
 * Web Speech `speechSynthesis` wrapper. Lists OS voices, persists the user's
 * pick + auto-speak preference, and exposes a simple speak/stop surface.
 *
 * Voice loading is asynchronous on Chrome — the first `getVoices()` call may
 * return [] before the engine fires `voiceschanged`. We listen and re-read.
 */
export function useTextToSpeech(): TtsApi {
  const [supported] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceName, setSelectedVoiceNameState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return DEFAULT_VOICE_NAME;
    return window.localStorage.getItem(VOICE_KEY) ?? DEFAULT_VOICE_NAME;
  });
  const [autoSpeak, setAutoSpeakState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(AUTOSPEAK_KEY) === '1';
  });
  const [speaking, setSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Pull voices and re-pull when the engine fires voiceschanged — Chrome
  // returns an empty list synchronously on the first call.
  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const refresh = () => setVoices(synth.getVoices());
    refresh();
    synth.addEventListener('voiceschanged', refresh);
    return () => synth.removeEventListener('voiceschanged', refresh);
  }, [supported]);

  const setSelectedVoiceName = useCallback((name: string | null) => {
    setSelectedVoiceNameState(name);
    if (typeof window === 'undefined') return;
    if (name) window.localStorage.setItem(VOICE_KEY, name);
    else window.localStorage.removeItem(VOICE_KEY);
  }, []);

  const setAutoSpeak = useCallback((next: boolean) => {
    setAutoSpeakState(next);
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(AUTOSPEAK_KEY, next ? '1' : '0');
  }, []);

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setSpeaking(false);
  }, [supported]);

  const speak = useCallback(
    (text: string) => {
      if (!supported) return;
      const spoken = stripMarkdownForSpeech(text);
      if (!spoken) return;

      // Cancel anything already speaking — only one stream at a time.
      window.speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(spoken);
      // Read voices live in addition to React state. Chrome populates the
      // voice list asynchronously via the voiceschanged event, so a caller
      // that speaks immediately on mount may see an empty `voices` state
      // even when the synth itself already has them. Without the fallback
      // we'd silently drop our voice selection and let the OS default play
      // (which on Chrome/Windows is the robotic male voice).
      const liveVoices =
        voices.length > 0 ? voices : window.speechSynthesis.getVoices();
      const picked = selectedVoiceName
        ? liveVoices.find((v) => v.name === selectedVoiceName)
        : null;
      if (picked) {
        u.voice = picked;
        u.lang = picked.lang;
      }
      u.onend = () => {
        if (utteranceRef.current === u) {
          utteranceRef.current = null;
          setSpeaking(false);
        }
      };
      u.onerror = () => {
        if (utteranceRef.current === u) {
          utteranceRef.current = null;
          setSpeaking(false);
        }
      };
      utteranceRef.current = u;
      setSpeaking(true);
      window.speechSynthesis.speak(u);
    },
    [supported, voices, selectedVoiceName],
  );

  // Cancel any active speech on unmount so navigation doesn't leave a runaway
  // utterance speaking off-page.
  useEffect(() => {
    return () => {
      if (supported) window.speechSynthesis.cancel();
    };
  }, [supported]);

  return {
    supported,
    voices,
    selectedVoiceName,
    setSelectedVoiceName,
    autoSpeak,
    setAutoSpeak,
    speaking,
    speak,
    stop,
  };
}
