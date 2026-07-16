'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SummaryPanel, Transcript, type Segment, type Draft, type ApproveState } from './RecorderShared';

type State =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number; recordingId: string }
  | { kind: 'uploading' }
  | { kind: 'transcribing' }
  | { kind: 'ready'; recordingId: string }
  | { kind: 'failed'; message: string };

interface Props {
  initialRecordings: Array<{ id: string; title: string | null; createdAt: string; status: string }>;
}

const BAR_COUNT = 7;

function pickMime(): string {
  // iOS Safari only records mp4; Chromium/Firefox prefer webm/opus.
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'audio/webm';
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function RecorderWorkspace({ initialRecordings }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [checked, setChecked] = useState<boolean[]>([]);
  const [approve, setApprove] = useState<ApproveState>('idle');
  const [approveError, setApproveError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0));
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopMeter = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setLevels(new Array(BAR_COUNT).fill(0));
  }, []);

  // Tap the live mic stream with a Web Audio AnalyserNode so we can render
  // a bouncing level meter while recording — purely a "we're listening" cue,
  // it does not touch the MediaRecorder pipeline that produces the upload.
  const startMeter = useCallback((stream: MediaStream) => {
    type WindowWithWebkit = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctx = window.AudioContext ?? (window as WindowWithWebkit).webkitAudioContext;
    if (!Ctx) return; // no Web Audio support — skip the meter, recording still works
    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    audioCtxRef.current = ctx;
    analyserRef.current = analyser;

    const bins = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      const a = analyserRef.current;
      if (!a) return;
      a.getByteFrequencyData(bins);
      // Fold the FFT bins into BAR_COUNT bands and normalise to 0..1.
      const perBar = Math.floor(bins.length / BAR_COUNT) || 1;
      const next = new Array(BAR_COUNT).fill(0).map((_, i) => {
        let sum = 0;
        for (let j = 0; j < perBar; j++) sum += bins[i * perBar + j] ?? 0;
        return Math.min(1, sum / perBar / 255);
      });
      setLevels(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const cleanup = useCallback(() => {
    stopMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, [stopMeter]);

  useEffect(() => () => cleanup(), [cleanup]);

  const startRecording = useCallback(async () => {
    setSegments([]);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setState({ kind: 'failed', message: `microphone access denied: ${(err as Error).message}` });
      return;
    }

    let recordingId: string;
    try {
      const res = await fetch('/api/recorder/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'mic' }),
      });
      if (!res.ok) throw new Error(`start ${res.status}`);
      const json = (await res.json()) as { recordingId: string };
      recordingId = json.recordingId;
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setState({ kind: 'failed', message: `could not start recording: ${(err as Error).message}` });
      return;
    }

    const mime = pickMime();
    const rec = new MediaRecorder(stream, { mimeType: mime });
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.start(1000);
    recorderRef.current = rec;
    streamRef.current = stream;
    startMeter(stream);

    const startedAt = Date.now();
    setState({ kind: 'recording', startedAt, recordingId });
    setElapsedMs(0);
    tickRef.current = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
  }, [startMeter]);

  const stopRecording = useCallback(async () => {
    const rec = recorderRef.current;
    const stream = streamRef.current;
    if (!rec || state.kind !== 'recording') return;

    const recordingId = state.recordingId;
    const durationS = Math.round((Date.now() - state.startedAt) / 1000);

    const stopped: Promise<Blob> = new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        resolve(blob);
      };
      rec.stop();
    });

    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    stopMeter();

    setState({ kind: 'uploading' });
    const blob = await stopped;
    stream?.getTracks().forEach((t) => t.stop());

    const form = new FormData();
    form.append('recordingId', recordingId);
    form.append('durationS', String(durationS));
    form.append('audio', blob, `audio.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);

    setState({ kind: 'transcribing' });
    try {
      const res = await fetch('/api/recorder/finalize', { method: 'POST', body: form });
      const json = (await res.json()) as { recordingId?: string; error?: string; detail?: string };
      if (!res.ok) {
        const parts = [json.error, json.detail].filter(Boolean);
        throw new Error(parts.length ? parts.join(' — ') : `finalize ${res.status}`);
      }
      const [segRes, outRes] = await Promise.all([
        fetch(`/api/recorder/${recordingId}/segments`),
        fetch(`/api/recorder/${recordingId}/output`),
      ]);
      if (segRes.ok) {
        const segJson = (await segRes.json()) as { segments: Segment[] };
        setSegments(segJson.segments);
      }
      if (outRes.ok) {
        const outJson = (await outRes.json()) as { output: Draft | null };
        setDraft(outJson.output);
        setChecked((outJson.output?.actionItems ?? []).map(() => true));
      }
      setApprove('idle');
      setApproveError(null);
      setState({ kind: 'ready', recordingId });
    } catch (err) {
      setState({ kind: 'failed', message: (err as Error).message });
    } finally {
      cleanup();
    }
  }, [state, cleanup, stopMeter]);

  const reset = useCallback(() => {
    setSegments([]);
    setDraft(null);
    setChecked([]);
    setApprove('idle');
    setApproveError(null);
    setState({ kind: 'idle' });
  }, []);

  const approveDraft = useCallback(async () => {
    if (state.kind !== 'ready' || !draft) return;
    const items = draft.actionItems.filter((_, i) => checked[i]);
    setApprove('saving');
    setApproveError(null);
    try {
      const res = await fetch(`/api/recorder/${state.recordingId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summaryMd: draft.summaryMd,
          actionItems: items.map((it) => ({ text: it.text, dueHint: it.dueHint })),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok || !json.ok) throw new Error(json.detail ?? json.error ?? `approve ${res.status}`);
      setApprove('saved');
    } catch (err) {
      setApprove('error');
      setApproveError((err as Error).message);
    }
  }, [state, draft, checked]);

  const updateActionItem = useCallback((i: number, text: string) => {
    setDraft((d) =>
      d
        ? {
            ...d,
            actionItems: d.actionItems.map((it, idx) => (idx === i ? { ...it, text } : it)),
          }
        : d,
    );
  }, []);

  const updateSummary = useCallback((text: string) => {
    setDraft((d) => (d ? { ...d, summaryMd: text } : d));
  }, []);

  const toggleChecked = useCallback((i: number) => {
    setChecked((arr) => arr.map((v, idx) => (idx === i ? !v : v)));
  }, []);

  return (
    <div className="space-y-6">
      <RecorderControls state={state} elapsedMs={elapsedMs} levels={levels} onStart={startRecording} onStop={stopRecording} onReset={reset} />
      {state.kind === 'ready' && draft && (
        <SummaryPanel
          draft={draft}
          checked={checked}
          approve={approve}
          approveError={approveError}
          onSummaryChange={updateSummary}
          onActionItemChange={updateActionItem}
          onToggle={toggleChecked}
          onApprove={approveDraft}
        />
      )}
      {state.kind === 'ready' && segments.length > 0 && <Transcript segments={segments} />}
      {state.kind === 'ready' && segments.length === 0 && (
        <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          Deepgram returned no utterances — the audio may have been silent.
        </p>
      )}
      {state.kind === 'failed' && (
        <p className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-900/20 dark:text-rose-300">
          {state.message}
        </p>
      )}
      {initialRecordings.length > 0 && state.kind === 'idle' && segments.length === 0 && (
        <PastRecordings rows={initialRecordings} />
      )}
    </div>
  );
}

