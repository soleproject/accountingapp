'use server';

import { randomUUID } from 'crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  organizations,
  enterpriseStaff,
  enterpriseClients,
  permissionSets,
  userPermissionSets,
  adminAuditLog,
} from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { isAccountingTierKey } from '@/lib/accounting/tiers';
import { setUserAccountingTier, setOrgAccountingTier } from '@/lib/accounting/assign-tier';
import { deleteOrganizationCascade } from '@/lib/accounting/delete-organization';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase/service';
import { TASK_CATALOG, parseResponsibilities, defaultOwnerFor } from '@/lib/enterprise/task-catalog';
import { getEnterpriseDefaultsForOwner, syncRecurringTaskRouting } from '@/lib/enterprise/recurring-task-routing';
import { normalizeStateCode, normalizeMonthDay } from '@/lib/geo/us-states';

interface ClientAccess {
  realUserId: string;
  enterpriseId: string;
}

/**
 * Ensures the signed-in user owns or staffs an enterprise that has
 * `targetUserId` as a client. Returns the matching enterprise id so the
 * caller can write it into the audit log.
 */
async function requireClientAccess(targetUserId: string): Promise<ClientAccess> {
  const real = await requireSession();
  if (!targetUserId) throw new Error('targetUserId required');

  const [owned, staffed] = await Promise.all([
    db.select({ id: organizations.id }).from(organizations).where(eq(organizations.ownerUserId, real.id)),
    db.select({ id: enterpriseStaff.enterpriseId }).from(enterpriseStaff).where(eq(enterpriseStaff.staffUserId, real.id)),
  ]);
  const enterpriseIds = Array.from(new Set([...owned.map((o) => o.id), ...staffed.map((s) => s.id)]));
  if (enterpriseIds.length === 0) throw new Error('forbidden');

  const [link] = await db
    .select({ enterpriseId: enterpriseClients.enterpriseId })
    .from(enterpriseClients)
    .where(
      and(
        eq(enterpriseClients.clientUserId, targetUserId),
        inArray(enterpriseClients.enterpriseId, enterpriseIds),
      ),
    )
    .limit(1);
  if (!link) throw new Error('forbidden');
  return { realUserId: real.id, enterpriseId: link.enterpriseId };
}

async function logAudit(
  adminUserId: string,
  action: string,
  targetId: string,
  metadata?: Record<string, unknown>,
  targetType: string = 'user',
) {
  await db.insert(adminAuditLog).values({
    id: randomUUID(),
    adminUserId,
    action,
    targetType,
    targetId,
    auditMetadata: metadata ?? null,
  });
}

