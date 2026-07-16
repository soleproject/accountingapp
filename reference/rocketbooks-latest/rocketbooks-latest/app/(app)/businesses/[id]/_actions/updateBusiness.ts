'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { listAccessibleOrgs } from '@/lib/auth/org';

const AddressSchema = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    city: z.string().max(120).optional(),
    state: z.string().max(120).optional(),
    postal: z.string().max(40).optional(),
    country: z.string().max(120).optional(),
  })
  .partial();

const InputSchema = z.object({
  name: z.string().min(1).max(120),
  businessDescription: z.string().max(500).optional(),
  accountingMethod: z.enum(['accrual', 'cash']),
  email: z.string().email().max(200).optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().max(60).optional(),
  fax: z.string().max(60).optional(),
  website: z.string().max(200).optional(),
  address: AddressSchema.optional(),
});

export interface UpdateBusinessState {
  error?: string;
}

export async function updateBusiness(
  orgIdParam: string,
  _prev: UpdateBusinessState | undefined,
  formData: FormData,
): Promise<UpdateBusinessState | undefined> {
  // Authorization: the user must have access to this org.
  const orgs = await listAccessibleOrgs();
  const target = orgs.find((o) => o.id === orgIdParam);
  if (!target) return { error: 'Business not found or you don\'t have access' };
  if (target.role !== 'owner') {
    return { error: 'Only owners can edit business details.' };
  }

  const addressInput = {
    line1: (formData.get('address.line1') as string) || undefined,
    line2: (formData.get('address.line2') as string) || undefined,
    city: (formData.get('address.city') as string) || undefined,
    state: (formData.get('address.state') as string) || undefined,
    postal: (formData.get('address.postal') as string) || undefined,
    country: (formData.get('address.country') as string) || undefined,
  };
  const hasAddress = Object.values(addressInput).some((v) => v && v.trim() !== '');

  const parsed = InputSchema.safeParse({
    name: formData.get('name'),
    businessDescription: formData.get('businessDescription') || undefined,
    accountingMethod: formData.get('accountingMethod'),
    email: formData.get('email') || undefined,
    phone: formData.get('phone') || undefined,
    fax: formData.get('fax') || undefined,
    website: formData.get('website') || undefined,
    address: hasAddress ? addressInput : undefined,
  });
  if (!parsed.success) {
    return { error: 'Invalid input. Check email format.' };
  }

  await db
    .update(organizations)
    .set({
      name: parsed.data.name,
      businessDescription: parsed.data.businessDescription ?? null,
      accountingMethod: parsed.data.accountingMethod,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      fax: parsed.data.fax ?? null,
      website: parsed.data.website ?? null,
      address: parsed.data.address ?? null,
    })
    .where(eq(organizations.id, orgIdParam));

  revalidatePath('/businesses');
  revalidatePath(`/businesses/${orgIdParam}/edit`);
  redirect('/businesses');
}
