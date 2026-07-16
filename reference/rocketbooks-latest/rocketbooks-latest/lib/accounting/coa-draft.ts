import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { resolveAccount } from './resolve-account';
import { logger } from '@/lib/logger';

// Canonical gaapType values, matching the enum in app/(app)/chart-of-accounts/_actions/createAccount.ts
const DEBIT_TYPES = [
  'asset',
  'current_asset',
  'fixed_asset',
  'other_asset',
  'expense',
  'cost_of_goods_sold',
  'other_expense',
];
const CREDIT_TYPES = [
  'liability',
  'current_liability',
  'long_term_liability',
  'other_liability',
  'equity',
  'revenue',
  'income',
  'other_income',
];
const VALID_GAAP_TYPES = new Set([...DEBIT_TYPES, ...CREDIT_TYPES]);

// Catches the rename-after-commit pattern: user creates an account,
// then within the same turn says "actually call it X" — AI mistakenly
// starts a fresh draft instead of treating the rename as a no-op.
// 60s is generous enough to catch real rename intent, short enough
// not to interfere with legitimate "create another similar account"
// workflows. Tunable.
const RECENT_COMMITS_TTL_MS = 60_000;

interface RecentCommit {
  accountId: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
  committedAt: number;
}

// In-memory per-org tracker. Production with multiple Next.js instances has
// separate maps per instance; the rename-after-commit pattern unfolds in
// seconds and back-to-back calls almost certainly land on the same instance.
// Worst case if state is lost: this guard doesn't fire and the prompt rule
// is the only line of defense.
const recentCommits = new Map<string, RecentCommit[]>();

function trackRecentCommit(orgId: string, c: RecentCommit): void {
  const list = recentCommits.get(orgId) ?? [];
  list.push(c);
  recentCommits.set(orgId, list);
}

function getFreshRecentCommits(orgId: string): RecentCommit[] {
  const list = recentCommits.get(orgId);
  if (!list) return [];
  const now = Date.now();
  const fresh = list.filter((c) => now - c.committedAt < RECENT_COMMITS_TTL_MS);
  if (fresh.length === 0) {
    recentCommits.delete(orgId);
    return [];
  }
  if (fresh.length !== list.length) recentCommits.set(orgId, fresh);
  return fresh;
}

export interface CoaDraftConflict {
  kind:
    | 'duplicate-number'
    | 'duplicate-name'
    | 'parent-not-found'
    | 'invalid-gaap-type'
    | 'recently-committed';
  message: string;
  suggestedNumber?: string;
  existingAccount?: { id: string; accountNumber: string; accountName: string; gaapType?: string };
}

export interface CoaDraftSnapshot {
  draftId: string;
  status: 'draft' | 'committed';
  committedAccountId: string | null;
  accountName: string;
  accountNumber: string;
  gaapType: string;
  normalBalance: 'debit' | 'credit';
  parentAccount: { id: string; accountNumber: string; accountName: string } | null;
  description: string | null;
  accountType: string | null;
  conflicts: CoaDraftConflict[];
}

export interface SaveCoaDraftInput {
  organizationId: string;
  draftId?: string;
  accountName: string;
  accountNumber: string;
  gaapType: string;
  parentAccountName?: string;
  /** Free-form rationale. Stored in chart_of_accounts.definition (the schema's
   * description-equivalent column — name mismatch is intentional, see comment below). */
  description?: string;
  accountType?: string;
}

/**
 * Derive normal balance from gaapType. Equity defaults to credit, but the
 * standard contra-equity case (Owner's Draw / Drawing) flips to debit. Other
 * contras (Accumulated Depreciation = asset+credit, Sales Returns = revenue+debit)
 * are not auto-handled in v1 — the user can override verbally if needed.
 */
