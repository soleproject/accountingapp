'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyCall } from '@daily-co/daily-js';
import { ChatPanel, type ChatLine } from './ChatPanel';

/**
 * Daily Prebuilt call frame, embedded in-app (no redirect to daily.co), with an
 * optional in-app chat sidebar and our own control bar beneath the call
 * (Expand on the left; host Chat On/Off + show/hide on the right).
 *
 * Provider isolation: receives a ready-to-join `roomUrl` + `token` and emits
 * provider-neutral events (ParticipantEvent, PersistableChat) — the rest of the
 * app never sees Daily types. The only Daily coupling is the prebuilt runtime
 * (@daily-co/daily-js), unavoidable for the embedded frame + its data channel.
 *
 * Strict Mode: createFrame throws on a second live instance, so we guard with a
 * `cancelled` flag + a single frame ref and always destroy on cleanup.
 */

export interface ParticipantEvent {
  action: 'join' | 'leave';
  dailySessionId: string;
  name: string;
  role: 'host' | 'guest';
  at: string; // ISO timestamp (client clock)
}

export interface PersistableChat {
  dailySessionId: string;
  senderName: string;
  text: string;
  sentAt: string; // ISO
}

/** Provider-neutral transcript line (one spoken utterance). */
export interface TranscriptLine {
  dailySessionId: string; // the speaker
  speakerName: string;
  text: string;
  saidAt: string; // ISO
}

interface VideoCallFrameProps {
  roomUrl: string;
  token: string;
  onLeft: () => void;
  onError?: (message: string) => void;
  onParticipant?: (evt: ParticipantEvent) => void;
  /** Enable the in-app chat (sidebar + bar toggle). */
  chat?: boolean;
  /** Persist a chat message (host only — see notes in the launcher). */
  onPersistMessage?: (msg: PersistableChat) => void;
  /** The host gets the Chat On/Off + Transcript controls and authors policy. */
  isHost?: boolean;
  /** Persist a transcript line (host only). When set + isHost, the Transcript
   *  toggle appears (Daily live transcription — a paid Deepgram add-on). */
  onTranscriptLine?: (line: TranscriptLine) => void;
  /** Org has auto-transcription on — host auto-starts transcription on join. */
  autoTranscribe?: boolean;
}

// Matches Daily Prebuilt's tray/main-area color (`mainAreaBg`) so our bar reads
// as one continuous bar with Daily's controls above it.
const BAR_BG = '#121a24';
const ICON = 'h-4 w-4 shrink-0';

