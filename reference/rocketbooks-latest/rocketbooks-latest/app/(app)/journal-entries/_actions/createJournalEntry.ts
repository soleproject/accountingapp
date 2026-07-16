'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { recordFirmChange } from '@/lib/enterprise/attribution';

const LineSchema = z.object({
  accountId: z.string().uuid().or(z.string().min(1)),
  debit: z.coerce.number().min(0).default(0),
  credit: z.coerce.number().min(0).default(0),
  memo: z.string().optional(),
  contactId: z.string().optional().nullable(),
});

const InputSchema = z.object({
  date: z.iso.date(),
  memo: z.string().max(500).optional(),
  isAdjusting: z.boolean().optional().default(false),
  lines: z.array(LineSchema).min(2),
});

export interface CreateJEState {
  error?: string;
  fieldErrors?: Record<string, string[]>;
}

export async function createJournalEntryAction(
  _prev: CreateJEState | undefined,
  formData: FormData,
): Promise<CreateJEState | undefined> {
  const orgId = await getCurrentOrgId();

  const lines: unknown[] = [];
  for (let i = 0; ; i++) {
    const accountId = formData.get(`lines[${i}].accountId`);
    if (accountId === null) break;
    const accountStr = String(accountId).trim();
    if (!accountStr) continue;
    lines.push({
      accountId: accountStr,
      debit: formData.get(`lines[${i}].debit`) || 0,
      credit: formData.get(`lines[${i}].credit`) || 0,
      memo: formData.get(`lines[${i}].memo`) || undefined,
      contactId: formData.get(`lines[${i}].contactId`) || null,
    });
  }

  const parsed = InputSchema.safeParse({
    date: formData.get('date'),
    memo: formData.get('memo') || undefined,
    isAdjusting: formData.get('isAdjusting') === 'on',
    lines,
  });

  if (!parsed.success) {
    return {
      error: 'Invalid input',
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
    };
  }

  try {
    const result = await createJournalEntry({
      organizationId: orgId,
      date: parsed.data.date,
      memo: parsed.data.memo ?? null,
      lines: parsed.data.lines,
      posted: true,
      isAdjusting: parsed.data.isAdjusting,
    });
    await recordFirmChange({
      action: 'journal_entry',
      orgId,
      entityType: 'journal_entry',
      entityId: result.id,
      summary: `Posted a journal entry${parsed.data.memo ? `: ${parsed.data.memo}` : ''}`,
    });
    revalidatePath('/journal-entries');
    redirect(`/journal-entries/${result.id}`);
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }
}
