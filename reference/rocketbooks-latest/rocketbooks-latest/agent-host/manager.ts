import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ManagedAgent, type AgentHooks } from './agent';
import { readGitState } from './git';
import { scanObservedSessions, parseTranscriptEvents } from './observe';
import type { AgentEvent, AgentSummary, GitState } from './types';

export interface SpawnOptions {
  cwd: string;
  model?: string | null;
  title?: string;
  firstMessage?: string;
}

/**
 * Owns the set of live agents, persists the registry, resumes agents on
 * startup, polls per-repo git state, and surfaces read-only observed terminal
 * sessions. Emits per-agent events and roster changes to listeners.
 */
export class AgentManager {
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly eventListeners = new Set<(agentId: string, event: AgentEvent) => void>();
  private readonly changeListeners = new Set<() => void>();
  private readonly dataFile: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private gitTimer: NodeJS.Timeout | null = null;
  private observedTimer: NodeJS.Timeout | null = null;
  private readonly gitCache = new Map<string, GitState>(); // cwd -> latest GitState
  private readonly gitSerialized = new Map<string, string>(); // cwd -> serialized (change detect)
  private observed: AgentSummary[] = [];
  private lastObservedKey = '';
  private readonly observedPaths = new Map<string, string>(); // sessionId -> transcriptPath
  private clientCount = 0;
  private observedLimit = 30;

  constructor(dataFile: string) {
    this.dataFile = dataFile;
  }

  onEvent(fn: (agentId: string, event: AgentEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** Live agents plus read-only observed sessions (deduped by sessionId). */
  list(): AgentSummary[] {
    const live = [...this.agents.values()].map((a) => a.summary());
    const liveSessions = new Set(live.map((a) => a.sessionId).filter(Boolean));
    const observed = this.observed
      .filter((o) => !liveSessions.has(o.sessionId))
      .map((o) => ({ ...o, git: this.gitForCwd(o.cwd) }));
    return [...live, ...observed].sort((x, y) => y.lastActivity.localeCompare(x.lastActivity));
  }

  get(id: string): ManagedAgent | undefined {
    return this.agents.get(id);
  }

  spawn(opts: SpawnOptions): ManagedAgent {
    const title =
      opts.title?.trim() ||
      (opts.firstMessage ? opts.firstMessage.slice(0, 60) : `Agent in ${path.basename(opts.cwd)}`);
    const agent = new ManagedAgent({ title, cwd: opts.cwd, model: opts.model ?? null }, this.hooks());
    this.agents.set(agent.id, agent);
    agent.start();
    if (opts.firstMessage) agent.send(opts.firstMessage);
    this.scheduleSave();
    this.notifyChange();
    void this.pollGit();
    return agent;
  }

  async remove(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;
    await agent.stop();
    this.agents.delete(id);
    this.scheduleSave();
    this.notifyChange();
  }

  rename(id: string, title: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.rename(title);
    this.scheduleSave();
    this.notifyChange();
  }

  async stop(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;
    await agent.stop();
    this.notifyChange();
  }

  async restart(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;
    await agent.restart();
    this.scheduleSave();
    this.notifyChange();
  }

  /** Read-only backlog for an observed (non-daemon) session. */
  async getObservedTranscript(id: string): Promise<{ summary: AgentSummary; events: AgentEvent[] } | null> {
    const file = this.observedPaths.get(id);
    const summary = this.observed.find((o) => o.id === id);
    if (!file || !summary) return null;
    const events = await parseTranscriptEvents(file);
    return { summary: { ...summary, git: this.gitForCwd(summary.cwd) }, events };
  }

  // --- client tracking (gates background polling) --------------------------

  clientConnected(): void {
    this.clientCount += 1;
    if (this.clientCount === 1) {
      void this.pollObserved();
      void this.pollGit();
    }
  }

  clientDisconnected(): void {
    this.clientCount = Math.max(0, this.clientCount - 1);
    if (this.clientCount === 0) {
      // No dashboard left to answer permission prompts — don't leave agents hanging.
      for (const agent of this.agents.values()) agent.denyPending('No dashboard connected');
    }
  }

  // --- polling -------------------------------------------------------------

  startPolling(gitIntervalMs: number, observedIntervalMs: number, observedLimit = 30): void {
    this.observedLimit = observedLimit;
    if (!this.gitTimer) this.gitTimer = setInterval(() => void this.pollGit(), gitIntervalMs);
    if (!this.observedTimer) this.observedTimer = setInterval(() => void this.pollObserved(), observedIntervalMs);
  }

  private gitForCwd(cwd: string): GitState | null {
    return (cwd && this.gitCache.get(cwd)) || null;
  }

  private async pollGit(): Promise<void> {
    if (this.clientCount === 0) return;
    const cwds = new Set<string>();
    for (const a of this.agents.values()) cwds.add(a.cwd);
    for (const o of this.observed) if (o.cwd) cwds.add(o.cwd);

    let changed = false;
    for (const cwd of cwds) {
      const state = await readGitState(cwd);
      const serialized = JSON.stringify(state);
      if (this.gitSerialized.get(cwd) !== serialized) {
        this.gitSerialized.set(cwd, serialized);
        this.gitCache.set(cwd, state);
        changed = true;
      }
      for (const agent of this.agents.values()) if (agent.cwd === cwd) agent.git = state;
    }
    if (changed) this.notifyChange();
  }

  private async pollObserved(): Promise<void> {
    if (this.clientCount === 0) return;
    const sessions = await scanObservedSessions(this.observedLimit);
    const liveSessions = new Set([...this.agents.values()].map((a) => a.sessionId).filter(Boolean));
    this.observedPaths.clear();
    const summaries: AgentSummary[] = [];
    for (const s of sessions) {
      if (liveSessions.has(s.sessionId)) continue;
      this.observedPaths.set(s.sessionId, s.transcriptPath);
      summaries.push({
        id: s.sessionId,
        title: s.title,
        cwd: s.cwd ?? '',
        model: s.model,
        status: 'ended',
        sessionId: s.sessionId,
        createdAt: s.lastActivity,
        lastActivity: s.lastActivity,
        pendingPermissions: 0,
        git: null,
        readonly: true,
      });
    }
    this.observed = summaries;
    const key = summaries.map((s) => `${s.id}:${s.lastActivity}`).join('|');
    if (key !== this.lastObservedKey) {
      this.lastObservedKey = key;
      this.notifyChange();
    }
  }

  /** Load the persisted registry and re-establish each session via resume. */
  async loadAndResume(): Promise<number> {
    let persisted: { agents?: Array<ReturnType<ManagedAgent['persisted']>> };
    try {
      persisted = JSON.parse(await fs.readFile(this.dataFile, 'utf8'));
    } catch {
      return 0;
    }
    for (const p of persisted.agents ?? []) {
      const agent = new ManagedAgent(
        { id: p.id, title: p.title, cwd: p.cwd, model: p.model, sessionId: p.sessionId, createdAt: p.createdAt },
        this.hooks(),
      );
      this.agents.set(agent.id, agent);
      agent.start();
    }
    return this.agents.size;
  }

  private hooks(): AgentHooks {
    return {
      onEvent: (a, e) => {
        for (const l of this.eventListeners) l(a.id, e);
      },
      onChange: () => {
        this.scheduleSave();
        this.notifyChange();
      },
    };
  }

  private notifyChange(): void {
    for (const l of this.changeListeners) l();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 250);
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
      const data = { agents: [...this.agents.values()].map((a) => a.persisted()) };
      await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2));
    } catch {
      /* non-fatal: registry is a convenience, not source of truth */
    }
  }
}
