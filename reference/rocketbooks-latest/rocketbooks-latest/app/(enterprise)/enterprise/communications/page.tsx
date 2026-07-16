import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { timeDb } from '@/lib/perf/db-timing';

export const dynamic = 'force-dynamic';

interface Item {
  kind: 'inbound' | 'outbound';
  at: string;
  orgName: string | null;
  who: string | null;
  issueType: string | null;
  subject: string | null;
  body: string | null;
  channel: string | null;
}

function fmt(at: string): string {
  try {
    return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return at;
  }
}
function labelIssue(t: string | null): string {
  return t ? t.replace(/_/g, ' ') : 'outreach';
}

export default async function EnterpriseCommunicationsPage() {
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  let items: Item[] = [];
  if (current.id !== DEMO_ENTERPRISE_ID) {
    const timingContext = { route: '/enterprise/communications' };
    const inbound = (await timeDb(
      'enterprise.communications.inbound',
      () => db.execute(sql`
        select ei.received_at as at, ei.from_email as who, ei.subject, ei.body,
               o.issue_type, o.channel, org.name as org_name
        from email_inbound ei
        left join ai_client_outreach o on o.id = ei.outreach_id
        left join organizations org on org.id = ei.organization_id
        where ei.enterprise_id = ${current.id}
        order by ei.received_at desc
        limit 100
      `),
      timingContext,
    )) as unknown as Array<Record<string, string | null>>;

    const outbound = (await timeDb(
      'enterprise.communications.outbound',
      () => db.execute(sql`
        select o.last_contact_at as at, o.issue_type, o.channel,
               o.last_message_subject as subject, o.last_message_body as body, org.name as org_name
        from ai_client_outreach o
        left join organizations org on org.id = o.organization_id
        where o.enterprise_id = ${current.id} and o.status = 'sent'
        order by o.last_contact_at desc
        limit 100
      `),
      timingContext,
    )) as unknown as Array<Record<string, string | null>>;

    items = [
      ...inbound.map((r): Item => ({
        kind: 'inbound',
        at: r.at ?? '',
        who: r.who,
        issueType: r.issue_type,
        subject: r.subject,
        body: r.body,
        channel: r.channel,
        orgName: r.org_name,
      })),
      ...outbound.map((r): Item => ({
        kind: 'outbound',
        at: r.at ?? '',
        who: null,
        issueType: r.issue_type,
        subject: r.subject,
        body: r.body,
        channel: r.channel,
        orgName: r.org_name,
      })),
    ]
      .filter((i) => i.at)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  const replyCount = items.filter((i) => i.kind === 'inbound').length;

  return (
    <AdminPage title="Communications" crumbs={[{ label: 'Enterprise' }, { label: 'Communications' }]}>
      <Panel title="Client communications">
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Outreach you&rsquo;ve sent to clients and their replies, newest first.
          {replyCount === 0 && ' Client replies appear here once inbound email is set up.'}
        </p>
        {items.length === 0 ? (
          <p className="text-sm text-zinc-400">No communications yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {items.map((it, i) => (
              <li key={i} className="flex gap-3 py-3">
                <span
                  className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                    it.kind === 'inbound'
                      ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                  }`}
                  title={it.kind === 'inbound' ? 'Reply from client' : 'Sent to client'}
                >
                  {it.kind === 'inbound' ? '↩' : '→'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{it.orgName ?? it.who ?? 'Client'}</span>
                    <span className="shrink-0 text-xs text-zinc-400">{fmt(it.at)}</span>
                  </div>
                  <div className="text-xs text-zinc-500">
                    {it.kind === 'inbound'
                      ? `Reply${it.who ? ` from ${it.who}` : ''}`
                      : `Sent · ${labelIssue(it.issueType)}${it.channel ? ` · ${it.channel}` : ''}`}
                  </div>
                  {it.subject && <div className="mt-0.5 text-sm font-medium text-zinc-800 dark:text-zinc-100">{it.subject}</div>}
                  {it.body && <p className="mt-0.5 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-300">{it.body}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </AdminPage>
  );
}
