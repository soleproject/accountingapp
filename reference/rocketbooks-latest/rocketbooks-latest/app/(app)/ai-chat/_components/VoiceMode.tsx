'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { REALTIME_VOICES, DEFAULT_VOICE, type RealtimeVoice } from '@/lib/ai/realtime-voices';
import { InvoicePreview, type InvoiceDraftView } from './InvoicePreview';
import { TransactionsPanel, type TransactionsResult } from './TransactionsPanel';
import { OnboardingPanel, type OnboardingStatusView } from './OnboardingPanel';

export type VoiceStatus = 'idle' | 'starting' | 'connected' | 'ending' | 'error';
export type VoiceActivity = 'idle' | 'listening' | 'thinking' | 'tool' | 'speaking';

// Keep the internal aliases — file already references these short names heavily.
type Status = VoiceStatus;
type Activity = VoiceActivity;

/** Imperative handle exposed to AiChatWorkspace so the cards panel can inject
 *  an AI prompt into the active realtime session. The implementation gates on
 *  activity === 'idle' to avoid colliding with an in-flight response. */
export interface VoiceModeHandle {
  inject(prompt: string): void;
}

// Caps to keep voice-mode state small after long sessions. Without these the
// transcripts array grows unbounded; after ~10 minutes of dialog every audio
// delta clones a huge array and the main thread starves, manifesting as
// laggy / "locked" page scroll.
const MAX_TRANSCRIPTS = 40;
const MAX_RAW_EVENTS = 60;
const MAX_TOOL_LOG = 10;

interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  item_id?: string;
  error?: { type?: string; code?: string; message?: string };
}

interface VoiceModeProps {
  /** When true, the voice mode auto-starts on mount (for the post-onboarding-delete welcome flow). */
  autoStart?: boolean;
  /** If set, the AI greets the user by this name and proactively offers onboarding right after connect. */
  welcomeName?: string;
  /** Lifted shared state — the workspace owns it so all entry paths produce the same panel. */
  onboarding: OnboardingStatusView | null;
  setOnboarding: (next: OnboardingStatusView | null) => void;
  /** Lifted: workspace owns the voice connection status so the cards panel
   *  can decide whether to route a prompt to text or voice. */
  voiceStatus: VoiceStatus;
  setVoiceStatus: (s: VoiceStatus) => void;
  /** Workspace also reads activity so it can compute a unified "busy" gate
   *  spanning both surfaces. */
  onActivityChange?: (a: VoiceActivity) => void;
  /** When provided, renders a small "hide" button in the card header so the
   *  user can collapse the voice card and reclaim vertical space for chat.
   *  Hiding unmounts this component; any active WebRTC session tears down. */
  onHide?: () => void;
}

