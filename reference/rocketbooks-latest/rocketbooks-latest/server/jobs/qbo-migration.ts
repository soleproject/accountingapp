import 'server-only';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import {
  qboMigrationJobs,
  qboAccountStaging,
  qboCustomerStaging,
  qboVendorStaging,
  qboInvoiceStaging,
  qboBillStaging,
  qboPaymentStaging,
  qboBillPaymentStaging,
  qboPurchaseStaging,
  qboDepositStaging,
  qboTransferStaging,
  qboJournalEntryStaging,
} from '@/db/schema/schema';
import { qboFetch, QboApiError, QboNotConnectedError } from '@/lib/qbo/client';
import {
  promoteAccounts,
  promoteContacts,
  promoteInvoices,
  promoteBills,
  promotePayments,
  promoteBillPayments,
  promotePurchases,
  promoteDeposits,
  promoteTransfers,
  promoteJournalEntries,
  type PromoteResult,
} from '@/lib/qbo/promote/promoter';
import { relabelClaimedSeeds } from '@/lib/qbo/promote/relabel-claimed-seeds';
import { finalizeCoaAfterQb } from '@/lib/qbo/promote/finalize-coa-after-qb';
import { logger } from '@/lib/logger';

const PAGE_SIZE = 1000;

interface QueryEnvelope<T> {
  QueryResponse: { startPosition?: number; maxResults?: number } & Record<string, T[] | number | undefined>;
}

interface QboRefName {
  value: string;
  name?: string;
}

interface QboAccount {
  Id: string;
  Name: string;
  AccountType: string;
  AccountSubType?: string;
  FullyQualifiedName?: string;
  Active: boolean;
}

interface QboParty {
  Id: string;
  DisplayName: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
}

interface QboInvoice {
  Id: string;
  CustomerRef?: QboRefName;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt: number;
  Balance: number;
}

interface QboBill {
  Id: string;
  VendorRef?: QboRefName;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt: number;
  Balance: number;
}

interface QboPayment {
  Id: string;
  CustomerRef?: QboRefName;
  TotalAmt: number;
  TxnDate?: string;
}

interface QboBillPayment {
  Id: string;
  VendorRef?: QboRefName;
  TotalAmt: number;
  TxnDate?: string;
}

interface QboPurchase {
  Id: string;
  AccountRef?: QboRefName;
  EntityRef?: { value: string; type?: string; name?: string };
  TotalAmt: number;
  TxnDate?: string;
}

interface QboDeposit {
  Id: string;
  DepositToAccountRef?: QboRefName;
  TotalAmt: number;
  TxnDate?: string;
}

interface QboTransfer {
  Id: string;
  FromAccountRef?: QboRefName;
  ToAccountRef?: QboRefName;
  Amount: number;
  TxnDate?: string;
}

interface QboJournalEntry {
  Id: string;
  DocNumber?: string;
  TotalAmt?: number;
  TxnDate?: string;
}

type EntityKey =
  | 'Account' | 'Customer' | 'Vendor'
  | 'Invoice' | 'Bill' | 'Payment' | 'BillPayment'
  | 'Purchase' | 'Deposit' | 'Transfer' | 'JournalEntry';

interface EntitySummary {
  fetched: number;
  errored: boolean;
  errorMessage?: string;
}

/**
 * Fetch ONE page of a QBO entity via the Query API. STARTPOSITION is 1-based,
 * NOT 0-based. QBO caps page size at 1000. Returns just this page's rows so the
 * caller can persist page-by-page (see the per-page step loop below).
 */
async function fetchPage<T>(orgId: string, entity: EntityKey, startPosition: number): Promise<T[]> {
  const query = `SELECT * FROM ${entity} STARTPOSITION ${startPosition} MAXRESULTS ${PAGE_SIZE}`;
  const res = await qboFetch<QueryEnvelope<T>>(orgId, '/query', { query: { query } });
  return (res.QueryResponse?.[entity] as T[] | undefined) ?? [];
}

/**
 * Persist one page of an entity into its staging table. The column mapping per
 * entity is intentionally explicit (each QBO type has different fields). Random
 * UUID PKs: on resume only a *failed* page re-runs, and a failed page's insert
 * didn't commit (it's the last awaited op), so this stays effectively
 * idempotent without a natural-key constraint.
 */
