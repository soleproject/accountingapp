'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { receipts, contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

const InputSchema = z.object({
  contactId: z.string().optional().nullable(),
  receiptDate: z.iso.date(),
  totalAmount: z.coerce.number().positive(),
  memo: z.string().max(500).optional(),
});

export interface CreateReceiptState { error?: string; }

export async function createReceipt(_prev: CreateReceiptState | undefined, formData: FormData): Promise<CreateReceiptState | undefined> {
  const orgId = await getCurrentOrgId();
  const parsed = InputSchema.safeParse({
    contactId: formData.get('contactId') || null,
    receiptDate: formData.get('receiptDate'),
    totalAmount: formData.get('totalAmount'),
    memo: formData.get('memo') || undefined,
  });
  if (!parsed.success) return { error: 'Invalid input. Provide date and a positive amount.' };

  if (parsed.data.contactId) {
    const [c] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, parsed.data.contactId), eq(contacts.organizationId, orgId))).limit(1);
    if (!c) return { error: 'Vendor not in this organization' };
  }

  const id = randomUUID();
  await db.insert(receipts).values({
    id,
    organizationId: orgId,
    contactId: parsed.data.contactId ?? null,
    receiptDate: parsed.data.receiptDate,
    totalAmount: parsed.data.totalAmount,
    memo: parsed.data.memo ?? null,
    status: 'draft',
    posted: false,
  });

  revalidatePath('/receipts');
  redirect(`/receipts`);
}
