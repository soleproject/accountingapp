'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CategorizationContactRow } from './CategorizationContactRow';
import type { SessionView, SessionContactView } from '@/lib/server/categorization-session';

// Local SpeechRecognition typings — Web Speech API isn't in the standard DOM
// lib; Chrome/Edge/Safari expose it via webkitSpeechRecognition. Mirrors the
// declaration in ChatBox.tsx (intentional duplication; the regular chat surface
// keeps its own copy so changes there can't break this workspace).
interface SpeechRecognitionEvt extends Event {
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
interface SpeechRecognitionErrorEvt extends Event {
  readonly error: string;
  readonly message: string;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEvt) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvt) => void) | null;
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

/**
 * Compose a coherent assistant message from the intent endpoint's response.
 * Combines the parser's narration, per-action results, and (for show-remaining
 * intents) a fresh count of pending contacts.
 */
function composeAssistantMessage(
  parse: { kind: 'actions' | 'unclear'; narration?: string; clarifyingQuestion?: string },
  results: Array<{
    kind: string;
    status: 'applied' | 'skipped' | 'created' | 'proposed' | 'failed' | 'noop';
    contactName?: string;
    accountName?: string;
    accountLabel?: string;
    rationale?: string;
    message?: string;
  }>,
  session: { pendingCount: number; doneCount: number; skippedCount: number; totalContacts: number },
): string {
  if (parse.kind === 'unclear') {
    return parse.clarifyingQuestion ?? "I'm not sure what you meant — say it again with the contact and account name?";
  }

  const lines: string[] = [];
  const showRemaining = results.some((r) => r.kind === 'show-remaining');
  const sessionComplete = results.some((r) => r.kind === 'session-complete' && r.status === 'applied');

  const successes = results.filter(
    (r) => r.status === 'applied' || r.status === 'created',
  );
  const proposals = results.filter((r) => r.status === 'proposed');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failures = results.filter((r) => r.status === 'failed');

  // Lead with the parser's narration unless we're showing remaining only or
  // the response is purely a proposal (the proposal itself is more informative).
  if (parse.narration && !showRemaining && proposals.length === 0) {
    lines.push(parse.narration);
  }

  // Proposals: existing-account suggestions. Typing "yes" / "confirm"
  // executes ALL pending proposals.
  for (const r of proposals) {
    const reason = r.rationale ? r.rationale : 'looks like a fit';
    lines.push(
      `${r.contactName} — ${reason}. I'd put that under ${r.accountLabel}.`,
    );
  }
  if (proposals.length > 0) {
    if (proposals.length === 1) {
      lines.push("Confirm to apply, or tell me which account you'd prefer.");
    } else {
      lines.push(`Confirm to apply all ${proposals.length}, or override any individually.`);
    }
  }

  for (const r of successes) {
    if (r.kind === 'session-complete') continue;
    const symbol = r.status === 'created' ? '✦' : '✓';
    const right = r.accountName ? ` → ${r.accountName}` : '';
    lines.push(`${symbol} ${r.contactName ?? r.kind}${right}`);
  }
  for (const r of skipped) {
    lines.push(`↷ Skipped ${r.contactName ?? r.kind}`);
  }
  if (failures.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `Couldn't complete ${failures.length} action${failures.length === 1 ? '' : 's'}:`,
    );
    for (const r of failures) {
      lines.push(`• ${r.contactName ?? r.kind}: ${r.message ?? 'unknown error'}`);
    }
  }

  if (showRemaining) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `${session.pendingCount} pending · ${session.doneCount} done · ${session.skippedCount} skipped · ${session.totalContacts} total`,
    );
  }

  if (sessionComplete) {
    if (lines.length > 0) lines.push('');
    lines.push('Session marked complete.');
  }

  if (lines.length === 0) {
    return parse.narration ?? 'Done.';
  }
  return lines.join('\n');
}

interface AccountOption {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
}

interface IntentResult {
  parse: { kind: 'actions' | 'unclear'; narration?: string; clarifyingQuestion?: string };
  results: Array<{
    kind: string;
    status: 'applied' | 'skipped' | 'created' | 'proposed' | 'failed' | 'noop';
    contactName?: string;
    accountName?: string;
    accountLabel?: string;
    rationale?: string;
    message?: string;
  }>;
  session: SessionView;
  pendingProposalContactIds?: string[];
}

interface Props {
  /** Session id from the URL query param. If null, the workspace creates / resumes one on mount. */
  sessionIdFromUrl: string | null;
  /** All active accounts in this org. Used by the Change dropdown. */
  accountOptions: AccountOption[];
  /** Server-rendered initial session, if available. */
  initialSession: SessionView | null;
}

