import 'server-only';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, organizations, enterpriseStaff, adminAuditLog } from '@/db/schema/schema';
import { createServiceClient } from '@/lib/supabase/service';

export interface PerformEnterpriseSignupInput {
  fullName: string;
  email: string;
  password: string;
  /** The accounting firm's name — becomes the enterprise org name. */
  firmName: string;
  /**
   * Optional intake field from the marketing form ("Number of Clients").
   * Not required to provision a usable account; persisted to the audit log
   * when present so sales/onboarding can see it later.
   */
  clientCount?: number | null;
  /** Source label written to the audit log. */
  source?: 'app_signup' | 'marketing_form';
}

export type PerformEnterpriseSignupResult =
  | { ok: true; userId: string; enterpriseId: string }
  | { ok: false; error: string; status: number };

/**
 * Self-serve provisioning for a "Regular" Enterprise Owner — the public
 * counterpart to the super-admin "create Enterprise Owner / Regular tier"
 * path in app/(super-admin)/super-admin/_actions/createUser.ts. Mirrors that
 * action's new-enterprise branch exactly:
 *
 *   - users row, role='enterprise_owner', organization_id = the new enterprise
 *   - organizations row, planType='enterprise', enterprise_tier=NULL,
 *     private_label_enabled=false (Regular = no platform fee; the owner picks
 *     private label & client pricing during /enterprise/onboarding and earns
 *     the flat 20% referral share per paying client)
 *   - enterprise_staff row, role='owner' (the membership row that, together
 *     with ownerUserId, grants /enterprise access)
 *
 * No subscription row is created — Regular owners pay no monthly platform fee.
 * Everything runs in one transaction; the auth user is rolled back on failure.
 */
export async function performEnterpriseSignup(
  input: PerformEnterpriseSignupInput,
): Promise<PerformEnterpriseSignupResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const firmName = input.firmName.trim();
  const password = input.password;
  const source = input.source ?? 'app_signup';
  const clientCount =
    typeof input.clientCount === 'number' && Number.isFinite(input.clientCount)
      ? input.clientCount
      : null;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    return { ok: false, status: 409, error: `A user with email ${email} already exists` };
  }

  const service = createServiceClient();
  const { data, error: authErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (authErr || !data.user) {
    return {
      ok: false,
      status: 400,
      error: `Signup failed: ${authErr?.message ?? 'unknown auth error'}`,
    };
  }
  const authUserId = data.user.id;
  const enterpriseId = randomUUID();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: authUserId,
        email,
        fullName,
        passwordHash: 'supabase',
        isActive: true,
        role: 'enterprise_owner',
      });

      await tx.insert(organizations).values({
        id: enterpriseId,
        name: firmName,
        ownerUserId: authUserId,
        planType: 'enterprise',
        // Regular tier: no paid tier key, no private label until the owner
        // opts in during onboarding. enterprise_tier's CHECK only permits the
        // paid keys, so NULL is the correct "untiered / referral" value.
        enterpriseTier: null,
        privateLabelEnabled: false,
      });

      // Membership row — required for /enterprise access (role flip alone
      // doesn't grant it). The owner also owns the org via ownerUserId above.
      await tx.insert(enterpriseStaff).values({
        id: randomUUID(),
        enterpriseId,
        staffUserId: authUserId,
        role: 'owner',
      });

      // The enterprise they head is their primary org context — without this,
      // getCurrentOrgId() throws on first sign-in.
      await tx
        .update(users)
        .set({ organizationId: enterpriseId, activeOrganizationId: enterpriseId })
        .where(eq(users.id, authUserId));

      await tx.insert(adminAuditLog).values({
        id: randomUUID(),
        adminUserId: authUserId,
        action: 'enterprise.signup',
        targetType: 'user',
        targetId: authUserId,
        auditMetadata: {
          email,
          enterpriseId,
          firmName,
          tier: 'regular',
          source,
          ...(clientCount != null ? { clientCount } : {}),
        },
      });
    });
  } catch (err) {
    try {
      await service.auth.admin.deleteUser(authUserId);
    } catch (deleteErr) {
      console.error('Failed to roll back Supabase auth user', authUserId, deleteErr);
    }
    const message = err instanceof Error ? err.message : 'Signup failed';
    return { ok: false, status: 500, error: message };
  }

  return { ok: true, userId: authUserId, enterpriseId };
}
