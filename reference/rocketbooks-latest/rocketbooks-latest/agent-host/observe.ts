import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from './types';

/**
 * Read-only observation of Claude Code sessions that were NOT started by this
 * daemon (e.g. your interactive terminal agents). We derive everything from the
 * transcript files Claude Code writes under ~/.claude/projects — so these can be
 * listed and viewed, but not driven.
 */

export interface ObservedSession {
  sessionId: string;
  title: string;
  cwd: string | null;
  model: string | null;
  lastActivity: string;
  userMessages: number;
  assistantMessages: number;
  transcriptPath: string;
}

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === 'object' && 'text' in p && typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : '',
      )
      .join(' ')
      .trim();
  }
  return '';
}

async function readLines(file: string): Promise<string[]> {
  try {
    return (await fs.readFile(file, 'utf8')).split('\n');
  } catch {
    return [];
  }
}

async function summarize(file: string): Promise<ObservedSession | null> {
  const lines = await readLines(file);
  if (lines.length === 0) return null;

  let cwd: string | null = null;
  let model: string | null = null;
  let aiTitle: string | null = null;
  let firstUser: string | null = null;
  let lastPrompt: string | null = null;
  let userMessages = 0;
  let assistantMessages = 0;
  let sessionId = path.basename(file, '.jsonl');
  let lastTs = 0;

  for (const line of lines) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
    if (typeof o.sessionId === 'string') sessionId = o.sessionId;
    if (typeof o.timestamp === 'string') {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
    }
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') aiTitle = o.aiTitle;
    else if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string') lastPrompt = o.lastPrompt;
    else if (o.type === 'user') {
      const t = textOf((o.message as { content?: unknown })?.content);
      if (t) {
        userMessages += 1;
        if (!firstUser) firstUser = t;
      }
    } else if (o.type === 'assistant') {
      const msg = o.message as { content?: unknown; model?: unknown } | undefined;
      if (msg) {
        if (typeof msg.model === 'string') model = msg.model;
        if (textOf(msg.content)) assistantMessages += 1;
      }
    }
  }

  if (userMessages === 0 && assistantMessages === 0) return null;

  let mtime = lastTs;
  try {
    mtime = Math.max(mtime, (await fs.stat(file)).mtimeMs);
  } catch {
    /* ignore */
  }

  return {
    sessionId,
    title: aiTitle || firstUser || lastPrompt || '(untitled session)',
    cwd,
    model,
    lastActivity: new Date(mtime || Date.now()).toISOString(),
    userMessages,
    assistantMessages,
    transcriptPath: file,
  };
}

/** Scan top-level session transcripts across all projects, most-recent first. */
export async function scanObservedSessions(limit = 0): Promise<ObservedSession[]> {
  const root = projectsRoot();
  let projects: string[];
  try {
    projects = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== 'memory')
      .map((e) => e.name);
  } catch {
    return [];
  }

  // Cheap pass first: stat every transcript for its mtime, so we only fully
  // read+parse the most-recent `limit` files instead of the entire store.
  const candidates: Array<{ file: string; mtime: number }> = [];
  for (const project of projects) {
    const dir = path.join(root, project);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, e.name);
      try {
        candidates.push({ file, mtime: (await fs.stat(file)).mtimeMs });
      } catch {
        /* ignore unreadable */
      }
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const picked = limit > 0 ? candidates.slice(0, limit) : candidates;

  const sessions = (await Promise.all(picked.map((c) => summarize(c.file)))).filter(
    (s): s is ObservedSession => s !== null,
  );
  sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return sessions;
}

const EVENT_CAP = 800;

/** Parse a transcript file into read-only AgentEvents for the console. */
export async function parseTranscriptEvents(file: string): Promise<AgentEvent[]> {
  const lines = await readLines(file);
  const events: AgentEvent[] = [];
  let seq = 0;
  const push = (e: Omit<AgentEvent, 'seq' | 'ts'>, ts: string) => {
    events.push({ seq: ++seq, ts, ...e });
  };

  for (const line of lines) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : new Date(0).toISOString();
    if (o.type === 'user') {
      const t = textOf((o.message as { content?: unknown })?.content);
      if (t) push({ kind: 'user', text: t }, ts);
    } else if (o.type === 'assistant') {
      const content = (o.message as { content?: unknown })?.content;
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) push({ kind: 'assistant_text', text: b.text }, ts);
          else if (b.type === 'tool_use') push({ kind: 'tool_use', tool: String(b.name ?? 'tool'), input: b.input }, ts);
        }
      }
    } else if (o.type === 'result') {
      push({ kind: 'result', subtype: typeof o.subtype === 'string' ? o.subtype : undefined }, ts);
    }
  }

  // Keep the tail if the transcript is very long.
  return events.length > EVENT_CAP ? events.slice(events.length - EVENT_CAP) : events;
}
