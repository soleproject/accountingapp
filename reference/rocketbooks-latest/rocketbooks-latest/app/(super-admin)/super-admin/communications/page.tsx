import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { adminCommunications, adminSms, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { AdminPage, Panel, Badge, EmptyHint } from '@/components/admin/AdminPage';
import { isResendConfigured } from '@/lib/email/resend';
import { isTwilioConfigured } from '@/lib/sms/twilio';
import { EmailComposeForm } from './_components/EmailComposeForm';
import { TextComposeForm } from './_components/TextComposeForm';
import { ComposeToggle } from './_components/ComposeToggle';

export const dynamic = 'force-dynamic';

const RECENT_LIMIT = 25;

type Tab = 'emails' | 'texts';

interface SearchParams {
  tab?: string;
}

function emailStatusTone(status: string): 'green' | 'red' | 'amber' | 'zinc' {
  if (status === 'sent') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'skipped') return 'amber';
  return 'zinc';
}

function smsStatusTone(status: string): 'green' | 'red' | 'amber' | 'blue' | 'zinc' {
  if (status === 'delivered') return 'green';
  if (status === 'sent') return 'blue';
  if (status === 'failed' || status === 'undelivered') return 'red';
  if (status === 'skipped' || status === 'canceled') return 'amber';
  return 'zinc';
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function preview(text: string, max = 60): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export default async function CommunicationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const tab: Tab = sp.tab === 'texts' ? 'texts' : 'emails';

  const user = await requireSession();

  return (
    <AdminPage
      title="Communications"
      crumbs={[{ label: 'SuperAdmin', href: '/super-admin/dashboard' }, { label: 'Communications' }]}
    >
      <Tabs active={tab} />
      {tab === 'emails' ? <EmailsTab defaultReplyTo={user.email ?? ''} /> : <TextsTab />}
    </AdminPage>
  );
}

function Tabs({ active }: { active: Tab }) {
  // Tabs are full URL links (not client-side state) so the active tab
  // is shareable, bookmarkable, and back-button-friendly.
  const tab = (key: Tab, label: string) => {
    const isActive = active === key;
    const href = key === 'emails' ? '/super-admin/communications' : '/super-admin/communications?tab=texts';
    return (
      <Link
        key={key}
        href={href}
        className={`rounded-t-md border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
          isActive
            ? 'border-blue-500 text-blue-700 dark:text-blue-300'
            : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
        }`}
      >
        {label}
      </Link>
    );
  };
  return (
    <div className="flex border-b border-zinc-200 dark:border-zinc-800">
      {tab('emails', 'Emails')}
      {tab('texts', 'Texts')}
    </div>
  );
}

async function EmailsTab({ defaultReplyTo }: { defaultReplyTo: string }) {
  const recent = await db
    .select({
      id: adminCommunications.id,
      toEmail: adminCommunications.toEmail,
      subject: adminCommunications.subject,
      status: adminCommunications.status,
      sentAt: adminCommunications.sentAt,
      senderEmail: users.email,
    })
    .from(adminCommunications)
    .leftJoin(users, eq(users.id, adminCommunications.sentByUserId))
    .orderBy(desc(adminCommunications.sentAt))
    .limit(RECENT_LIMIT);

  const configured = isResendConfigured();

  return (
    <>
      <ComposeToggle openLabel="Compose email">
        <Panel title="Compose new email">
          <EmailComposeForm defaultReplyTo={defaultReplyTo} resendConfigured={configured} />
        </Panel>
      </ComposeToggle>

      <Panel title={`Recent sends (last ${RECENT_LIMIT})`}>
        {recent.length === 0 ? (
          <EmptyHint>No emails sent from this page yet.</EmptyHint>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="px-2 py-2 font-medium">Sent</th>
                  <th className="px-2 py-2 font-medium">To</th>
                  <th className="px-2 py-2 font-medium">Subject</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/40">
                    <td className="px-2 py-2 whitespace-nowrap text-zinc-500">{fmtTime(r.sentAt)}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.toEmail}</td>
                    <td className="px-2 py-2">
                      <Link href={`/super-admin/communications/${r.id}`} className="text-blue-700 hover:underline dark:text-blue-400">
                        {r.subject}
                      </Link>
                    </td>
                    <td className="px-2 py-2"><Badge tone={emailStatusTone(r.status)}>{r.status}</Badge></td>
                    <td className="px-2 py-2 whitespace-nowrap text-zinc-500">{r.senderEmail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

async function TextsTab() {
  const recent = await db
    .select({
      id: adminSms.id,
      toPhone: adminSms.toPhone,
      body: adminSms.body,
      status: adminSms.status,
      segments: adminSms.segments,
      sentAt: adminSms.sentAt,
      senderEmail: users.email,
    })
    .from(adminSms)
    .leftJoin(users, eq(users.id, adminSms.sentByUserId))
    .orderBy(desc(adminSms.sentAt))
    .limit(RECENT_LIMIT);

  const configured = isTwilioConfigured();

  return (
    <>
      <ComposeToggle openLabel="Send new text">
        <Panel title="Send a new text">
          <TextComposeForm twilioConfigured={configured} />
        </Panel>
      </ComposeToggle>

      <Panel title={`Recent sends (last ${RECENT_LIMIT})`}>
        {recent.length === 0 ? (
          <EmptyHint>No texts sent from this page yet.</EmptyHint>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="px-2 py-2 font-medium">Sent</th>
                  <th className="px-2 py-2 font-medium">To</th>
                  <th className="px-2 py-2 font-medium">Message</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2 font-medium">Seg</th>
                  <th className="px-2 py-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/40">
                    <td className="px-2 py-2 whitespace-nowrap text-zinc-500">{fmtTime(r.sentAt)}</td>
                    <td className="px-2 py-2 whitespace-nowrap font-mono text-xs">{r.toPhone}</td>
                    <td className="px-2 py-2">
                      <Link href={`/super-admin/communications/text/${r.id}`} className="text-blue-700 hover:underline dark:text-blue-400">
                        {preview(r.body)}
                      </Link>
                    </td>
                    <td className="px-2 py-2"><Badge tone={smsStatusTone(r.status)}>{r.status}</Badge></td>
                    <td className="px-2 py-2 whitespace-nowrap text-zinc-500 tabular-nums">{r.segments ?? '—'}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-zinc-500">{r.senderEmail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
