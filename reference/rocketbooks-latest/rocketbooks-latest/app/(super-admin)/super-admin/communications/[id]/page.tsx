import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { adminCommunications, users } from '@/db/schema/schema';
import { AdminPage, Panel, Badge } from '@/components/admin/AdminPage';

export const dynamic = 'force-dynamic';

function statusTone(status: string): 'green' | 'red' | 'amber' | 'zinc' {
  if (status === 'sent') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'skipped') return 'amber';
  return 'zinc';
}

interface Params {
  id: string;
}

export default async function CommunicationDetailPage({ params }: { params: Promise<Params> }) {
  const { id } = await params;

  const [row] = await db
    .select({
      id: adminCommunications.id,
      toEmail: adminCommunications.toEmail,
      replyTo: adminCommunications.replyTo,
      subject: adminCommunications.subject,
      bodyHtml: adminCommunications.bodyHtml,
      bodyText: adminCommunications.bodyText,
      status: adminCommunications.status,
      providerMessageId: adminCommunications.providerMessageId,
      error: adminCommunications.error,
      sentAt: adminCommunications.sentAt,
      senderEmail: users.email,
    })
    .from(adminCommunications)
    .leftJoin(users, eq(users.id, adminCommunications.sentByUserId))
    .where(eq(adminCommunications.id, id))
    .limit(1);

  if (!row) notFound();

  return (
    <AdminPage
      title="Email"
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Communications', href: '/super-admin/communications' },
        { label: row.subject },
      ]}
      actions={
        <Link
          href="/super-admin/communications"
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
          <Meta label="To">{row.toEmail}</Meta>
          <Meta label="Reply-to">{row.replyTo ?? '—'}</Meta>
          <Meta label="Sent by">{row.senderEmail ?? '—'}</Meta>
          <Meta label="Provider message id">
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-900">
              {row.providerMessageId ?? '—'}
            </code>
          </Meta>
          {row.error && (
            <Meta label="Error" wide>
              <span className="text-red-700 dark:text-red-400">{row.error}</span>
            </Meta>
          )}
        </dl>
      </Panel>

      <Panel title="Subject">
        <div className="text-sm">{row.subject}</div>
      </Panel>

      <Panel title="Body — rendered">
        {/* Sandbox the rendered HTML in an iframe srcDoc so any inline
            script/style in the saved body can't reach into the
            super-admin shell (defense in depth — this content was
            written by a super-admin, but compromising one's account
            shouldn't compromise the rest). */}
        <iframe
          title="Email body preview"
          srcDoc={row.bodyHtml ?? ''}
          sandbox=""
          className="h-[480px] w-full rounded-md border border-zinc-200 bg-white dark:border-zinc-800"
        />
      </Panel>

      <Panel title="Body — plain text fallback">
        <pre className="whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 font-mono text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          {row.bodyText ?? '—'}
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