async function insertPage(
  entity: EntityKey,
  rows: unknown[],
  jobId: string,
  realmId: string,
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  switch (entity) {
    case 'Account':
      await db.insert(qboAccountStaging).values(
        (rows as QboAccount[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          name: r.Name,
          type: r.AccountType,
          subtype: r.AccountSubType ?? null,
          fullyQualifiedName: r.FullyQualifiedName ?? null,
          isActive: r.Active,
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'Customer':
      await db.insert(qboCustomerStaging).values(
        (rows as QboParty[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          displayName: r.DisplayName,
          primaryEmail: r.PrimaryEmailAddr?.Address ?? null,
          primaryPhone: r.PrimaryPhone?.FreeFormNumber ?? null,
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'Vendor':
      await db.insert(qboVendorStaging).values(
        (rows as QboParty[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          displayName: r.DisplayName,
          primaryEmail: r.PrimaryEmailAddr?.Address ?? null,
          primaryPhone: r.PrimaryPhone?.FreeFormNumber ?? null,
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'Invoice':
      await db.insert(qboInvoiceStaging).values(
        (rows as QboInvoice[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          customerQboId: r.CustomerRef?.value ?? null,
          txnDate: r.TxnDate ?? null,
          dueDate: r.DueDate ?? null,
          totalAmount: String(r.TotalAmt ?? 0),
          balance: String(r.Balance ?? 0),
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'Bill':
      await db.insert(qboBillStaging).values(
        (rows as QboBill[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          vendorQboId: r.VendorRef?.value ?? null,
          txnDate: r.TxnDate ?? null,
          dueDate: r.DueDate ?? null,
          totalAmount: String(r.TotalAmt ?? 0),
          balance: String(r.Balance ?? 0),
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'Payment':
      await db.insert(qboPaymentStaging).values(
        (rows as QboPayment[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          customerQboId: r.CustomerRef?.value ?? null,
          totalAmount: String(r.TotalAmt ?? 0),
          txnDate: r.TxnDate ?? null,
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'BillPayment':
      await db.insert(qboBillPaymentStaging).values(
        (rows as QboBillPayment[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          vendorQboId: r.VendorRef?.value ?? null,
          totalAmount: String(r.TotalAmt ?? 0),
          txnDate: r.TxnDate ?? null,
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'Purchase':
      await db.insert(qboPurchaseStaging).values(
        (rows as QboPurchase[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          accountQboId: r.AccountRef?.value ?? null,
          // EntityRef can be Vendor / Employee / Customer; only record vendor
          // id, leave null otherwise. Promote handles the contact lookup
          // defensively.
          vendorQboId: r.EntityRef?.type === 'Vendor' ? r.EntityRef.value : null,
          totalAmount: String(r.TotalAmt ?? 0),
          txnDate: r.TxnDate ?? null,
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'Deposit':
      await db.insert(qboDepositStaging).values(
        (rows as QboDeposit[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          depositToAccountQboId: r.DepositToAccountRef?.value ?? null,
          totalAmount: String(r.TotalAmt ?? 0),
          txnDate: r.TxnDate ?? null,
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'Transfer':
      await db.insert(qboTransferStaging).values(
        (rows as QboTransfer[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          fromAccountQboId: r.FromAccountRef?.value ?? null,
          toAccountQboId: r.ToAccountRef?.value ?? null,
          amount: String(r.Amount ?? 0),
          txnDate: r.TxnDate ?? null,
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
    case 'JournalEntry':
      await db.insert(qboJournalEntryStaging).values(
        (rows as QboJournalEntry[]).map((r) => ({
          id: randomUUID(),
          migrationJobId: jobId,
          realmId,
          rawQboId: r.Id,
          docNumber: r.DocNumber ?? null,
          totalAmount: String(r.TotalAmt ?? 0),
          txnDate: r.TxnDate ?? null,
          rawJson: r as unknown as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return;
  }
}

export const qboMigration = inngest.createFunction(
  {
    id: 'qbo-migration',
    // One migration per org at a time — re-trigger while running is a no-op
    // by Inngest, no double-pull. Keyed on org rather than realm because a
    // single org could connect multiple realms over time but it's still one
    // workspace's worth of work to coordinate.
    concurrency: { limit: 1, key: 'event.data.organizationId' },
    retries: 2,
    triggers: [{ event: 'qbo/migration.requested' }],
  },
  async ({ event, step }) => {
    const { organizationId, realmId, userId } = event.data as {
      organizationId: string;
      realmId: string;
      userId: string;
    };

    const jobId = await step.run('create-job-row', async () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.insert(qboMigrationJobs).values({
        id,
        userId,
        orgId: organizationId,
        realmId,
        status: 'running',
        progress: 0,
        createdAt: now,
        updatedAt: now,
      });
      return id;
    });

    logger.info({ jobId, organizationId, realmId }, 'qbo migration starting');

    const entities: EntityKey[] = [
      'Account', 'Customer', 'Vendor',
      'Invoice', 'Bill', 'Payment', 'BillPayment',
      'Purchase', 'Deposit', 'Transfer', 'JournalEntry',
    ];
    const summary: Record<EntityKey, EntitySummary> = {
      Account: { fetched: 0, errored: false },
      Customer: { fetched: 0, errored: false },
      Vendor: { fetched: 0, errored: false },
      Invoice: { fetched: 0, errored: false },
      Bill: { fetched: 0, errored: false },
      Payment: { fetched: 0, errored: false },
      BillPayment: { fetched: 0, errored: false },
      Purchase: { fetched: 0, errored: false },
      Deposit: { fetched: 0, errored: false },
      Transfer: { fetched: 0, errored: false },
      JournalEntry: { fetched: 0, errored: false },
    };

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      let fetched = 0;
      try {
        // Page-per-step: each step pulls AND persists exactly one page, so no
        // single step can exceed maxDuration no matter how large the account.
        // Inngest checkpoints after every page, so a failure (timeout, 429,
        // transient API error) resumes from the next page rather than
        // restarting the entity from page 1. Completed pages are memoized and
        // never re-pulled.
        let startPosition = 1;
        let pageNum = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          pageNum++;
          const startAt = startPosition;
          const count: number = await step.run(
            `pull-${entity.toLowerCase()}-p${pageNum}`,
            async () => {
              const rows = await fetchPage<unknown>(organizationId, entity, startAt);
              await insertPage(entity, rows, jobId, realmId);
              return rows.length;
            },
          );
          fetched += count;
          if (count < PAGE_SIZE) break;
          startPosition += PAGE_SIZE;
        }
        summary[entity] = { fetched, errored: false };
      } catch (err) {
        // Permissions gaps and transient API errors shouldn't kill the whole
        // migration — record the entity-level failure and keep going. Any
        // pages persisted before the failure are kept. QboNotConnectedError is
        // fatal though — without a token we can't do anything else.
        if (err instanceof QboNotConnectedError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ jobId, entity, fetched, err: msg }, 'qbo migration entity failed; continuing');
        summary[entity] = {
          fetched,
          errored: true,
          errorMessage: err instanceof QboApiError ? `QBO ${err.status}: ${msg}` : msg.slice(0, 500),
        };
      }

      // Pull phase covers 0-50% of progress; promote phase fills 50-100.
      // Each entity pull is one unit of `entities.length`.
      await step.run(`progress-pull-${entity.toLowerCase()}`, async () =>
        db
          .update(qboMigrationJobs)
          .set({
            progress: Math.round(((i + 1) / entities.length) * 50),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(qboMigrationJobs.id, jobId)),
      );
    }

    // Promote phase: staging → live tables. Strict dependency order — each
    // step is its own checkpoint so a failure (e.g. unique constraint
    // violation surfaced by an unmapped reference) only forces that single
    // step to retry. promote* helpers are idempotent via qboEntityMap so
    // re-running a step after partial success is safe.
    const promoteCtx = { organizationId, realmId, migrationJobId: jobId };
    const promoteSummary: Record<string, PromoteResult> = {};
    const promoteSteps = [
      'accounts', 'relabelClaimedSeeds', 'finalizeCoa', 'contacts',
      'invoices', 'bills', 'payments', 'billPayments',
      'purchases', 'deposits', 'transfers', 'journalEntries',
    ] as const;

    for (let i = 0; i < promoteSteps.length; i++) {
      const phase = promoteSteps[i];
      try {
        promoteSummary[phase] = await step.run(`promote-${phase}`, async () => {
          switch (phase) {
            case 'accounts':            return promoteAccounts(promoteCtx);
            case 'relabelClaimedSeeds': return relabelClaimedSeeds(promoteCtx);
            case 'finalizeCoa':         return finalizeCoaAfterQb(promoteCtx);
            case 'contacts':       return promoteContacts(promoteCtx);
            case 'invoices':       return promoteInvoices(promoteCtx);
            case 'bills':          return promoteBills(promoteCtx);
            case 'payments':       return promotePayments(promoteCtx);
            case 'billPayments':   return promoteBillPayments(promoteCtx);
            case 'purchases':      return promotePurchases(promoteCtx);
            case 'deposits':       return promoteDeposits(promoteCtx);
            case 'transfers':      return promoteTransfers(promoteCtx);
            case 'journalEntries': return promoteJournalEntries(promoteCtx);
          }
        });
      } catch (err) {
        // Don't let one bad promote phase abort the rest. Record it and
        // keep going so partial promotion is still visible to the user.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ jobId, phase, err: msg }, 'qbo promote phase failed; continuing');
        promoteSummary[phase] = { created: 0, skipped: 0, errored: -1 };
      }

      await step.run(`progress-promote-${phase}`, async () =>
        db
          .update(qboMigrationJobs)
          .set({
            progress: 50 + Math.round(((i + 1) / promoteSteps.length) * 50),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(qboMigrationJobs.id, jobId)),
      );
    }

    // Cross-source de-duplication (QBO = source of truth). If this org already
    // held Plaid/Veryfi rows before the QBO import, the just-promoted QBO rows
    // outrank them — demote the exact same-account + same-day + same-amount twins
    // into the Removed-duplicates bucket (JE reversed) so the import doesn't
    // double-post. SAME-ACCOUNT only; cross-account clusters (same bank under a
    // different label) stay dry-run-gated via scripts/sweep-cross-source-dupes.
    // Its own checkpointed step: idempotent + retryable, so a partial pass
    // resumes cleanly, and a failure here never fails the migration.
    try {
      const dedupe = await step.run('dedupe-cross-source', async () => {
        const { sweepOrgDuplicates } = await import('@/lib/audit/dedupe-sweep');
        const r = await sweepOrgDuplicates(organizationId, { apply: true, crossAccount: false });
        return { quarantined: r.plan.length };
      });
      logger.info({ jobId, quarantined: dedupe.quarantined }, 'qbo-migration: cross-source dedupe (same-account) done');
    } catch (err) {
      logger.warn(
        { jobId, err: err instanceof Error ? err.message : String(err) },
        'qbo-migration: cross-source dedupe failed (non-fatal)',
      );
    }

    // finalStatus reflects BOTH pull and promote outcomes. A migration that
    // successfully pulled everything but failed to promote (e.g. unique
    // constraint violations against pre-seeded local data) is 'partial',
    // not 'completed' — otherwise the user sees a green badge over a half-
    // imported workspace. promoteSummary entries with errored === -1 mean
    // the entire phase threw (Inngest retries exhausted); errored > 0 means
    // per-row failures.
    const pullAnyErr = Object.values(summary).some((s) => s.errored);
    const pullAllErr = Object.values(summary).every((s) => s.errored);
    const promoteAnyErr = Object.values(promoteSummary).some((p) => p.errored !== 0);
    const promoteAllErr = Object.values(promoteSummary).every((p) => p.errored !== 0 && p.created === 0);
    const anyErrored = pullAnyErr || promoteAnyErr;
    const allErrored = pullAllErr || promoteAllErr;
    const finalStatus = allErrored ? 'failed' : anyErrored ? 'partial' : 'completed';

    await step.run('finalize', async () =>
      db
        .update(qboMigrationJobs)
        .set({
          status: finalStatus,
          progress: 100,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          migrationReport: { entities: summary, promote: promoteSummary, completedAt: new Date().toISOString() },
          errorMessage: allErrored ? 'All entity pulls failed — check QBO permissions and reconnect' : null,
        })
        .where(eq(qboMigrationJobs.id, jobId)),
    );

    logger.info({ jobId, status: finalStatus, summary }, 'qbo migration finished');
    return { jobId, status: finalStatus, summary };
  },
);
