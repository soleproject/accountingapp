'use server';

import { categorizeTransaction } from './categorize';
import { splitTransaction } from './splitTransaction';
import { unsplitTransaction } from './unsplitTransaction';
import type { CreateManualTransactionState } from '../../new/_actions/createManualTransaction';

/**
 * Adapter server actions that bridge the edit-page action signatures to
 * the unified ManualTransactionForm's `(prev, formData) => { error? }`
 * contract. The forms render the same UI for create + edit; only the
 * thunks behind Save / Update differ. Each adapter:
 *   1. Forwards to the underlying action
 *   2. Returns a `{ error?: string }`-shaped state the form can render
 *
 * Split + unsplit need the transactionId bound up-front (their first
 * positional arg), so the page binds before passing them through.
 */

export async function categorizeAdapter(
  _prev: CreateManualTransactionState | undefined,
  formData: FormData,
): Promise<CreateManualTransactionState | undefined> {
  const result = await categorizeTransaction(undefined, formData);
  if (result?.error) return { error: result.error };
  return undefined;
}

export async function splitAdapter(
  transactionId: string,
  _prev: CreateManualTransactionState | undefined,
  formData: FormData,
): Promise<CreateManualTransactionState | undefined> {
  const result = await splitTransaction(transactionId, undefined, formData);
  if (result?.error) return { error: result.error };
  return undefined;
}

export async function unsplitAdapter(
  transactionId: string,
  _prev: CreateManualTransactionState | undefined,
  formData: FormData,
): Promise<CreateManualTransactionState | undefined> {
  const result = await unsplitTransaction(transactionId, undefined, formData);
  if (result?.error) return { error: result.error };
  return undefined;
}
