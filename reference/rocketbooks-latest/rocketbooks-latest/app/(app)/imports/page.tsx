import Link from 'next/link';
import { eq, count, desc, and, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { imports, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { BankStatementDropZone } from './_components/BankStatementDropZone';
import { DeleteImportButton } from './_components/DeleteImportButton';
import { PendingImportsSection } from '@/components/billing/PendingImportsSection';

const PAGE_SIZE = 50;
const ASSET_TYPES = ['asset', 'current_asset'];

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function ImportsPage({ searchParams }: PageProps) {
  const orgId = await getCurrentOrgId();

  // Demo workspace: render a populated "what an active imports page looks
  // like" view. No real `imports` / `imported_transactions` rows, and the
  // drop zone is replaced with an inert visual replica so file drops don't
  // hit the upload endpoint.
  if (isDemoOrg(orgId)) {
    return <DemoImportsPageView />;
  }

  const { page: pageStr } = await searchParams;
  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [[total], rows, allAssets] = await Promise.all([
    db.select({ n: count() }).from(imports).where(eq(imports.organizationId, orgId)),
    db
      .select({
        id: imports.id,
        method: imports.method,
        filename: imports.filename,
        transactionCount: imports.transactionCount,
        startDate: imports.startDate,
        endDate: imports.endDate,
        status: imports.status,
        errorMessage: imports.errorMessage,
        createdAt: imports.createdAt,
        accountName: chartOfAccounts.accountName,
      })
      .from(imports)
      .leftJoin(chartOfAccounts, eq(imports.accountId, chartOfAccounts.id))
      .where(eq(imports.organizationId, orgId))
      .orderBy(desc(imports.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
      })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
      .orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  // Bank-like asset accounts first; fall back to all assets if none match.
  const bankish = allAssets.filter((a) => {
    const t = (a.gaapType ?? '').toLowerCase();
    const n = a.accountName.toLowerCase();
    return ASSET_TYPES.includes(t) && (n.includes('bank') || n.includes('cash') || n.includes('checking') || n.includes('savings'));
  });
  const assetAccounts = (bankish.length > 0 ? bankish : allAssets.filter((a) => ASSET_TYPES.includes((a.gaapType ?? '').toLowerCase()))).map(
    (a) => ({ id: a.id, accountNumber: a.accountNumber, accountName: a.accountName }),
  );

  const totalCount = total?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Imports</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{totalCount.toLocaleString()} import batches</p>
        </div>
        <Link
          href="/imports/new"
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          + New CSV import
        </Link>
      </header>

      <PendingImportsSection orgId={orgId} />

      <BankStatementDropZone accounts={assetAccounts} />

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">When</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">File</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Method</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">#</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Range</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
              <th className="px-4 py-2 text-right"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                  No imports yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">
                  <Link href={`/imports/${r.id}`} className="block hover:underline">
                    {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—'}
                  </Link>
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                  <Link href={`/imports/${r.id}`} className="block hover:underline">
                    {r.filename ?? '—'}
                  </Link>
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.accountName ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.method}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  <Link href={`/imports/${r.id}`} className="block hover:underline">
                    {r.transactionCount?.toLocaleString() ?? '—'}
                  </Link>
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                  {r.startDate && r.endDate ? `${r.startDate} → ${r.endDate}` : '—'}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      r.status === 'completed' || r.status === 'success'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : r.status === 'failed' || r.status === 'error'
                          ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                          : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <DeleteImportButton
                    importId={r.id}
                    filename={r.filename}
                    transactionCount={r.transactionCount}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <nav className="flex items-center gap-2 text-sm">
          {page > 1 && <a href={`?page=${page - 1}`} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">← Previous</a>}
          {page < pageCount && <a href={`?page=${page + 1}`} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Next →</a>}
        </nav>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo-only render. Hardcoded "what an active imports page looks like" view
// shown only in the demo workspace. No `imports` / `imported_transactions`
// rows; the drop zone is a visual replica with no file handlers so drops
// don't hit the upload endpoint. Used by the cool tour's imports beat.
// ---------------------------------------------------------------------------
function DemoImportsPageView() {
  const now = new Date();
  const daysAgo = (n: number) => {
    const d = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
    return d.toLocaleDateString();
  };
  const isoDate = (n: number) =>
    new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  type DemoImport = {
    id: string;
    createdAtDaysAgo: number;
    filename: string;
    account: string;
    method: string;
    transactionCount: number;
    rangeDaysAgoStart: number;
    rangeDaysAgoEnd: number;
    status: 'completed';
  };
  const rows: DemoImport[] = [
    {
      id: 'demo-import-1',
      createdAtDaysAgo: 1,
      filename: 'BofA_AdvPlus_9917_May2026.pdf',
      account: '1013 · Bank of America Adv Plus Banking ···9917',
      method: 'bank_statement',
      transactionCount: 47,
      rangeDaysAgoStart: 31,
      rangeDaysAgoEnd: 2,
      status: 'completed',
    },
    {
      id: 'demo-import-2',
      createdAtDaysAgo: 1,
      filename: 'BofA_AdvRelationship_6084_May2026.pdf',
      account: '1012 · Bank of America Adv Relationship Banking ···6084',
      method: 'bank_statement',
      transactionCount: 118,
      rangeDaysAgoStart: 31,
      rangeDaysAgoEnd: 2,
      status: 'completed',
    },
    {
      id: 'demo-import-3',
      createdAtDaysAgo: 32,
      filename: 'BofA_AdvPlus_9917_Apr2026.pdf',
      account: '1013 · Bank of America Adv Plus Banking ···9917',
      method: 'bank_statement',
      transactionCount: 52,
      rangeDaysAgoStart: 62,
      rangeDaysAgoEnd: 33,
      status: 'completed',
    },
    {
      id: 'demo-import-4',
      createdAtDaysAgo: 32,
      filename: 'BofA_AdvRelationship_6084_Apr2026.pdf',
      account: '1012 · Bank of America Adv Relationship Banking ···6084',
      method: 'bank_statement',
      transactionCount: 134,
      rangeDaysAgoStart: 62,
      rangeDaysAgoEnd: 33,
      status: 'completed',
    },
    {
      id: 'demo-import-5',
      createdAtDaysAgo: 78,
      filename: 'opening_balances.csv',
      account: '1013 · Bank of America Adv Plus Banking ···9917',
      method: 'csv',
      transactionCount: 12,
      rangeDaysAgoStart: 120,
      rangeDaysAgoEnd: 90,
      status: 'completed',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Imports</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{rows.length.toLocaleString()} import batches</p>
        </div>
        <button
          type="button"
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          aria-disabled="true"
          title="Demo workspace — New CSV import is read-only"
        >
          + New CSV import
        </button>
      </header>

      {/* Inert visual replica of BankStatementDropZone. Same layout/styling
          but no input, no drag handlers -- drops do nothing. */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-medium">Upload bank statements</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Drag PDFs (or images) of bank statements. Veryfi extracts every transaction; you review and post on the Plaid Feed–style review screen.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-zinc-500">Bank account</span>
            <select
              defaultValue="auto"
              aria-disabled="true"
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="auto">Auto-detect from statement</option>
            </select>
          </label>
        </div>

        <div
          role="button"
          tabIndex={-1}
          aria-disabled="true"
          title="Demo workspace — uploads are read-only"
          className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-blue-400 bg-blue-50/40 p-10 text-center text-blue-700 dark:border-blue-700 dark:bg-blue-950/20 dark:text-blue-300"
        >
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <div className="text-base font-medium">Drop bank statements here, or click to browse</div>
          <div className="text-xs text-zinc-500">PDF · JPG · PNG · up to 25 MB · multiple files OK</div>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">When</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">File</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Method</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">#</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Range</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
              <th className="px-4 py-2 text-right"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{daysAgo(r.createdAtDaysAgo)}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.filename}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.account}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.method}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {r.transactionCount.toLocaleString()}
                </td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                  {isoDate(r.rangeDaysAgoStart)} → {isoDate(r.rangeDaysAgoEnd)}
                </td>
                <td className="px-4 py-2">
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    aria-disabled="true"
                    title="Demo workspace — delete is read-only"
                    className="text-xs text-zinc-400 dark:text-zinc-500"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
