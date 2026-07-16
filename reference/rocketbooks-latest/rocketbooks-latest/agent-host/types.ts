/** Shared types for the agent-host daemon and its WebSocket protocol. */

import type { GitState } from './git';

export type { GitState };

export type AgentStatus =
  | 'starting'
  | 'working'
  | 'idle' // waiting for the next user message
  | 'awaiting_permission'
  | 'error'
  | 'ended';

export type EventKind =
  | 'system'
  | 'user'
  | 'assistant_text'
  | 'tool_use'
  | 'result'
  | 'status'
  | 'permission_request'
  | 'permission_resolved'
  | 'error';

/** A normalized, UI-friendly event derived from an SDK message. */
export interface AgentEvent {
  seq: number;
  ts: string;
  kind: EventKind;
  text?: string;
  subtype?: string;
  tool?: string;
  input?: unknown;
  toolUseId?: string;
  costUsd?: number;
  status?: AgentStatus;
  requestId?: string;
  decision?: 'allow' | 'deny';
  message?: string;
}

export interface AgentSummary {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  status: AgentStatus;
  sessionId: string | null;
  createdAt: string;
  lastActivity: string;
  pendingPermissions: number;
  git: GitState | null;
  /** True for observed terminal sessions (not daemon-managed; view-only). */
  readonly?: boolean;
}

/** What we persist to disk so agents can be recalled after a daemon restart. */
export interface PersistedAgent {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  sessionId: string | null;
  createdAt: string;
}

export type ClientMessage =
  | { type: 'list' }
  | { type: 'spawn'; cwd: string; model?: string | null; title?: string; firstMessage?: string }
  | { type: 'attach'; agentId: string }
  | { type: 'input'; agentId: string; text: string }
  | { type: 'interrupt'; agentId: string }
  | { type: 'permission'; agentId: string; requestId: string; decision: 'allow' | 'deny'; message?: string }
  | { type: 'rename'; agentId: string; title: string }
  | { type: 'stop'; agentId: string }
  | { type: 'restart'; agentId: string }
  | { type: 'remove'; agentId: string };

export type ServerMessage =
  | { type: 'hello'; ok: true; pid: number }
  | { type: 'agents'; agents: AgentSummary[] }
  | { type: 'backlog'; agentId: string; summary: AgentSummary; events: AgentEvent[] }
  | { type: 'event'; agentId: string; event: AgentEvent }
  | { type: 'error'; message: string };
