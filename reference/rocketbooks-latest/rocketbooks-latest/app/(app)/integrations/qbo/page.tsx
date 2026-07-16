import Link from 'next/link';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  qboConflicts,
  qboConnections,
  qboMigrationJobs,
  qboAccountStaging,
  qboCustomerStaging,
  qboVendorStaging,
  qboInvoiceStaging,
  qboBillStaging,
  qboPaymentStaging,
  qboBillPaymentStaging,
  qboPurchaseStaging,
  qboDepositStaging,
  qboTransferStaging,
  qboJournalEntryStaging,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { canMirrorQbo, resolveQboMirroringProduct } from '@/lib/billing/entitlements';
import { promotedCountsByType } from '@/lib/qbo/promote/promoter';
import { syncItems } from './_actions/syncItems';
import { startMigration } from './_actions/startMigration';
import { startAddOnSubscriptionCheckoutAction } from '@/app/(app)/billing/_actions/billing';

interface PageProps {
  searchParams: Promise<{ connected?: string; disconnected?: string; error?: string; import?: string }>;
}

const ERROR_MESSAGES: Record<string, string> = {
  demo_workspace: "QuickBooks isn't available in the demo workspace. Create your own workspace first.",
  not_configured: 'QBO is not configured on the server. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET, and QBO_REDIRECT_URI.',
  missing_params: 'QuickBooks did not return the expected parameters. Try again.',
  bad_state: 'The connection link expired or was reused. Try connecting again.',
  state_expired: 'The connection link expired. Try connecting again.',
  no_org_in_state: 'No active workspace was associated with the connection request.',
  token_exchange_failed: 'QuickBooks rejected the authorization. Check your client credentials and try again.',
};

