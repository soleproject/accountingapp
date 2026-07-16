import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { adminSms, users } from '@/db/schema/schema';
import { AdminPage, Panel, Badge } from '@/components/admin/AdminPage';

export const dynamic = 'force-dynamic';

function statusTone(status: string): 'green' | 'red' | 'amber' | 'blue' | 'zinc' {
  if (status === 'delivered') return 'green';
  if (status === 'sent') return 'blue';
  if (status === 'failed' || status === 'undelivered') return 'red';
  if (status === 'skipped' || status === 'canceled') return 'amber';
  return 'zinc';
}

interface Params {
  id: string;
}

export default async function TextDetailPage({ params }: { params: Promise<Params> }) {
  const { id } = await params;

  const [row] = await db
    .select({
      id: adminSms.id,
      toPhone: adminSms.toPhone,
      fromPhone: adminSms.fromPhone,
      body: adminSms.body,
      status: adminSms.status,
      providerMessageId: adminSms.providerMessageId,
      segments: adminSms.segments,
      error: adminSms.error,
      errorCode: adminSms.errorCode,
      sentAt: adminSms.sentAt,
      senderEmail: users.email,
    })
    .from(adminSms)
    .leftJoin(users, eq(users.id, adminSms.sentByUserId))
    .where(eq(adminSms.id, id))
    .limit(1);

  if (!row) notFound();

  return (
    <AdminPage
      title="Text"
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Communications', href: '/super-admin/communications?tab=texts' },
        { label: row.toPhone },
      ]}
      actions={
        <Link
          href="/super-admin/communications?tab=texts"
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          ← Back
        </Link>
      }
    >
      <Panel title="Metadata">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Meta label="Status"><Badge tone={statusTone(row.status)}>{row.status}</Badge></Meta>
          <Meta label="Sent at">{row.sentAt ? new Date(row.sentAt).toLocaleString() : '—'}</Meta>
          <Meta label="To"><code className="font-mono">{row.toPhone}</code></Meta>
          <Meta label="From"><code className="font-mono">{row.fromPhone ?? '—'}</code></Meta>
          <Meta label="Sent by">{row.senderEmail ?? '—'}</Meta>
          <Meta label="Segments billed">{row.segments ?? '—'}</Meta>
          <Meta label="Provider message id" wide>
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-900">
              {row.providerMessageId ?? '—'}
            </code>
          </Meta>
          {(row.error || row.errorCode) && (
            <Meta label="Error" wide>
              <span className="text-red-700 dark:text-red-400">
                {row.errorCode && (
                  <a
                    href={`https://www.twilio.com/docs/api/errors/${row.errorCode}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono underline"
                  >
                    {row.errorCode}
                  </a>
                )}
                {row.errorCode && row.error && <span className="mx-1">·</span>}
                {row.error}
              </span>
            </Meta>
          )}
        </dl>
      </Panel>

      <Panel title="Message">
        <pre className="whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-sm text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {row.body}
        </pre>
      </Panel>
    </AdminPage>
  );
}

function Meta({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
