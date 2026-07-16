'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentEvent, AgentSummary } from '@/agent-host/types';

interface Props {
  wsUrl: string;
  defaultCwd: string;
}

type Conn = 'connecting' | 'open' | 'closed';

const MODELS = [
  { value: '', label: 'Default (Opus)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const STATUS_COLOR: Record<string, string> = {
  working: 'bg-blue-500 animate-pulse',
  awaiting_permission: 'bg-amber-500 animate-pulse',
  idle: 'bg-emerald-500',
  starting: 'bg-zinc-400',
  ended: 'bg-zinc-400',
  error: 'bg-red-500',
};

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function AgentConsole({ wsUrl, defaultCwd }: Props) {
  const wsRef = useRef<WebSocket | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [eventsByAgent, setEventsByAgent] = useState<Record<string, AgentEvent[]>>({});
  const [input, setInput] = useState('');
  const [showSpawn, setShowSpawn] = useState(false);
  const [spawnCwd, setSpawnCwd] = useState(defaultCwd);
  const [spawnModel, setSpawnModel] = useState('');
  const [spawnMsg, setSpawnMsg] = useState('');
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [notifyOn, setNotifyOn] = useState(false);
  const notifyRef = useRef(false);
  const agentsRef = useRef<AgentSummary[]>([]);

  // Fire a browser notification only when the tab is hidden and the user opted in.
  const notify = useCallback((title: string, body: string) => {
    if (!notifyRef.current || !document.hidden) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body });
    } catch {
      /* ignore */
    }
  }, []);

  const toggleNotify = useCallback(async () => {
    if (notifyOn) {
      setNotifyOn(false);
      notifyRef.current = false;
      return;
    }
    if (typeof Notification === 'undefined') return;
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    const on = perm === 'granted';
    setNotifyOn(on);
    notifyRef.current = on;
  }, [notifyOn]);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const mergeEvents = useCallback((agentId: string, incoming: AgentEvent[], replace = false) => {
    setEventsByAgent((prev) => {
      const existing = replace ? [] : prev[agentId] ?? [];
      const lastSeq = existing.length ? existing[existing.length - 1].seq : 0;
      const fresh = incoming.filter((e) => e.seq > lastSeq);
      if (!replace && fresh.length === 0) return prev;
      return { ...prev, [agentId]: replace ? incoming : [...existing, ...fresh] };
    });
  }, []);

  // Connect (with simple auto-reconnect).
  useEffect(() => {
    let stop = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      setConn('connecting');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setConn('open');
      ws.onclose = () => {
        setConn('closed');
        if (!stop) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (m.type === 'agents') {
          const next = m.agents as AgentSummary[];
          agentsRef.current = next;
          setAgents(next);
        } else if (m.type === 'backlog') {
          // Sent on spawn (focus the new agent) and on attach (same id we just
          // selected) — either way, focus the agent this backlog is for.
          const agentId = m.agentId as string;
          mergeEvents(agentId, m.events as AgentEvent[], true);
          setSelected(agentId);
        } else if (m.type === 'event') {
          const agentId = m.agentId as string;
          const event = m.event as AgentEvent;
          mergeEvents(agentId, [event]);
          if (event.kind === 'permission_request' || (event.kind === 'status' && event.status === 'idle')) {
            const name = agentsRef.current.find((a) => a.id === agentId)?.title ?? 'Agent';
            if (event.kind === 'permission_request') notify(`${name} needs permission`, event.tool ?? 'tool use');
            else notify(`${name} is idle`, 'Finished its turn — your move');
          }
        }
      };
    };

    connect();
    return () => {
      stop = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [wsUrl, mergeEvents, notify]);

  // Auto-scroll transcript.
  const selectedEvents = useMemo(
    () => (selected ? eventsByAgent[selected] ?? [] : []),
    [selected, eventsByAgent],
  );
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selectedEvents.length, selected]);

  // Reflect agents needing attention in the tab title.
  useEffect(() => {
    const waiting = agents.filter((a) => a.pendingPermissions > 0).length;
    const base = 'Agent Console';
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [agents]);

  const selectAgent = useCallback(
    (id: string) => {
      setSelected(id);
      send({ type: 'attach', agentId: id });
    },
    [send],
  );

  const submitInput = useCallback(() => {
    const text = input.trim();
    if (!text || !selected) return;
    send({ type: 'input', agentId: selected, text });
    setInput('');
  }, [input, selected, send]);

  const doSpawn = useCallback(() => {
    if (!spawnCwd.trim()) return;
    send({
      type: 'spawn',
      cwd: spawnCwd.trim(),
      model: spawnModel || undefined,
      firstMessage: spawnMsg.trim() || undefined,
    });
    setSpawnMsg('');
    setShowSpawn(false);
  }, [spawnCwd, spawnModel, spawnMsg, send]);

  // Pending permission requests for the selected agent.
  const pending = useMemo(() => {
    const resolved = new Set(
      selectedEvents.filter((e) => e.kind === 'permission_resolved').map((e) => e.requestId),
    );
    return selectedEvents.filter((e) => e.kind === 'permission_request' && !resolved.has(e.requestId));
  }, [selectedEvents]);

  const selectedAgent = agents.find((a) => a.id === selected) ?? null;
  const liveAgents = agents.filter((a) => !a.readonly);
  const observedAgents = agents.filter((a) => a.readonly);

  const renameAgent = useCallback(() => {
    if (!selectedAgent) return;
    const t = window.prompt('Rename agent', selectedAgent.title);
    if (t && t.trim()) send({ type: 'rename', agentId: selectedAgent.id, title: t.trim() });
  }, [selectedAgent, send]);

  const removeAgent = useCallback(() => {
    if (!selectedAgent) return;
    if (window.confirm('Remove this agent? Its session transcript is kept on disk.')) {
      send({ type: 'remove', agentId: selectedAgent.id });
      setSelected(null);
    }
  }, [selectedAgent, send]);

  return (
    <div className="flex flex-col gap-3">
      <ConnBar
        conn={conn}
        wsUrl={wsUrl}
        notifyOn={notifyOn}
        onToggleNotify={toggleNotify}
        onNewAgent={() => setShowSpawn((s) => !s)}
      />

      {showSpawn && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Working directory
              <input
                value={spawnCwd}
                onChange={(e) => setSpawnCwd(e.target.value)}
                className="rounded-md border border-zinc-200 bg-transparent px-2 py-1.5 font-mono text-sm dark:border-zinc-800"
                placeholder="C:\\path\\to\\repo"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Model
              <select
                value={spawnModel}
                onChange={(e) => setSpawnModel(e.target.value)}
                className="rounded-md border border-zinc-200 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-800"
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1 text-xs text-zinc-500">
            First message (optional)
            <textarea
              value={spawnMsg}
              onChange={(e) => setSpawnMsg(e.target.value)}
              rows={2}
              className="rounded-md border border-zinc-200 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-800"
              placeholder="What should this agent start on?"
            />
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setShowSpawn(false)}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              Cancel
            </button>
            <button
              onClick={doSpawn}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
            >
              Spawn agent
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[260px_1fr]">
        {/* Agent list */}
        <div className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950">
          {agents.length === 0 && (
            <div className="p-3 text-sm text-zinc-500">
              No agents yet. Click “+ New agent” — your terminal sessions show up under Observed.
            </div>
          )}
          {liveAgents.length > 0 && <ListHeading>Live</ListHeading>}
          {liveAgents.map((a) => (
            <AgentRow key={a.id} a={a} active={selected === a.id} onSelect={() => selectAgent(a.id)} />
          ))}
          {observedAgents.length > 0 && (
            <ListHeading>Observed · read-only ({observedAgents.length})</ListHeading>
          )}
          {observedAgents.map((a) => (
            <AgentRow key={a.id} a={a} active={selected === a.id} onSelect={() => selectAgent(a.id)} />
          ))}
        </div>

        {/* Transcript + input */}
        <div className="flex min-h-[460px] flex-col rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          {!selectedAgent ? (
            <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
              Select an agent to view its conversation.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{selectedAgent.title}</div>
                  <div className="truncate font-mono text-[11px] text-zinc-500" title={selectedAgent.cwd}>
                    {selectedAgent.cwd} · {selectedAgent.model ?? 'default'} ·{' '}
                    {selectedAgent.readonly ? 'observed (terminal session)' : selectedAgent.status}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    <GitHeader git={selectedAgent.git} />
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  {selectedAgent.readonly ? (
                    <span className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-500 dark:border-zinc-800">
                      read-only
                    </span>
                  ) : (
                    <>
                      {selectedAgent.status === 'working' && (
                        <button
                          onClick={() => send({ type: 'interrupt', agentId: selectedAgent.id })}
                          className="rounded-md border border-amber-300 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
                        >
                          Interrupt
                        </button>
                      )}
                      <button
                        onClick={renameAgent}
                        className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => send({ type: 'restart', agentId: selectedAgent.id })}
                        className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                      >
                        Restart
                      </button>
                      {selectedAgent.status !== 'ended' && (
                        <button
                          onClick={() => send({ type: 'stop', agentId: selectedAgent.id })}
                          className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                        >
                          Stop
                        </button>
                      )}
                      <button
                        onClick={removeAgent}
                        className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div ref={transcriptRef} className="flex-1 space-y-2 overflow-y-auto p-4">
                {selectedEvents.map((e) => (
                  <EventRow key={`${e.seq}`} e={e} />
                ))}
              </div>

              {pending.length > 0 && (
                <div className="space-y-2 border-t border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/30">
                  {pending.map((p) => (
                    <div key={p.requestId} className="flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium text-amber-800 dark:text-amber-300">Permission: {p.tool}</span>
                        <span className="ml-2 truncate font-mono text-xs text-amber-700/80 dark:text-amber-400/70">
                          {summarizeInput(p.input)}
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          onClick={() =>
                            send({ type: 'permission', agentId: selectedAgent.id, requestId: p.requestId, decision: 'deny' })
                          }
                          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-900"
                        >
                          Deny
                        </button>
                        <button
                          onClick={() =>
                            send({ type: 'permission', agentId: selectedAgent.id, requestId: p.requestId, decision: 'allow' })
                          }
                          className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500"
                        >
                          Allow
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {selectedAgent.readonly ? (
                <div className="border-t border-zinc-200 px-4 py-3 text-center text-xs text-zinc-500 dark:border-zinc-800">
                  Read-only — this session was started outside the daemon (a terminal agent). Resume it from a
                  terminal to interact, or spawn a new daemon agent to chat here.
                </div>
              ) : (
                <div className="flex items-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        submitInput();
                      }
                    }}
                    rows={2}
                    placeholder={conn === 'open' ? 'Message this agent…  (Enter to send, Shift+Enter for newline)' : 'Daemon offline'}
                    disabled={conn !== 'open'}
                    className="flex-1 resize-none rounded-md border border-zinc-200 bg-transparent px-3 py-2 text-sm focus:border-blue-400 focus:outline-none disabled:opacity-50 dark:border-zinc-800"
                  />
                  <button
                    onClick={submitInput}
                    disabled={conn !== 'open' || !input.trim()}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    Send
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnBar({
  conn,
  wsUrl,
  notifyOn,
  onToggleNotify,
  onNewAgent,
}: {
  conn: Conn;
  wsUrl: string;
  notifyOn: boolean;
  onToggleNotify: () => void;
  onNewAgent: () => void;
}) {
  const dot = conn === 'open' ? 'bg-emerald-500' : conn === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-red-500';
  const label = conn === 'open' ? 'Daemon connected' : conn === 'connecting' ? 'Connecting…' : 'Daemon offline';
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="font-medium">{label}</span>
        {conn !== 'open' && (
          <span className="font-mono text-xs text-zinc-500">
            — run <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">npm run agent-host</code> ({wsUrl.split('?')[0]})
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onToggleNotify}
          title={notifyOn ? 'Notifications on (when tab is in background)' : 'Enable background notifications'}
          className={`rounded-md border px-2.5 py-1.5 text-sm ${
            notifyOn
              ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
              : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900'
          }`}
        >
          {notifyOn ? '🔔' : '🔕'}
        </button>
        <button
          onClick={onNewAgent}
          disabled={conn !== 'open'}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
        >
          + New agent
        </button>
      </div>
    </div>
  );
}

function EventRow({ e }: { e: AgentEvent }) {
  switch (e.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">{e.text}</div>
        </div>
      );
    case 'assistant_text':
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">{e.text}</div>
        </div>
      );
    case 'tool_use':
      return (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="rounded bg-violet-100 px-1.5 py-0.5 font-mono text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
            🔧 {e.tool}
          </span>
          <span className="truncate font-mono">{summarizeInput(e.input)}</span>
        </div>
      );
    case 'permission_resolved':
      return (
        <div className="text-center text-[11px] text-zinc-400">
          permission {e.decision === 'allow' ? 'allowed' : 'denied'}
        </div>
      );
    case 'result':
      return (
        <div className="flex items-center gap-2 py-1 text-[11px] text-zinc-400">
          <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          <span>turn complete{e.costUsd != null ? ` · $${e.costUsd.toFixed(4)}` : ''}</span>
          <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>
      );
    case 'error':
      return <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">⚠ {e.message}</div>;
    case 'system':
      return <div className="text-center text-[11px] text-zinc-400">{e.text}</div>;
    default:
      return null;
  }
}

function ListHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{children}</div>
  );
}

function timeAgo(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function AgentRow({ a, active, onSelect }: { a: AgentSummary; active: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`flex flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors ${
        active ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            a.readonly ? 'bg-zinc-300 dark:bg-zinc-600' : STATUS_COLOR[a.status] ?? 'bg-zinc-400'
          }`}
        />
        <span className={`flex-1 truncate text-sm font-medium ${a.readonly ? 'text-zinc-600 dark:text-zinc-400' : ''}`}>
          {a.title}
        </span>
        {a.pendingPermissions > 0 && (
          <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
            {a.pendingPermissions}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 pl-4 text-[11px] text-zinc-500">
        {a.cwd && (
          <span className="truncate font-mono" title={a.cwd}>
            {baseName(a.cwd)}
          </span>
        )}
        <GitInline git={a.git} />
        {a.readonly && <span className="ml-auto shrink-0 text-zinc-400">{timeAgo(a.lastActivity)}</span>}
      </div>
    </button>
  );
}

/** Compact git indicators for the agent list row. */
function GitInline({ git }: { git: AgentSummary['git'] }) {
  if (!git || !git.isRepo) return null;
  const clean = git.dirty === 0 && (!git.hasUpstream || git.ahead === 0);
  return (
    <span className="flex items-center gap-1.5">
      <span>·</span>
      <span className="font-mono" title="branch">
        ⎇ {git.branch ?? '—'}
      </span>
      {git.dirty > 0 && (
        <span className="text-amber-600 dark:text-amber-400" title={`${git.dirty} uncommitted`}>
          ●{git.dirty}
        </span>
      )}
      {git.hasUpstream && git.ahead != null && git.ahead > 0 && (
        <span className="text-blue-600 dark:text-blue-400" title={`${git.ahead} unpushed`}>
          ↑{git.ahead}
        </span>
      )}
      {clean && (
        <span className="text-emerald-600 dark:text-emerald-400" title="clean & pushed">
          ✓
        </span>
      )}
    </span>
  );
}

/** Fuller git line for the selected-agent header. */
function GitHeader({ git }: { git: AgentSummary['git'] }) {
  if (!git) return <span className="text-zinc-400">git: …</span>;
  if (!git.isRepo) return <span className="text-zinc-400">not a git repo</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-mono">⎇ {git.branch ?? '—'}</span>
      {git.dirty > 0 ? (
        <span className="rounded bg-amber-100 px-1.5 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
          {git.dirty} uncommitted
        </span>
      ) : (
        <span className="rounded bg-emerald-100 px-1.5 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
          clean
        </span>
      )}
      {!git.hasUpstream ? (
        <span className="rounded bg-zinc-100 px-1.5 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">no upstream</span>
      ) : git.ahead && git.ahead > 0 ? (
        <span className="rounded bg-blue-100 px-1.5 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
          {git.ahead} unpushed
        </span>
      ) : git.behind && git.behind > 0 ? (
        <span className="rounded bg-amber-100 px-1.5 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
          {git.behind} behind
        </span>
      ) : (
        <span className="rounded bg-emerald-100 px-1.5 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
          pushed
        </span>
      )}
      {git.lastCommit && <span className="truncate text-zinc-500">{git.lastCommit}</span>}
    </span>
  );
}

function summarizeInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 120);
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return '';
  }
}