function deriveNormalBalance(gaapType: string, accountName: string): 'debit' | 'credit' {
  const t = gaapType.toLowerCase();
  if (t === 'equity' && /\b(draw|drawing|drawings)\b/i.test(accountName)) {
    return 'debit';
  }
  return DEBIT_TYPES.includes(t) ? 'debit' : 'credit';
}

/**
 * Suggest the smallest unused 4-digit account number ≥ candidate within the
 * same first-digit family (1xxx assets, 2xxx liabilities, 3xxx equity, etc.).
 * Returns null if the candidate isn't a 4-digit number or no slot is free.
 */
async function findNextAvailableNumber(orgId: string, candidate: string): Promise<string | null> {
  if (!/^\d{4}$/.test(candidate)) return null;
  const firstDigit = candidate[0];
  const startNum = parseInt(candidate, 10);
  const rangeEnd = parseInt(firstDigit + '999', 10);

  const taken = await db
    .select({ accountNumber: chartOfAccounts.accountNumber })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.organizationId, orgId),
        sql`${chartOfAccounts.accountNumber} ~ '^[0-9]{4}$'`,
        sql`${chartOfAccounts.accountNumber} >= ${candidate}`,
        sql`${chartOfAccounts.accountNumber} <= ${firstDigit + '999'}`,
      ),
    );
  const takenSet = new Set(taken.map((r) => r.accountNumber));

  for (let n = startNum; n <= rangeEnd; n++) {
    const next = String(n).padStart(4, '0');
    if (!takenSet.has(next)) return next;
  }
  return null;
}

async function snapshot(
  orgId: string,
  draftId: string,
  conflicts: CoaDraftConflict[] = [],
): Promise<CoaDraftSnapshot | null> {
  const [row] = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      normalBalance: chartOfAccounts.normalBalance,
      accountType: chartOfAccounts.accountType,
      parentAccountId: chartOfAccounts.parentAccountId,
      definition: chartOfAccounts.definition,
      isActive: chartOfAccounts.isActive,
      isTemporary: chartOfAccounts.isTemporary,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, draftId), eq(chartOfAccounts.organizationId, orgId)))
    .limit(1);
  if (!row) return null;

  const [parent] = row.parentAccountId
    ? await db
        .select({
          id: chartOfAccounts.id,
          accountNumber: chartOfAccounts.accountNumber,
          accountName: chartOfAccounts.accountName,
        })
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.id, row.parentAccountId))
        .limit(1)
    : [];

  const isCommitted = row.isActive === true && row.isTemporary !== true;
  return {
    draftId: row.id,
    status: isCommitted ? 'committed' : 'draft',
    committedAccountId: isCommitted ? row.id : null,
    accountName: row.accountName,
    accountNumber: row.accountNumber,
    gaapType: row.gaapType,
    normalBalance: row.normalBalance as 'debit' | 'credit',
    parentAccount: parent
      ? { id: parent.id, accountNumber: parent.accountNumber, accountName: parent.accountName }
      : null,
    // Schema column is `definition`; AI-facing API calls it `description`.
    // Alias intentional — `definition` is the existing-data field; keep
    // legacy data accessible while exposing a clearer name to the AI.
    description: row.definition,
    accountType: row.accountType,
    conflicts,
  };
}

