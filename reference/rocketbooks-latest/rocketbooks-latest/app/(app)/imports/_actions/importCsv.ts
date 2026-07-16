'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { chartOfAccounts, imports, transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

export interface ImportState {
  error?: string;
  ok?: boolean;
  created?: number;
  skipped?: number;
}

const RowSchema = z.object({
  date: z.iso.date(),
  description: z.string().min(1).max(500),
  amount: z.coerce.number().positive(),
  type: z.enum(['deposit', 'withdrawal']),
});

function parseCsv(text: string): { rows: Array<Record<string, string>>; error?: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], error: 'CSV needs a header and at least one row' };

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const required = ['date', 'description', 'amount', 'type'];
  const missing = required.filter((r) => !headers.includes(r));
  if (missing.length) return { rows: [], error: `Missing columns: ${missing.join(', ')}` };

  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });

  return { rows };
}

function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (c === '"') {
      inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export async function importCsv(_prev: ImportState | undefined, formData: FormData): Promise<ImportState | undefined> {
  const orgId = await getCurrentOrgId();
  const accountId = String(formData.get('accountId') ?? '');
  const file = formData.get('file');

  if (!accountId) return { error: 'Pick a target bank account' };
  if (!(file instanceof File)) return { error: 'No file uploaded' };
  if (file.size > 10 * 1024 * 1024) return { error: 'CSV too large (max 10 MB)' };

  const [account] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, accountId), eq(chartOfAccounts.organizationId, orgId)))
    .limit(1);
  if (!account) return { error: 'Account not in this organization' };

  const text = await file.text();
  const parsed = parseCsv(text);
  if (parsed.error) return { error: parsed.error };
  if (parsed.rows.length === 0) return { error: 'CSV had no data rows' };

  const importId = randomUUID();
  const now = new Date().toISOString();
  let created = 0;
  let skipped = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  const newTxnIds: string[] = [];

  // First parse + assign references for dedup. Reference shape mirrors the
  // pattern used by Plaid/Veryfi promote: stable enough that re-uploading
  // the same CSV (or one with a few overlapping rows) does NOT duplicate.
  const ref = (r: z.infer<typeof RowSchema>) =>
    `csv:${accountId}:${r.date}:${r.amount}:${r.type}:${r.description.trim().toLowerCase()}`;

  const validRows: Array<{ row: z.infer<typeof RowSchema>; reference: string }> = [];
  for (const row of parsed.rows) {
    const r = RowSchema.safeParse(row);
    if (!r.success) {
      skipped++;
      continue;
    }
    validRows.push({ row: r.data, reference: ref(r.data) });
  }

  // Look up existing references for this org to skip duplicates from prior imports.
  const refs = validRows.map((v) => v.reference);
  const existing = refs.length
    ? await db
        .select({ reference: transactions.reference })
        .from(transactions)
        .where(and(eq(transactions.organizationId, orgId), inArray(transactions.reference, refs)))
    : [];
  const seen = new Set(existing.map((e) => e.reference));

  await db.transaction(async (tx) => {
    await tx.insert(imports).values({
      id: importId,
      organizationId: orgId,
      accountId,
      method: 'csv',
      filename: file.name,
      status: 'in_progress',
      createdAt: now,
    });

    for (const { row, reference } of validRows) {
      if (seen.has(reference)) {
        skipped++;
        continue;
      }
      seen.add(reference);
      if (!firstDate || row.date < firstDate) firstDate = row.date;
      if (!lastDate || row.date > lastDate) lastDate = row.date;

      const txnId = randomUUID();
      await tx.insert(transactions).values({
        id: txnId,
        organizationId: orgId,
        accountId,
        date: row.date,
        description: row.description,
        bankDescription: row.description,
        amount: row.amount,
        type: row.type,
        importId,
        reviewed: false,
        reference,
        createdAt: now,
      });
      newTxnIds.push(txnId);
      created++;
    }

    await tx
      .update(imports)
      .set({
        status: 'completed',
        transactionCount: created,
        startDate: firstDate,
        endDate: lastDate,
      })
      .where(eq(imports.id, importId));
  });

  // Match the Veryfi/Plaid flow: kick off categorization automatically. Use
  // safeSend so a queue outage doesn't fail the import.
  if (newTxnIds.length > 0) {
    await safeSend({
      name: 'transactions/auto-categorize.requested',
      data: { organizationId: orgId, transactionIds: newTxnIds },
    });
  }

  logger.info({ importId, created, skipped }, 'csv import done');
  revalidatePath('/imports');
  revalidatePath('/transactions');
  return { ok: true, created, skipped };
}
