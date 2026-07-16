import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
  applySessionContact,
  completeSession,
  loadSessionView,
  skipSessionContact,
} from '@/lib/server/categorization-session';
import { saveCoaDraft, commitCoaDraft } from '@/lib/accounting/coa-draft';
import { parseCategorizationIntent } from '@/lib/ai/parse-categorization-intent';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 90;

const Body = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).max(2000),
  /** Workspace's current focused contact, if any. Narrows parser context. */
  focusedContactId: z.string().nullable().optional(),
});

// ── In-memory pending-proposals tracker ──────────────────────────────────
// Module-level map: sessionId → array of proposals awaiting user confirmation.
// Single-instance only; lost on server restart. Acceptable for v1 — proposals
// are interactive (live for seconds, minutes at most). If we move to multi-
// instance in production we'll persist this to the categorization_sessions
// row instead.
const PROPOSAL_TTL_MS = 10 * 60 * 1000;

interface PendingProposal {
  sessionContactId: string;
  contactName: string;
  proposedAccountId: string;
  proposedAccountLabel: string;
  rationale: string;
  proposedAt: number;
}

const pendingProposals = new Map<string, PendingProposal[]>();

function getPendingProposals(sessionId: string): PendingProposal[] {
  const list = pendingProposals.get(sessionId);
  if (!list) return [];
  const now = Date.now();
  const fresh = list.filter((p) => now - p.proposedAt < PROPOSAL_TTL_MS);
  if (fresh.length === 0) {
    pendingProposals.delete(sessionId);
    return [];
  }
  if (fresh.length !== list.length) pendingProposals.set(sessionId, fresh);
  return fresh;
}

function upsertPendingProposal(sessionId: string, proposal: PendingProposal): void {
  const list = getPendingProposals(sessionId);
  // Replace any existing proposal for the same contact — user might be
  // re-proposing with different reasoning before confirming.
  const filtered = list.filter((p) => p.sessionContactId !== proposal.sessionContactId);
  filtered.push(proposal);
  pendingProposals.set(sessionId, filtered);
}

function clearPendingProposalForContact(sessionId: string, sessionContactId: string): void {
  const list = pendingProposals.get(sessionId);
  if (!list) return;
  const filtered = list.filter((p) => p.sessionContactId !== sessionContactId);
  if (filtered.length === 0) pendingProposals.delete(sessionId);
  else pendingProposals.set(sessionId, filtered);
}

function clearAllPendingProposals(sessionId: string): void {
  pendingProposals.delete(sessionId);
}

/**
 * POST /api/categorization/intent
 *   body: { sessionId, message }
 *
 * Single-shot AI parse → server executes structured actions deterministically.
 * The AI never holds UUIDs or manages state. Server validates each parsed
 * action against the live session before executing.
 *
 * Response shape:
 *   {
 *     parse: { kind: 'actions' | 'unclear', narration?, clarifyingQuestion? },
 *     results: Array<{ kind, status: 'applied' | 'skipped' | 'created' | 'failed' | 'noop', message? }>,
 *     session: SessionView,
 *   }
 */