export async function saveCoaDraft(input: SaveCoaDraftInput): Promise<CoaDraftSnapshot> {
  const orgId = input.organizationId;
  const conflicts: CoaDraftConflict[] = [];

  const gaapType = input.gaapType.toLowerCase();
  if (!VALID_GAAP_TYPES.has(gaapType)) {
    throw new Error(
      `Invalid gaapType "${input.gaapType}". Must be one of: ${[...VALID_GAAP_TYPES].join(', ')}`,
    );
  }

  // Recently-committed guard. Refuses to start a new draft (no draftId)
  // whose accountNumber or accountName matches an account this org committed
  // in the last 60s. Surfaces a conflict so the AI narrates the limitation
  // rather than silently creating a duplicate. Only fires for new drafts —
  // updates to existing drafts (with draftId) bypass this check.
  if (!input.draftId) {
    const recent = getFreshRecentCommits(orgId);
    const candidateNameLower = input.accountName.toLowerCase();
    const collision = recent.find(
      (c) =>
        c.accountNumber === input.accountNumber ||
        c.accountName.toLowerCase() === candidateNameLower,
    );
    if (collision) {
      return {
        draftId: '',
        status: 'draft',
        committedAccountId: null,
        accountName: input.accountName,
        accountNumber: input.accountNumber,
        gaapType,
        normalBalance: deriveNormalBalance(gaapType, input.accountName),
        parentAccount: null,
        description: input.description ?? null,
        accountType: input.accountType ?? null,
        conflicts: [
          {
            kind: 'recently-committed',
            message: `Account already created in this session ("${collision.accountNumber} - ${collision.accountName}"). To rename, edit the chart of accounts directly.`,
            existingAccount: {
              id: collision.accountId,
              accountNumber: collision.accountNumber,
              accountName: collision.accountName,
              gaapType: collision.gaapType,
            },
          },
        ],
      };
    }
  }

  // Resolve parent if provided. Non-fatal — surface as conflict and continue.
  let parentAccountId: string | null = null;
  if (input.parentAccountName) {
    const parent = await resolveAccount(orgId, input.parentAccountName);
    if (parent) {
      parentAccountId = parent.id;
    } else {
      conflicts.push({
        kind: 'parent-not-found',
        message: `Parent account "${input.parentAccountName}" not found in this organization. Saving draft without a parent.`,
      });
    }
  }

  // Duplicate account-number check. Allow the draft itself to keep its number on update.
  const numberCollisions = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.accountNumber, input.accountNumber),
        eq(chartOfAccounts.isActive, true),
      ),
    )
    .limit(1);
  const numberCollision = numberCollisions[0];
  if (numberCollision && numberCollision.id !== input.draftId) {
    const suggested = await findNextAvailableNumber(orgId, input.accountNumber);
    conflicts.push({
      kind: 'duplicate-number',
      message: `Account number ${input.accountNumber} is already used by "${numberCollision.accountName}".${
        suggested ? ` Try ${suggested}.` : ''
      }`,
      suggestedNumber: suggested ?? undefined,
      existingAccount: numberCollision,
    });
  }

  // Server-side name dedup within same gaapType. Catches "Owner's Draws" vs
  // "Owner's Draw" before the AI's near-match check fails.
  const candidateName = input.accountName.toLowerCase();
  if (candidateName.length >= 4) {
    const sameTypeAccounts = await db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
      })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.organizationId, orgId),
          eq(chartOfAccounts.gaapType, gaapType),
          eq(chartOfAccounts.isActive, true),
        ),
      );
    for (const a of sameTypeAccounts) {
      if (a.id === input.draftId) continue;
      const existingName = a.accountName.toLowerCase();
      if (
        existingName.length >= 4 &&
        (existingName.includes(candidateName) || candidateName.includes(existingName))
      ) {
        conflicts.push({
          kind: 'duplicate-name',
          message: `An existing ${gaapType} account looks similar: "${a.accountNumber} - ${a.accountName}". Use that instead, or differentiate the name.`,
          existingAccount: a,
        });
        break;
      }
    }
  }

  const normalBalance = deriveNormalBalance(gaapType, input.accountName);

  let id = input.draftId;
  if (!id) {
    id = randomUUID();
    await db.insert(chartOfAccounts).values({
      id,
      organizationId: orgId,
      accountNumber: input.accountNumber,
      accountName: input.accountName,
      gaapType,
      accountType: input.accountType ?? null,
      parentAccountId,
      normalBalance,
      isActive: false,
      isTemporary: true,
      createdByAi: true,
      systemGenerated: false,
      needsReview: false,
      definition: input.description ?? null,
      passedNameContactCheck: true,
    });
  } else {
    const [existing] = await db
      .select({ isActive: chartOfAccounts.isActive, isTemporary: chartOfAccounts.isTemporary })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, id), eq(chartOfAccounts.organizationId, orgId)))
      .limit(1);
    if (!existing) throw new Error('Draft account not found');
    const isCommitted = existing.isActive === true && existing.isTemporary !== true;
    if (isCommitted) throw new Error('Cannot edit a committed account');
    await db
      .update(chartOfAccounts)
      .set({
        accountNumber: input.accountNumber,
        accountName: input.accountName,
        gaapType,
        accountType: input.accountType ?? null,
        parentAccountId,
        normalBalance,
        definition: input.description ?? null,
      })
      .where(eq(chartOfAccounts.id, id));
  }

  const snap = await snapshot(orgId, id, conflicts);
  if (!snap) throw new Error('Failed to read draft after save');
  return snap;
}

