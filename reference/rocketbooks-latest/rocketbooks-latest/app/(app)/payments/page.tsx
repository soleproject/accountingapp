import Link from 'next/link';
import { eq, count, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { payments } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function PaymentsPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();
  const { page: pageStr } = await searchParams;
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);

  const [[total], rows] = await Promise.all([
    db.select({ n: count() }).from(payments).where(eq(payments.organizationId, orgId)),
    db
      .select({
        id: payments.id,
        type: payments.type,
        paymentDate: payments.paymentDate,
        amount: payments.amount,
        invoiceId: payments.invoiceId,
        billId: payments.billId,
        journalEntryId: payments.journalEntryId,
      })
      .from(payments)
      .where(eq(payments.organizationId, orgId))
      .orderBy(desc(payments.paymentDate))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Payments</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{(total?.n ?? 0).toLocaleString()} payments</p>
        </div>
        <Link href="/payments/new" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
          + New payment
        </Link>
      </header>
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Date</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Type</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Applied to</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">JE</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No payments.</td>
              </tr>
            )}
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{p.paymentDate}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{p.type}</td>
                <td className="px-4 py-2 text-xs text-zinc-500">
                  {p.invoiceId ? `Invoice ${p.invoiceId.slice(0, 8)}…` : p.billId ? `Bill ${p.billId.slice(0, 8)}…` : '—'}
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                  {p.journalEntryId ? <Link href={`/journal-entries/${p.journalEntryId}`} className="text-xs underline">View</Link> : '—'}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(p.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
