'use server';

import { randomBytes, randomUUID } from 'crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { inArray } from 'drizzle-orm';
import { deleteOrganizationCascade } from '@/lib/accounting/delete-organization';
import { logger } from '@/lib/logger';
import {
  organizations,
  users,
  adminAuditLog,
  permissions,
  permissionSets,
  permissionSetPermissions,
  userPermissionSets,
  enterpriseStaff,
  enterpriseClients,
  organizationSupportUsers,
  platformMaintenanceState,
} from '@/db/schema/schema';
import { and, ne } from 'drizzle-orm';
import { isEnterpriseTierKey } from '@/lib/enterprise/tiers';
import { isAccountingTierKey } from '@/lib/accounting/tiers';
import { setUserAccountingTier } from '@/lib/accounting/assign-tier';
import { validateSubdomain } from '@/lib/enterprise/subdomain';
import { allPermissionKeys } from '@/lib/permissions/structure';
import { requireSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/org';
import { createServiceClient } from '@/lib/supabase/service';

const ENTERPRISE_LOGO_BUCKET = 'enterprise-logos';

async function requireSuperAdmin() {
  const u = await requireSession();
  if (!(await isSuperAdmin())) throw new Error('forbidden');
  return u;
}

async function logAudit(adminUserId: string, action: string, targetType: string, targetId: string | null, metadata?: Record<string, unknown>) {
  await db.insert(adminAuditLog).values({
    id: randomUUID(),
    adminUserId,
    action,
    targetType,
    targetId,
    auditMetadata: metadata ?? null,
  });
}

export async function createEnterpriseAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const name = String(formData.get('name') ?? '').trim();
  const domain = String(formData.get('domain') ?? '').trim() || null;
  const ownerEmail = String(formData.get('ownerEmail') ?? '').trim();

  if (!name) throw new Error('Name is required');
  if (!ownerEmail) throw new Error('Owner email is required');

  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ownerEmail))
    .limit(1);
  if (!owner) throw new Error(`No user found with email ${ownerEmail}`);

  const id = randomUUID();
  await db.insert(organizations).values({
    id,
    name,
    ownerUserId: owner.id,
    planType: 'enterprise',
    domain,
  });

  await logAudit(admin.id, 'enterprise.create', 'organization', id, { name, ownerEmail });
  revalidatePath('/super-admin/enterprises');
  redirect(`/super-admin/enterprises/${id}`);
}

