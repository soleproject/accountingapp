import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/permissions';
import { DemoModeError } from '@/lib/auth/demo';
import { validateJsonSameOrigin } from '@/app/api/transactions/_lib/request-guard';

export async function authorizeJsonTransactionMutation(request: Request): Promise<NextResponse | null> {
  const requestRejection = validateJsonSameOrigin(request);
  if (requestRejection) {
    return NextResponse.json({ error: requestRejection.error }, { status: requestRejection.status });
  }

  try {
    await requirePermission('accounting.transactions.view');
  } catch {
    return NextResponse.json({ error: 'Not authorized.' }, { status: 403 });
  }
  return null;
}

export function transactionMutationError(error: unknown): NextResponse {
  if (error instanceof DemoModeError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  return NextResponse.json({ error: 'The transaction operation could not be completed.' }, { status: 500 });
}
