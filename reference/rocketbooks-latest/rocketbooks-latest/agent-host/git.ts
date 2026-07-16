import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitState {
  isRepo: boolean;
  branch: string | null;
  /** uncommitted (working tree + staged) file count */
  dirty: number;
  /** commits on HEAD not yet pushed to upstream */
  ahead: number | null;
  /** commits on upstream not yet local */
  behind: number | null;
  hasUpstream: boolean;
  lastCommit: string | null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
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

const NOT_A_REPO: GitState = {
  isRepo: false,
  branch: null,
  dirty: 0,
  ahead: null,
  behind: null,
  hasUpstream: false,
  lastCommit: null,
};

/** Read a compact git status for a working directory. Never throws. */
export async function readGitState(cwd: string): Promise<GitState> {
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return NOT_A_REPO;

  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = await git(cwd, ['status', '--porcelain']);
  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  const lastCommit = await git(cwd, ['log', '-1', '--format=%h %s']);

  let ahead: number | null = null;
  let behind: number | null = null;
  let hasUpstream = false;
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  if (counts) {
    const [b, a] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      behind = b;
      ahead = a;
      hasUpstream = true;
    }
  }

  return { isRepo: true, branch, dirty, ahead, behind, hasUpstream, lastCommit };
}