export async function updateUserAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) throw new Error('userId required');

  const fullName = String(formData.get('fullName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const role = String(formData.get('role') ?? '').trim();
  const isActive = formData.get('isActive') === 'on';
  const password = String(formData.get('password') ?? '');
  // Empty string = "— None —" = clear any assignment. Mirrors the
  // detail-page User Type panel (setUserPermissionSetAction).
  const permissionSetId = String(formData.get('permissionSetId') ?? '').trim();

  if (!fullName) throw new Error('Full name is required');
  if (!email || !email.includes('@')) throw new Error('Valid email is required');
  if (!role) throw new Error('Role is required');
  if (password && password.length < 8) throw new Error('Password must be at least 8 characters');

  // Detect email collision against other users.
  const collision = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (collision[0] && collision[0].id !== userId) {
    throw new Error(`Email ${email} is already in use by another user`);
  }

  await db.update(users).set({ fullName, email, role, isActive }).where(eq(users.id, userId));
  await logAudit(admin.id, 'user.update', 'user', userId, { fullName, email, role, isActive });

  // Replace the permission-set assignment (or clear it when "— None —").
  // Same replace-semantics as setUserPermissionSetAction so the two entry
  // points stay consistent.
  await db.delete(userPermissionSets).where(eq(userPermissionSets.userId, userId));
  if (permissionSetId) {
    await db.insert(userPermissionSets).values({
      id: randomUUID(),
      userId,
      permissionSetId,
    });
  }
  await logAudit(admin.id, 'user.permission_set.assign', 'user', userId, { permissionSetId: permissionSetId || null });

  if (password) {
    // users.id is the Supabase auth user id (see createUser.ts), so we can
    // overwrite the auth password directly. Never log the value itself.
    const supabase = createServiceClient();
    const { error } = await supabase.auth.admin.updateUserById(userId, { password });
    if (error) throw new Error(`Password update failed: ${error.message}`);
    await logAudit(admin.id, 'user.password.update', 'user', userId);
  }

  revalidatePath('/super-admin/all-users');
  revalidatePath(`/super-admin/all-users/${userId}`);
  redirect(`/super-admin/all-users/${userId}`);
}

/**
 * Edit a user's roles + enterprise access in place — the editable counterpart
 * to the Create wizard's "User Roles" block. The hard problem this solves:
 * flipping users.role alone does NOT grant enterprise access (that's gated by
 * MEMBERSHIP — owning an enterprise org or an enterprise_staff row, see
 * lib/auth/enterprise.ts), so promoting e.g. a paying_user → enterprise_owner
 * must also provision the enterprise + owner membership + primary org, or the
 * user lands role='enterprise_owner' but gets bounced out of /enterprise.
 *
 * Reconciliation semantics (never destructive to orgs):
 *   - Enterprise Owner CHECKED:
 *       · already heads an enterprise → update that enterprise's tier
 *       · not yet an owner → create a new enterprise headed by them, insert the
 *         owner enterprise_staff row, set their primary org if unset (promote)
 *     Owner is one-way here: UN-checking it is a no-op (you can't safely
 *     un-own an enterprise from this screen — do it on the enterprise page).
 *   - Staff / Paying / Support: add the membership row when newly checked,
 *     delete it when newly unchecked. Owned organizations are never deleted.
 *   - users.role is set to the derived primary role (owner > staff > paying >
 *     support > base) so the workspace dropdown + gating stay consistent.
 */
export async function updateUserRolesAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) throw new Error('userId required');

  const [target] = await db
    .select({ id: users.id, fullName: users.fullName, organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) throw new Error('User not found');

  const baseUser = formData.get('role_baseUser') === 'on';
  const enterpriseOwner = formData.get('role_enterpriseOwner') === 'on';
  const enterpriseStaffRole = formData.get('role_enterpriseStaff') === 'on';
  const payingUser = formData.get('role_payingUser') === 'on';
  const supportUser = formData.get('role_supportUser') === 'on';
  if (!baseUser && !enterpriseOwner && !enterpriseStaffRole && !payingUser && !supportUser) {
    throw new Error('Pick at least one role');
  }

  // Tier: a paid key (pl_495/pl_995/cp1) or the 'regular' sentinel (untiered /
  // referral → enterprise_tier NULL, no private label). Anything else is "not
  // chosen" and errors below only when a brand-new enterprise is being created.
  const tierRaw = String(formData.get('enterpriseTier') ?? '').trim();
  const paidTier = isEnterpriseTierKey(tierRaw) ? tierRaw : null;
  const isRegular = tierRaw === 'regular';

  const enterpriseId = String(formData.get('enterpriseId') ?? '').trim() || null;
  const newEnterpriseName = String(formData.get('newEnterpriseName') ?? '').trim() || null;
  const supportOrgId = String(formData.get('supportOrgId') ?? '').trim() || null;

  // Current memberships — drives add-vs-noop and uncheck-vs-delete decisions.
  const [ownedEnterprises, ownerStaff, plainStaff, clients, supports] = await Promise.all([
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.ownerUserId, userId), eq(organizations.planType, 'enterprise'))),
    db
      .select({ id: enterpriseStaff.id, enterpriseId: enterpriseStaff.enterpriseId })
      .from(enterpriseStaff)
      .where(and(eq(enterpriseStaff.staffUserId, userId), eq(enterpriseStaff.role, 'owner'))),
    db
      .select({ id: enterpriseStaff.id })
      .from(enterpriseStaff)
      .where(and(eq(enterpriseStaff.staffUserId, userId), ne(enterpriseStaff.role, 'owner'))),
    db.select({ id: enterpriseClients.id }).from(enterpriseClients).where(eq(enterpriseClients.clientUserId, userId)),
    db.select({ id: organizationSupportUsers.id }).from(organizationSupportUsers).where(eq(organizationSupportUsers.supportUserId, userId)),
  ]);

  const headedEnterpriseId = ownedEnterprises[0]?.id ?? ownerStaff[0]?.enterpriseId ?? null;
  const touchedEnterprises = new Set<string>();
  let primaryOrgToSet: string | null = null;

  // ── Enterprise Owner ─────────────────────────────────────────────
  if (enterpriseOwner) {
    if (headedEnterpriseId) {
      // Already heads one → just (re)set its tier and make sure the owner
      // membership row exists (an owned org without a staff row still grants
      // access, but we keep the row so the detail page renders the role).
      await db
        .update(organizations)
        .set({ enterpriseTier: paidTier, privateLabelEnabled: paidTier !== null })
        .where(eq(organizations.id, headedEnterpriseId));
      if (ownerStaff.length === 0) {
        await db.insert(enterpriseStaff).values({
          id: randomUUID(),
          enterpriseId: headedEnterpriseId,
          staffUserId: userId,
          role: 'owner',
        });
      }
      touchedEnterprises.add(headedEnterpriseId);
      if (!target.organizationId) primaryOrgToSet = headedEnterpriseId;
    } else {
      // Promote: a tier choice (paid or Regular) is required for the new org.
      if (!paidTier && !isRegular) throw new Error('Pick an Enterprise Owner tier (or Regular)');
      const name = newEnterpriseName || `${target.fullName}'s Enterprise`;
      const entId = randomUUID();
      await db.insert(organizations).values({
        id: entId,
        name,
        ownerUserId: userId,
        planType: 'enterprise',
        enterpriseTier: paidTier,
        privateLabelEnabled: paidTier !== null,
      });
      await logAudit(admin.id, 'enterprise.create', 'organization', entId, {
        name,
        tier: paidTier ?? 'regular',
        viaUserEdit: true,
      });
      await db.insert(enterpriseStaff).values({
        id: randomUUID(),
        enterpriseId: entId,
        staffUserId: userId,
        role: 'owner',
      });
      touchedEnterprises.add(entId);
      if (!target.organizationId) primaryOrgToSet = entId;
    }
  }
  // Un-checking Enterprise Owner is intentionally a no-op (see doc comment).

  // ── Enterprise Staff (non-owner) ─────────────────────────────────
  if (enterpriseStaffRole && plainStaff.length === 0) {
    if (!enterpriseId) throw new Error('Pick an enterprise for the Enterprise Staff role');
    await db.insert(enterpriseStaff).values({
      id: randomUUID(),
      enterpriseId,
      staffUserId: userId,
      role: 'staff',
    });
    touchedEnterprises.add(enterpriseId);
    if (!target.organizationId && !primaryOrgToSet) primaryOrgToSet = enterpriseId;
  } else if (!enterpriseStaffRole && plainStaff.length > 0) {
    await db.delete(enterpriseStaff).where(and(eq(enterpriseStaff.staffUserId, userId), ne(enterpriseStaff.role, 'owner')));
  }

  // ── Paying User ──────────────────────────────────────────────────
  if (payingUser && clients.length === 0) {
    if (!enterpriseId) throw new Error('Pick an enterprise for the Paying User role');
    await db.insert(enterpriseClients).values({
      id: randomUUID(),
      enterpriseId,
      clientUserId: userId,
      status: 'active',
      acquisitionSource: 'manual',
    });
    touchedEnterprises.add(enterpriseId);
  } else if (!payingUser && clients.length > 0) {
    await db.delete(enterpriseClients).where(eq(enterpriseClients.clientUserId, userId));
  }

  // ── Support User ─────────────────────────────────────────────────
  if (supportUser && supports.length === 0) {
    if (!supportOrgId) throw new Error('Pick an organization for the Support User role');
    await db.insert(organizationSupportUsers).values({
      id: randomUUID(),
      organizationId: supportOrgId,
      supportUserId: userId,
      status: 'active',
    });
    if (!target.organizationId && !primaryOrgToSet) primaryOrgToSet = supportOrgId;
  } else if (!supportUser && supports.length > 0) {
    await db.delete(organizationSupportUsers).where(eq(organizationSupportUsers.supportUserId, userId));
  }

  // ── Derived primary role + primary org ───────────────────────────
  const primaryRole = enterpriseOwner
    ? 'enterprise_owner'
    : enterpriseStaffRole
      ? 'enterprise_staff'
      : payingUser
        ? 'paying_user'
        : supportUser
          ? 'support_user'
          : 'base_user';
  await db.update(users).set({ role: primaryRole }).where(eq(users.id, userId));
  if (primaryOrgToSet) {
    await db
      .update(users)
      .set({ organizationId: primaryOrgToSet, activeOrganizationId: primaryOrgToSet })
      .where(eq(users.id, userId));
  }

  await logAudit(admin.id, 'user.roles.update', 'user', userId, {
    primaryRole,
    enterpriseOwner,
    enterpriseStaff: enterpriseStaffRole,
    payingUser,
    supportUser,
    tier: enterpriseOwner ? (paidTier ?? 'regular') : null,
  });

  revalidatePath('/super-admin/all-users');
  revalidatePath(`/super-admin/all-users/${userId}`);
  for (const e of touchedEnterprises) revalidatePath(`/super-admin/enterprises/${e}`);
  redirect(`/super-admin/all-users/${userId}`);
}

