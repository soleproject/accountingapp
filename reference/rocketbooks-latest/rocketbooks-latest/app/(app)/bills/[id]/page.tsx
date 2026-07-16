import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, asc, desc, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { bills, billLines, contacts, organizations, payments, journalEntries } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { DeleteBillButton } from './_components/DeleteBillButton';
import { LogoSlot } from '@/components/org/LogoSlot';

interface PageProps { params: Promise<{ id: string }>; }

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function formatLongDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderAddress(addr: unknown): string[] {
  if (!addr) return [];
  if (typeof addr === 'string') return addr.split('\n').map((s) => s.trim()).filter(Boolean);
  if (typeof addr !== 'object') return [];
  const a = addr as Record<string, unknown>;
  const lines: string[] = [];
  const line1 = (a.line1 ?? a.street ?? a.address1 ?? a.address) as string | undefined;
  const line2 = (a.line2 ?? a.address2) as string | undefined;
  const city = a.city as string | undefined;
  const state = (a.state ?? a.region ?? a.province) as string | undefined;
  const postal = (a.zip ?? a.postal ?? a.postalCode ?? a.postal_code) as string | undefined;
  const country = a.country as string | undefined;
  if (line1) lines.push(line1);
  if (line2) lines.push(line2);
  const cityStateZip = [city, state].filter(Boolean).join(', ');
  const tail = [cityStateZip, postal].filter(Boolean).join(' ');
  if (tail) lines.push(tail);
  if (country) lines.push(country);
  return lines;
}

const STATUS_PALETTE: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  posted: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  paid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  void: 'bg-zinc-200 text-zinc-600 line-through dark:bg-zinc-800 dark:text-zinc-500',
  overdue: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
};