export const VoiceMode = forwardRef<VoiceModeHandle, VoiceModeProps>(function VoiceMode(
  { autoStart = false, welcomeName = '', onboarding, setOnboarding, voiceStatus, setVoiceStatus, onActivityChange, onHide },
  ref,
) {
  const [voice, setVoice] = useState<RealtimeVoice>(DEFAULT_VOICE);
  // Status is now lifted to the workspace. Read via the prop, write via the
  // setter prop. Internal naming preserves existing readability.
  const status = voiceStatus;
  const setStatus = setVoiceStatus;
  const [activity, setActivity] = useState<Activity>('idle');
  const activityRef = useRef<Activity>('idle');
  const [activityLabel, setActivityLabel] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [draft, setDraft] = useState<InvoiceDraftView | null>(null);
  const [txnResult, setTxnResult] = useState<TransactionsResult | null>(null);
  const [toolLog, setToolLog] = useState<Array<{ name: string; ok: boolean; summary: string }>>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [rawEvents, setRawEvents] = useState<string[]>([]);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const sessionConfigRef = useRef<{ instructions?: string; tools?: unknown; session?: Record<string, unknown> } | null>(null);
  // Realtime cost tracking: audio streams client↔OpenAI, so we tally token
  // usage from response.done events here and report the session total to the
  // server on stop (it prices + records it into the usage ledger).
  const realtimeUsageRef = useRef({
    inputTextTokens: 0,
    inputAudioTokens: 0,
    cachedTextTokens: 0,
    cachedAudioTokens: 0,
    outputTextTokens: 0,
    outputAudioTokens: 0,
  });
  const realtimeModelRef = useRef<string | undefined>(undefined);
  const sessionStartRef = useRef<number>(0);
  const welcomeNameRef = useRef(welcomeName);
  const autoStartedRef = useRef(false);
  // Tracks the OpenAI Realtime user-conversation-item id of the most recent
  // user utterance. Sent to the server as turnId on every tool call so the
  // onboarding turn-gate can refuse a chained second advance within the
  // same user turn. Null until the first user message arrives.
  const lastUserItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    welcomeNameRef.current = welcomeName;
  }, [welcomeName]);

  // Mirror activity into a ref so the imperative inject() can read the latest
  // value without re-creating the handle on every activity change. Also forward
  // changes to the parent so the cards panel busy gate stays accurate.
  useEffect(() => {
    activityRef.current = activity;
    onActivityChange?.(activity);
  }, [activity, onActivityChange]);

  useImperativeHandle(
    ref,
    () => ({
      inject(prompt: string) {
        // Idle gate — if the model is mid-response or running a tool, drop
        // the inject. The parent disables clicks via `busy`, but this is a
        // belt-and-suspenders check in case a click sneaks through.
        if (activityRef.current !== 'idle') return;
        const dc = dcRef.current;
        if (!dc || dc.readyState !== 'open') return;
        dc.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: prompt }],
            },
          }),
        );
        dc.send(JSON.stringify({ type: 'response.create' }));
      },
    }),
    [],
  );

  useEffect(() => {
    const saved = localStorage.getItem('rs_voice') as RealtimeVoice | null;
    if (saved && REALTIME_VOICES.some((v) => v.value === saved)) setVoice(saved);
  }, []);

  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-start when the welcome flow lands here (post-only-org-delete).
  useEffect(() => {
    if (autoStart && !autoStartedRef.current && status === 'idle') {
      autoStartedRef.current = true;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, status]);

  const handleVoiceChange = (v: RealtimeVoice) => {
    setVoice(v);
    localStorage.setItem('rs_voice', v);
    if (status === 'connected') stop();
  };

  const sendDc = (msg: object) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg));
  };

  const pushRaw = (line: string) => {
    setRawEvents((prev) => (prev.length >= MAX_RAW_EVENTS ? [...prev.slice(1), line] : [...prev, line]));
  };

  const handleToolCall = async (callId: string, name: string, argsJson: string) => {
    let args: Record<string, unknown> = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      // bad JSON from model; let server reject
    }
    setActivity('tool');
    setActivityLabel(`${name}…`);

    let output: unknown;
    let ok = true;
    try {
      const res = await fetch('/api/ai/realtime/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args, turnId: lastUserItemIdRef.current ?? undefined }),
      });
      output = await res.json();
      if (!res.ok) ok = false;
    } catch (e) {
      output = { error: e instanceof Error ? e.message : 'tool failed' };
      ok = false;
    }

    if (ok && (name === 'save_invoice_draft' || name === 'post_invoice')) {
      const candidate = output as InvoiceDraftView;
      if (candidate?.draftId) setDraft(candidate);
    }
    if (ok && name === 'cancel_invoice_draft') setDraft(null);
    if (ok && name === 'query_transactions') {
      setTxnResult(output as TransactionsResult);
    }
    if (
      ok &&
      (name === 'get_onboarding_status' || name === 'set_business_info' || name === 'advance_onboarding')
    ) {
      setOnboarding(output as OnboardingStatusView);
    }

    setToolLog((prev) => {
      const next = { name, ok, summary: summarizeOutput(name, output) };
      return prev.length >= MAX_TOOL_LOG ? [...prev.slice(1), next] : [...prev, next];
    });
    pushRaw(`→ tool result ${name}: ${ok ? 'ok' : 'ERR'} ${JSON.stringify(output).slice(0, 160)}`);

    sendDc({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
    sendDc({ type: 'response.create' });
    setActivity('thinking');
    setActivityLabel('');
  };

  const start = async () => {
    setError(null);
    setStatus('starting');
    setActivity('idle');
    setTranscripts([]);
    setDraft(null);
    setTxnResult(null);
    setOnboarding(null);
    setToolLog([]);
    setRawEvents([]);
    realtimeUsageRef.current = {
      inputTextTokens: 0,
      inputAudioTokens: 0,
      cachedTextTokens: 0,
      cachedAudioTokens: 0,
      outputTextTokens: 0,
      outputAudioTokens: 0,
    };
    sessionStartRef.current = Date.now();
    try {
      const tokenRes = await fetch('/api/ai/realtime/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice }),
      });
      const tokenBody = (await tokenRes.json()) as {
        token?: string;
        model?: string;
        error?: string;
        instructions?: string;
        tools?: unknown;
        session?: Record<string, unknown>;
      };
      if (!tokenRes.ok || !tokenBody.token) throw new Error(tokenBody.error ?? `Token mint failed: ${tokenRes.status}`);
      realtimeModelRef.current = tokenBody.model;
      sessionConfigRef.current = {
        instructions: tokenBody.instructions,
        tools: tokenBody.tools,
        session: tokenBody.session,
      };

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      let audioEl = audioElRef.current;
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioElRef.current = audioEl;
      }
      pc.ontrack = (e) => {
        if (audioEl) audioEl.srcObject = e.streams[0];
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      // Belt-and-suspenders: re-send tools + instructions via session.update once the channel opens.
      // GA shape — type:'realtime' is required, voice/transcription nest under audio,
      // modalities is renamed to output_modalities. The token route returns the full
      // session config it sent at mint; prefer that, fall back to a re-derived shape.
      dc.addEventListener('open', () => {
        const cfg = sessionConfigRef.current;
        if (cfg?.session) {
          dc.send(JSON.stringify({ type: 'session.update', session: cfg.session }));
          pushRaw('→ session.update sent (GA shape, mint echo)');
        } else if (cfg?.instructions && cfg.tools) {
          dc.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                instructions: cfg.instructions,
                tools: cfg.tools,
                tool_choice: 'auto',
                output_modalities: ['audio'],
                audio: {
                  input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' } },
                },
              },
            }),
          );
          pushRaw('→ session.update sent (GA shape, derived)');
        }

        // The AI speaks first: greet by name and lead from the live CLIENT
        // CONTEXT snapshot in its instructions (what needs attention today). For
        // a not-yet-set-up business the snapshot shows the onboarding step, so
        // the same greeting naturally offers onboarding.
        const name = welcomeNameRef.current;
        if (name) {
          const greeting = `The user just opened their books. Their first name is ${name}. Greet them warmly by name and, using the CLIENT CONTEXT in your instructions, lead with the one or two most important things that need their attention right now (or tell them their books look good if nothing does). If they haven't finished setting up yet, briefly offer to walk them through onboarding and, if they say yes, immediately call get_onboarding_status. Keep it short — two or three sentences — then ask one specific question and wait for their answer.`;
          dc.send(
            JSON.stringify({
              type: 'response.create',
              response: { output_modalities: ['audio'], instructions: greeting },
            }),
          );
          pushRaw(`→ response.create sent (welcome greeting for ${name})`);
        }
      });

      const argBuffers = new Map<string, { name: string; args: string }>();

      dc.addEventListener('message', (e) => {
        try {
          const evt = JSON.parse(e.data) as RealtimeEvent & {
            response?: {
              output?: Array<{ type: string; name?: string; call_id?: string; arguments?: string }>;
            };
            item?: { type?: string; name?: string; call_id?: string };
          };
          // Trim long deltas in the raw log
          if (
            evt.type !== 'response.output_audio_transcript.delta' &&
            evt.type !== 'response.output_audio.delta'
          ) {
            pushRaw(`← ${evt.type}${evt.name ? ' ' + evt.name : ''}${evt.error ? ' ERR ' + evt.error.message : ''}`);
          }

          if (evt.type === 'error' || evt.type === 'session.error') {
            const msg = evt.error?.message ?? 'session error';
            setError(msg);
          } else if (evt.type === 'input_audio_buffer.speech_started') {
            setActivity('listening');
            setActivityLabel('');
          } else if (evt.type === 'input_audio_buffer.speech_stopped') {
            setActivity('thinking');
            setActivityLabel('');
          } else if (evt.type === 'response.created') {
            setActivity('thinking');
            setActivityLabel('');
          } else if (
            evt.type === 'response.output_audio.delta' ||
            evt.type === 'response.output_audio_transcript.delta'
          ) {
            setActivity('speaking');
          } else if (evt.type === 'response.done') {
            setActivity('idle');
            setActivityLabel('');
            // Tally token usage for cost tracking. Realtime reports per-modality
            // counts on response.done; we sum them across the session and report
            // the total on stop.
            const ru = (evt.response as {
              usage?: {
                input_token_details?: { text_tokens?: number; audio_tokens?: number; cached_tokens_details?: { text_tokens?: number; audio_tokens?: number } };
                output_token_details?: { text_tokens?: number; audio_tokens?: number };
              };
            } | undefined)?.usage;
            if (ru) {
              const acc = realtimeUsageRef.current;
              acc.inputTextTokens += ru.input_token_details?.text_tokens ?? 0;
              acc.inputAudioTokens += ru.input_token_details?.audio_tokens ?? 0;
              acc.cachedTextTokens += ru.input_token_details?.cached_tokens_details?.text_tokens ?? 0;
              acc.cachedAudioTokens += ru.input_token_details?.cached_tokens_details?.audio_tokens ?? 0;
              acc.outputTextTokens += ru.output_token_details?.text_tokens ?? 0;
              acc.outputAudioTokens += ru.output_token_details?.audio_tokens ?? 0;
            }
            // Fallback: pick up any function_call items that didn't fire .done
            for (const item of evt.response?.output ?? []) {
              if (item.type === 'function_call' && item.call_id && item.name && argBuffers.has(item.call_id)) continue;
              if (item.type === 'function_call' && item.call_id && item.name) {
                handleToolCall(item.call_id, item.name, item.arguments ?? '');
              }
            }
          } else if (evt.type === 'response.output_audio_transcript.delta' && evt.delta) {
            setTranscripts((prev) => {
              type T = { role: 'user' | 'assistant'; text: string };
              const last = prev[prev.length - 1];
              const next: T[] = last?.role === 'assistant'
                ? [...prev.slice(0, -1), { role: 'assistant', text: last.text + evt.delta }]
                : [...prev, { role: 'assistant', text: evt.delta ?? '' }];
              return next.length > MAX_TRANSCRIPTS ? next.slice(-MAX_TRANSCRIPTS) : next;
            });
          } else if (
            evt.type === 'conversation.item.input_audio_transcription.completed' &&
            evt.transcript
          ) {
            // Capture the user's conversation-item id so subsequent tool
            // calls in this turn carry it as turnId — server uses it to
            // refuse a chained second advance within the same user message.
            if (evt.item_id) lastUserItemIdRef.current = evt.item_id;
            setTranscripts((prev) => {
              type T = { role: 'user' | 'assistant'; text: string };
              const next: T[] = [...prev, { role: 'user', text: evt.transcript ?? '' }];
              return next.length > MAX_TRANSCRIPTS ? next.slice(-MAX_TRANSCRIPTS) : next;
            });
          } else if (
            evt.type === 'response.output_item.added' &&
            evt.item?.type === 'function_call' &&
            evt.item.call_id &&
            evt.item.name
          ) {
            argBuffers.set(evt.item.call_id, { name: evt.item.name, args: '' });
            setActivity('tool');
            setActivityLabel(`${evt.item.name}…`);
          } else if (evt.type === 'response.function_call_arguments.delta' && evt.call_id) {
            const cur = argBuffers.get(evt.call_id) ?? { name: evt.name ?? '', args: '' };
            argBuffers.set(evt.call_id, {
              name: cur.name || evt.name || '',
              args: cur.args + (evt.delta ?? ''),
            });
          } else if (evt.type === 'response.function_call_arguments.done' && evt.call_id) {
            const buf = argBuffers.get(evt.call_id);
            const fnName = evt.name ?? buf?.name ?? '';
            const fnArgs = evt.arguments ?? buf?.args ?? '';
            argBuffers.delete(evt.call_id);
            if (fnName) handleToolCall(evt.call_id, fnName, fnArgs);
          }
        } catch {
          // ignore non-JSON
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // GA WebRTC requires ICE gathering to finish before the offer is
      // posted — otherwise the SDP lacks ICE candidates for the upload
      // direction and the user's mic audio never reaches OpenAI, even
      // though playback works. Cap the wait at 5s so a slow STUN doesn't
      // hang Start voice forever.
      if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve) => {
          const onChange = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', onChange);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', onChange);
          setTimeout(() => {
            pc.removeEventListener('icegatheringstatechange', onChange);
            resolve();
          }, 5000);
        });
      }

      // GA SDP exchange: POST FormData(sdp, session) to /v1/realtime/calls.
      // The model goes inside the `session` JSON, not the query string.
      // FormData fields must be plain strings, not Blobs — the server
      // rejects multipart parts that carry a filename attribute.
      const form = new FormData();
      form.set('sdp', pc.localDescription?.sdp ?? offer.sdp ?? '');
      form.set(
        'session',
        JSON.stringify(
          sessionConfigRef.current?.session ?? { type: 'realtime', model: tokenBody.model },
        ),
      );
      const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: form,
        headers: { Authorization: `Bearer ${tokenBody.token}` },
      });
      if (!sdpRes.ok) {
        const t = await sdpRes.text().catch(() => '');
        throw new Error(`OpenAI Realtime SDP error: ${sdpRes.status} ${t.slice(0, 200)}`);
      }
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setStatus('connected');
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') setStatus('idle');
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start');
      setStatus('error');
      stop();
    }
  };

  // Report the session's accumulated token usage to the server for pricing +
  // ledger recording. Resets the accumulator first so a double-stop / unmount
  // can't double-count. keepalive lets the POST survive the page teardown.
  const reportRealtimeUsage = () => {
    const u = realtimeUsageRef.current;
    realtimeUsageRef.current = {
      inputTextTokens: 0,
      inputAudioTokens: 0,
      cachedTextTokens: 0,
      cachedAudioTokens: 0,
      outputTextTokens: 0,
      outputAudioTokens: 0,
    };
    const total = u.inputTextTokens + u.inputAudioTokens + u.outputTextTokens + u.outputAudioTokens;
    if (total <= 0) return;
    const payload = {
      ...u,
      model: realtimeModelRef.current,
      durationMs: sessionStartRef.current ? Date.now() - sessionStartRef.current : undefined,
    };
    try {
      void fetch('/api/ai/realtime/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // best-effort — never let usage reporting break teardown
    }
  };

  const stop = () => {
    setStatus('ending');
    reportRealtimeUsage();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    dcRef.current = null;
    if (audioElRef.current) audioElRef.current.srcObject = null;
    setStatus('idle');
    setActivity('idle');
    setActivityLabel('');
  };

  const isActive = status === 'connected' || status === 'starting';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">
            🎙 Voice mode <span className="text-xs font-normal text-zinc-500">— with invoice creation</span>
          </h2>
          <div className="flex items-center gap-2">
            <label htmlFor="voice-picker" className="text-xs text-zinc-500">Voice</label>
            <select
              id="voice-picker"
              value={voice}
              disabled={isActive}
              onChange={(e) => handleVoiceChange(e.target.value as RealtimeVoice)}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
            >
              {REALTIME_VOICES.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label} — {v.description}
                </option>
              ))}
            </select>
            {onHide && (
              <button
                type="button"
                onClick={onHide}
                title="Hide voice mode"
                aria-label="Hide voice mode"
                className="inline-flex items-center justify-center rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {!isActive && (
            <button
              type="button"
              onClick={start}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              ● Start voice
            </button>
          )}
          {isActive && (
            <button
              type="button"
              onClick={stop}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              ■ Stop
            </button>
          )}
          <span className={`text-xs ${
            status === 'connected' ? 'text-emerald-600' :
            status === 'starting' ? 'text-amber-600' :
            status === 'error' ? 'text-red-600' :
            'text-zinc-500'
          }`}>
            {status === 'connected' ? '● Connected' :
             status === 'starting' ? '◌ Negotiating WebRTC…' :
             status === 'error' ? `✗ ${error ?? 'Error'}` :
             '○ Idle'}
          </span>
        </div>

        {status === 'connected' && (
          <ActivityIndicator activity={activity} label={activityLabel} />
        )}

        {transcripts.length > 0 && (
          <div className="max-h-40 overflow-y-auto overscroll-contain rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            {transcripts.map((t, i) => (
              <div key={i} className="mb-1">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{t.role}:</span>{' '}
                <span className="text-zinc-700 dark:text-zinc-300">{t.text}</span>
              </div>
            ))}
          </div>
        )}

        {toolLog.length > 0 && (
          <details className="rounded-md border border-zinc-200 bg-zinc-50 text-xs dark:border-zinc-800 dark:bg-zinc-900">
            <summary className="cursor-pointer select-none px-2 py-1.5 font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
              Tool calls ({toolLog.length})
              {toolLog.some((t) => !t.ok) && (
                <span className="ml-2 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-red-900 dark:bg-red-950/40 dark:text-red-200">
                  {toolLog.filter((t) => !t.ok).length} error
                </span>
              )}
            </summary>
            <div className="border-t border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
              {toolLog.map((t, i) => (
                <div key={i} className={t.ok ? 'text-zinc-700 dark:text-zinc-300' : 'text-red-700 dark:text-red-300'}>
                  {t.ok ? '⚙' : '✗'} {t.name} — {t.summary}
                </div>
              ))}
            </div>
          </details>
        )}

        {isActive && (
          <details className="text-xs">
            <summary
              className="cursor-pointer select-none text-zinc-500 hover:text-zinc-700"
              onClick={() => setShowRaw(!showRaw)}
            >
              Debug: raw events ({rawEvents.length})
            </summary>
            <div className="mt-2 max-h-40 overflow-y-auto overscroll-contain rounded-md border border-zinc-200 bg-zinc-950 p-2 font-mono text-[10px] text-zinc-300 dark:border-zinc-800">
              {rawEvents.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* OnboardingPanel is rendered by AiChatWorkspace at the page level so
          all entry paths (voice, welcome card, text chat) share one panel. */}
      {txnResult && <TransactionsPanel result={txnResult} onClose={() => setTxnResult(null)} />}
      {draft && <InvoicePreview draft={draft} onClose={() => setDraft(null)} />}
    </div>
  );
});

