import { NextResponse } from 'next/server';
import { z } from 'zod';
import { acceptRuleAndVerify } from '@/app/(app)/transactions/_actions/approveTransaction';
import { authorizeJsonTransactionMutation, transactionMutationError } from '@/app/api/transactions/_lib/mutation-route';

const TransactionType = z.string().max(64).regex(/^[A-Za-z0-9_-]*$/).nullable();
const Body = z.object({
  pattern: z.string().trim().min(1).max(500),
  categoryAccountId: z.string().uuid(),
  transactionType: TransactionType,
}).strict();

export async function POST(request: Request) {
  const rejection = await authorizeJsonTransactionMutation(request);
  if (rejection) return rejection;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  const formData = new FormData();
  formData.set('pattern', parsed.data.pattern);
  formData.set('categoryAccountId', parsed.data.categoryAccountId);
  formData.set('transactionType', parsed.data.transactionType ?? '');
  try {
    const result = await acceptRuleAndVerify(undefined, formData);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return transactionMutationError(error);
  }
}