export default async function QboIntegrationPage({ searchParams }: PageProps) {
  const { connected, disconnected, error, import: importStatus } = await searchParams;
  const orgId = await getCurrentOrgId();
  const demo = isDemoOrg(orgId);

  // Demo workspace: render a fully-populated "as-if-connected" view so the
  // cool tour can show what an active QBO integration looks like, without
  // touching qbo_connections / qbo_migration_jobs / staging tables and
  // without actually round-tripping with Intuit. All action buttons are
  // visually identical but inert (type="button", no handler) -- clicking
  // does nothing, so there's no risk of polluting the shared demo org.
  if (demo) {
    return <DemoQboPageView />;
  }

  const [connection] = await db
    .select({
      realmId: qboConnections.realmId,
      createdAt: qboConnections.createdAt,
      updatedAt: qboConnections.updatedAt,
      accessTokenExpiresAt: qboConnections.accessTokenExpiresAt,
    })
    .from(qboConnections)
    .where(eq(qboConnections.orgId, orgId))
    .limit(1);

  const mirroringUnlocked = connection ? await canMirrorQbo(orgId) : false;
  const mirroringSku = connection && !mirroringUnlocked ? await resolveQboMirroringProduct() : null;

  const [migrationJob] = connection
    ? await db
        .select({
          id: qboMigrationJobs.id,
          status: qboMigrationJobs.status,
          progress: qboMigrationJobs.progress,
          createdAt: qboMigrationJobs.createdAt,
          completedAt: qboMigrationJobs.completedAt,
          errorMessage: qboMigrationJobs.errorMessage,
          migrationReport: qboMigrationJobs.migrationReport,
        })
        .from(qboMigrationJobs)
        .where(eq(qboMigrationJobs.orgId, orgId))
        .orderBy(desc(qboMigrationJobs.createdAt))
        .limit(1)
    : [];

  const promotedCounts = connection ? await promotedCountsByType(orgId, connection.realmId) : null;

  // Count open conflicts for the link/banner. Cheap query, scoped to org.
  const [{ openConflicts }] = connection
    ? await db
        .select({ openConflicts: sql<number>`COUNT(*)::int` })
        .from(qboConflicts)
        .where(and(eq(qboConflicts.organizationId, orgId), isNull(qboConflicts.resolvedAt)))
    : [{ openConflicts: 0 }];

  const stagingCounts = migrationJob
    ? await Promise.all([
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboAccountStaging).where(eq(qboAccountStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboCustomerStaging).where(eq(qboCustomerStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboVendorStaging).where(eq(qboVendorStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboInvoiceStaging).where(eq(qboInvoiceStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboBillStaging).where(eq(qboBillStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboPaymentStaging).where(eq(qboPaymentStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboBillPaymentStaging).where(eq(qboBillPaymentStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboPurchaseStaging).where(eq(qboPurchaseStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboDepositStaging).where(eq(qboDepositStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboTransferStaging).where(eq(qboTransferStaging.migrationJobId, migrationJob.id)),
        db.select({ n: sql<number>`COUNT(*)::int` }).from(qboJournalEntryStaging).where(eq(qboJournalEntryStaging.migrationJobId, migrationJob.id)),
      ]).then(([a, c, v, i, b, p, bp, pu, d, t, je]) => ({
        Account: a[0]?.n ?? 0,
        Customer: c[0]?.n ?? 0,
        Vendor: v[0]?.n ?? 0,
        Invoice: i[0]?.n ?? 0,
        Bill: b[0]?.n ?? 0,
        Payment: p[0]?.n ?? 0,
        BillPayment: bp[0]?.n ?? 0,
        Purchase: pu[0]?.n ?? 0,
        Deposit: d[0]?.n ?? 0,
        Transfer: t[0]?.n ?? 0,
        JournalEntry: je[0]?.n ?? 0,
      }))
    : null;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">QuickBooks Online</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Migrate your QuickBooks data into rocketsuite, or keep the two systems in sync with two-way mirroring.
        </p>
      </header>

      {error && ERROR_MESSAGES[error] && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {ERROR_MESSAGES[error]}
        </div>
      )}
      {connected && importStatus !== 'not_queued' && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
          QuickBooks connected. Initial migration will run shortly.
        </div>
      )}
      {importStatus === 'not_queued' && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          QuickBooks connected, but the initial migration could not be started automatically. Use{' '}
          <strong>Start migration</strong> below to run it.
        </div>
      )}
      {disconnected && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          QuickBooks disconnected.
        </div>
      )}

      {openConflicts > 0 && (
        <Link
          href="/integrations/qbo/conflicts"
          className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/50"
        >
          <span>
            <strong>{openConflicts}</strong> {openConflicts === 1 ? 'record has' : 'records have'} an unresolved sync conflict. Outbound for {openConflicts === 1 ? 'it' : 'them'} is paused.
          </span>
          <span aria-hidden>→</span>
        </Link>
      )}

      {!connection ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-lg font-medium">Connect QuickBooks Online</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            You&rsquo;ll be redirected to Intuit to grant access to your company file. After connecting, the
            historical migration runs automatically &mdash; that&rsquo;s always free. Ongoing two-way mirroring is a
            separate paid add-on.
          </p>
          {demo ? (
            <div
              className="mt-4 inline-block cursor-not-allowed rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
              title="QBO isn't available in the demo workspace"
            >
              🔒 Connect QuickBooks &mdash; create a workspace first
            </div>
          ) : (
            <a
              href="/api/qbo/oauth/start"
              className="mt-4 inline-block rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Connect QuickBooks
            </a>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                    Connected
                  </span>
                  <h2 className="text-lg font-medium">Realm {connection.realmId}</h2>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  <dt className="text-zinc-500">Connected at</dt>
                  <dd className="text-zinc-700 dark:text-zinc-300">
                    {new Date(connection.createdAt).toLocaleString()}
                  </dd>
                  <dt className="text-zinc-500">Last refreshed</dt>
                  <dd className="text-zinc-700 dark:text-zinc-300">
                    {new Date(connection.updatedAt).toLocaleString()}
                  </dd>
                  <dt className="text-zinc-500">Access token expires</dt>
                  <dd className="text-zinc-700 dark:text-zinc-300">
                    {new Date(connection.accessTokenExpiresAt).toLocaleString()}
                  </dd>
                </dl>
              </div>
              <form action="/api/qbo/oauth/disconnect" method="post">
                <button
                  type="submit"
                  className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:bg-zinc-950 dark:text-red-300 dark:hover:bg-red-950/30"
                >
                  Disconnect
                </button>
              </form>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-medium">Two-way mirroring</h2>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                  {mirroringUnlocked
                    ? 'Active. New invoices, bills, payments, and transactions sync between QuickBooks and rocketsuite as they happen.'
                    : 'Locked. Historical migration is included; ongoing real-time sync requires the mirroring add-on.'}
                </p>
              </div>
              {mirroringUnlocked ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                  Active
                </span>
              ) : mirroringSku?.stripeReady ? (
                <form action={startAddOnSubscriptionCheckoutAction}>
                  <input type="hidden" name="billingProductId" value={mirroringSku.id} />
                  <button
                    type="submit"
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                  >
                    Unlock mirroring &mdash; {new Intl.NumberFormat('en-US', { style: 'currency', currency: mirroringSku.currency.toUpperCase() }).format(mirroringSku.unitAmountCents / 100)}/mo
                  </button>
                </form>
              ) : (
                <span
                  className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                  title="The mirroring SKU has not been configured in Stripe yet"
                >
                  Mirroring not yet available
                </span>
              )}
            </div>
          </div>

          {mirroringUnlocked && (
            <ItemsBackfillCard />
          )}

          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-medium">Historical migration</h2>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                  One-time pull of your QuickBooks accounts, contacts, invoices, bills, and payments into rocketsuite&rsquo;s
                  staging tables. Always free.
                </p>
              </div>
              {migrationJob && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                    migrationJob.status === 'completed'
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                      : migrationJob.status === 'running'
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                        : migrationJob.status === 'partial'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                          : migrationJob.status === 'failed'
                            ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                            : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                  }`}
                >
                  {migrationJob.status}
                </span>
              )}
            </div>

            {!migrationJob ? (
              <div className="mt-4 flex flex-col gap-3">
                <p className="text-sm text-zinc-500">No migration has run yet. One should start automatically right after connecting; if it didn&rsquo;t, start it manually.</p>
                <StartMigrationButton label="Start migration" />
              </div>
            ) : (
              <>
                <div className="mt-4">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className={`h-full transition-all ${
                        migrationJob.status === 'failed' ? 'bg-red-500' : migrationJob.status === 'partial' ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${migrationJob.progress ?? 0}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-xs text-zinc-500">
                    <span>{migrationJob.progress ?? 0}%</span>
                    <span>
                      Started {new Date(migrationJob.createdAt).toLocaleString()}
                      {migrationJob.completedAt && ` · finished ${new Date(migrationJob.completedAt).toLocaleString()}`}
                    </span>
                  </div>
                </div>

                {migrationJob.errorMessage && (
                  <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                    {migrationJob.errorMessage}
                  </p>
                )}

                {(migrationJob.status === 'failed' || migrationJob.status === 'partial') && (
                  <div className="mt-3">
                    <StartMigrationButton label="Re-run migration" />
                  </div>
                )}

                {stagingCounts && (
                  <>
                    <div className="mt-4">
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Pulled from QBO (staging)</div>
                      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6 lg:grid-cols-11">
                        {(['Account', 'Customer', 'Vendor', 'Invoice', 'Bill', 'Payment', 'BillPayment', 'Purchase', 'Deposit', 'Transfer', 'JournalEntry'] as const).map((entity) => (
                          <div key={entity} className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                            <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{entity}s</div>
                            <div className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                              {stagingCounts[entity].toLocaleString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {promotedCounts && (
                      <div className="mt-4">
                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">In your books (live)</div>
                        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6 lg:grid-cols-11">
                          {(['account', 'customer', 'vendor', 'invoice', 'bill', 'payment', 'billPayment', 'purchase', 'deposit', 'transfer', 'journalEntry'] as const).map((entity) => (
                            <div key={entity} className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900/30 dark:bg-emerald-950/20">
                              <div className="text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">{entity.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}s</div>
                              <div className="mt-1 text-lg font-semibold tabular-nums text-emerald-900 dark:text-emerald-100">
                                {(promotedCounts[entity] ?? 0).toLocaleString()}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo-only render. Hardcoded "as-if-connected" view shown only in the demo
// workspace. No DB writes, no real OAuth, no real syncItems call -- buttons
// look real but do nothing. Used by the cool tour's QBO step so users can
// see what a populated QBO integration looks like before they have one.
// ---------------------------------------------------------------------------
function DemoQboPageView() {
  // Anchor everything to "now" so the timestamps look fresh whenever the
  // demo runs, instead of slowly aging into "two years ago".
  const now = new Date();
  const connectedAt = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
  const lastRefreshed = new Date(now.getTime() - 2 * 60 * 60 * 1000);   // 2 hours ago
  const tokenExpires = new Date(now.getTime() + 60 * 60 * 1000);        // 1 hour from now
  const migrationStarted = new Date(connectedAt.getTime() + 1_000);
  const migrationFinished = new Date(connectedAt.getTime() + 6 * 60_000 + 23_000);
  const fmt = (d: Date) => d.toLocaleString();

  // Counts shown on the screenshot. staging and live are identical because
  // historical migration is complete.
  const counts = {
    Account: 89,
    Customer: 29,
    Vendor: 26,
    Invoice: 31,
    Bill: 15,
    Payment: 16,
    BillPayment: 10,
    Purchase: 35,
    Deposit: 5,
    Transfer: 0,
    JournalEntry: 3,
  } as const;
  const entities = Object.keys(counts) as Array<keyof typeof counts>;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">QuickBooks Online</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Migrate your QuickBooks data into rocketsuite, or keep the two systems in sync with two-way mirroring.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {/* Connection */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                  Connected
                </span>
                <h2 className="text-lg font-medium">Realm 9341456406174312</h2>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <dt className="text-zinc-500">Connected at</dt>
                <dd className="text-zinc-700 dark:text-zinc-300">{fmt(connectedAt)}</dd>
                <dt className="text-zinc-500">Last refreshed</dt>
                <dd className="text-zinc-700 dark:text-zinc-300">{fmt(lastRefreshed)}</dd>
                <dt className="text-zinc-500">Access token expires</dt>
                <dd className="text-zinc-700 dark:text-zinc-300">{fmt(tokenExpires)}</dd>
              </dl>
            </div>
            <button
              type="button"
              className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:bg-zinc-950 dark:text-red-300 dark:hover:bg-red-950/30"
              aria-disabled="true"
              title="Disconnect isn't available in the demo workspace"
            >
              Disconnect
            </button>
          </div>
        </div>

        {/* Two-way mirroring */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium">Two-way mirroring</h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Active. New invoices, bills, payments, and transactions sync between QuickBooks and rocketsuite as they happen.
              </p>
            </div>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
              Active
            </span>
          </div>
        </div>

        {/* Items backfill */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium">Items backfill</h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Pull QuickBooks Items into RocketSuite&rsquo;s map so that invoices created here can be pushed to QBO with proper ItemRefs.
                Run once after enabling mirroring; subsequent item changes flow via webhook.
              </p>
            </div>
            <button
              type="button"
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
              aria-disabled="true"
              title="Demo workspace — this button is read-only"
            >
              Sync items from QBO
            </button>
          </div>
        </div>

        {/* Historical migration */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium">Historical migration</h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                One-time pull of your QuickBooks accounts, contacts, invoices, bills, and payments into rocketsuite&rsquo;s
                staging tables. Always free.
              </p>
            </div>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
              completed
            </span>
          </div>

          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: '100%' }} />
            </div>
            <div className="mt-1 flex justify-between text-xs text-zinc-500">
              <span>100%</span>
              <span>
                Started {fmt(migrationStarted)} · finished {fmt(migrationFinished)}
              </span>
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Pulled from QBO (staging)</div>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6 lg:grid-cols-11">
              {entities.map((entity) => (
                <div key={entity} className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{entity}s</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {counts[entity].toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">In your books (live)</div>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6 lg:grid-cols-11">
              {entities.map((entity) => (
                <div key={entity} className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900/30 dark:bg-emerald-950/20">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                    {entity.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}s
                  </div>
                  <div className="mt-1 text-lg font-semibold tabular-nums text-emerald-900 dark:text-emerald-100">
                    {counts[entity].toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Manual (re-)trigger for the historical migration. Recovery path when the
// auto kick-off in the OAuth callback never queued, and a retry for
// failed/partial runs. Inline server action mirrors ItemsBackfillCard.
function StartMigrationButton({ label }: { label: string }) {
  async function handleStart() {
    'use server';
    await startMigration();
  }
  return (
    <form action={handleStart}>
      <button
        type="submit"
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
      >
        {label}
      </button>
    </form>
  );
}

function ItemsBackfillCard() {
  // The migration's pull phase doesn't include Item yet, so orgs with
  // existing QBO items need a one-shot backfill to map them. Invoice
  // push needs item QBO ids to populate ItemRef on each line.
  async function handleSync() {
    'use server';
    await syncItems();
  }
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Items backfill</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Pull QuickBooks Items into RocketSuite&rsquo;s map so that invoices created here can be pushed to QBO with
            proper ItemRefs. Run once after enabling mirroring; subsequent item changes flow via webhook.
          </p>
        </div>
        <form action={handleSync}>
          <button
            type="submit"
            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
          >
            Sync items from QBO
          </button>
        </form>
      </div>
    </div>
  );
}
