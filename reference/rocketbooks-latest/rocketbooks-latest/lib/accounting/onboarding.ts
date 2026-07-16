import 'server-only';
import { randomUUID } from 'crypto';
import { eq, and, count, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  organizations,
  onboardingState,
  plaidAccounts,
  imports,
  receipts,
  contacts,
  chartOfAccounts,
  trustBeneficiaries,
  organizationAccountingFeatures,
} from '@/db/schema/schema';
import { seedDefaultCoa } from './seed-default-coa';
import { seedBeneficialTrustCoa } from './seed-beneficial-trust-coa';
import { seedTrustPfcOverrides } from './beneficial-trust-pfc-overrides';
import { seedDefaultAssetCategories } from './seed-asset-categories';
import { orgHasCapability } from './entitlements';
import { logger } from '@/lib/logger';
import {
  getEntityTypeOnboardingEnabledForOrg,
  toOrgEntityType,
  type OrgEntityType,
} from '@/lib/orgs/entity-type';

const TRUST_ENTITY_TYPES = new Set<OrgEntityType>(['beneficial_trust', 'business_trust']);

/**
 * The phases the user walks through during onboarding. Order matters —
 * advance() goes one forward.
 */
export const ONBOARDING_PHASES = [
  'business_info',
  'quickbooks',
  'plaid',
  'bank_statements',
  'receipts',
  'review',
  'complete',
] as const;

export type OnboardingPhase = (typeof ONBOARDING_PHASES)[number];

export interface OnboardingPlaidAccount {
  id: string;
  institutionName: string | null;
  accountName: string | null;
  last4: string | null;
  chartOfAccountId: string | null;
  chartOfAccountLabel: string | null;
  status: string | null;
  inScope: boolean;
}

