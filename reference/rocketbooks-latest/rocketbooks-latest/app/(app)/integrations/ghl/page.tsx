import { and, eq, like, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { ghlRawPayments, transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { loadConnectionByOrg } from '@/lib/ghl/connection';
import { safeSend } from '@/lib/inngest';

interface PageProps {
  searchParams: Promise<{ connected?: string; error?: string }>;
}

const ERROR_MESSAGES: Record<string, string> = {
  demo_workspace: "GoHighLevel isn't available in the demo workspace. Create your own workspace first.",
  not_configured: 'GoHighLevel is not configured on the server. Set GHL_CLIENT_ID, GHL_CLIENT_SECRET, and GHL_REDIRECT_URI.',
  missing_params: 'GoHighLevel did not return the expected parameters. Try again.',
  bad_state: 'The connection link expired or was reused. Try connecting again.',
  state_expired: 'The connection link expired. Try connecting again.',
  no_org_in_state: 'No active workspace was associated with the connection request.',
  token_exchange_failed: 'GoHighLevel rejected the authorization. Check your client credentials and try again.',
};

export default async function GhlIntegrationPage({ searchParams }: PageProps) {
  const { connected, error } = await searchParams;
  const orgId = await getCurrentOrgId();
  const demo = isDemoOrg(orgId);

  const connection = demo ? null : await loadConnectionByOrg(orgId);

  // Ingest + promote counts so the page shows the pipeline actually did
  // something. Cheap COUNTs, scoped to this connection / org.
  const [ingested, promoted] = connection
    ? await Promise.all([
        db
          .select({ n: sql<number>`COUNT(*)::int` })
          .from(ghlRawPayments)
          .where(eq(ghlRawPayments.ghlConnectionId, connection.id)),
        db
          .select({ n: sql<number>`COUNT(*)::int` })
          .from(transactions)
          .where(and(eq(transactions.organizationId, orgId), like(transactions.reference, 'ghl:%'))),
      ])
    : [null, null];

  const ingestedCount = ingested?.[0]?.n ?? 0;
  const promotedCount = promoted?.[0]?.n ?? 0;

  // Manual re-sync — re-emits the same event the OAuth callback fires.
  async function triggerSync() {
    'use server';
    if (!connection) return;
    await safeSend({
      name: 'ghl/sync.requested',
      data: { connectionId: connection.id, trigger: 'manual' },
    });
    revalidatePath('/integrations/ghl');
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">GoHighLevel</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Connect a GoHighLevel sub-account to pull its payments and customers into RocketSuite. Payments arrive as
          unreviewed transactions and are reconciled against your bank feed &mdash; nothing posts to your books
          automatically.
        </p>
      </header>

      {error && ERROR_MESSAGES[error] && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {ERROR_MESSAGES[error]}
        </div>
      )}
      {connected && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
          GoHighLevel connected. Importing your payments now &mdash; they&rsquo;ll appear below shortly.
        </div>
      )}

      {!connection ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-lg font-medium">Connect GoHighLevel</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            You&rsquo;ll be redirected to GoHighLevel to choose a sub-account and grant read access to its payments,
            invoices, and contacts. We only request read-only scopes.
          </p>
          {demo ? (
            <div
              className="mt-4 inline-block cursor-not-allowed rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
              title="GoHighLevel isn't available in the demo workspace"
            >
              🔒 Connect GoHighLevel &mdash; create a workspace first
            </div>
          ) : (
            <a
              href="/api/crm/oauth/start"
              className="mt-4 inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Connect GoHighLevel
            </a>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                    connection.connectionStatus === 'error'
                      ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                  }`}
                >
                  {connection.connectionStatus === 'error' ? 'Error' : 'Connected'}
                </span>
                <h2 className="text-lg font-medium">Location {connection.locationId}</h2>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <dt className="text-zinc-500">Connected at</dt>
                <dd className="text-zinc-700 dark:text-zinc-300">
                  {new Date(connection.createdAt).toLocaleString()}
                </dd>
                <dt className="text-zinc-500">Last synced</dt>
                <dd className="text-zinc-700 dark:text-zinc-300">
                  {connection.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleString() : 'Never'}
                </dd>
                <dt className="text-zinc-500">Access token expires</dt>
                <dd className="text-zinc-700 dark:text-zinc-300">
                  {new Date(connection.accessTokenExpiresAt).toLocaleString()}
                </dd>
              </dl>
            </div>
            <form action={triggerSync}>
              <button
                type="submit"
                className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-800 hover:bg-indigo-100 dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
              >
                Sync now
              </button>
            </form>
          </div>

          {connection.connectionStatus === 'error' && connection.lastSyncError && (
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {connection.lastSyncError}
            </p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Payments pulled</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {ingestedCount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 dark:border-indigo-900/30 dark:bg-indigo-950/20">
              <div className="text-[10px] font-medium uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
                In review (to categorize)
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-indigo-900 dark:text-indigo-100">
                {promotedCount.toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