function RecorderControls({
  state,
  elapsedMs,
  levels,
  onStart,
  onStop,
  onReset,
}: {
  state: State;
  elapsedMs: number;
  levels: number[];
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}) {
  const recording = state.kind === 'recording';
  const busy = state.kind === 'uploading' || state.kind === 'transcribing';

  let statusText = 'Ready';
  if (recording) statusText = `Recording — ${formatElapsed(elapsedMs)}`;
  else if (state.kind === 'uploading') statusText = 'Uploading…';
  else if (state.kind === 'transcribing') statusText = 'Transcribing with Deepgram…';
  else if (state.kind === 'ready') statusText = 'Ready';
  else if (state.kind === 'failed') statusText = 'Failed';

  return (
    <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      {!recording && !busy && state.kind !== 'ready' && (
        <button
          type="button"
          onClick={onStart}
          className="inline-flex items-center gap-2 rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700"
        >
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-white" />
          Start recording
        </button>
      )}
      {recording && (
        <>
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" />
            Stop
          </button>
          <LevelMeter levels={levels} />
          <span className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">{statusText}</span>
        </>
      )}
      {busy && (
        <div className="inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-sky-500" />
          {statusText}
        </div>
      )}
      {state.kind === 'ready' && (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          New recording
        </button>
      )}
      {!busy && !recording && (
        <span className="text-sm text-zinc-500 dark:text-zinc-500">{statusText}</span>
      )}
    </div>
  );
}

// Live mic level meter — bars bounce up/down with input volume so the user can
// see the device is actively listening. `levels` is BAR_COUNT values in 0..1.
function LevelMeter({ levels }: { levels: number[] }) {
  return (
    <div
      className="flex h-8 items-center gap-1"
      role="img"
      aria-label="Microphone input level"
      title="Listening…"
    >
      {levels.map((v, i) => (
        <span
          key={i}
          className="w-1 rounded-full bg-rose-500 transition-[height] duration-75 ease-out dark:bg-rose-400"
          // Floor at 10% so idle/silence still shows a faint baseline rather than vanishing.
          style={{ height: `${Math.max(10, v * 100)}%` }}
        />
      ))}
    </div>
  );
}

function PastRecordings({ rows }: { rows: Props['initialRecordings'] }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Recent recordings</h2>
      <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/organizer/recorder/${r.id}`}
              className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
            >
              <span className="truncate">{r.title ?? 'Untitled'}</span>
              <span className="shrink-0 text-xs text-zinc-500">
                {new Date(r.createdAt).toLocaleString()} · {r.status}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