export async function updateEnterpriseClientAction(formData: FormData): Promise<void> {
  const userId = String(formData.get('userId') ?? '');
  const { realUserId, enterpriseId } = await requireClientAccess(userId);

  const fullName = String(formData.get('fullName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const isActive = formData.get('isActive') === 'on';

  if (!fullName) throw new Error('Full name is required');
  if (!email || !email.includes('@')) throw new Error('Valid email is required');

  const collision = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (collision[0] && collision[0].id !== userId) {
    throw new Error(`Email ${email} is already in use by another user`);
  }

  // Deliberately not updating role here — that's a super-admin-only knob.
  await db.update(users).set({ fullName, email, isActive }).where(eq(users.id, userId));
  await logAudit(realUserId, 'enterprise.client.update', userId, { fullName, email, isActive, enterpriseId });
  revalidatePath('/enterprise/clients');
  revalidatePath(`/enterprise/clients/${userId}`);
  redirect(`/enterprise/clients/${userId}`);
}

/**
 * Edit a client BUSINESS (organization) from the Client Businesses table's edit
 * pencil — name, what it does, who keeps the books, and the accounting plan.
 * Access-checked through the org's owner (requireClientAccess). The tier change
 * is delegated to setOrgAccountingTier (per-org, multi-company safe) and only
 * fired when it actually changed, so we don't churn the permission set / Stripe
 * sync on an unrelated edit.
 */
export async function updateBusinessAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get('orgId') ?? '');
  if (!orgId) throw new Error('orgId required');

  const [org] = await db
    .select({ ownerUserId: organizations.ownerUserId, accountingTier: organizations.accountingTier })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error('Business not found');

  const { realUserId, enterpriseId } = await requireClientAccess(org.ownerUserId);

  const name = String(formData.get('name') ?? '').trim();
  const businessDescription = String(formData.get('businessDescription') ?? '').trim();
  const booksManagedBy = String(formData.get('booksManagedBy') ?? '').trim() === 'firm' ? 'firm' : 'client';
  const tierRaw = String(formData.get('accountingTier') ?? '').trim();
  const tier = isAccountingTierKey(tierRaw) ? tierRaw : null;
  if (tierRaw && !tier) throw new Error(`Invalid accounting tier: ${tierRaw}`);

  if (!name) throw new Error('Business name is required');

  // Registration state + annual-report due date (MM-DD). Invalid input → null
  // (no reminder) rather than a hard error, so a typo never blocks the save.
  const formationState = normalizeStateCode(formData.get('formationState'));
  const annualReportDue = normalizeMonthDay(formData.get('annualReportDue'));

  // Sparse overrides: persist ONLY the tasks that differ from the firm-wide
  // default (enterprise default → smart). Anything matching the default is
  // omitted so the client keeps inheriting future default changes.
  const enterpriseDefaults = parseResponsibilities(await getEnterpriseDefaultsForOwner(org.ownerUserId));
  const taskResponsibilities: Record<string, 'pro' | 'client'> = {};
  for (const t of TASK_CATALOG) {
    const v = String(formData.get(`resp_${t.key}`) ?? '');
    if (v !== 'pro' && v !== 'client') continue;
    const def = enterpriseDefaults[t.key] ?? defaultOwnerFor(t, booksManagedBy);
    if (v !== def) taskResponsibilities[t.key] = v;
  }

  await db
    .update(organizations)
    .set({
      name,
      businessDescription: businessDescription || null,
      booksManagedBy,
      taskResponsibilities,
      formationState,
      annualReportDue,
    })
    .where(eq(organizations.id, orgId));

  // Move this client's existing open recurring tasks to the new owner so the
  // Work queue + client task list match the dashboard.
  await syncRecurringTaskRouting(orgId, realUserId);

  // Only touch the tier path when it actually changed — it re-syncs the
  // permission set + Stripe price. null === the legacy flat plan.
  if ((org.accountingTier ?? null) !== tier) {
    await setOrgAccountingTier(orgId, tier);
  }

  await logAudit(
    realUserId,
    'enterprise.business.update',
    orgId,
    { name, booksManagedBy, tier: tier ?? 'legacy_flat', enterpriseId },
    'organization',
  );
  revalidatePath('/enterprise/businesses');
  revalidatePath('/enterprise/dashboard');
  redirect('/enterprise/businesses');
}

/**
 * Permanently delete a client BUSINESS (organization) and EVERY record that
 * belongs to it, then the org row — via the shared deleteOrganizationCascade
 * (one FK-deferred transaction). Firm-access-checked through the org's owner,
 * and gated behind a typed-name confirmation passed from the UI. Returns a
 * result object (no redirect) so the client component can confirm + navigate.
 */
export async function deleteEnterpriseBusinessAction(args: {
  orgId: string;
  confirmName: string;
}): Promise<{ ok: boolean; error?: string; totalRowsDeleted?: number }> {
  try {
    if (!args.orgId) return { ok: false, error: 'orgId required' };

    const [org] = await db
      .select({ ownerUserId: organizations.ownerUserId, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, args.orgId))
      .limit(1);
    if (!org) return { ok: false, error: 'Business not found' };

    // Firm must own/staff an enterprise that has this business's owner as a
    // client. Throws 'forbidden' otherwise (caught below). This also blocks
    // deleting the firm's own org or the enterprise itself (not a client).
    const { realUserId, enterpriseId } = await requireClientAccess(org.ownerUserId);

    if (args.confirmName.trim() !== (org.name ?? '')) {
      return { ok: false, error: 'Confirmation text does not match the business name' };
    }

    const result = await deleteOrganizationCascade(args.orgId);
    logger.warn(
      { orgId: args.orgId, name: result.organizationName, totalRowsDeleted: result.totalRowsDeleted, enterpriseId },
      'enterprise: client business deleted (cascade)',
    );
    await logAudit(
      realUserId,
      'enterprise.business.delete',
      args.orgId,
      {
        name: result.organizationName,
        totalRowsDeleted: result.totalRowsDeleted,
        perTable: result.perTable,
        enterpriseId,
      },
      'organization',
    );
    revalidatePath('/enterprise/businesses');
    revalidatePath('/enterprise/dashboard');
    return { ok: true, totalRowsDeleted: result.totalRowsDeleted };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed' };
  }
}