export interface OnboardingImport {
  id: string;
  filename: string | null;
  status: string;
  transactionCount: number | null;
  createdAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface OnboardingReceipt {
  id: string;
  vendorName: string | null;
  total: number | null;
  receiptDate: string | null;
  status: string | null;
  posted: boolean;
}

export interface OnboardingAssetAccount {
  id: string;
  accountNumber: string;
  accountName: string;
}

export interface OnboardingBeneficiary {
  id: string;
  fullName: string;
  dateOfBirth: string | null;
  isIncapacitated: boolean;
  relationship: string | null;
}

export interface OnboardingStatus {
  organizationId: string;
  organizationName: string;
  businessDescription: string | null;
  phase: OnboardingPhase;
  completed: boolean;
  /** Cheap counts so the UI / AI can decide when each step looks "done" */
  signals: {
    hasBusinessInfo: boolean;
    plaidAccountsLinked: number;
    plaidAccountsInScope: number;
    bankStatementsImported: number;
    receiptsUploaded: number;
  };
  plaidAccounts: OnboardingPlaidAccount[];
  recentImports: OnboardingImport[];
  recentReceipts: OnboardingReceipt[];
  assetAccounts: OnboardingAssetAccount[];
  /** Currently-saved entity type (null if not yet selected). */
  entityType: OrgEntityType | null;
  /** Whether the entity-type onboarding step should be shown. Inherited from
   *  the org's parent Enterprise; false when the org has no Enterprise. */
  entityTypeOnboardingEnabled: boolean;
  /** Trust beneficiaries collected so far (empty array if none / not a trust). */
  beneficiaries: OnboardingBeneficiary[];
}

function isPhase(s: string | null | undefined): s is OnboardingPhase {
  return !!s && (ONBOARDING_PHASES as readonly string[]).includes(s);
}

export async function getOnboardingStatus(orgId: string): Promise<OnboardingStatus> {
  const [
    [org],
    [state],
    [plaidCount],
    [importCount],
    [receiptCount],
    plaidRows,
    importRows,
    receiptRows,
    assetRows,
    beneficiaryRows,
  ] = await db.transaction(async (tx) => Promise.all([
    tx
      .select({
        id: organizations.id,
        name: organizations.name,
        description: organizations.businessDescription,
        entityType: organizations.entityType,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
    tx.select().from(onboardingState).where(eq(onboardingState.orgId, orgId)).limit(1),
    tx.select({ n: count() }).from(plaidAccounts).where(eq(plaidAccounts.linkedOrganizationId, orgId)),
    tx
      .select({ n: count() })
      .from(imports)
      .where(and(eq(imports.organizationId, orgId), eq(imports.method, 'veryfi'))),
    tx.select({ n: count() }).from(receipts).where(eq(receipts.organizationId, orgId)),
    tx
      .select({
        id: plaidAccounts.id,
        accountName: plaidAccounts.accountName,
        last4: plaidAccounts.last4,
        institutionName: plaidAccounts.institutionName,
        chartOfAccountId: plaidAccounts.chartOfAccountId,
        chartOfAccountNumber: chartOfAccounts.accountNumber,
        chartOfAccountLabel: chartOfAccounts.accountName,
        status: plaidAccounts.connectionStatus,
        inScope: plaidAccounts.inScope,
      })
      .from(plaidAccounts)
      .leftJoin(chartOfAccounts, eq(plaidAccounts.chartOfAccountId, chartOfAccounts.id))
      .where(eq(plaidAccounts.linkedOrganizationId, orgId)),
    tx
      .select({
        id: imports.id,
        filename: imports.filename,
        status: imports.status,
        transactionCount: imports.transactionCount,
        createdAt: imports.createdAt,
        startDate: imports.startDate,
        endDate: imports.endDate,
      })
      .from(imports)
      .where(and(eq(imports.organizationId, orgId), eq(imports.method, 'veryfi')))
      .orderBy(desc(imports.createdAt))
      .limit(10),
    tx
      .select({
        id: receipts.id,
        contactId: receipts.contactId,
        vendorName: contacts.contactName,
        total: receipts.totalAmount,
        receiptDate: receipts.receiptDate,
        status: receipts.status,
        posted: receipts.posted,
      })
      .from(receipts)
      .leftJoin(contacts, eq(receipts.contactId, contacts.id))
      .where(eq(receipts.organizationId, orgId))
      .orderBy(desc(receipts.receiptDate))
      .limit(10),
    tx
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
      })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true))),
    tx
      .select({
        id: trustBeneficiaries.id,
        fullName: trustBeneficiaries.fullName,
        dateOfBirth: trustBeneficiaries.dateOfBirth,
        isIncapacitated: trustBeneficiaries.isIncapacitated,
        relationship: trustBeneficiaries.relationship,
      })
      .from(trustBeneficiaries)
      .where(eq(trustBeneficiaries.organizationId, orgId)),
  ]));
  const entityTypeOnboardingEnabled = await getEntityTypeOnboardingEnabledForOrg(orgId);

  if (!org) throw new Error('Organization not found');

  const phase: OnboardingPhase = isPhase(state?.phase) ? state.phase : 'business_info';
  const completed = !!state?.completed;
  const hasBusinessInfo = !!(org.name && org.description && org.description.trim().length > 0);

  return {
    organizationId: org.id,
    organizationName: org.name,
    businessDescription: org.description,
    phase: completed ? 'complete' : phase,
    completed,
    signals: {
      hasBusinessInfo,
      plaidAccountsLinked: plaidCount?.n ?? 0,
      plaidAccountsInScope: plaidRows.filter((p) => p.inScope).length,
      bankStatementsImported: importCount?.n ?? 0,
      receiptsUploaded: receiptCount?.n ?? 0,
    },
    plaidAccounts: plaidRows.map((p) => ({
      id: p.id,
      institutionName: p.institutionName,
      accountName: p.accountName,
      last4: p.last4,
      chartOfAccountId: p.chartOfAccountId,
      chartOfAccountLabel:
        p.chartOfAccountNumber && p.chartOfAccountLabel ? `${p.chartOfAccountNumber} · ${p.chartOfAccountLabel}` : null,
      status: p.status,
      inScope: p.inScope,
    })),
    recentImports: importRows.map((r) => ({
      id: r.id,
      filename: r.filename,
      status: r.status,
      transactionCount: r.transactionCount,
      createdAt: r.createdAt,
      startDate: r.startDate,
      endDate: r.endDate,
    })),
    recentReceipts: receiptRows.map((r) => ({
      id: r.id,
      vendorName: r.vendorName,
      total: r.total === null || r.total === undefined ? null : Number(r.total),
      receiptDate: r.receiptDate,
      status: r.status,
      posted: r.posted ?? false,
    })),
    assetAccounts: (() => {
      const ASSET_TYPES = ['asset', 'current_asset'];
      const all = assetRows.filter((a) => ASSET_TYPES.includes((a.gaapType ?? '').toLowerCase()));
      const banky = all.filter((a) => {
        const n = a.accountName.toLowerCase();
        return n.includes('bank') || n.includes('cash') || n.includes('checking') || n.includes('savings');
      });
      return (banky.length > 0 ? banky : all).map((a) => ({
        id: a.id,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
      }));
    })(),
    entityType: org.entityType ?? null,
    entityTypeOnboardingEnabled,
    beneficiaries: beneficiaryRows.map((b) => ({
      id: b.id,
      fullName: b.fullName,
      dateOfBirth: b.dateOfBirth ?? null,
      isIncapacitated: b.isIncapacitated,
      relationship: b.relationship ?? null,
    })),
  };
}

