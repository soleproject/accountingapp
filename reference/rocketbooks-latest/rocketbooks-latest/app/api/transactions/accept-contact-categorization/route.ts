import { NextResponse } from 'next/server';
import { z } from 'zod';
import { acceptContactCategorization } from '@/app/(app)/transactions/_actions/approveTransaction';
import { authorizeJsonTransactionMutation, transactionMutationError } from '@/app/api/transactions/_lib/mutation-route';

const TransactionType = z.string().max(64).regex(/^[A-Za-z0-9_-]*$/).nullable();
const Body = z.object({
  contactId: z.string().uuid(),
  categoryAccountId: z.string().uuid(),
  transactionType: TransactionType,
}).strict();

export async function POST(request: Request) {
  const rejection = await authorizeJsonTransactionMutation(request);
  if (rejection) return rejection;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  const formData = new FormData();
  formData.set('contactId', parsed.data.contactId);
  formData.set('categoryAccountId', parsed.data.categoryAccountId);
  formData.set('transactionType', parsed.data.transactionType ?? '');
  try {
    const result = await acceptContactCategorization(undefined, formData);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return transactionMutationError(error);
  }
}