/**
 * Permanently delete a client USER and EVERYTHING they own: first cascade-delete
 * every organization where they're the owner (deleteOrganizationCascade), then
 * remove their enterprise-client link, permission sets, the user row, and the
 * Supabase auth account. Firm-access-checked; refuses super admins + self.
 * Returns a result object so the client component can confirm + navigate.
 */
export async function deleteEnterpriseClientUserAction(args: {
  userId: string;
  confirmName: string;
}): Promise<{ ok: boolean; error?: string; orgsDeleted?: number; totalRowsDeleted?: number }> {
  try {
    if (!args.userId) return { ok: false, error: 'userId required' };

    const { realUserId, enterpriseId } = await requireClientAccess(args.userId);
    if (args.userId === realUserId) return { ok: false, error: 'You cannot delete yourself.' };

    const [target] = await db
      .select({ id: users.id, email: users.email, fullName: users.fullName, role: users.role })
      .from(users)
      .where(eq(users.id, args.userId))
      .limit(1);
    if (!target) return { ok: false, error: 'User not found' };
    if (target.role === 'super_admin' || target.role === 'superadmin') {
      return { ok: false, error: 'Cannot delete a super admin.' };
    }

    const expectedName = (target.fullName?.trim() || target.email).trim();
    if (args.confirmName.trim() !== expectedName) {
      return { ok: false, error: 'Confirmation text does not match the user’s name.' };
    }

    // 1. Cascade-delete every business this user owns (all their companies first).
    const ownedOrgs = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.ownerUserId, args.userId));
    let totalRowsDeleted = 0;
    for (const o of ownedOrgs) {
      const result = await deleteOrganizationCascade(o.id);
      totalRowsDeleted += result.totalRowsDeleted;
      logger.warn(
        { orgId: o.id, name: result.organizationName, totalRowsDeleted: result.totalRowsDeleted, enterpriseId },
        'enterprise: client org deleted (user-delete cascade)',
      );
    }

    // 2. Remove the user + their enterprise links. FK checks are deferred so
    //    no-action refs (audit rows they authored, qbo, etc.) don't block the
    //    delete — but we explicitly drop the enterprise-client + permission-set
    //    rows so the user doesn't linger as a broken client.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      await tx.execute(sql`UPDATE organizations SET client_id = NULL WHERE client_id = ${args.userId}`);
      await tx.delete(enterpriseClients).where(eq(enterpriseClients.clientUserId, args.userId));
      await tx.delete(userPermissionSets).where(eq(userPermissionSets.userId, args.userId));
      await tx.delete(users).where(eq(users.id, args.userId));
      await tx.execute(sql`SET LOCAL session_replication_role = 'origin'`);
    });

    // 3. Remove the Supabase auth account (best-effort — a failure here just
    //    leaves an orphaned auth user who can no longer resolve to a DB row).
    try {
      const supabase = createServiceClient();
      const { error: authErr } = await supabase.auth.admin.deleteUser(args.userId);
      if (authErr) {
        logger.warn({ userId: args.userId, err: authErr.message }, 'enterprise: supabase auth deleteUser failed');
      }
    } catch (e) {
      logger.warn(
        { userId: args.userId, err: e instanceof Error ? e.message : String(e) },
        'enterprise: supabase auth deleteUser threw',
      );
    }

    await logAudit(realUserId, 'enterprise.client.delete', args.userId, {
      email: target.email,
      fullName: target.fullName,
      orgsDeleted: ownedOrgs.length,
      totalRowsDeleted,
      enterpriseId,
    });
    revalidatePath('/enterprise/clients');
    revalidatePath('/enterprise/businesses');
    revalidatePath('/enterprise/dashboard');
    return { ok: true, orgsDeleted: ownedOrgs.length, totalRowsDeleted };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed' };
  }
}

export async function deactivateEnterpriseClientAction(formData: FormData): Promise<void> {
  const userId = String(formData.get('userId') ?? '');
  const { realUserId, enterpriseId } = await requireClientAccess(userId);
  await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
  await logAudit(realUserId, 'enterprise.client.deactivate', userId, { enterpriseId });
  revalidatePath('/enterprise/clients');
  revalidatePath(`/enterprise/clients/${userId}`);
}