export function VideoCallFrame({
  roomUrl,
  token,
  onLeft,
  onError,
  onParticipant,
  chat = false,
  onPersistMessage,
  isHost = false,
  onTranscriptLine,
  autoTranscribe = false,
}: VideoCallFrameProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<DailyCall | null>(null);
  const localRef = useRef<{ sessionId: string; name: string } | null>(null);
  const [messages, setMessages] = useState<ChatLine[]>([]);

  // Chat panel visibility + unread (badged on the bar toggle when hidden).
  const [chatOpen, setChatOpen] = useState(true);
  const [unread, setUnread] = useState(0);
  const chatOpenRef = useRef(true);
  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);
  const toggleChat = useCallback(() => {
    setChatOpen((o) => {
      const next = !o;
      if (next) setUnread(0);
      return next;
    });
  }, []);

  // Chat policy (host on/off). Host authors + broadcasts; guests follow.
  const [chatAllowed, setChatAllowed] = useState(true);
  const chatAllowedRef = useRef(true);
  useEffect(() => {
    chatAllowedRef.current = chatAllowed;
  }, [chatAllowed]);
  const setChatPolicy = useCallback((allowed: boolean) => {
    setChatAllowed(allowed);
    frameRef.current?.sendAppMessage({ type: 'chat-policy', allowed }, '*');
  }, []);

  // Live transcript. Runs start-to-end when the org enables it (autoTranscribe);
  // we surface only errors here (the transcript itself is emailed via webhook).
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  // In-app maximize (the whole container, not just the iframe).
  const [expanded, setExpanded] = useState(false);
  const toggleExpand = useCallback(() => setExpanded((e) => !e), []);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const sendChat = useCallback(
    (text: string) => {
      const frame = frameRef.current;
      const local = localRef.current;
      if (!frame || !local || !chatAllowedRef.current) return;
      frame.sendAppMessage({ type: 'chat', text, name: local.name }, '*');
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), name: local.name, text, mine: true }]);
      onPersistMessage?.({
        dailySessionId: local.sessionId,
        senderName: local.name,
        text,
        sentAt: new Date().toISOString(),
      });
    },
    [onPersistMessage],
  );

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    let cancelled = false;

    (async () => {
      const DailyIframe = (await import('@daily-co/daily-js')).default;
      if (cancelled) return;

      const stray = DailyIframe.getCallInstance();
      if (stray) await stray.destroy();
      if (cancelled) return;

      const frame = DailyIframe.createFrame(wrapper, {
        showLeaveButton: true,
        // Daily's fullscreen targets only the iframe and would hide our chat; we
        // provide our own container-level Expand control in the bar below.
        showFullscreenButton: false,
        iframeStyle: { width: '100%', height: '100%', border: '0', borderRadius: '0.5rem' },
      });
      frameRef.current = frame;

      frame.on('left-meeting', () => onLeft());

      // Provider-neutral participant lifecycle. `owner` === host (is_owner token).
      const emit = (
        action: ParticipantEvent['action'],
        p: { session_id?: string; user_name?: string; owner?: boolean } | undefined,
      ) => {
        if (!p?.session_id) return;
        onParticipant?.({
          action,
          dailySessionId: p.session_id,
          name: p.user_name || 'Guest',
          role: p.owner ? 'host' : 'guest',
          at: new Date().toISOString(),
        });
      };

      frame.on('joined-meeting', () => {
        const local = frame.participants().local;
        if (local?.session_id) {
          localRef.current = { sessionId: local.session_id, name: local.user_name || 'You' };
        }
        emit('join', local);
        // Org has auto-transcription on — the host starts it for the whole call.
        if (autoTranscribe && isHost) frame.startTranscription();
      });
      frame.on('participant-joined', (ev) => {
        emit('join', ev?.participant);
        // Re-send the current policy so late joiners sync to it.
        if (isHost) frame.sendAppMessage({ type: 'chat-policy', allowed: chatAllowedRef.current }, '*');
      });
      frame.on('participant-left', (ev) => emit('leave', ev?.participant));

      // Data channel: chat messages + the host's chat policy.
      if (chat) {
        frame.on('app-message', (ev) => {
          if (!ev) return;
          const data = ev.data as
            | { type?: string; text?: string; name?: string; allowed?: boolean }
            | undefined;
          if (!data) return;

          if (data.type === 'chat-policy') {
            setChatAllowed(!!data.allowed);
            return;
          }

          if (data.type !== 'chat' || !data.text) return;
          if (!chatAllowedRef.current) return; // chat is off — ignore stray messages
          const name = data.name || 'Guest';
          setMessages((prev) => [...prev, { id: crypto.randomUUID(), name, text: data.text!, mine: false }]);
          if (!chatOpenRef.current) setUnread((u) => u + 1);
          onPersistMessage?.({
            dailySessionId: ev.fromId,
            senderName: name,
            text: data.text,
            sentAt: new Date().toISOString(),
          });
        });
      }

      // Live transcript. Each message resolves the speaker by session id and is
      // handed up for persistence (host only); errors surface in the bar.
      frame.on('transcription-started', () => setTranscribeError(null));
      frame.on('transcription-error', (ev) => {
        setTranscribeError(ev?.errorMsg || 'Transcription failed — is it enabled on your Daily account?');
      });
      frame.on('transcription-message', (ev) => {
        if (!ev?.text || !ev.participantId) return;
        const speaker = Object.values(frame.participants()).find((p) => p.session_id === ev.participantId);
        onTranscriptLine?.({
          dailySessionId: ev.participantId,
          speakerName: speaker?.user_name || 'Speaker',
          text: ev.text,
          saidAt: ev.timestamp instanceof Date ? ev.timestamp.toISOString() : new Date().toISOString(),
        });
      });

      try {
        await frame.join({ url: roomUrl, token });
      } catch (err) {
        if (cancelled) return;
        onError?.(err instanceof Error ? err.message : 'Failed to join the call');
      }
    })();

    return () => {
      cancelled = true;
      const frame = frameRef.current;
      frameRef.current = null;
      localRef.current = null;
      if (frame) void frame.destroy();
    };
  }, [roomUrl, token, onLeft, onError, onParticipant, chat, onPersistMessage, isHost, onTranscriptLine, autoTranscribe]);

  return (
    <div className={expanded ? 'fixed inset-0 z-50 flex flex-col bg-zinc-950' : 'flex h-full w-full flex-col'}>
      <div className="flex min-h-0 flex-1">
        <div ref={wrapperRef} className="h-full min-w-0 flex-1" />
        {chat && chatOpen && (
          <ChatPanel messages={messages} onSend={sendChat} onClose={() => setChatOpen(false)} disabled={!chatAllowed} />
        )}
      </div>

      {transcribeError && (
        <div className="shrink-0 px-3 py-1 text-xs text-rose-300" style={{ backgroundColor: BAR_BG }}>
          Transcript: {transcribeError}
        </div>
      )}

      {/* Our control bar — colored to match the video blue above it. */}
      <div
        className="flex shrink-0 items-center justify-between gap-2 px-3 py-1.5 text-white"
        style={{ backgroundColor: BAR_BG }}
      >
        <button
          type="button"
          onClick={toggleExpand}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-white/90 hover:bg-white/10"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICON} aria-hidden="true">
            {expanded ? (
              <>
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
              </>
            ) : (
              <>
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </>
            )}
          </svg>
          {expanded ? 'Collapse' : 'Expand'}
        </button>

        <div className="flex items-center gap-1">
          {chat && isHost && (
            <button
              type="button"
              onClick={() => setChatPolicy(!chatAllowed)}
              title={chatAllowed ? 'Turn chat off for the guest' : 'Turn chat on'}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-white/90 hover:bg-white/10"
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${chatAllowed ? 'bg-emerald-500' : 'bg-zinc-400'}`}
                aria-hidden="true"
              />
              {chatAllowed ? 'Chat: On' : 'Chat: Off'}
            </button>
          )}

          {chat && (
            <button
              type="button"
              onClick={toggleChat}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-white/90 hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICON} aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {chatOpen ? 'Hide chat' : 'Chat'}
              {!chatOpen && unread > 0 && (
                <span className="ml-0.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-sky-600 px-1 text-[10px] font-medium text-white">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
