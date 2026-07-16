import 'server-only';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Phase 0 of the Agent Dashboard: read-only observability.
 *
 * Reads the local Claude Code transcript store (~/.claude/projects) and the git
 * state of each working tree those sessions ran in. Everything here is derived
 * from files on disk that Claude Code already writes — there is no daemon yet,
 * so "status" is inferred from how recently a transcript was touched, not from a
 * live process. Live status / chat / recall arrive in Phase 1.
 *
 * On the production server this directory does not exist, so scanAgents()
 * returns an empty result. It only produces data when rocketsuite runs on the
 * same machine as the agents (i.e. localhost during development).
 */

export type AgentStatus = 'active' | 'idle' | 'dormant';

export interface GitState {
  cwd: string;
  branch: string | null;
  /** uncommitted (working tree + staged) file count */
  dirtyCount: number;
  /** commits on HEAD not yet on the upstream branch (unpushed) */
  ahead: number | null;
  /** commits on upstream not yet local */
  behind: number | null;
  /** whether an upstream is configured for the current branch */
  hasUpstream: boolean;
  lastCommit: string | null;
  isRepo: boolean;
}

export interface AgentSession {
  sessionId: string;
  /** decoded project folder name, e.g. "C--Users-micha-rocketsuite" */
  project: string;
  title: string;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  lastPrompt: string | null;
  lastAssistant: string | null;
  userMessages: number;
  assistantMessages: number;
  subAgents: number;
  lastActivity: string; // ISO
  status: AgentStatus;
  transcriptPath: string;
}

export interface AgentScan {
  generatedAt: string;
  storeExists: boolean;
  storePath: string;
  sessions: AgentSession[];
  repos: GitState[];
}

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

function statusFromAge(ms: number): AgentStatus {
  const minutes = ms / 60_000;
  if (minutes < 5) return 'active';
  if (minutes < 120) return 'idle';
  return 'dormant';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join(' ')
      .trim();
  }
  return '';
}

/** Parse one transcript file into a session summary, or null if it has no real content. */
async function parseTranscript(
  project: string,
  filePath: string,
): Promise<AgentSession | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  let cwd: string | null = null;
  let branch: string | null = null;
  let model: string | null = null;
  let aiTitle: string | null = null;
  let firstUser: string | null = null;
  let lastPrompt: string | null = null;
  let lastAssistant: string | null = null;
  let userMessages = 0;
  let assistantMessages = 0;
  let lastTs: number | null = null;
  let sessionId = path.basename(filePath, '.jsonl');

  for (const line of lines) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
    if (typeof o.gitBranch === 'string') branch = o.gitBranch;
    if (typeof o.sessionId === 'string') sessionId = o.sessionId;
    if (typeof o.timestamp === 'string') {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) lastTs = lastTs === null ? t : Math.max(lastTs, t);
    }

    switch (o.type) {
      case 'ai-title':
        if (typeof o.aiTitle === 'string') aiTitle = o.aiTitle;
        break;
      case 'last-prompt':
        if (typeof o.lastPrompt === 'string') lastPrompt = o.lastPrompt;
        break;
      case 'user': {
        const msg = o.message as { content?: unknown } | undefined;
        if (msg) {
          const t = textOf(msg.content);
          // Skip tool-result-only user turns (no human text).
          if (t) {
            userMessages += 1;
            if (!firstUser) firstUser = t;
          }
        }
        break;
      }
      case 'assistant': {
        const msg = o.message as { content?: unknown; model?: unknown } | undefined;
        if (msg) {
          if (typeof msg.model === 'string') model = msg.model;
          const t = textOf(msg.content);
          if (t) {
            assistantMessages += 1;
            lastAssistant = t;
          }
        }
        break;
      }
    }
  }

  if (userMessages === 0 && assistantMessages === 0) return null;

  // Prefer the transcript file mtime as the activity clock — it always advances,
  // even for event types that carry no timestamp.
  let mtime = lastTs ?? 0;
  try {
    const st = await fs.stat(filePath);
    mtime = Math.max(mtime, st.mtimeMs);
  } catch {
    /* ignore */
  }

  // Count sub-agents spawned by this session (sibling <sessionId>/subagents dir).
  let subAgents = 0;
  try {
    const subDir = path.join(path.dirname(filePath), sessionId, 'subagents');
    const entries = await fs.readdir(subDir);
    subAgents = entries.filter((e) => e.endsWith('.jsonl')).length;
  } catch {
    /* no subagents */
  }

  const age = Date.now() - mtime;

  return {
    sessionId,
    project,
    title: aiTitle || firstUser || lastPrompt || '(untitled session)',
    cwd,
    branch,
    model,
    lastPrompt: lastPrompt || firstUser,
    lastAssistant,
    userMessages,
    assistantMessages,
    subAgents,
    lastActivity: new Date(mtime).toISOString(),
    status: statusFromAge(age),
    transcriptPath: filePath,
  };
}

async function gitText(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function readGitState(cwd: string): Promise<GitState> {
  const inside = await gitText(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return {
      cwd,
      branch: null,
      dirtyCount: 0,
      ahead: null,
      behind: null,
      hasUpstream: false,
      lastCommit: null,
      isRepo: false,
    };
  }

  const branch = await gitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = await gitText(cwd, ['status', '--porcelain']);
  const dirtyCount = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  const lastCommit = await gitText(cwd, ['log', '-1', '--format=%h %s']);

  // ahead/behind vs upstream — null when no upstream is configured.
  let ahead: number | null = null;
  let behind: number | null = null;
  let hasUpstream = false;
  const counts = await gitText(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  if (counts) {
    const [b, a] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      behind = b;
      ahead = a;
      hasUpstream = true;
    }
  }

  return { cwd, branch, dirtyCount, ahead, behind, hasUpstream, lastCommit, isRepo: true };
}

export async function scanAgents(): Promise<AgentScan> {
  const storePath = projectsRoot();
  const base: AgentScan = {
    generatedAt: new Date().toISOString(),
    storeExists: false,
    storePath,
    sessions: [],
    repos: [],
  };

  let projectDirs: string[];
  try {
    const entries = await fs.readdir(storePath, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return base; // store doesn't exist (e.g. production) — empty, not an error
  }
  base.storeExists = true;

  // Collect all top-level session transcripts across every project.
  const transcriptJobs: Promise<AgentSession | null>[] = [];
  for (const project of projectDirs) {
    if (project === 'memory') continue;
    const dir = path.join(storePath, project);
    let files: string[];
    try {
      const dirEntries = await fs.readdir(dir, { withFileTypes: true });
      files = dirEntries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => path.join(dir, e.name));
    } catch {
      continue;
    }
    for (const f of files) transcriptJobs.push(parseTranscript(project, f));
  }

  const sessions = (await Promise.all(transcriptJobs))
    .filter((s): s is AgentSession => s !== null)
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  // One git read per distinct working tree.
  const cwds = Array.from(
    new Set(sessions.map((s) => s.cwd).filter((c): c is string => !!c)),
  );
  const repos = await Promise.all(cwds.map(readGitState));

  return { ...base, sessions, repos };
}