export async function reactivateEnterpriseClientAction(formData: FormData): Promise<void> {
  const userId = String(formData.get('userId') ?? '');
  const { realUserId, enterpriseId } = await requireClientAccess(userId);
  await db.update(users).set({ isActive: true }).where(eq(users.id, userId));
  await logAudit(realUserId, 'enterprise.client.reactivate', userId, { enterpriseId });
  revalidatePath('/enterprise/clients');
  revalidatePath(`/enterprise/clients/${userId}`);
}

export async function setEnterpriseClientPermissionSetAction(formData: FormData): Promise<void> {
  const userId = String(formData.get('userId') ?? '');
  const { realUserId, enterpriseId } = await requireClientAccess(userId);
  const permissionSetId = String(formData.get('permissionSetId') ?? '').trim();

  if (permissionSetId) {
    // Block assigning privileged sets from enterprise context.
    const [ps] = await db
      .select({ name: permissionSets.name })
      .from(permissionSets)
      .where(eq(permissionSets.id, permissionSetId))
      .limit(1);
    if (!ps) throw new Error('Permission set not found');
    if (ps.name.toLowerCase().includes('super admin') || ps.name.toLowerCase().includes('superadmin')) {
      throw new Error('Cannot assign a Super Admin permission set from the enterprise area');
    }
  }

  await db.delete(userPermissionSets).where(eq(userPermissionSets.userId, userId));
  if (permissionSetId) {
    await db.insert(userPermissionSets).values({
      id: randomUUID(),
      userId,
      permissionSetId,
    });
  }
  await logAudit(realUserId, 'enterprise.client.permission_set.assign', userId, {
    permissionSetId: permissionSetId || null,
    enterpriseId,
  });
  revalidatePath(`/enterprise/clients/${userId}`);
}

/**
 * Set a single client's accounting plan (Starter/Plus/Pro), or clear it back to
 * the grandfathered flat $89 plan when empty. setUserAccountingTier stamps the
 * client's owned org + assigns the matching permission set in lockstep. This is
 * the per-client counterpart to the bulk action below; both are firm-scoped via
 * requireClientAccess so a firm can only re-plan its own clients.
 */
export async function setEnterpriseClientAccountingTierAction(formData: FormData): Promise<void> {
  const userId = String(formData.get('userId') ?? '');
  const { realUserId, enterpriseId } = await requireClientAccess(userId);

  const tierRaw = String(formData.get('accountingTier') ?? '').trim();
  const tier = isAccountingTierKey(tierRaw) ? tierRaw : null;
  if (tierRaw && !tier) throw new Error(`Invalid accounting tier: ${tierRaw}`);

  const result = await setUserAccountingTier(userId, tier);
  await logAudit(realUserId, 'enterprise.client.accounting_tier.set', userId, {
    tier: tier ?? 'legacy_flat',
    orgId: result.orgId ?? null,
    enterpriseId,
  });
  revalidatePath('/enterprise/clients');
  revalidatePath(`/enterprise/clients/${userId}`);
}

/**
 * Bulk-set the accounting plan for several of the firm's clients at once.
 * Each client is access-checked individually so a stray id can't be re-planned;
 * one failure is isolated and reported, never aborting the batch.
 */
export async function bulkSetEnterpriseClientTierAction(
  userIds: string[],
  tierRaw: string,
): Promise<{ updated: number; failed: number; errors: string[] }> {
  await requireSession();
  const ids = Array.from(new Set(userIds.map((s) => String(s)).filter(Boolean)));
  if (ids.length === 0) throw new Error('Select at least one client');

  const tier = isAccountingTierKey(tierRaw) ? tierRaw : null;
  if (tierRaw && !tier) throw new Error(`Invalid accounting tier: ${tierRaw}`);

  let updated = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const userId of ids) {
    try {
      const { realUserId, enterpriseId } = await requireClientAccess(userId);
      const result = await setUserAccountingTier(userId, tier);
      await logAudit(realUserId, 'enterprise.client.accounting_tier.set', userId, {
        tier: tier ?? 'legacy_flat',
        orgId: result.orgId ?? null,
        enterpriseId,
        bulk: true,
      });
      updated++;
    } catch (e) {
      failed++;
      errors.push(`${userId}: ${e instanceof Error ? e.message : 'failed'}`);
    }
  }
  revalidatePath('/enterprise/clients');
  return { updated, failed, errors };
}