export async function POST(req: NextRequest) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  const { sessionId, message, focusedContactId } = parsed.data;

  // Load current session view + active accounts for the parse context.
  let sessionView;
  try {
    sessionView = await loadSessionView(sessionId, orgId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'load failed';
    if (msg === 'Session not found') return NextResponse.json({ error: msg }, { status: 404 });
    logger.error({ err: msg }, 'intent route: session load failed');
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const availableAccounts = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
    .orderBy(asc(chartOfAccounts.accountNumber));

  const pendingContacts = sessionView.contacts
    .filter((c) => c.status === 'pending' || c.status === 'failed')
    .map((c) => ({
      sessionContactId: c.id,
      contactName: c.contactName ?? '(no contact)',
      transactionCount: c.transactionCount,
      totalAmount: c.totalAmount,
      recommendationLabel: c.recommendationLabel,
      recommendedAccountId: c.recommendedAccountId,
    }));

  const pendingProposalSummary = getPendingProposals(sessionId).map((p) => ({
    sessionContactId: p.sessionContactId,
    contactName: p.contactName,
    proposedAccountLabel: p.proposedAccountLabel,
  }));

  const parseResult = await parseCategorizationIntent({
    userMessage: message,
    pendingContacts,
    availableAccounts,
    pendingProposalSummary,
    focusedContactId: focusedContactId ?? null,
    organizationId: orgId,
    actorUserId: user.id,
  });

  if (parseResult.kind === 'unclear') {
    return NextResponse.json({
      parse: { kind: 'unclear', clarifyingQuestion: parseResult.clarifyingQuestion },
      results: [],
      session: sessionView,
      pendingProposalContactIds: getPendingProposals(sessionId).map((p) => p.sessionContactId),
    });
  }

  // Execute actions in order. Each action validated against live session.
  const validSessionContactIds = new Set(sessionView.contacts.map((c) => c.id));
  const validAccountIds = new Set(availableAccounts.map((a) => a.id));
  const results: Array<{
    kind: string;
    status: 'applied' | 'skipped' | 'created' | 'proposed' | 'failed' | 'noop';
    contactName?: string;
    accountName?: string;
    accountLabel?: string;
    rationale?: string;
    message?: string;
  }> = [];

  let sessionMarkedComplete = false;
  for (const action of parseResult.actions) {
    if (action.kind === 'show-remaining') {
      results.push({ kind: 'show-remaining', status: 'noop' });
      continue;
    }
    if (action.kind === 'session-complete') {
      try {
        await completeSession({ organizationId: orgId, sessionId });
        sessionMarkedComplete = true;
        clearAllPendingProposals(sessionId);
        results.push({ kind: 'session-complete', status: 'applied' });
      } catch (err) {
        results.push({
          kind: 'session-complete',
          status: 'failed',
          message: err instanceof Error ? err.message : 'failed',
        });
      }
      continue;
    }

    // confirm-pending: execute every stored proposal for this session via
    // applySessionContact.
    if (action.kind === 'confirm-pending') {
      const pending = getPendingProposals(sessionId);
      if (pending.length === 0) {
        results.push({
          kind: 'confirm-pending',
          status: 'failed',
          message: "Nothing pending to confirm — tell me what to categorize.",
        });
        continue;
      }
      for (const p of pending) {
        const apply = await applySessionContact({
          organizationId: orgId,
          sessionId,
          sessionContactId: p.sessionContactId,
          accountIdCandidate: p.proposedAccountId,
          source: 'ai',
        });
        results.push(
          apply.ok
            ? {
                kind: 'categorize',
                status: 'applied',
                contactName: p.contactName,
                accountName: apply.appliedAccountName,
              }
            : {
                kind: 'categorize',
                status: 'failed',
                contactName: p.contactName,
                message: apply.error,
              },
        );
      }
      clearAllPendingProposals(sessionId);
      continue;
    }

    if (!validSessionContactIds.has(action.sessionContactId)) {
      results.push({
        kind: action.kind,
        status: 'failed',
        contactName: action.contactNameMatched,
        message: `Contact "${action.contactNameMatched}" doesn't match any pending contact in this session.`,
      });
      continue;
    }

    if (action.kind === 'skip') {
      // User decided to skip — supersedes any pending proposal for this contact.
      clearPendingProposalForContact(sessionId, action.sessionContactId);
      try {
        await skipSessionContact({ sessionId, sessionContactId: action.sessionContactId });
        results.push({
          kind: 'skip',
          status: 'skipped',
          contactName: action.contactNameMatched,
        });
      } catch (err) {
        results.push({
          kind: 'skip',
          status: 'failed',
          contactName: action.contactNameMatched,
          message: err instanceof Error ? err.message : 'failed',
        });
      }
      continue;
    }

    if (action.kind === 'propose-categorize') {
      // Validate the proposed account exists in the org's CoA. The parser is
      // supposed to pick from AVAILABLE only, but we don't trust the LLM —
      // verify before storing.
      if (!validAccountIds.has(action.proposedAccountId)) {
        results.push({
          kind: 'propose-categorize',
          status: 'failed',
          contactName: action.contactNameMatched,
          message: `Suggested account doesn't exist — try naming it explicitly.`,
        });
        continue;
      }
      upsertPendingProposal(sessionId, {
        sessionContactId: action.sessionContactId,
        contactName: action.contactNameMatched,
        proposedAccountId: action.proposedAccountId,
        proposedAccountLabel: action.proposedAccountLabel,
        rationale: action.rationale,
        proposedAt: Date.now(),
      });
      results.push({
        kind: 'propose-categorize',
        status: 'proposed',
        contactName: action.contactNameMatched,
        accountLabel: action.proposedAccountLabel,
        rationale: action.rationale,
      });
      continue;
    }

    if (action.kind === 'categorize') {
      // Explicit user action supersedes any pending proposal for this contact.
      clearPendingProposalForContact(sessionId, action.sessionContactId);
      const apply = await applySessionContact({
        organizationId: orgId,
        sessionId,
        sessionContactId: action.sessionContactId,
        accountIdCandidate: action.accountIdHint,
        source: 'manual',
      });
      results.push(
        apply.ok
          ? {
              kind: 'categorize',
              status: 'applied',
              contactName: action.contactNameMatched,
              accountName: apply.appliedAccountName,
            }
          : {
              kind: 'categorize',
              status: 'failed',
              contactName: action.contactNameMatched,
              message: apply.error,
            },
      );
      continue;
    }

    if (action.kind === 'create-account-and-categorize') {
      clearPendingProposalForContact(sessionId, action.sessionContactId);
      try {
        const draft = await saveCoaDraft({
          organizationId: orgId,
          accountName: action.proposed.accountName,
          accountNumber: action.proposed.accountNumber,
          gaapType: action.proposed.gaapType,
          description: action.proposed.description,
        });
        if (draft.conflicts.length > 0) {
          results.push({
            kind: 'create-account-and-categorize',
            status: 'failed',
            contactName: action.contactNameMatched,
            message: draft.conflicts.map((c) => c.message).join(' '),
          });
          continue;
        }
        const committed = await commitCoaDraft({ organizationId: orgId, draftId: draft.draftId });
        if (committed.status !== 'committed' || !committed.committedAccountId) {
          results.push({
            kind: 'create-account-and-categorize',
            status: 'failed',
            contactName: action.contactNameMatched,
            message: committed.conflicts[0]?.message ?? 'commit failed',
          });
          continue;
        }
        const apply = await applySessionContact({
          organizationId: orgId,
          sessionId,
          sessionContactId: action.sessionContactId,
          accountIdCandidate: committed.committedAccountId,
          source: 'manual',
        });
        results.push(
          apply.ok
            ? {
                kind: 'create-account-and-categorize',
                status: 'created',
                contactName: action.contactNameMatched,
                accountName: apply.appliedAccountName,
              }
            : {
                kind: 'create-account-and-categorize',
                status: 'failed',
                contactName: action.contactNameMatched,
                message: apply.error,
              },
        );
      } catch (err) {
        results.push({
          kind: 'create-account-and-categorize',
          status: 'failed',
          contactName: action.contactNameMatched,
          message: err instanceof Error ? err.message : 'failed',
        });
      }
      continue;
    }
  }

  // Auto-complete: if no pending rows remain and the user didn't explicitly
  // say "I'm done", leave the session active. The UI surfaces the remaining
  // counts and the user can complete deliberately.
  void sessionMarkedComplete;

  // Forensic log of every parsed action's kind plus the truncated user input.
  // Closes the visibility gap that left us guessing about parser behavior on
  // the Nexus / "loans" sequence.
  logger.info(
    {
      sessionId,
      kinds: parseResult.actions.map((a) => a.kind),
      resultStatuses: results.map((r) => `${r.kind}:${r.status}`),
      userMessage: message.slice(0, 200),
    },
    'intent parse result',
  );

  const updated = await loadSessionView(sessionId, orgId);
  return NextResponse.json({
    parse: { kind: 'actions', narration: parseResult.narration },
    results,
    session: updated,
    // Drives focus mode on the client. Empty array → focus exits.
    pendingProposalContactIds: getPendingProposals(sessionId).map((p) => p.sessionContactId),
  });
}
