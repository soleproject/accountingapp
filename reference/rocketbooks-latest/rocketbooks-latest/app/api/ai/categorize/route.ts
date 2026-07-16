import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { categorizeTransaction } from '@/lib/ai/categorization';

export const maxDuration = 60;

const Body = z.object({ transactionId: z.string().min(1) });

export async function POST(req: NextRequest) {
  const orgId = await getCurrentOrgId();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const [txn] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, parsed.data.transactionId), eq(transactions.organizationId, orgId)))
    .limit(1);
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  if (txn.amount == null) return NextResponse.json({ error: 'Transaction has no amount' }, { status: 400 });
  if (!txn.type) return NextResponse.json({ error: 'Transaction has no type' }, { status: 400 });

  const result = await categorizeTransaction({
    organizationId: orgId,
    description: txn.userDescription || txn.bankDescription || txn.description || '',
    amount: txn.amount,
    type: txn.type,
    date: txn.date,
  });

  return NextResponse.json(result);
}
