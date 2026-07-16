import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { journalEntries, journalEntryLines, chartOfAccounts, contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function JournalEntryDetailPage({ params }: PageProps) {
  const { id } = await params;
  const orgId = await getCurrentOrgId();

  const [je] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, id), eq(journalEntries.organizationId, orgId)))
    .limit(1);

  if (!je) notFound();

  const lines = await db
    .select({
      id: journalEntryLines.id,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      memo: journalEntryLines.memo,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      contactName: contacts.contactName,
    })
    .from(journalEntryLines)
    .leftJoin(chartOfAccounts, eq(journalEntryLines.accountId, chartOfAccounts.id))
    .leftJoin(contacts, eq(journalEntryLines.contactId, contacts.id))
    .where(eq(journalEntryLines.journalEntryId, id))
    .orderBy(asc(journalEntryLines.createdAt));

  const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);

  return (
    <div className="flex flex-col gap-6">
      <Link href="/journal-entries" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        ← Back to journal entries
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">JE {je.date}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {je.memo ?? <em className="text-zinc-400">No memo</em>} · {je.posted ? 'Posted' : 'Draft'} ·
          source: {je.sourceType ?? 'manual'} · id: <code className="font-mono text-xs">{je.id}</code>
        </p>
      </header>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Contact</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Debit</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Credit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                  {l.accountNumber} · {l.accountName}
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{l.contactName ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{l.memo ?? '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {Number(l.debit) > 0 ? `$${Number(l.debit).toFixed(2)}` : ''}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {Number(l.credit) > 0 ? `$${Number(l.credit).toFixed(2)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-zinc-50 dark:bg-zinc-900">
            <tr className="border-t border-zinc-200 dark:border-zinc-800">
              <td colSpan={3} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                Totals
              </td>
              <td className="px-4 py-2 text-right tabular-nums">${totalDebit.toFixed(2)}</td>
              <td className="px-4 py-2 text-right tabular-nums">${totalCredit.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