// Sibling visual to ChatActivityIndicator.tsx — kept separate intentionally so the
// voice and text surfaces can evolve independently. If you change the look here,
// consider whether the text indicator should mirror the change.
function ActivityIndicator({ activity, label }: { activity: Activity; label: string }) {
  if (activity === 'idle') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <span className="text-zinc-500">◌ Ready — say something</span>
      </div>
    );
  }
  const config = {
    listening: { icon: '🎤', text: 'Listening…', color: 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200' },
    thinking: { icon: '💭', text: 'Thinking…', color: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200' },
    tool: { icon: '⚙', text: label || 'Running tool…', color: 'border-purple-300 bg-purple-50 text-purple-900 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-200' },
    speaking: { icon: '💬', text: 'Speaking…', color: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200' },
  }[activity];

  return (
    <div className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${config.color}`}>
      <span className="text-base">{config.icon}</span>
      <span>{config.text}</span>
      <span className="ml-auto flex gap-1">
        <span className="h-2 w-2 animate-pulse rounded-full bg-current opacity-50" style={{ animationDelay: '0ms' }} />
        <span className="h-2 w-2 animate-pulse rounded-full bg-current opacity-50" style={{ animationDelay: '150ms' }} />
        <span className="h-2 w-2 animate-pulse rounded-full bg-current opacity-50" style={{ animationDelay: '300ms' }} />
      </span>
    </div>
  );
}

function summarizeOutput(name: string, output: unknown): string {
  if (typeof output !== 'object' || !output) return String(output);
  const o = output as Record<string, unknown>;
  if (o.error) return `error: ${String(o.error)}`;
  switch (name) {
    case 'lookup_contact': {
      const matches = (o.matches as Array<{ name: string }> | undefined) ?? [];
      return matches.length === 0 ? 'no match' : `${matches.length} match(es): ${matches.slice(0, 3).map((m) => m.name).join(', ')}`;
    }
    case 'create_contact':
      return `created ${o.name}`;
    case 'list_revenue_accounts': {
      const rev = (o.revenue as unknown[] | undefined) ?? [];
      const ar = (o.ar as unknown[] | undefined) ?? [];
      return `${rev.length} revenue, ${ar.length} AR candidates`;
    }
    case 'save_invoice_draft':
      return `draft total ${(o.total as number)?.toFixed(2) ?? '?'}, ${(o.lines as unknown[])?.length ?? 0} line(s)`;
    case 'post_invoice':
      return `posted (JE ${(o.journalEntryId as string)?.slice(0, 8) ?? '?'})`;
    case 'cancel_invoice_draft':
      return o.ok ? 'cancelled' : 'not found';
    case 'query_transactions': {
      const count = (o.count as number) ?? 0;
      const total = (o.totalAmount as number) ?? 0;
      return `${count} txn(s), total ${total.toFixed(2)}`;
    }
    case 'get_onboarding_status':
    case 'set_business_info':
    case 'advance_onboarding':
      return `phase: ${String(o.phase)}${o.completed ? ' · complete' : ''}`;
    default:
      return JSON.stringify(o).slice(0, 80);
  }
}
