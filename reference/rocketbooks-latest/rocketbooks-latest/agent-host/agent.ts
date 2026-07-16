import { randomUUID } from 'node:crypto';
import { query, type SDKUserMessage, type PermissionResult, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { Pushable } from './pushable';
import type { AgentEvent, AgentStatus, AgentSummary, GitState, PersistedAgent } from './types';

const BACKLOG_CAP = 1500;

export interface AgentInit {
  id?: string;
  title: string;
  cwd: string;
  model?: string | null;
  sessionId?: string | null;
  createdAt?: string;
}

export interface AgentHooks {
  onEvent: (agent: ManagedAgent, event: AgentEvent) => void;
  onChange: (agent: ManagedAgent) => void;
}

/**
 * A single live Claude Code session, owned by the daemon (not by any terminal
 * or browser tab). It runs an Agent SDK `query()` fed by a pushable stream of
 * user messages, so it stays alive between turns and across client disconnects.
 */
export class ManagedAgent {
  readonly id: string;
  title: string;
  readonly cwd: string;
  model: string | null;
  sessionId: string | null;
  readonly createdAt: string;
  lastActivity: string;
  status: AgentStatus = 'starting';
  /** Latest working-tree git state, refreshed by the manager's poller. */
  git: GitState | null = null;

  private input = new Pushable<SDKUserMessage>();
  private query: ReturnType<typeof query> | null = null;
  /** Bumped on every (re)launch so stale consume loops can detect supersession. */
  private generation = 0;
  /** Serializes lifecycle ops (start/send/stop/restart) so input can't race a relaunch. */
  private opChain: Promise<void> = Promise.resolve();
  private readonly backlog: AgentEvent[] = [];
  private seq = 0;
  private readonly pending = new Map<string, { resolve: (r: PermissionResult) => void; input: Record<string, unknown> }>();
  private readonly hooks: AgentHooks;

  constructor(init: AgentInit, hooks: AgentHooks) {
    this.id = init.id ?? randomUUID();
    this.title = init.title;
    this.cwd = init.cwd;
    this.model = init.model ?? null;
    this.sessionId = init.sessionId ?? null;
    this.createdAt = init.createdAt ?? new Date().toISOString();
    this.lastActivity = this.createdAt;
    this.hooks = hooks;
  }

  private isLive(): boolean {
    return this.query !== null && this.status !== 'ended' && this.status !== 'error';
  }

  /** Serialize lifecycle ops so a message can't race a stop/restart relaunch. */
  private enqueue(op: () => void | Promise<void>): Promise<void> {
    this.opChain = this.opChain.then(op).catch(() => {});
    return this.opChain;
  }

  /** Start the session if it isn't already live (idempotent). */
  start(): void {
    void this.enqueue(() => {
      if (!this.isLive()) this.launch();
    });
  }

  private launch(): void {
    const gen = ++this.generation;
    this.input = new Pushable<SDKUserMessage>();
    this.query = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        permissionMode: 'default',
        canUseTool: this.canUseTool as CanUseTool,
        ...(this.model ? { model: this.model } : {}),
        ...(this.sessionId ? { resume: this.sessionId } : {}),
      },
    });
    void this.consume(gen);
    // A resumed agent has no in-flight turn; mark it idle (ready for input).
    this.setStatus(this.sessionId ? 'idle' : 'starting');
  }

  /** Send a human message into the live session (relaunching if stopped). */
  send(text: string): void {
    void this.enqueue(() => {
      if (!this.isLive()) this.launch();
      this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      this.emit({ kind: 'user', text });
      this.setStatus('working');
    });
  }

  /** Interrupt the current turn; the session stays live and returns to idle. */
  async interrupt(): Promise<void> {
    try {
      await this.query?.interrupt();
    } catch {
      /* best effort */
    }
  }

  /** End the session (process stops) but keep the agent so it can be restarted. */
  async stop(): Promise<void> {
    await this.enqueue(() => this.doStop());
  }

  /** Stop and re-establish the session, resuming from sessionId. */
  async restart(): Promise<void> {
    await this.enqueue(async () => {
      await this.doStop();
      this.launch();
    });
  }

  private async doStop(): Promise<void> {
    this.generation++; // invalidate the running consume loop
    const q = this.query;
    this.query = null;
    try {
      await q?.interrupt();
    } catch {
      /* best effort */
    }
    this.input.end();
    this.failPending('Session stopped');
    this.setStatus('ended');
  }

  rename(title: string): void {
    const t = title.trim();
    if (t) this.title = t;
  }

  /** Resolve a pending permission request from a dashboard decision. */
  resolvePermission(requestId: string, decision: 'allow' | 'deny', message?: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (decision === 'allow') p.resolve({ behavior: 'allow', updatedInput: p.input });
    else p.resolve({ behavior: 'deny', message: message ?? 'Denied from dashboard' });
    this.emit({ kind: 'permission_resolved', requestId, decision });
    this.setStatus(this.pending.size > 0 ? 'awaiting_permission' : 'working');
  }

  getBacklog(): AgentEvent[] {
    return this.backlog;
  }

  summary(): AgentSummary {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      model: this.model,
      status: this.status,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      pendingPermissions: this.pending.size,
      git: this.git,
    };
  }

  persisted(): PersistedAgent {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      model: this.model,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
    };
  }

  // --- internals -----------------------------------------------------------

  private emit(e: Omit<AgentEvent, 'seq' | 'ts'>): void {
    const full: AgentEvent = { seq: ++this.seq, ts: new Date().toISOString(), ...e };
    this.backlog.push(full);
    if (this.backlog.length > BACKLOG_CAP) this.backlog.shift();
    this.lastActivity = full.ts;
    this.hooks.onEvent(this, full);
  }

  private setStatus(s: AgentStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit({ kind: 'status', status: s });
    this.hooks.onChange(this);
  }

  private async consume(gen: number): Promise<void> {
    const q = this.query;
    if (!q) return;
    try {
      // Loosely typed: the SDKMessage union is broad; we narrow on `type`.
      for await (const m of q as AsyncGenerator<Record<string, unknown>>) {
        if (gen !== this.generation) return; // superseded by stop()/restart()
        this.handleMessage(m);
      }
      if (gen === this.generation) this.setStatus('ended');
    } catch (err) {
      if (gen === this.generation) {
        this.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        this.setStatus('error');
      }
    }
  }

  /** Deny in-flight permission requests (e.g. when the last dashboard disconnects). */
  denyPending(reason: string): void {
    this.failPending(reason);
  }

  /** Deny and clear any in-flight permission requests (e.g. on stop). */
  private failPending(reason: string): void {
    for (const [, p] of this.pending) p.resolve({ behavior: 'deny', message: reason });
    this.pending.clear();
  }

  private handleMessage(m: Record<string, unknown>): void {
    const sid = m.session_id;
    if (typeof sid === 'string' && this.sessionId !== sid) {
      this.sessionId = sid;
      this.hooks.onChange(this);
    }

    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.emit({ kind: 'system', subtype: 'init', text: typeof sid === 'string' ? `session ${sid}` : 'session started' });
        }
        break;
      case 'assistant': {
        const content = (m.message as { content?: unknown })?.content;
        if (Array.isArray(content)) {
          for (const b of content as Array<Record<string, unknown>>) {
            if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              this.emit({ kind: 'assistant_text', text: b.text });
            } else if (b.type === 'tool_use') {
              this.emit({ kind: 'tool_use', tool: String(b.name ?? 'tool'), input: b.input, toolUseId: String(b.id ?? '') });
            }
          }
        }
        this.setStatus('working');
        break;
      }
      case 'result':
        this.emit({
          kind: 'result',
          subtype: typeof m.subtype === 'string' ? m.subtype : undefined,
          costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
        });
        this.setStatus('idle');
        break;
      default:
        break; // ignore other message types in Phase 1
    }
  }

  private canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<PermissionResult> => {
    const requestId = randomUUID();
    this.emit({ kind: 'permission_request', requestId, tool: toolName, input });
    this.setStatus('awaiting_permission');
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input });
      options.signal?.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(requestId)) resolve({ behavior: 'deny', message: 'aborted' });
        },
        { once: true },
      );
    });
  };
}
