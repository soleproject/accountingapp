'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { enterpriseStaff, organizations, users, adminAuditLog } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';

interface StaffManageContext {
  realUserId: string;
  enterpriseId: string;
  staffUserId: string;
  role: string;
}

/**
 * Authorize managing a single staff row and load its context. The signed-in
 * user must be a super admin, or the owner of the enterprise org the staff row
 * belongs to. A member can never archive/delete their own membership (that
 * would let someone lock themselves out or orphan the last owner).
 *
 * Uses the *real* session identity (not the impersonated one) so the audit
 * trail records who actually performed the change.
 */
async function requireStaffManageAccess(staffId: string): Promise<StaffManageContext> {
  const real = await requireSession();
  if (!staffId) throw new Error('staffId required');

  const [staff] = await db
    .select({
      enterpriseId: enterpriseStaff.enterpriseId,
      staffUserId: enterpriseStaff.staffUserId,
      role: enterpriseStaff.role,
    })
    .from(enterpriseStaff)
    .where(eq(enterpriseStaff.id, staffId))
    .limit(1);
  if (!staff) throw new Error('Staff member not found');

  if (staff.staffUserId === real.id) {
    throw new Error('You cannot archive or remove your own staff membership');
  }

  const [profile] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, real.id))
    .limit(1);
  const isSuper = profile?.role === 'super_admin' || profile?.role === 'superadmin';

  if (!isSuper) {
    // Only the enterprise owner (or a super admin) may manage staff.
    const [org] = await db
      .select({ ownerUserId: organizations.ownerUserId })
      .from(organizations)
      .where(eq(organizations.id, staff.enterpriseId))
      .limit(1);
    if (!org || org.ownerUserId !== real.id) {
      throw new Error('forbidden');
    }
  }

  return {
    realUserId: real.id,
    enterpriseId: staff.enterpriseId,
    staffUserId: staff.staffUserId,
    role: staff.role,
  };
}

async function logAudit(adminUserId: string, action: string, targetId: string, metadata: Record<string, unknown>) {
  await db.insert(adminAuditLog).values({
    id: randomUUID(),
    adminUserId,
    action,
    targetType: 'user',
    targetId,
    auditMetadata: metadata,
  });
}

/** Soft-remove: revoke firm access but keep the record so it can be restored. */
export async function archiveEnterpriseStaffAction(formData: FormData): Promise<void> {
  const staffId = String(formData.get('staffId') ?? '');
  const ctx = await requireStaffManageAccess(staffId);
  await db
    .update(enterpriseStaff)
    .set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(enterpriseStaff.id, staffId));
  await logAudit(ctx.realUserId, 'enterprise.staff.archive', ctx.staffUserId, {
    staffId,
    enterpriseId: ctx.enterpriseId,
    role: ctx.role,
  });
  revalidatePath('/enterprise/staff');
}

/** Restore an archived staff member's firm access. */
export async function restoreEnterpriseStaffAction(formData: FormData): Promise<void> {
  const staffId = String(formData.get('staffId') ?? '');
  const ctx = await requireStaffManageAccess(staffId);
  await db
    .update(enterpriseStaff)
    .set({ archivedAt: null, updatedAt: new Date().toISOString() })
    .where(eq(enterpriseStaff.id, staffId));
  await logAudit(ctx.realUserId, 'enterprise.staff.restore', ctx.staffUserId, {
    staffId,
    enterpriseId: ctx.enterpriseId,
    role: ctx.role,
  });
  revalidatePath('/enterprise/staff');
}

/** Hard-remove: permanently delete the membership row. */
export async function deleteEnterpriseStaffAction(formData: FormData): Promise<void> {
  const staffId = String(formData.get('staffId') ?? '');
  const ctx = await requireStaffManageAccess(staffId);
  await db.delete(enterpriseStaff).where(eq(enterpriseStaff.id, staffId));
  await logAudit(ctx.realUserId, 'enterprise.staff.delete', ctx.staffUserId, {
    staffId,
    enterpriseId: ctx.enterpriseId,
    role: ctx.role,
  });
  revalidatePath('/enterprise/staff');
}