async function upsertState(orgId: string, phase: OnboardingPhase, completed: boolean): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(onboardingState)
    .values({ orgId, phase, step: phase, context: {}, completed, updatedAt: now })
    .onConflictDoUpdate({
      target: onboardingState.orgId,
      set: { phase, step: phase, completed, updatedAt: now },
    });
}

interface OnboardingContext {
  lastAdvanceTurnId?: string;
  [k: string]: unknown;
}

async function readState(orgId: string): Promise<{ phase: OnboardingPhase | null; context: OnboardingContext }> {
  const [row] = await db
    .select({ phase: onboardingState.phase, context: onboardingState.context })
    .from(onboardingState)
    .where(eq(onboardingState.orgId, orgId))
    .limit(1);
  if (!row) return { phase: null, context: {} };
  const phase = isPhase(row.phase) ? row.phase : null;
  const context = (row.context as OnboardingContext | null) ?? {};
  return { phase, context };
}

/**
 * Phase-changing write that also stamps the turn id of the user message that
 * caused the change. Used by both advance_onboarding and set_business_info's
 * auto-advance path so they share the same turn-based gate.
 */
async function recordAdvance(args: {
  orgId: string;
  phase: OnboardingPhase;
  completed: boolean;
  turnId?: string;
  prevContext: OnboardingContext;
}): Promise<void> {
  const now = new Date().toISOString();
  const nextContext: OnboardingContext = {
    ...args.prevContext,
    ...(args.turnId ? { lastAdvanceTurnId: args.turnId } : {}),
  };
  await db
    .insert(onboardingState)
    .values({
      orgId: args.orgId,
      phase: args.phase,
      step: args.phase,
      context: nextContext,
      completed: args.completed,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: onboardingState.orgId,
      set: {
        phase: args.phase,
        step: args.phase,
        context: nextContext,
        completed: args.completed,
        updatedAt: now,
      },
    });
}

export class OnboardingTurnGated extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingTurnGated';
  }
}

/**
 * Returns true if a phase change in this turn would be a duplicate. The model
 * sometimes chains advance_onboarding twice on a single user "skip" — this
 * gate keyed off the user message id (turnId) blocks the second one so the
 * user actually sees the in-between phase.
 *
 * If turnId is undefined (panel button click, no AI involvement) the gate is
 * skipped — the user is in direct control.
 */
function checkTurnGate(args: {
  orgId: string;
  tool: 'advance_onboarding' | 'set_business_info';
  currentPhase: OnboardingPhase;
  context: OnboardingContext;
  turnId?: string;
}): void {
  if (!args.turnId) return;
  if (args.context.lastAdvanceTurnId !== args.turnId) return;

  logger.warn(
    {
      orgId: args.orgId,
      tool: args.tool,
      turnId: args.turnId,
      phase: args.currentPhase,
      ts: new Date().toISOString(),
    },
    'onboarding advance gated (turn already advanced)',
  );
  throw new OnboardingTurnGated(
    'Onboarding already advanced this turn. Wait for the user’s next message before calling advance_onboarding or set_business_info again.',
  );
}