export type GenerateTempPasswordState =
  | { ok: true; password: string }
  | { ok: false; error: string }
  | undefined;

export async function generateTempPasswordAction(
  _prev: GenerateTempPasswordState,
  formData: FormData,
): Promise<GenerateTempPasswordState> {
  const admin = await requireSuperAdmin();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) return { ok: false, error: 'userId required' };

  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return { ok: false, error: 'User not found' };

  // 18 url-safe characters, ~108 bits of entropy. Matches createUser.ts.
  const password = randomBytes(14).toString('base64url');

  const supabase = createServiceClient();
  const { error } = await supabase.auth.admin.updateUserById(userId, { password });
  if (error) return { ok: false, error: `Password update failed: ${error.message}` };

  await logAudit(admin.id, 'user.password.temp_generated', 'user', userId);
  return { ok: true, password };
}

export type SendPasswordResetState =
  | { ok: true; message: string }
  | { ok: false; error: string }
  | undefined;

export async function sendPasswordResetAction(
  _prev: SendPasswordResetState,
  formData: FormData,
): Promise<SendPasswordResetState> {
  const admin = await requireSuperAdmin();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) return { ok: false, error: 'userId required' };

  const [target] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return { ok: false, error: 'User not found' };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const supabase = createServiceClient();
  const { error } = await supabase.auth.resetPasswordForEmail(target.email, {
    redirectTo: `${appUrl}/reset`,
  });
  if (error) return { ok: false, error: `Reset email failed: ${error.message}` };

  await logAudit(admin.id, 'user.password.reset_sent', 'user', userId, { email: target.email });
  return { ok: true, message: `Reset email sent to ${target.email}` };
}

export async function bulkSetUserPermissionSetAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const userIds = formData.getAll('userIds').map((v) => String(v)).filter(Boolean);
  const permissionSetId = String(formData.get('permissionSetId') ?? '').trim();
  if (userIds.length === 0) throw new Error('Select at least one user');

  // For each user: clear existing permission-set assignments and apply the
  // new one (or leave cleared when permissionSetId is empty).
  for (const userId of userIds) {
    await db.delete(userPermissionSets).where(eq(userPermissionSets.userId, userId));
    if (permissionSetId) {
      await db.insert(userPermissionSets).values({
        id: randomUUID(),
        userId,
        permissionSetId,
      });
    }
  }
  await logAudit(admin.id, 'user.bulk_permission_set.assign', 'user', null, {
    count: userIds.length,
    permissionSetId: permissionSetId || null,
  });
  revalidatePath('/super-admin/all-users');
}

/**
 * Bulk-assign selected users to an enterprise. Replace semantics: each user's
 * existing enterprise_staff and enterprise_clients rows are deleted first, so
 * after this runs every selected user belongs to exactly one enterprise
 * (the one chosen here) under exactly one kind.
 *
 * `kind`:
 *   - 'staff'  → enterprise_staff row with the given `role` (default 'staff')
 *   - 'client' → enterprise_clients row with status='active', acquisitionSource='manual'
 */
export async function bulkAssignEnterpriseAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const userIds = formData.getAll('userIds').map((v) => String(v)).filter(Boolean);
  const enterpriseId = String(formData.get('enterpriseId') ?? '').trim();
  const kindRaw = String(formData.get('kind') ?? 'client').trim();
  const kind: 'staff' | 'client' = kindRaw === 'staff' ? 'staff' : 'client';
  const role = String(formData.get('role') ?? 'staff').trim() || 'staff';

  if (userIds.length === 0) throw new Error('Select at least one user');
  if (!enterpriseId) throw new Error('Pick an enterprise');

  const [ent] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);
  if (!ent) throw new Error('Enterprise not found');

  // Collect every enterprise touched so we can revalidate their pages too.
  const touchedEnterpriseIds = new Set<string>([enterpriseId]);

  for (const userId of userIds) {
    const [prevStaff, prevClient] = await Promise.all([
      db.select({ enterpriseId: enterpriseStaff.enterpriseId })
        .from(enterpriseStaff)
        .where(eq(enterpriseStaff.staffUserId, userId)),
      db.select({ enterpriseId: enterpriseClients.enterpriseId })
        .from(enterpriseClients)
        .where(eq(enterpriseClients.clientUserId, userId)),
    ]);
    for (const r of prevStaff) touchedEnterpriseIds.add(r.enterpriseId);
    for (const r of prevClient) touchedEnterpriseIds.add(r.enterpriseId);

    await db.delete(enterpriseStaff).where(eq(enterpriseStaff.staffUserId, userId));
    await db.delete(enterpriseClients).where(eq(enterpriseClients.clientUserId, userId));

    if (kind === 'staff') {
      await db.insert(enterpriseStaff).values({
        id: randomUUID(),
        enterpriseId,
        staffUserId: userId,
        role,
      });
    } else {
      await db.insert(enterpriseClients).values({
        id: randomUUID(),
        enterpriseId,
        clientUserId: userId,
        status: 'active',
        acquisitionSource: 'manual',
      });
    }
  }

  await logAudit(admin.id, 'user.bulk_enterprise.assign', 'user', null, {
    enterpriseId,
    enterpriseName: ent.name,
    kind,
    role: kind === 'staff' ? role : null,
    count: userIds.length,
    replaced: true,
  });
  revalidatePath('/super-admin/all-users');
  for (const id of touchedEnterpriseIds) {
    revalidatePath(`/super-admin/enterprises/${id}`);
  }
}

export async function setUserPermissionSetAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const userId = String(formData.get('userId') ?? '');
  const permissionSetId = String(formData.get('permissionSetId') ?? '').trim();
  if (!userId) throw new Error('userId required');

  // Replace any existing assignment(s) with the new one (or none, if cleared).
  await db.delete(userPermissionSets).where(eq(userPermissionSets.userId, userId));
  if (permissionSetId) {
    await db.insert(userPermissionSets).values({
      id: randomUUID(),
      userId,
      permissionSetId,
    });
  }
  await logAudit(admin.id, 'user.permission_set.assign', 'user', userId, { permissionSetId: permissionSetId || null });
  revalidatePath(`/super-admin/all-users/${userId}`);
}

/**
 * Set a user's self-serve accounting tier (Starter/Plus/Pro), or clear it back
 * to the grandfathered flat $89 plan when tier is empty. Funnels through
 * setUserAccountingTier so the org stamp + permission-set assignment stay in
 * lockstep. The richer per-client / bulk assignment UI for accounting pros
 * lands in Phase 4; this is the super-admin escape hatch + integration point.
 */
export async function setUserAccountingTierAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) throw new Error('userId required');

  const tierRaw = String(formData.get('accountingTier') ?? '').trim();
  // Empty string = "— Legacy $89 —" = clear the tier + permission set.
  const tier = isAccountingTierKey(tierRaw) ? tierRaw : null;
  if (tierRaw && !tier) throw new Error(`Invalid accounting tier: ${tierRaw}`);

  const result = await setUserAccountingTier(userId, tier);
  await logAudit(admin.id, 'user.accounting_tier.set', 'user', userId, {
    tier: tier ?? 'legacy_flat',
    orgId: result.orgId ?? null,
    permissionSetId: result.permissionSetId,
  });
  revalidatePath(`/super-admin/all-users/${userId}`);
}

export async function deactivateUserAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) throw new Error('userId required');
  await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
  await logAudit(admin.id, 'user.deactivate', 'user', userId);
  revalidatePath('/super-admin/all-users');
}

export async function reactivateUserAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const userId = String(formData.get('userId') ?? '');
  if (!userId) throw new Error('userId required');
  await db.update(users).set({ isActive: true }).where(eq(users.id, userId));
  await logAudit(admin.id, 'user.reactivate', 'user', userId);
  revalidatePath('/super-admin/all-users');
}

export interface DeleteUserState {
  ok?: boolean;
  error?: string;
  orgsDeleted?: number;
  totalRowsDeleted?: number;
  redirectTo?: string;
}

