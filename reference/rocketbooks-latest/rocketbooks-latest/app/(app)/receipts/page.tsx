import Link from 'next/link';
import { eq, count, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { receipts, contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { ReceiptsList, type ReceiptRow } from './_components/ReceiptsList';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function ReceiptsPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();

  // Demo workspace: render a populated "view of a working Receipts page"
  // with an inert upload area + 2 OCR'd sample receipts. No real `receipts`
  // / `receipt_lines` rows touched.
  if (isDemoOrg(orgId)) {
    return <DemoReceiptsPageView />;
  }

  const { page: pageStr } = await searchParams;
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);

  const [[total], rows] = await Promise.all([
    db.select({ n: count() }).from(receipts).where(eq(receipts.organizationId, orgId)),
    db
      .select({
        id: receipts.id,
        receiptDate: receipts.receiptDate,
        memo: receipts.memo,
        totalAmount: receipts.totalAmount,
        status: receipts.status,
        posted: receipts.posted,
        vendorLogoUrl: receipts.vendorLogoUrl,
        contactName: contacts.contactName,
      })
      .from(receipts)
      .leftJoin(contacts, eq(receipts.contactId, contacts.id))
      .where(eq(receipts.organizationId, orgId))
      .orderBy(desc(receipts.receiptDate))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
  ]);

  const totalCount = total?.n ?? 0;
  const initialRows: ReceiptRow[] = rows.map((r) => ({
    id: r.id,
    receiptDate: r.receiptDate,
    memo: r.memo,
    totalAmount: Number(r.totalAmount),
    status: r.status,
    posted: r.posted,
    vendorLogoUrl: r.vendorLogoUrl,
    contactName: r.contactName,
  }));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Receipts</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            View and manage all receipts for your organization
            {totalCount > 0 && <span className="ml-2 text-zinc-400">· {totalCount.toLocaleString()} total</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/ai-chat"
            className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:from-violet-700 hover:to-fuchsia-700"
          >
            Receipt AI
          </Link>
          <Link
            href="/receipts/new"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            Add Receipt
          </Link>
        </div>
      </header>

      <ReceiptsList initialRows={initialRows} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo-only render. Hardcoded populated Receipts view shown only in the demo
// workspace. No `receipts` / `receipt_lines` rows are written; the upload
// drop zone is a visual replica with no input or drag handlers, and all
// action buttons are inert.
// ---------------------------------------------------------------------------
function DemoReceiptsPageView() {
  const now = new Date();
  const dateLabel = (offsetDays: number) =>
    new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  type DemoReceipt = {
    id: string;
    daysAgo: number;
    vendor: string;
    initials: string;
    initialsPalette: string;
    total: number;
    categorySummary: string;
  };
  const rows: DemoReceipt[] = [
    {
      id: 'demo-receipt-1',
      daysAgo: 5,
      vendor: 'Walmart',
      initials: 'WA',
      initialsPalette: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
      total: 88.0,
      categorySummary: 'Meals & Entertainment',
    },
    {
      id: 'demo-receipt-2',
      daysAgo: 115,
      vendor: 'WinCo Foods',
      initials: 'WI',
      initialsPalette: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
      total: 2.68,
      categorySummary: 'Meals & Entertainment',
    },
  ];
  const fmtCurrency = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Receipts</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            View and manage all receipts for your organization
            <span className="ml-2 text-zinc-400">· {rows.length.toLocaleString()} total</span>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-disabled="true"
            title="Demo workspace — Receipt AI is read-only"
            className="rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:from-violet-700 hover:to-fuchsia-700"
          >
            Receipt AI
          </button>
          <button
            type="button"
            aria-disabled="true"
            title="Demo workspace — Add Receipt is read-only"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            Add Receipt
          </button>
        </div>
      </header>

      {/* Inert visual replica of the ReceiptsList drop zone. Same layout,
          icon, copy, and button as the real client component -- but with
          no file input, no drag handlers. Clicks do nothing. */}
      <div className="flex cursor-default flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-zinc-300 bg-white px-4 py-10 dark:border-zinc-700 dark:bg-zinc-950">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-blue-500">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="16" y2="17" />
          <line x1="8" y1="9" x2="10" y2="9" />
        </svg>
        <div className="text-center">
          <p className="text-base font-medium text-zinc-700 dark:text-zinc-200">Click to upload or drag and drop</p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">PDF, JPG, or PNG up to 10 MB · multiple files OK</p>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">PDFs and images are processed automatically using OCR</p>
        <button
          type="button"
          aria-disabled="true"
          title="Demo workspace — uploads are read-only"
          className="mt-1 inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Choose Files
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Transaction Date</th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Logo</th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Vendor</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Total</th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Category Summary</th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-3 tabular-nums text-zinc-700 dark:text-zinc-300">{dateLabel(r.daysAgo)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex h-14 w-14 items-center justify-center rounded-full text-sm font-semibold ${r.initialsPalette}`}>
                    {r.initials}
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{r.vendor}</td>
                <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {fmtCurrency(r.total)}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{r.categorySummary}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                    Posted
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-disabled="true"
                      title="Demo workspace — view is read-only"
                      className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      aria-disabled="true"
                      title="Demo workspace — delete is read-only"
                      className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-red-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-red-300"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                        <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