export async function commitCoaDraft(args: {
  organizationId: string;
  draftId: string;
}): Promise<CoaDraftSnapshot> {
  const orgId = args.organizationId;

  const [row] = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      isActive: chartOfAccounts.isActive,
      isTemporary: chartOfAccounts.isTemporary,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, args.draftId), eq(chartOfAccounts.organizationId, orgId)))
    .limit(1);
  if (!row) throw new Error('Draft account not found');

  const isAlreadyCommitted = row.isActive === true && row.isTemporary !== true;
  if (isAlreadyCommitted) {
    const snap = await snapshot(orgId, args.draftId);
    if (!snap) throw new Error('Failed to read committed account');
    return snap;
  }

  // Last-mile duplicate-number recheck — protects against a concurrent commit
  // grabbing the same number between save and commit.
  const conflicts: CoaDraftConflict[] = [];
  const [conflictRow] = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.accountNumber, row.accountNumber),
        eq(chartOfAccounts.isActive, true),
      ),
    )
    .limit(1);
  if (conflictRow && conflictRow.id !== row.id) {
    const suggested = await findNextAvailableNumber(orgId, row.accountNumber);
    conflicts.push({
      kind: 'duplicate-number',
      message: `Account number ${row.accountNumber} is now used by "${conflictRow.accountName}".${
        suggested ? ` Try ${suggested}.` : ''
      }`,
      suggestedNumber: suggested ?? undefined,
      existingAccount: conflictRow,
    });
    const snap = await snapshot(orgId, args.draftId, conflicts);
    if (!snap) throw new Error('Failed to read draft after conflict');
    return snap;
  }

  await db
    .update(chartOfAccounts)
    .set({ isActive: true, isTemporary: false })
    .where(eq(chartOfAccounts.id, args.draftId));

  trackRecentCommit(orgId, {
    accountId: row.id,
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    gaapType: row.gaapType,
    committedAt: Date.now(),
  });

  logger.info(
    {
      tool: 'commit_chart_of_account_entry',
      accountId: args.draftId,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
      gaapType: row.gaapType,
    },
    'CoA account committed',
  );

  const snap = await snapshot(orgId, args.draftId);
  if (!snap) throw new Error('Failed to read account after commit');
  return snap;
}

export async function cancelCoaDraft(args: {
  organizationId: string;
  draftId: string;
}): Promise<{ ok: boolean }> {
  const [row] = await db
    .select({ isActive: chartOfAccounts.isActive, isTemporary: chartOfAccounts.isTemporary })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, args.draftId), eq(chartOfAccounts.organizationId, args.organizationId)))
    .limit(1);
  if (!row) return { ok: false };
  const isCommitted = row.isActive === true && row.isTemporary !== true;
  if (isCommitted) throw new Error('Cannot cancel a committed account');
  await db.delete(chartOfAccounts).where(eq(chartOfAccounts.id, args.draftId));
  return { ok: true };
}
