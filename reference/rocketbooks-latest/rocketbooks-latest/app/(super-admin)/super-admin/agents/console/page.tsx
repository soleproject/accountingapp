import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { AdminPage } from '@/components/admin/AdminPage';
import { AgentConsole } from '../_components/AgentConsole';

export const dynamic = 'force-dynamic';

const OWNER_EMAIL = 'michael@bigsaas.ai';
const DEFAULT_CWD = 'C:\\Users\\micha\\rocketsuite';

export default async function AgentConsolePage() {
  const user = await requireSession();
  if ((user.email ?? '').toLowerCase() !== OWNER_EMAIL) redirect('/super-admin/dashboard');

  const wsBase = process.env.NEXT_PUBLIC_AGENT_HOST_URL ?? 'ws://127.0.0.1:4500';
  const token = process.env.AGENT_HOST_TOKEN ?? 'local-dev';
  const wsUrl = `${wsBase}?token=${encodeURIComponent(token)}`;

  return (
    <AdminPage
      title="Agent Console"
      crumbs={[{ label: 'SuperAdmin' }, { label: 'Agents', href: '/super-admin/agents' }, { label: 'Console' }]}
    >
      <AgentConsole wsUrl={wsUrl} defaultCwd={DEFAULT_CWD} />
    </AdminPage>
  );
}
