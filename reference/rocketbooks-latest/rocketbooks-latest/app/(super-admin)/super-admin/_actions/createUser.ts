'use server';

import { randomUUID, randomBytes } from 'crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  organizations,
  enterpriseStaff,
  enterpriseClients,
  organizationSupportUsers,
  permissionSets,
  userPermissionSets,
  adminAuditLog,
} from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/org';
import { createServiceClient } from '@/lib/supabase/service';
import { seedDefaultCoa } from '@/lib/accounting/seed-default-coa';
import { toOrgEntityType } from '@/lib/orgs/entity-type';
import { isEnterpriseTierKey } from '@/lib/enterprise/tiers';
import { recordInitialClientRevenueShare } from '@/lib/enterprise/revenue-share';

type PasswordMode = 'invite' | 'auto' | 'manual';
type OrgMode = 'now' | 'later';

interface CreateUserResult {
  ok: boolean;
  error?: string;
  /** Temp password to surface on the success page when passwordMode='auto'. */
  tempPassword?: string;
  userId?: string;
}

function generatePassword(): string {
  // 18 url-safe characters, ~108 bits of entropy.
  return randomBytes(14).toString('base64url');
}

async function logAudit(adminUserId: string, action: string, targetId: string | null, metadata?: Record<string, unknown>) {
  await db.insert(adminAuditLog).values({
    id: randomUUID(),
    adminUserId,
    action,
    targetType: 'user',
    targetId,
    auditMetadata: metadata ?? null,
  });
}

