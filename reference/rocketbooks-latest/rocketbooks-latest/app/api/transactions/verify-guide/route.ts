import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyGuideGroup } from '@/app/(app)/transactions/_actions/approveTransaction';
import { authorizeJsonTransactionMutation, transactionMutationError } from '@/app/api/transactions/_lib/mutation-route';

const Body = z.object({
  transactionIds: z.array(z.string().uuid()).min(1).max(500),
}).strict();

export async function POST(request: Request) {
  const rejection = await authorizeJsonTransactionMutation(request);
  if (rejection) return rejection;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  try {
    const result = await verifyGuideGroup(parsed.data.transactionIds);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return transactionMutationError(error);
  }
}