/**
 * Top-level categorization workspace. Two zones:
 *   - Visual contacts table (top, larger). Status indicators update as the
 *     server reports results back. Done/skipped rows fade.
 *   - Prominent chat input (bottom). Free-form intent is parsed by
 *     /api/categorization/intent and executed server-side; the response
 *     includes the updated SessionView.
 *
 * Buttons on each row are secondary fallbacks for users who'd rather click
 * than type. Clicks hit /api/categorization/contact/[id] which calls the
 * same server helpers as the intent path.
 */
export function CategorizationWorkspace({ sessionIdFromUrl, accountOptions, initialSession }: Props) {
  const router = useRouter();
  const [session, setSession] = useState<SessionView | null>(initialSession);
  const [loadedAccountOptions, setLoadedAccountOptions] = useState<AccountOption[]>(accountOptions);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  // Persistent conversation thread for the workspace. Each user input pushes
  // a user bubble immediately + a placeholder assistant bubble; the assistant
  // bubble is filled in once the intent endpoint returns. Lives in client
  // state only — not persisted across browser refreshes (v1 scope).
  const [messages, setMessages] = useState<
    Array<{ role: 'user' | 'assistant'; content: string }>
  >([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);

  // Focus mode: when set, the contacts table renders only this contact and
  // every other row collapses out of view. Auto-set from the intent
  // endpoint's pendingProposalContactIds; auto-cleared when the focused
  // contact's status flips to done/skipped or pending list goes empty;
  // manually cleared by the "Back to full list" button.
  const [focusedContactId, setFocusedContactId] = useState<string | null>(null);

  // Speech-recognition state — mirrors ChatBox's mic UX. Auto-submit on
  // sustained silence so the user can dictate "AT&T is Utilities", pause,
  // and have the action fire automatically.
  const [listening, setListening] = useState(false);
  const [sttSupported, setSttSupported] = useState(false);
  const [silenceCountdown, setSilenceCountdown] = useState(0);
  const [interim, setInterim] = useState('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const inputBeforeListenRef = useRef('');
  const silenceTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const listeningRef = useRef(false);
  const pendingRef = useRef(false);
  const sendRef = useRef<(overrideText?: string) => void>(() => {});

  useEffect(() => {
    if (loadedAccountOptions.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/categorization/accounts', { cache: 'no-store' });
        if (!r.ok) return;
        const data = (await r.json()) as { accounts?: AccountOption[] };
        if (!cancelled && Array.isArray(data.accounts)) setLoadedAccountOptions(data.accounts);
      } catch {
        // Manual account dropdown degrades empty; free-form categorization still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadedAccountOptions.length]);

  // Bootstrap: if we don't have a session view yet, create or resume one.
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    (async () => {
      setPending(true);
      try {
        // If URL has ?categorize=<id>, prefer GET to resume that exact session.
        // Otherwise POST to create-or-resume the user's active session.
        const r = sessionIdFromUrl
          ? await fetch(`/api/categorization/session?id=${encodeURIComponent(sessionIdFromUrl)}`)
          : await fetch('/api/categorization/session', { method: 'POST' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          if (!cancelled) setErrorMessage(err.error ?? `Failed to load session (${r.status})`);
          return;
        }
        const view = (await r.json()) as SessionView;
        if (cancelled) return;
        setSession(view);
        // Sync URL so refresh / bookmark works.
        if (!sessionIdFromUrl || sessionIdFromUrl !== view.sessionId) {
          router.replace(`/ai-chat?categorize=${view.sessionId}`);
        }
      } catch (e) {
        if (!cancelled) setErrorMessage(e instanceof Error ? e.message : 'Failed to load session');
      } finally {
        if (!cancelled) setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, sessionIdFromUrl, router]);

  const orderedContacts = useMemo<SessionContactView[]>(() => {
    if (!session) return [];
    return session.contacts;
  }, [session]);

  // Auto-exit focus when the focused contact is no longer pending — covers
  // (a) it resolved via a contact button (apply/skip) so its status flipped,
  // (b) it dropped out of the session view entirely (shouldn't happen mid-
  // session but guard anyway).
  useEffect(() => {
    if (!focusedContactId) return;
    const c = session?.contacts.find((x) => x.id === focusedContactId);
    if (!c || (c.status !== 'pending' && c.status !== 'failed')) {
      setFocusedContactId(null);
    }
  }, [focusedContactId, session]);

  const focusedContact = focusedContactId
    ? orderedContacts.find((c) => c.id === focusedContactId) ?? null
    : null;
  const visibleContacts = focusedContact ? [focusedContact] : orderedContacts;
  const hiddenCount = focusedContact ? Math.max(0, orderedContacts.length - 1) : 0;

  // ── Speech-recognition wiring ───────────────────────────────────────
  useEffect(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSttSupported(!!Ctor);
  }, []);
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

    r.onresult = (e: SpeechRecognitionEvt) => {
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
        setChatInput(merged);
        setInterim('');
      }
      if (interimChunk) setInterim(interimChunk);
      if (finalChunk || interimChunk) armSilenceTimer();
    };

    r.onerror = (e: SpeechRecognitionErrorEvt) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setErrorMessage('Microphone permission denied');
        listeningRef.current = false;
        setListening(false);
        clearSilenceTimer();
        return;
      }
      setErrorMessage(`Speech recognition: ${e.error}`);
    };

    r.onend = () => {
      // Chrome ends continuous recognition periodically. Auto-restart while
      // the mic is still on so the user can keep dictating.
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
    const r = buildRecognition();
    if (!r) return;
    inputBeforeListenRef.current = chatInput;
    try {
      r.start();
      recognitionRef.current = r;
      setErrorMessage(null);
      listeningRef.current = true;
      setListening(true);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not start mic');
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

  // Cleanup on unmount: stop listening, abort recognition, clear timers.
  useEffect(() => {
    return () => {
      clearSilenceTimer();
      listeningRef.current = false;
      recognitionRef.current?.abort();
    };
  }, []);

  // Auto-scroll the thread to the latest message whenever it grows.
  useEffect(() => {
    threadScrollRef.current?.scrollTo({
      top: threadScrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  const sendIntent = async (message: string) => {
    if (!session) return;
    // Push the user bubble + an empty assistant placeholder right away so the
    // thread reflects the user's input immediately. The placeholder gets
    // filled in once the intent endpoint returns.
    const trimmed = message.trim();
    setMessages((cur) => [
      ...cur,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: '' },
    ]);
    setPending(true);
    setErrorMessage(null);
    try {
      const r = await fetch('/api/categorization/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          message: trimmed,
          focusedContactId,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const msg = err.error ?? `Intent failed (${r.status})`;
        setErrorMessage(msg);
        replaceLastAssistant(`Sorry — ${msg}`);
        return;
      }
      const data = (await r.json()) as IntentResult;
      setSession(data.session);
      replaceLastAssistant(composeAssistantMessage(data.parse, data.results, data.session));
      // Focus mode follows pending proposals. First pending wins. Empty list
      // → exit focus.
      const nextPending = data.pendingProposalContactIds ?? [];
      setFocusedContactId(nextPending.length > 0 ? nextPending[0] : null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Intent failed';
      setErrorMessage(msg);
      replaceLastAssistant(`Sorry — ${msg}`);
    } finally {
      setPending(false);
      setChatInput('');
      // Reset dictation buffers so the next utterance starts clean and the
      // silence timer doesn't carry stale text. Mic stays on if the user
      // had it on — they can keep dictating the next instruction.
      inputBeforeListenRef.current = '';
      setInterim('');
      // Refocus input for continuous typing flow.
      inputRef.current?.focus();
    }
  };

  const replaceLastAssistant = (content: string) => {
    setMessages((cur) => {
      const copy = [...cur];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === 'assistant') {
          copy[i] = { role: 'assistant', content };
          break;
        }
      }
      return copy;
    });
  };

  const callContactAction = async (
    sessionContactId: string,
    body:
      | { action: 'apply'; accountIdCandidate: string; source: 'rules' | 'manual' }
      | { action: 'skip' }
      | { action: 'unskip' },
  ) => {
    if (!session) return;
    setPending(true);
    setErrorMessage(null);
    try {
      const r = await fetch(`/api/categorization/contact/${sessionContactId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, ...body }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setErrorMessage(err.error ?? `Action failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as { result: unknown; session: SessionView };
      setSession(data.session);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setPending(false);
    }
  };

  const handleExitToChat = () => {
    router.push('/ai-chat');
  };

  // Keep sendRef pointing at the latest closure so the silence timer fires
  // sendIntent against the current chatInput. No deps array — runs every
  // render, which is what we want here.
  useEffect(() => {
    sendRef.current = (overrideText?: string) => {
      const text = (overrideText ?? chatInput).trim();
      if (!text || pending) return;
      void sendIntent(text);
    };
  });

  const displayValue = listening && interim ? `${chatInput}${chatInput ? ' ' : ''}${interim}` : chatInput;

  if (!session) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
        {errorMessage ? (
          <span className="text-red-600">⚠ {errorMessage}</span>
        ) : (
          <span>Loading categorization workspace…</span>
        )}
      </div>
    );
  }

  return (
    // Mirror ChatBox's container shape: fixed height (h-[70vh]) on mobile +
    // flex-1 within the column at lg+ so both modes' inputs anchor at the
    // same bottom edge regardless of what's stacked above (e.g., VoiceMode
    // in chat mode pushes ChatBox down; here the workspace fills the same
    // bottom because we let the column define the bound).
    <div className="flex h-[70vh] flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 lg:h-auto lg:min-h-0 lg:flex-1">
      {/* Progress strip — fixed top */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <div className="text-sm font-semibold">Categorization workspace</div>
          <div className="text-xs text-zinc-500">
            {session.doneCount} of {session.totalContacts} done · {session.pendingCount} pending · {session.skippedCount} skipped
          </div>
        </div>
        <button
          type="button"
          onClick={handleExitToChat}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Exit to chat
        </button>
      </div>

      {/* Contacts list — scrolling, larger share. flex-[2] vs thread's flex-[1]
          gives roughly 2:1 split of remaining space (after header, errors, input). */}
      <div className="flex-[2] min-h-0 overflow-y-auto">
        {focusedContact && (
          <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs dark:border-amber-900 dark:bg-amber-950/30">
            <span className="text-amber-900 dark:text-amber-200">
              Focused on{' '}
              <strong>{focusedContact.contactName ?? 'this contact'}</strong>
              {hiddenCount > 0 && (
                <>
                  {' · '}
                  {hiddenCount} other{hiddenCount === 1 ? '' : 's'} hidden
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => setFocusedContactId(null)}
              className="rounded-md border border-amber-300 px-2 py-1 text-xs text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-100 dark:hover:bg-amber-900/30"
            >
              Back to full list
            </button>
          </div>
        )}
        {visibleContacts.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm italic text-zinc-500">
            No uncategorized transactions. All caught up.
          </div>
        ) : (
          visibleContacts.map((c) => (
            <CategorizationContactRow
              key={c.id}
              contact={c}
              accountOptions={loadedAccountOptions}
              busy={pending}
              onApply={(accountIdCandidate, source) =>
                callContactAction(c.id, { action: 'apply', accountIdCandidate, source })
              }
              onSkip={() => callContactAction(c.id, { action: 'skip' })}
              onUnskip={() => callContactAction(c.id, { action: 'unskip' })}
            />
          ))
        )}
      </div>

      {/* Chat thread — flex-[1] grows with available space, min-h-32 keeps it
          usable when contacts list is long. Independent overflow-y-auto so
          the thread scrolls separately from the contacts list above. */}
      <div
        ref={threadScrollRef}
        className="flex-[1] min-h-32 overflow-y-auto border-t border-zinc-200 bg-zinc-50/50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs italic text-zinc-500">
            Tell me what to do — e.g. &ldquo;AT&amp;T is Utilities, NV Energy is Utilities, skip Online Banking.&rdquo;
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex flex-col gap-1 ${
                  m.role === 'user' ? 'max-w-[85%] self-end' : 'max-w-[85%] self-start'
                }`}
              >
                <div
                  className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'bg-white text-zinc-900 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700'
                  }`}
                >
                  {m.content || <span className="text-zinc-400">…</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {errorMessage && (
        <div className="shrink-0 border-t border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          ⚠ {errorMessage}
        </div>
      )}

      {/* Chat input — fixed bottom */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = chatInput.trim();
          if (!text || pending) return;
          void sendIntent(text);
        }}
        className="flex shrink-0 gap-2 border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
      >
        {sttSupported && (
          <button
            type="button"
            onClick={toggleListening}
            title={listening ? 'Stop dictation (auto-submits on silence)' : 'Dictate (speech to text)'}
            aria-label={listening ? 'Stop dictation' : 'Start dictation'}
            className={`relative flex h-10 w-10 shrink-0 items-center justify-center self-end rounded-md border transition-colors ${
              listening
                ? 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400'
                : 'border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />
            </svg>
            {listening && (
              <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
              </span>
            )}
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
        <textarea
          ref={inputRef}
          rows={2}
          value={displayValue}
          onChange={(e) => {
            setChatInput(e.target.value);
            inputBeforeListenRef.current = e.target.value;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const text = chatInput.trim();
              if (!text || pending) return;
              void sendIntent(text);
            }
          }}
          placeholder={
            listening
              ? 'Listening… speak now (auto-submits after a brief silence)'
              : 'e.g. "AT&T is Utilities, NV Energy goes to Utilities, skip Online Banking" — Enter to submit, Shift+Enter for newline'
          }
          disabled={pending}
          className={`flex-1 resize-none rounded-md border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:bg-zinc-900 ${
            listening ? 'border-red-300 dark:border-red-800' : 'border-zinc-300 dark:border-zinc-700'
          }`}
        />
        <button
          type="submit"
          disabled={!chatInput.trim() || pending}
          className="self-end rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {pending ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