export async function createUserAction(formData: FormData): Promise<void> {
  const sessionUser = await requireSession();
  if (!(await isSuperAdmin())) throw new Error('forbidden');

  const fullName = String(formData.get('fullName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const permissionSetId = String(formData.get('permissionSetId') ?? '').trim() || null;
  const passwordMode = (String(formData.get('passwordMode') ?? 'invite') as PasswordMode);
  const explicitPassword = String(formData.get('password') ?? '');

  const baseUser = formData.get('role_baseUser') === 'on';
  const enterpriseOwner = formData.get('role_enterpriseOwner') === 'on';
  const enterpriseOwnerDemo = formData.get('role_enterpriseOwnerDemo') === 'on';
  const enterpriseStaffRole = formData.get('role_enterpriseStaff') === 'on';
  const payingUser = formData.get('role_payingUser') === 'on';
  const supportUser = formData.get('role_supportUser') === 'on';

  const enterpriseId = String(formData.get('enterpriseId') ?? '').trim() || null;
  const newEnterpriseName = String(formData.get('newEnterpriseName') ?? '').trim() || null;
  const submittedTierRaw = String(formData.get('enterpriseTier') ?? '').trim();
  const submittedTier = isEnterpriseTierKey(submittedTierRaw) ? submittedTierRaw : null;
  // "Regular" is an explicit no-tier choice: the enterprise is created
  // untiered (enterprise_tier = NULL → referral model, no monthly platform
  // fee, no company cap) and the owner picks private-label / client billing
  // for themselves in /enterprise/onboarding. Distinct from "forgot to pick",
  // which still errors below.
  const isRegularTier = submittedTierRaw === 'regular';

  const orgMode = (String(formData.get('orgMode') ?? 'later') as OrgMode);
  const companyName = String(formData.get('companyName') ?? '').trim();
  const companyType = String(formData.get('companyType') ?? '').trim() || null;
  const industry = String(formData.get('industry') ?? '').trim() || null;
  const companyStatus = String(formData.get('companyStatus') ?? 'active').trim();

  const supportOrgId = String(formData.get('supportOrgId') ?? '').trim() || null;

  if (!fullName) throw new Error('Full name is required');
  if (!email) throw new Error('Email is required');
  if (!email.includes('@')) throw new Error('Email is not valid');
  if (passwordMode === 'manual' && explicitPassword.length < 8) {
    throw new Error('Manual password must be at least 8 characters');
  }
  if (!baseUser && !enterpriseOwner && !enterpriseOwnerDemo && !enterpriseStaffRole && !payingUser && !supportUser) {
    throw new Error('Pick at least one role');
  }
  if (enterpriseOwnerDemo && (baseUser || enterpriseOwner || enterpriseStaffRole || payingUser || supportUser)) {
    throw new Error('Enterprise Owner Demo cannot be combined with other roles');
  }
  if ((enterpriseOwner || enterpriseStaffRole || payingUser) && !enterpriseId && !newEnterpriseName) {
    throw new Error('Choose or create an enterprise for this user');
  }
  // A tier choice is required when creating a brand-new enterprise alongside
  // an Enterprise Owner — but "Regular" (untiered/referral) counts as a valid
  // choice. Picking an existing enterprise inherits whatever tier (if any) is
  // already on it — the form locks the radio to that value.
  if (enterpriseOwner && !enterpriseId && newEnterpriseName && !submittedTier && !isRegularTier) {
    throw new Error('Pick an enterprise tier for the new enterprise');
  }
  if (supportUser && !supportOrgId) {
    throw new Error('Select an organization for the support user');
  }
  if (payingUser && orgMode === 'now' && !companyName) {
    throw new Error('Company name is required when creating organization now');
  }

  // Make sure email isn't already taken.
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new Error(`A user with email ${email} already exists`);

  // 1. Create the auth user.
  const supabase = createServiceClient();
  const tempPassword = passwordMode === 'auto' ? generatePassword() : null;

  let authUserId: string;
  if (passwordMode === 'invite') {
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
    });
    if (error) throw new Error(`Auth invite failed: ${error.message}`);
    authUserId = data.user!.id;
  } else {
    const password = passwordMode === 'auto' ? tempPassword! : explicitPassword;
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw new Error(`Auth create failed: ${error.message}`);
    authUserId = data.user!.id;
  }

  // Derive a primary role for users.role compatibility.
  const primaryRole = enterpriseOwnerDemo
    ? 'enterprise_owner_demo'
    : enterpriseOwner
      ? 'enterprise_owner'
      : enterpriseStaffRole
        ? 'enterprise_staff'
        : payingUser
          ? 'paying_user'
          : supportUser
            ? 'support_user'
            : 'base_user';

  // 2. Insert our app users row.
  await db.insert(users).values({
    id: authUserId,
    email,
    fullName,
    passwordHash: 'supabase', // managed by Supabase Auth
    isActive: true,
    role: primaryRole,
  });

  // 3. Create or resolve the enterprise if needed.
  let resolvedEnterpriseId: string | null = enterpriseId;
  if (enterpriseOwnerDemo) {
    // Demo always gets a freshly-minted enterprise -- never reuse a picker
    // selection, even if one was submitted. Matches the /signup behavior.
    resolvedEnterpriseId = randomUUID();
    const demoName = `${fullName}'s Demo`;
    await db.insert(organizations).values({
      id: resolvedEnterpriseId,
      name: demoName,
      ownerUserId: authUserId,
      planType: 'enterprise',
    });
    await logAudit(sessionUser.id, 'enterprise.create', resolvedEnterpriseId, { name: demoName, demo: true });
    // Seed the default chart of accounts so the demo enterprise dashboard
    // and AI-chat onboarding have categories to work with immediately.
    // Idempotent + non-fatal -- mirrors the /signup behavior.
    try {
      await seedDefaultCoa({ organizationId: resolvedEnterpriseId });
    } catch (seedErr) {
      console.error('Failed to seed default CoA on demo enterprise', resolvedEnterpriseId, seedErr);
    }
  } else if (!resolvedEnterpriseId && newEnterpriseName) {
    resolvedEnterpriseId = randomUUID();
    await db.insert(organizations).values({
      id: resolvedEnterpriseId,
      name: newEnterpriseName,
      ownerUserId: authUserId,
      planType: 'enterprise',
      // Tier is required upstream when enterpriseOwner is checked for a new
      // enterprise. Other role combinations (e.g. creating a new enterprise
      // for an enterprise_staff or paying_user without an Enterprise Owner)
      // are allowed to leave it null and configure later.
      enterpriseTier: submittedTier,
      privateLabelEnabled: submittedTier !== null,
    });
    await logAudit(sessionUser.id, 'enterprise.create', resolvedEnterpriseId, {
      name: newEnterpriseName,
      tier: submittedTier,
    });
  }

  // 4. Assign permission set.
  if (permissionSetId) {
    const [ps] = await db.select({ id: permissionSets.id }).from(permissionSets).where(eq(permissionSets.id, permissionSetId)).limit(1);
    if (ps) {
      await db.insert(userPermissionSets).values({
        id: randomUUID(),
        userId: authUserId,
        permissionSetId: ps.id,
      });
    }
  }

  // 5. Apply role assignments. Track which org should become the user's
  // primary so we can set users.organizationId at the end — without this,
  // getCurrentOrgId() throws on first sign-in.
  let primaryOrgId: string | null = null;

  if (enterpriseOwner && resolvedEnterpriseId) {
    await db.insert(enterpriseStaff).values({
      id: randomUUID(),
      enterpriseId: resolvedEnterpriseId,
      staffUserId: authUserId,
      role: 'owner',
    });
    // Enterprise owner's primary org is the enterprise they head.
    if (!primaryOrgId) primaryOrgId = resolvedEnterpriseId;
  }
  if (enterpriseOwnerDemo && resolvedEnterpriseId) {
    // Mirrors the /signup path: own the auto-created demo enterprise.
    // No trial subscription row is created here -- that's deferred until
    // the demo user creates their one client (enforced by the enterprise
    // createUser action's demo branch).
    await db.insert(enterpriseStaff).values({
      id: randomUUID(),
      enterpriseId: resolvedEnterpriseId,
      staffUserId: authUserId,
      role: 'owner',
    });
    if (!primaryOrgId) primaryOrgId = resolvedEnterpriseId;
  }
  if (enterpriseStaffRole && resolvedEnterpriseId) {
    await db.insert(enterpriseStaff).values({
      id: randomUUID(),
      enterpriseId: resolvedEnterpriseId,
      staffUserId: authUserId,
      role: 'staff',
    });
    // Enterprise staff default into the enterprise org so the dashboard loads.
    if (!primaryOrgId) primaryOrgId = resolvedEnterpriseId;
  }
  if (payingUser && resolvedEnterpriseId) {
    await db.insert(enterpriseClients).values({
      id: randomUUID(),
      enterpriseId: resolvedEnterpriseId,
      clientUserId: authUserId,
      status: 'active',
      acquisitionSource: 'manual',
    });
    if (orgMode === 'now') {
      const orgId = randomUUID();
      await db.insert(organizations).values({
        id: orgId,
        name: companyName,
        ownerUserId: authUserId,
        planType: 'pro',
        entityType: toOrgEntityType(companyType),
        businessDescription: industry,
      });
      await logAudit(sessionUser.id, 'organization.create', orgId, {
        for: authUserId,
        name: companyName,
        active: companyStatus === 'active',
      });
      // Stamp an initial revenue-share ledger row when the enterprise has
      // a tier. No-op for legacy enterprises pre-tier-rollout. Non-fatal —
      // a failure here shouldn't abort the user creation; the periodic
      // billing job will reconcile.
      try {
        await recordInitialClientRevenueShare({
          enterpriseId: resolvedEnterpriseId,
          clientOrganizationId: orgId,
        });
      } catch (rsErr) {
        console.error('Failed to record initial revenue share for client', orgId, rsErr);
      }
      // Paying user lands in the company they own.
      primaryOrgId = orgId;
    }
    // 'later' mode: leave the user without an organization_id. On first
    // sign-in getCurrentOrgId routes them into the read-only demo workspace
    // (with a banner prompting them to create their own from /businesses).
  }
  if (supportUser && supportOrgId) {
    await db.insert(organizationSupportUsers).values({
      id: randomUUID(),
      organizationId: supportOrgId,
      supportUserId: authUserId,
      status: 'active',
    });
    if (!primaryOrgId) primaryOrgId = supportOrgId;
  }

  // 6. Set the user's organizationId so first sign-in works.
  if (primaryOrgId) {
    await db
      .update(users)
      .set({ organizationId: primaryOrgId, activeOrganizationId: primaryOrgId })
      .where(eq(users.id, authUserId));
  }

  await logAudit(sessionUser.id, 'user.create', authUserId, {
    email,
    primaryRole,
    passwordMode,
    enterpriseId: resolvedEnterpriseId,
    primaryOrgId,
  });

  revalidatePath('/super-admin/all-users');

  // Surface the temp password (if generated) via query string on the redirect.
  // The destination page reads it once and shows the admin so they can share it.
  if (tempPassword) {
    redirect(`/super-admin/all-users?created=${authUserId}&temp=${encodeURIComponent(tempPassword)}`);
  }
  redirect(`/super-admin/all-users?created=${authUserId}`);
}

// Suppress unused warning during typecheck.
void ({} as CreateUserResult);
