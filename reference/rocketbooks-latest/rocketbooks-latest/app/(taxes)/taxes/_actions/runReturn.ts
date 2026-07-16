'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { executeTaxIntakeTool } from '@/lib/tax/intake-tools';

export interface RunReturnState {
  error?: string;
  ranAt?: number;
  /** True while the crawl still has queued work — the workspace poller keeps ticking. */
  stillWorking?: boolean;
}

/**
 * Start a return's crawl from its workspace (bounded first batch), then revalidate so the
 * form tree renders. When stillWorking is true the client keeps calling tickReturnAction
 * until the queue drains — so a 6-8 form fan-out never exceeds the request time limit.
 */
export async function runReturnAction(
  _prev: RunReturnState | undefined,
  formData: FormData,
): Promise<RunReturnState> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const returnId = String(formData.get('return_id') ?? '');
  if (!returnId) return { error: 'Missing return id.' };

  const result = (await executeTaxIntakeTool(
    { organizationId: orgId },
    'run_tax_return',
    { return_id: returnId },
  )) as { ok?: boolean; error?: string; stillWorking?: boolean };

  if (!result?.ok) return { error: result?.error ?? 'Could not run the return.' };
  revalidatePath(`/taxes/${returnId}`);
  return { ranAt: Date.now(), stillWorking: Boolean(result.stillWorking) };
}

export interface TickReturnState {
  ok?: boolean;
  stillWorking?: boolean;
  error?: string;
}

/**
 * Advance an in-progress crawl one bounded batch — called repeatedly by the workspace
 * poller while stillWorking is true. Revalidates so each tick's progress (forms moving
 * acquiring → filled) shows on refresh.
 */
export async function tickReturnAction(returnId: string): Promise<TickReturnState> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (!returnId) return { error: 'Missing return id.' };

  const result = (await executeTaxIntakeTool(
    { organizationId: orgId },
    'tick_tax_return',
    { return_id: returnId },
  )) as { ok?: boolean; error?: string; stillWorking?: boolean };

  if (!result?.ok) return { error: result?.error ?? 'Tick failed.' };
  revalidatePath(`/taxes/${returnId}`);
  return { ok: true, stillWorking: Boolean(result.stillWorking) };
}
