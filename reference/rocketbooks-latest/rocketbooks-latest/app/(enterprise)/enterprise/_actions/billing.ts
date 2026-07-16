'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseStaff, enterpriseClients, organizationBilling, adminAuditLog } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { effectiveClientBilling } from '@/lib/enterprise/client-billing';
import { chargeCustomerOneOff } from '@/lib/stripe/charges';

export interface ChargeClientState {
  ok?: boolean;
  message?: string;
  error?: string;
}

/** Safety cap so a fat-fingered amount can't run away. */
const MAX_CHARGE_CENTS = 1_000_000; // $10,000

/**
 * Verify the signed-in user owns/staffs the firm this client belongs to, and
 * return the firm id + this client's per-client billing override. Mirrors the
 * guard in _actions/clients.ts (private there).
 */
async function requireClientAccess(
  targetUserId: string,
): Promise<{ realUserId: string; enterpriseId: string; clientMode: string | null; clientPrice: string | null }> {
  const real = await requireSession();
  if (!targetUserId) throw new Error('forbidden');
  const [owned, staffed] = await Promise.all([
    db.select({ id: organizations.id }).from(organizations).where(eq(organizations.ownerUserId, real.id)),
    db.select({ id: enterpriseStaff.enterpriseId }).from(enterpriseStaff).where(eq(enterpriseStaff.staffUserId, real.id)),
  ]);
  const enterpriseIds = Array.from(new Set([...owned.map((o) => o.id), ...staffed.map((s) => s.id)]));
  if (enterpriseIds.length === 0) throw new Error('forbidden');
  const [link] = await db
    .select({
      enterpriseId: enterpriseClients.enterpriseId,
      clientMode: enterpriseClients.clientBillingMode,
      clientPrice: enterpriseClients.clientPriceMode,
    })
    .from(enterpriseClients)
    .where(and(eq(enterpriseClients.clientUserId, targetUserId), inArray(enterpriseClients.enterpriseId, enterpriseIds)))
    .limit(1);
  if (!link) throw new Error('forbidden');
  return { realUserId: real.id, enterpriseId: link.enterpriseId, clientMode: link.clientMode, clientPrice: link.clientPrice };
}

/**
 * Manually charge a client a one-off amount. The card charged is whoever pays
 * for the client: their own card (client-pays) or the firm's card (firm-paid).
 * Creates a finalized + paid Stripe invoice (receipt + history), idempotent via
 * the form token, audit-logged.
 */
export async function chargeClientAction(
  _prev: ChargeClientState | undefined,
  formData: FormData,
): Promise<ChargeClientState> {
  const clientUserId = String(formData.get('clientUserId') ?? '').trim();
  const token = String(formData.get('token') ?? '').trim() || randomUUID();
  const description = String(formData.get('description') ?? '').trim();
  const amountStr = String(formData.get('amount') ?? '').trim();

  let access;
  try {
    access = await requireClientAccess(clientUserId);
  } catch {
    return { error: 'You do not have access to this client.' };
  }

  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Enter an amount greater than $0.' };
  const amountCents = Math.round(amount * 100);
  if (amountCents > MAX_CHARGE_CENTS) return { error: 'That exceeds the $10,000 one-off limit.' };
  if (!description) return { error: 'Add a short description for the charge.' };

  const [firm] = await db
    .select({ mode: organizations.clientBillingMode, price: organizations.clientPriceMode })
    .from(organizations)
    .where(eq(organizations.id, access.enterpriseId))
    .limit(1);
  const [clientOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.ownerUserId, clientUserId))
    .limit(1);
  if (!clientOrg) return { error: 'This client has no company to bill yet.' };

  const { billingMode } = effectiveClientBilling({
    enterpriseMode: firm?.mode ?? null,
    enterprisePrice: firm?.price ?? null,
    clientMode: access.clientMode,
    clientPrice: access.clientPrice,
  });
  // "Whoever pays": firm-paid → the firm's customer; otherwise the client's own.
  const payingOrgId = billingMode === 'firm_pays' ? access.enterpriseId : clientOrg.id;

  const [billing] = await db
    .select({ customerId: organizationBilling.stripeCustomerId })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, payingOrgId))
    .limit(1);
  if (!billing?.customerId) return { error: 'No card on file for whoever pays this client.' };

  const res = await chargeCustomerOneOff({
    customerId: billing.customerId,
    amountCents,
    description,
    clientOrgId: clientOrg.id,
    idempotencyKey: `charge_${clientUserId}_${token}`,
  });
  if (!res.ok) return { error: res.error ?? 'The charge did not go through.' };

  await db.insert(adminAuditLog).values({
    id: randomUUID(),
    adminUserId: access.realUserId,
    action: 'enterprise.client.charge',
    targetType: 'user',
    targetId: clientUserId,
    auditMetadata: {
      enterpriseId: access.enterpriseId,
      clientOrgId: clientOrg.id,
      amountCents,
      paidBy: billingMode,
      invoiceId: res.invoiceId ?? null,
    },
  });

  revalidatePath(`/enterprise/billing/${clientUserId}`);
  return { ok: true, message: `Charged $${amount.toFixed(2)}.` };
}