/**
 * Permanently delete a user. Cascades through every company they own first
 * (via deleteOrganizationCascade), then removes the user row and the
 * Supabase auth user.
 *
 * Safety rails:
 *   - confirmName must match the user's full name (or email if no name set)
 *   - super-admins cannot delete themselves
 *   - super-admins cannot delete other super-admins
 *
 * Remaining no-action FK refs (admin_audit_log entries authored by or
 * targeting this user, ai_recommendations, qbo_* user refs, etc.) are
 * bypassed via session_replication_role='replica' so the audit trail of
 * what they did is preserved even after they're gone.
 */
export async function deleteUserAction(args: {
  userId: string;
  confirmName: string;
}): Promise<DeleteUserState> {
  const admin = await requireSuperAdmin();

  try {
    if (!args.userId) return { ok: false, error: 'userId required' };
    if (args.userId === admin.id) {
      return { ok: false, error: 'You cannot delete yourself.' };
    }

    const [target] = await db
      .select({ id: users.id, email: users.email, fullName: users.fullName, role: users.role })
      .from(users)
      .where(eq(users.id, args.userId))
      .limit(1);
    if (!target) return { ok: false, error: 'User not found' };

    if (target.role === 'super_admin' || target.role === 'superadmin') {
      return { ok: false, error: 'Cannot delete another super admin from here.' };
    }

    const expectedName = (target.fullName?.trim() || target.email).trim();
    if (args.confirmName.trim() !== expectedName) {
      return { ok: false, error: 'Confirmation text does not match the user’s name.' };
    }

    // 1. Cascade-delete every organization where this user is the owner.
    const ownedOrgs = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.ownerUserId, args.userId));

    let totalRowsDeleted = 0;
    for (const o of ownedOrgs) {
      const result = await deleteOrganizationCascade(o.id);
      totalRowsDeleted += result.totalRowsDeleted;
      logger.warn(
        { orgId: o.id, name: result.organizationName, totalRowsDeleted: result.totalRowsDeleted },
        'organization deleted (user-delete cascade)',
      );
    }

    // 2. Delete the user row. We disable FK checks in this transaction so
    //    no-action references (audit log, qbo connections, etc.) don't
    //    block the delete — they're left as dangling ids on purpose so the
    //    audit trail still shows who did what.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      // Null out organizations.client_id rows pointing at this user so we
      // don't leave dangling refs on still-living orgs (different from
      // owned orgs, which we already cascade-deleted above).
      await tx.execute(
        sql`UPDATE organizations SET client_id = NULL WHERE client_id = ${args.userId}`,
      );
      await tx.delete(users).where(eq(users.id, args.userId));
    });

    // 3. Remove from Supabase auth. Best-effort: a failure here leaves the
    //    auth user orphaned but they can no longer sign in (no DB row).
    const supabase = createServiceClient();
    const { error: authErr } = await supabase.auth.admin.deleteUser(args.userId);
    if (authErr) {
      logger.warn({ userId: args.userId, err: authErr.message }, 'supabase auth deleteUser failed');
    }

    await logAudit(admin.id, 'user.delete', 'user', args.userId, {
      email: target.email,
      fullName: target.fullName,
      ownedOrgsDeleted: ownedOrgs.length,
      totalRowsDeleted,
      authDeleted: !authErr,
    });

    revalidatePath('/super-admin/all-users');
    return {
      ok: true,
      orgsDeleted: ownedOrgs.length,
      totalRowsDeleted,
      redirectTo: '/super-admin/all-users',
    };
  } catch (err) {
    logger.error({ err, userId: args.userId }, 'user delete failed');
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed' };
  }
}

export async function createPermissionSetAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  if (!name) throw new Error('Name is required');
  const id = randomUUID();
  await db.insert(permissionSets).values({ id, name, description });
  await logAudit(admin.id, 'permission_set.create', 'permission_set', id, { name });
  revalidatePath('/super-admin/permission-sets');
  redirect(`/super-admin/permission-sets/${id}`);
}

/**
 * Replace the set of permissions on a permission_set with the provided keys.
 * Auto-creates missing rows in the `permissions` table (using the catalog's
 * descriptions). Deletes and inserts in a single transaction.
 */
export async function setPermissionSetPermissionsAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const setId = String(formData.get('setId') ?? '');
  if (!setId) throw new Error('setId required');

  const keysRaw = formData.getAll('keys').map((v) => String(v)).filter(Boolean);
  const keys = Array.from(new Set(keysRaw));

  if (keys.length === 0) {
    await db.delete(permissionSetPermissions).where(eq(permissionSetPermissions.permissionSetId, setId));
    await logAudit(admin.id, 'permission_set.clear', 'permission_set', setId, { count: 0 });
    revalidatePath(`/super-admin/permission-sets/${setId}`);
    return;
  }

  // Ensure each key exists in the permissions table; auto-create from catalog.
  const existing = await db.select({ id: permissions.id, key: permissions.key }).from(permissions).where(inArray(permissions.key, keys));
  const haveKeys = new Set(existing.map((r) => r.key));
  const missing = keys.filter((k) => !haveKeys.has(k));
  if (missing.length > 0) {
    const catalog = new Map(allPermissionKeys().map((p) => [p.key, p.description]));
    const inserts = missing.map((k) => ({
      id: randomUUID(),
      key: k,
      description: catalog.get(k) ?? null,
    }));
    await db.insert(permissions).values(inserts);
  }

  // Re-read so we have ids for the brand-new rows.
  const all = await db.select({ id: permissions.id, key: permissions.key }).from(permissions).where(inArray(permissions.key, keys));
  const keyToId = new Map(all.map((r) => [r.key, r.id]));

  // Replace the join rows. Simple delete + insert; this set is small (<1k typical).
  await db.delete(permissionSetPermissions).where(eq(permissionSetPermissions.permissionSetId, setId));
  await db.insert(permissionSetPermissions).values(
    keys.map((k) => ({
      id: randomUUID(),
      permissionSetId: setId,
      permissionId: keyToId.get(k)!,
    })),
  );

  await logAudit(admin.id, 'permission_set.update', 'permission_set', setId, { count: keys.length });
  revalidatePath(`/super-admin/permission-sets/${setId}`);
}

export async function deletePermissionSetAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  await db.delete(permissionSetPermissions).where(eq(permissionSetPermissions.permissionSetId, id));
  await db.delete(permissionSets).where(eq(permissionSets.id, id));
  await logAudit(admin.id, 'permission_set.delete', 'permission_set', id);
  revalidatePath('/super-admin/permission-sets');
}

export async function updateEnterpriseAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');

  const name = String(formData.get('name') ?? '').trim();
  const domain = String(formData.get('domain') ?? '').trim() || null;
  const website = String(formData.get('website') ?? '').trim() || null;
  const orgEmail = String(formData.get('email') ?? '').trim() || null;
  const phone = String(formData.get('phone') ?? '').trim() || null;
  const planType = String(formData.get('planType') ?? '').trim() || null;
  const removeLogo = formData.get('removeLogo') === 'on';
  const entityTypeOnboardingEnabled = formData.get('entityTypeOnboardingEnabled') === 'on';

  if (!name) throw new Error('Name is required');

  // White-label subdomain (blank clears it). Validate + enforce uniqueness.
  const subdomainRaw = String(formData.get('subdomain') ?? '').trim();
  let subdomain: string | null = null;
  if (subdomainRaw) {
    const check = validateSubdomain(subdomainRaw);
    if (!check.ok) throw new Error(check.error);
    const [clash] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.subdomain, check.value), ne(organizations.id, id)))
      .limit(1);
    if (clash) throw new Error(`Subdomain "${check.value}" is already taken.`);
    subdomain = check.value;
  }

  const updates: Record<string, unknown> = {
    name,
    domain,
    subdomain,
    website,
    email: orgEmail,
    phone,
    entityTypeOnboardingEnabled,
  };
  if (planType) updates.planType = planType;

  // Handle logo upload (if any).
  const logo = formData.get('logo') as File | null;
  if (logo && typeof logo === 'object' && 'size' in logo && (logo as File).size > 0) {
    const file = logo as File;
    if (file.size > 5 * 1024 * 1024) throw new Error('Logo must be 5MB or less');
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const path = `${id}/${randomUUID()}.${ext}`;
    const supabase = createServiceClient();
    const buffer = Buffer.from(await file.arrayBuffer());
    const { error } = await supabase.storage.from(ENTERPRISE_LOGO_BUCKET).upload(path, buffer, {
      upsert: true,
      contentType: file.type || 'image/png',
    });
    if (error) {
      // Most common cause: bucket doesn't exist yet.
      throw new Error(`Logo upload failed: ${error.message}. Make sure the "${ENTERPRISE_LOGO_BUCKET}" public bucket exists in Supabase Storage.`);
    }
    const { data } = supabase.storage.from(ENTERPRISE_LOGO_BUCKET).getPublicUrl(path);
    updates.logoUrl = data.publicUrl;
  } else if (removeLogo) {
    updates.logoUrl = null;
  }

  await db.update(organizations).set(updates).where(eq(organizations.id, id));
  await logAudit(admin.id, 'enterprise.update', 'organization', id, {
    name,
    logoChanged: 'logoUrl' in updates,
  });
  revalidatePath(`/super-admin/enterprises/${id}`);
  revalidatePath('/super-admin/enterprises');
  redirect(`/super-admin/enterprises/${id}`);
}