export interface BeneficiaryInput {
  fullName: string;
  dateOfBirth?: string | null;
  isIncapacitated?: boolean;
  relationship?: string | null;
}

export async function setBusinessInfo(args: {
  organizationId: string;
  name?: string;
  description?: string;
  entityType?: OrgEntityType | string | null;
  beneficiaries?: BeneficiaryInput[];
  turnId?: string;
}): Promise<OnboardingStatus> {
  const updates: {
    name?: string;
    businessDescription?: string;
    entityType?: OrgEntityType | null;
  } = {};
  if (typeof args.name === 'string' && args.name.trim()) updates.name = args.name.trim();
  if (typeof args.description === 'string') updates.businessDescription = args.description.trim();

  // Only narrow + persist entityType when the caller explicitly passed it.
  // `undefined` means "don't touch"; `null` means "clear it".
  let resolvedEntityType: OrgEntityType | null | undefined = undefined;
  if (args.entityType !== undefined) {
    resolvedEntityType = args.entityType === null ? null : toOrgEntityType(args.entityType);
    updates.entityType = resolvedEntityType;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(organizations).set(updates).where(eq(organizations.id, args.organizationId));
  }

  // The moment a placeholder gets a real (non-"My Business") name, clean up any
  // leftover empty "My Business" shells this owner accumulated from abandoned
  // "Add business" attempts. Best-effort; the just-named org is excluded so it's
  // never touched, and onboarding is never blocked on this.
  if (updates.name && updates.name !== 'My Business') {
    try {
      const [org] = await db
        .select({ ownerUserId: organizations.ownerUserId })
        .from(organizations)
        .where(eq(organizations.id, args.organizationId))
        .limit(1);
      if (org?.ownerUserId) {
        const { pruneEmptyPlaceholderOrgs } = await import('./prune-placeholders');
        await pruneEmptyPlaceholderOrgs(org.ownerUserId, args.organizationId);
      }
    } catch (err) {
      logger.warn(
        { orgId: args.organizationId, err: err instanceof Error ? err.message : String(err) },
        'placeholder prune after naming failed',
      );
    }
  }

  // Trust-entity side effects: replace the beneficiary roster and flip the
  // feature pack on. We only delete-and-reinsert beneficiaries when the
  // caller actually sent a list, so other callers (e.g. an AI-only name
  // update) don't accidentally wipe the roster.
  const isTrust = !!resolvedEntityType && TRUST_ENTITY_TYPES.has(resolvedEntityType);
  if (isTrust && Array.isArray(args.beneficiaries)) {
    await db.delete(trustBeneficiaries).where(eq(trustBeneficiaries.organizationId, args.organizationId));
    const rows = args.beneficiaries
      .map((b) => ({
        fullName: typeof b.fullName === 'string' ? b.fullName.trim() : '',
        dateOfBirth: typeof b.dateOfBirth === 'string' && b.dateOfBirth.trim() ? b.dateOfBirth.trim() : null,
        isIncapacitated: !!b.isIncapacitated,
        relationship: typeof b.relationship === 'string' && b.relationship.trim() ? b.relationship.trim() : null,
      }))
      .filter((b) => b.fullName.length > 0);
    if (rows.length > 0) {
      await db.insert(trustBeneficiaries).values(
        rows.map((r) => ({
          id: randomUUID(),
          organizationId: args.organizationId,
          ...r,
        })),
      );
    }
  }

  // Enable the matching feature pack so Phase 4's posting rules pick it up.
  // Entity-aware accounting (trust packs) is a Pro-tier capability; Starter/Plus
  // don't get the pack even if they pick a trust entity type. Grandfathered $89
  // clients keep it (legacy → all capabilities).
  if (isTrust && resolvedEntityType && (await orgHasCapability(args.organizationId, 'entityPacks'))) {
    const featurePack = resolvedEntityType; // 'beneficial_trust' | 'business_trust'
    await db
      .insert(organizationAccountingFeatures)
      .values({
        id: randomUUID(),
        organizationId: args.organizationId,
        featurePack,
        enabled: true,
        enabledAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [organizationAccountingFeatures.organizationId, organizationAccountingFeatures.featurePack],
        set: { enabled: true, enabledAt: new Date().toISOString() },
      });
  }

  // First save → kick onboarding to the next phase if still in business_info,
  // and seed the chart of accounts so the AI categorizer has expense and
  // revenue accounts to assign transactions to. The seeder is picked by
  // entity type: beneficial_trust gets BENEFICIAL_TRUST_COA + auto-seeded
  // 26x per-beneficiary demand-note sub-accounts; everything else (null,
  // LLC, Corp, etc.) gets the standard DEFAULT_COA. Idempotent — safe to
  // run even if the org already has some COA entries.
  //
  // When the entity-type onboarding step is enabled and the user hasn't
  // picked an entity type yet, hold the user on business_info — the form
  // requires the dropdown to be filled before they can move on.
  const current = await getOnboardingStatus(args.organizationId);
  const entityTypeReady = !current.entityTypeOnboardingEnabled || current.entityType !== null;
  if (current.phase === 'business_info' && current.signals.hasBusinessInfo && entityTypeReady) {
    const stored = await readState(args.organizationId);
    checkTurnGate({
      orgId: args.organizationId,
      tool: 'set_business_info',
      currentPhase: current.phase,
      context: stored.context,
      turnId: args.turnId,
    });
    try {
      if (current.entityType === 'beneficial_trust') {
        await seedBeneficialTrustCoa({ organizationId: args.organizationId });
        // After the CoA is in place, seed the PFC overrides so future
        // Plaid syncs auto-categorize into trust accounts instead of
        // falling through to non-existent canonical slugs and leaving
        // transactions uncategorized.
        await seedTrustPfcOverrides({ organizationId: args.organizationId });
        // And seed the default asset categories now that the 145/146/745
        // accounts they reference are guaranteed to exist on this org.
        await seedDefaultAssetCategories({ organizationId: args.organizationId });
      } else {
        await seedDefaultCoa({ organizationId: args.organizationId });
      }
    } catch {
      // Don't block onboarding on a seed failure — the user can add accounts manually.
    }
    await recordAdvance({
      orgId: args.organizationId,
      phase: 'quickbooks',
      completed: false,
      turnId: args.turnId,
      prevContext: stored.context,
    });
    return await getOnboardingStatus(args.organizationId);
  }
  // Make sure the row exists so the AI's next get_onboarding_status reflects the data.
  // Not a phase change, so don't touch lastAdvanceTurnId.
  await upsertState(args.organizationId, current.phase, current.completed);
  return await getOnboardingStatus(args.organizationId);
}