function StatusPill({ label }: { label: string }) {
  const cls = STATUS_PALETTE[label] ?? STATUS_PALETTE.posted;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

export default async function BillDetailPage({ params }: PageProps) {
  const { id } = await params;
  const orgId = await getCurrentOrgId();

  const [bill] = await db
    .select({
      id: bills.id,
      number: bills.billNumber,
      date: bills.billDate,
      dueDate: bills.dueDate,
      memo: bills.memo,
      status: bills.status,
      contactName: contacts.contactName,
      contactCompany: contacts.companyName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactAddress: contacts.address,
    })
    .from(bills)
    .leftJoin(contacts, eq(bills.contactId, contacts.id))
    .where(and(eq(bills.id, id), eq(bills.organizationId, orgId)))
    .limit(1);
  if (!bill) notFound();

  const [orgRow] = await db
    .select({
      name: organizations.name,
      businessDescription: organizations.businessDescription,
      logoUrl: organizations.logoUrl,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const [lines, paymentRows, activeJe] = await Promise.all([
    db
      .select({
        id: billLines.id,
        description: billLines.description,
        quantity: billLines.quantity,
        unitPrice: billLines.unitPrice,
        amount: billLines.amount,
      })
      .from(billLines)
      .where(eq(billLines.billId, id))
      .orderBy(asc(billLines.id)),
    db
      .select({
        id: payments.id,
        date: payments.paymentDate,
        amount: payments.amount,
        type: payments.type,
        journalEntryId: payments.journalEntryId,
      })
      .from(payments)
      .where(
        and(
          eq(payments.organizationId, orgId),
          eq(payments.billId, id),
          eq(payments.type, 'sent'),
        ),
      )
      .orderBy(desc(payments.paymentDate)),
    db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.organizationId, orgId),
          eq(journalEntries.sourceType, 'bill'),
          eq(journalEntries.sourceId, id),
          isNull(journalEntries.reversalOfId),
        ),
      )
      .orderBy(desc(journalEntries.createdAt))
      .limit(1),
  ]);

  const subtotal = lines.reduce((s, l) => s + Number(l.amount), 0);
  const totalPaid = paymentRows.reduce((s, p) => s + p.amount, 0);
  const balanceDue = Math.max(0, subtotal - totalPaid);

  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = !!bill.dueDate && bill.dueDate < today && balanceDue > 0;
  const displayStatus =
    bill.status !== 'posted'
      ? (bill.status ?? 'draft')
      : balanceDue <= 0 && totalPaid > 0
        ? 'paid'
        : isOverdue
          ? 'overdue'
          : totalPaid > 0
            ? 'partial'
            : 'posted';

  const billLabel = bill.number ?? `#${bill.id.slice(0, 8)}`;
  const fromName = bill.contactCompany || bill.contactName || '—';
  const addressLines = renderAddress(bill.contactAddress);
  const linkedJeId = activeJe[0]?.id;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/bills" className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          ← Back to bills
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={`/bills/${bill.id}/edit`}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
          >
            Edit
          </Link>
          <DeleteBillButton billId={bill.id} billLabel={billLabel} />
        </div>
      </div>

      <article className="mx-auto w-full max-w-3xl rounded-lg border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-10">
        <header className="flex items-start justify-between gap-6 border-b border-zinc-200 pb-6 dark:border-zinc-800">
          <div className="flex min-w-0 items-start gap-4">
            <LogoSlot logoUrl={orgRow?.logoUrl ?? null} size="md" editable />
            <div className="min-w-0">
              <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                {orgRow?.name ?? 'Organization'}
              </div>
              {orgRow?.businessDescription && (
                <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {orgRow.businessDescription}
                </div>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold uppercase tracking-widest text-zinc-900 dark:text-zinc-100">
              Bill
            </div>
            <div className="mt-1"><StatusPill label={displayStatus} /></div>
          </div>
        </header>

        <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">From</div>
            <div className="mt-2 text-sm">
              <div className="font-medium text-zinc-900 dark:text-zinc-100">{fromName}</div>
              {bill.contactCompany && bill.contactName && bill.contactName !== bill.contactCompany && (
                <div className="text-zinc-700 dark:text-zinc-300">{bill.contactName}</div>
              )}
              {addressLines.map((l, i) => (
                <div key={i} className="text-zinc-700 dark:text-zinc-300">{l}</div>
              ))}
              {bill.contactEmail && (
                <div className="mt-1 text-zinc-600 dark:text-zinc-400">{bill.contactEmail}</div>
              )}
              {bill.contactPhone && (
                <div className="text-zinc-600 dark:text-zinc-400">{bill.contactPhone}</div>
              )}
            </div>
          </div>
          <div className="text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Number</dt>
              <dd className="text-zinc-900 dark:text-zinc-100">{billLabel}</dd>
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Date</dt>
              <dd className="text-zinc-900 dark:text-zinc-100">{formatLongDate(bill.date)}</dd>
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Due</dt>
              <dd className="text-zinc-900 dark:text-zinc-100">{formatLongDate(bill.dueDate)}</dd>
              {linkedJeId && (
                <>
                  <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Journal</dt>
                  <dd>
                    <Link href={`/journal-entries/${linkedJeId}`} className="text-blue-600 underline dark:text-blue-400">
                      View JE
                    </Link>
                  </dd>
                </>
              )}
            </dl>
          </div>
        </section>

        <section className="mt-8">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-300 dark:border-zinc-700">
                <th className="py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">Description</th>
                <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Qty</th>
                <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Price</th>
                <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="py-2 text-zinc-800 dark:text-zinc-200">{l.description ?? '—'}</td>
                  <td className="py-2 text-right tabular-nums text-zinc-800 dark:text-zinc-200">{Number(l.quantity).toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums text-zinc-800 dark:text-zinc-200">{fmt(Number(l.unitPrice))}</td>
                  <td className="py-2 text-right tabular-nums text-zinc-800 dark:text-zinc-200">{fmt(Number(l.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-6 flex justify-end">
          <dl className="grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
            <dt className="text-zinc-600 dark:text-zinc-400">Subtotal</dt>
            <dd className="text-right tabular-nums text-zinc-800 dark:text-zinc-200">{fmt(subtotal)}</dd>
            <dt className="border-t border-zinc-200 pt-2 text-zinc-900 dark:border-zinc-700 dark:text-zinc-100">Total</dt>
            <dd className="border-t border-zinc-200 pt-2 text-right tabular-nums text-base font-semibold text-zinc-900 dark:border-zinc-700 dark:text-zinc-100">
              {fmt(subtotal)}
            </dd>
            {totalPaid > 0 && (
              <>
                <dt className="text-zinc-600 dark:text-zinc-400">Amount paid</dt>
                <dd className="text-right tabular-nums text-emerald-700 dark:text-emerald-300">−{fmt(totalPaid)}</dd>
                <dt className="border-t border-zinc-300 pt-2 text-base font-semibold text-zinc-900 dark:border-zinc-700 dark:text-zinc-100">
                  Balance due
                </dt>
                <dd className={`border-t border-zinc-300 pt-2 text-right text-base font-semibold tabular-nums dark:border-zinc-700 ${
                  balanceDue > 0 ? 'text-zinc-900 dark:text-zinc-100' : 'text-emerald-700 dark:text-emerald-300'
                }`}>
                  {fmt(balanceDue)}
                </dd>
              </>
            )}
          </dl>
        </section>

        {paymentRows.length > 0 && (
          <section className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Payment history</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-zinc-500">
                  <th className="py-1 text-left font-medium">Date</th>
                  <th className="py-1 text-left font-medium">Type</th>
                  <th className="py-1 text-left font-medium">Journal</th>
                  <th className="py-1 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {paymentRows.map((p) => (
                  <tr key={p.id} className="border-t border-zinc-100 dark:border-zinc-800/60">
                    <td className="py-2 text-zinc-700 dark:text-zinc-300">{formatLongDate(p.date)}</td>
                    <td className="py-2 text-zinc-700 dark:text-zinc-300">Vendor payment</td>
                    <td className="py-2">
                      {p.journalEntryId ? (
                        <Link href={`/journal-entries/${p.journalEntryId}`} className="text-xs text-blue-600 underline dark:text-blue-400">
                          View
                        </Link>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-zinc-800 dark:text-zinc-200">{fmt(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-300 dark:border-zinc-700">
                  <td colSpan={3} className="py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Total paid
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium">{fmt(totalPaid)}</td>
                </tr>
              </tfoot>
            </table>
          </section>
        )}

        {bill.memo && (
          <section className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Notes</h2>
            <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{bill.memo}</p>
          </section>
        )}
      </article>
    </div>
  );
}