export async function suspendEnterpriseAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  await db.update(organizations).set({ planType: 'suspended' }).where(eq(organizations.id, id));
  await logAudit(admin.id, 'enterprise.suspend', 'organization', id);
  revalidatePath(`/super-admin/enterprises/${id}`);
  revalidatePath('/super-admin/enterprises');
}

export async function reactivateEnterpriseAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  await db.update(organizations).set({ planType: 'enterprise' }).where(eq(organizations.id, id));
  await logAudit(admin.id, 'enterprise.reactivate', 'organization', id);
  revalidatePath(`/super-admin/enterprises/${id}`);
  revalidatePath('/super-admin/enterprises');
}

export async function deleteEnterpriseLogoAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  await db.update(organizations).set({ logoUrl: null }).where(eq(organizations.id, id));
  await logAudit(admin.id, 'enterprise.logo.delete', 'organization', id);
  revalidatePath('/super-admin/logos-report');
  revalidatePath(`/super-admin/enterprises/${id}`);
}

export async function deleteEnterpriseAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  await db.update(organizations).set({ planType: 'archived' }).where(eq(organizations.id, id));
  await logAudit(admin.id, 'enterprise.archive', 'organization', id);
  revalidatePath('/super-admin/enterprises');
  redirect('/super-admin/enterprises');
}

export async function removeEnterpriseStaffAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(formData.get('id') ?? '');
  const enterpriseId = String(formData.get('enterpriseId') ?? '');
  if (!id) throw new Error('id required');
  await db.delete(enterpriseStaff).where(eq(enterpriseStaff.id, id));
  await logAudit(admin.id, 'enterprise.remove_staff', 'enterprise_staff', id, { enterpriseId });
  if (enterpriseId) revalidatePath(`/super-admin/enterprises/${enterpriseId}`);
}

export async function setMaintenanceModeAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const enabled = formData.get('enabled') === 'on';
  const id = 'singleton';

  const existing = await db.select({ id: platformMaintenanceState.id }).from(platformMaintenanceState).limit(1);
  if (existing[0]) {
    await db
      .update(platformMaintenanceState)
      .set({ maintenanceMode: enabled, updatedAt: new Date().toISOString() })
      .where(eq(platformMaintenanceState.id, existing[0].id));
  } else {
    await db.insert(platformMaintenanceState).values({ id, maintenanceMode: enabled });
  }
  await logAudit(admin.id, 'maintenance.toggle', 'platform', null, { enabled });
  revalidatePath('/super-admin/settings');
}

export async function addEnterpriseStaffAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const enterpriseId = String(formData.get('enterpriseId') ?? '');
  const staffEmail = String(formData.get('staffEmail') ?? '').trim();
  const role = String(formData.get('role') ?? 'staff').trim();
  if (!enterpriseId || !staffEmail) throw new Error('enterpriseId and staffEmail required');
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, staffEmail)).limit(1);
  if (!u) throw new Error(`No user with email ${staffEmail}`);
  const id = randomUUID();
  await db.insert(enterpriseStaff).values({ id, enterpriseId, staffUserId: u.id, role });
  await logAudit(admin.id, 'enterprise.add_staff', 'enterprise_staff', id, { enterpriseId, staffEmail, role });
  revalidatePath(`/super-admin/enterprises/${enterpriseId}`);
}