export async function advanceOnboarding(args: {
  organizationId: string;
  to?: OnboardingPhase | 'next';
  turnId?: string;
}): Promise<OnboardingStatus> {
  const cur = await getOnboardingStatus(args.organizationId);
  const stored = await readState(args.organizationId);

  checkTurnGate({
    orgId: args.organizationId,
    tool: 'advance_onboarding',
    currentPhase: cur.phase,
    context: stored.context,
    turnId: args.turnId,
  });

  let nextPhase: OnboardingPhase = cur.phase;
  if (args.to && args.to !== 'next' && (ONBOARDING_PHASES as readonly string[]).includes(args.to)) {
    nextPhase = args.to;
  } else {
    const idx = ONBOARDING_PHASES.indexOf(cur.phase);
    nextPhase = ONBOARDING_PHASES[Math.min(idx + 1, ONBOARDING_PHASES.length - 1)];
  }
  const completed = nextPhase === 'complete';
  await recordAdvance({
    orgId: args.organizationId,
    phase: nextPhase,
    completed,
    turnId: args.turnId,
    prevContext: stored.context,
  });
  return await getOnboardingStatus(args.organizationId);
}

export async function resetOnboarding(orgId: string): Promise<OnboardingStatus> {
  await upsertState(orgId, 'business_info', false);
  return await getOnboardingStatus(orgId);
}
