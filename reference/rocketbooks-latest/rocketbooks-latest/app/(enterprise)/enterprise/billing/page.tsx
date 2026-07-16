import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminPage, Panel, Badge, MetricTile, EmptyHint } from '@/components/admin/AdminPage';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { listClientBilling, type ClientBillingRow } from '@/lib/enterprise/billing-overview';

export const dynamic = 'force-dynamic';

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function money(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}/mo`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusBadge(status: string) {
  const tone =
    status === 'active'
      ? 'green'
      : status === 'trialing' || status === 'trial'
        ? 'blue'
        : status === 'past_due'
          ? 'amber'
          : status === 'canceled' || status === 'none'
            ? 'zinc'
            : 'zinc';
  const label = status === 'none' ? 'Not billed' : status.replace('_', ' ');
  return <Badge tone={tone as 'green' | 'amber' | 'red' | 'blue' | 'zinc'}>{label}</Badge>;
}

export default async function EnterpriseBillingPage() {
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  const rows = await listClientBilling(current.id);
  const firmPaid = rows.filter((r) => r.whoPays === 'firm');
  const clientPaid = rows.filter((r) => r.whoPays === 'client');
  const firmMonthlyCents = firmPaid.reduce((sum, r) => sum + (r.priceCents ?? 0), 0);

  return (
    <AdminPage
      title="Billing"
      crumbs={[{ label: 'Enterprise' }, { label: 'Billing' }]}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricTile label="Total clients" value={rows.length} />
        <MetricTile label="You pay for" value={firmPaid.length} iconColor="text-indigo-600 dark:text-indigo-400" />
        <MetricTile label="Client-paid" value={clientPaid.length} />
        <MetricTile label="Your monthly spend" value={firmMonthlyCents ? `$${(firmMonthlyCents / 100).toFixed(0)}` : '$0'} />
      </div>

      <Panel className="overflow-hidden p-0">
        {rows.length === 0 ? (
          <div className="p-5">
            <EmptyHint>No clients yet. Add clients to see their billing here.</EmptyHint>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-3 font-medium">Client</th>
                <th className="px-5 py-3 font-medium">Who pays</th>
                <th className="px-5 py-3 font-medium">Price</th>
                <th className="px-5 py-3 font-medium">Billing day</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Next bill</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: ClientBillingRow) => (
                <tr key={r.clientUserId} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/40">
                  <td className="px-5 py-3">
                    <Link href={`/enterprise/billing/${r.clientUserId}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                      {r.clientName}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    {r.whoPays === 'firm' ? (
                      <Badge tone="blue">You pay</Badge>
                    ) : r.whoPays === 'client' ? (
                      <span className="text-zinc-600 dark:text-zinc-300">Client pays</span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 tabular-nums text-zinc-700 dark:text-zinc-200">{money(r.priceCents)}</td>
                  <td className="px-5 py-3 text-zinc-700 dark:text-zinc-200">
                    {r.billingDayOfMonth ? ordinal(r.billingDayOfMonth) : <span className="text-zinc-400">—</span>}
                  </td>
                  <td className="px-5 py-3">{statusBadge(r.status)}</td>
                  <td className="px-5 py-3 text-zinc-600 dark:text-zinc-400">{fmtDate(r.nextBillAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </AdminPage>
  );
}
