'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { enqueueOutbound, fireOutboundDrain } from '@/lib/qbo/mirror/outbound';
import { serializeContactToCustomer, serializeContactToVendor } from '@/lib/qbo/mirror/serializers';

const Schema = z.object({
  contactName: z.string().min(1).max(200),
  companyName: z.string().max(200).optional(),
  email: z.email().optional().or(z.literal('')),
  phone: z.string().max(50).optional(),
  typeTags: z.array(z.string()).default([]),
  taxId: z.string().max(40).optional(),
  w9Status: z.enum(['not_requested', 'requested', 'on_file']).default('not_requested'),
  is1099Eligible: z.boolean().default(false),
});

export interface CreateContactState { error?: string; }

export async function createContact(_prev: CreateContactState | undefined, formData: FormData): Promise<CreateContactState | undefined> {
  const orgId = await getCurrentOrgId();

  const tags: string[] = [];
  if (formData.get('isCustomer') === 'on') tags.push('customer');
  if (formData.get('isVendor') === 'on') tags.push('vendor');
  if (formData.get('isTrustee') === 'on') tags.push('trustee');

  const parsed = Schema.safeParse({
    contactName: formData.get('contactName'),
    companyName: formData.get('companyName') || undefined,
    email: formData.get('email') || '',
    phone: formData.get('phone') || undefined,
    typeTags: tags,
    taxId: formData.get('taxId') || undefined,
    w9Status: formData.get('w9Status') || 'not_requested',
    is1099Eligible: formData.get('is1099Eligible') === 'on',
  });
  if (!parsed.success) return { error: 'Invalid input — contact name is required' };

  const id = randomUUID();
  const row = {
    id,
    organizationId: orgId,
    contactName: parsed.data.contactName,
    companyName: parsed.data.companyName ?? null,
    email: parsed.data.email && parsed.data.email !== '' ? parsed.data.email : null,
    phone: parsed.data.phone ?? null,
    typeTags: parsed.data.typeTags,
    isActive: true,
    taxId: parsed.data.taxId ?? null,
    w9Status: parsed.data.w9Status,
    is1099Eligible: parsed.data.is1099Eligible,
  };

  // Insert + outbound enqueue ride the same transaction so a failure
  // anywhere rolls both back. A contact tagged both customer and vendor
  // enqueues two rows — QBO models those as separate entities, with their
  // own ids and SyncTokens.
  const queueIds = await db.transaction(async (tx) => {
    await tx.insert(contacts).values(row);
    const enqueued: string[] = [];
    // Cast contact-shape passed to serializers to the full inferred select
    // type; the missing fields (timestamps, ai flags) aren't read by the
    // serializer.
    const fakeFullRow = { ...row, address: null, isTemporary: null, createdByAi: null, systemGenerated: null, needsReview: null, logoUrl: null, individualName: null, createdAt: '', updatedAt: '', reviewed: null, isWidelyKnown: false, coaAiMatch: null, coaAiMatchStatus: 'pending' as const, correctWidelyKnownReview: null, trusteeRole: null, trusteeEffectiveDate: null, trusteeRemovedAt: null, ai1099Suggestion: null, ai1099Reason: null, ai1099SuggestedAt: null };
    if (parsed.data.typeTags.includes('customer')) {
      const qid = await enqueueOutbound(tx, {
        organizationId: orgId,
        entityType: 'customer',
        localId: id,
        operation: 'create',
        payload: serializeContactToCustomer(fakeFullRow) as unknown as Record<string, unknown>,
      });
      if (qid) enqueued.push(qid);
    }
    if (parsed.data.typeTags.includes('vendor')) {
      const qid = await enqueueOutbound(tx, {
        organizationId: orgId,
        entityType: 'vendor',
        localId: id,
        operation: 'create',
        payload: serializeContactToVendor(fakeFullRow) as unknown as Record<string, unknown>,
      });
      if (qid) enqueued.push(qid);
    }
    return enqueued;
  });

  // Fire the drain event AFTER the transaction commits. If we fired
  // inside the tx and the tx rolled back, the event would still go out
  // referencing rows that don't exist.
  await fireOutboundDrain(queueIds);

  revalidatePath('/contacts');
  redirect(`/contacts`);
}
