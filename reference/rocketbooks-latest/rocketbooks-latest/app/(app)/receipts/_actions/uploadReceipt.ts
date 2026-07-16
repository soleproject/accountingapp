'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentOrgId } from '@/lib/auth/org';
import { validateReceiptFile } from '@/lib/receipts/validate-upload';
import { processReceiptUpload, VeryfiError } from '@/lib/receipts/process-upload';
import { DemoQuotaExceededError } from '@/lib/billing/demo-limits';
import { logger } from '@/lib/logger';

export interface UploadReceiptState { error?: string; }

export async function uploadReceipt(_prev: UploadReceiptState | undefined, formData: FormData): Promise<UploadReceiptState | undefined> {
  const orgId = await getCurrentOrgId();
  const validation = validateReceiptFile(formData.get('file'));
  if (!('ok' in validation)) return { error: validation.message };

  let result;
  try {
    result = await processReceiptUpload(orgId, validation.file);
  } catch (err) {
    if (err instanceof DemoQuotaExceededError) {
      return { error: err.message };
    }
    if (err instanceof VeryfiError) {
      logger.error({ err: err.message }, 'veryfi receipt processing failed');
      return { error: 'Receipt could not be processed. Please try a clearer scan.' };
    }
    throw err;
  }

  revalidatePath('/receipts');
  const redirectTo = (formData.get('redirectTo') as string | null) ?? `/receipts/${result.id}`;
  redirect(redirectTo);
}
