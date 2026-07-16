import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, organizations, organizationSubscriptions, billingProducts, enterpriseClients, organizationBilling } from '@/db/schema/schema';
import { AdminPage, Panel, Badge, EmptyHint } from '@/components/admin/AdminPage';
import { getCurrentEnterprise, listAccessibleEnterprises } from '@/lib/auth/enterprise';
import { effectiveClientBilling } from '@/lib/enterprise/client-billing';
import { listClientInvoices } from '@/lib/stripe/invoices';
import { customerHasPaymentMethod } from '@/lib/stripe/charges';
import { ChargeClientForm } from './_components/ChargeClientForm';

export const dynamic = 'force-dynamic';

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(cents / 100);
}

function invoiceBadge(status: string) {
  const tone = status === 'paid' ? 'green' : status === 'open' ? 'amber' : status === 'uncollectible' ? 'red' : 'zinc';
  return <Badge tone={tone as 'green' | 'amber' | 'red' | 'blue' | 'zinc'}>{status}</Badge>;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ClientBillingDetailPage({ params }: PageProps) {
  const { id: clientUserId } = await params;

  const current = await getCurrentEnterprise();
  if (!current) notFound();
  const enterprises = await listAccessibleEnterprises();
  const accessibleIds = enterprises.map((e) => e.id);

  // 404 unless this user is a client of a firm the actor can access.
  const [link] = await db
    .select({
      enterpriseId: enterpriseClients.enterpriseId,
      clientMode: enterpriseClients.clientBillingMode,
      clientPrice: enterpriseClients.clientPriceMode,
    })
    .from(enterpriseClients)
    .where(and(eq(enterpriseClients.clientUserId, clientUserId), inArray(enterpriseClients.enterpriseId, accessibleIds)))
    .limit(1);
  if (!link) notFound();

  const [user] = await db
    .select({ id: users.id, email: users.email, fullName: users.fullName })
    .from(users)
    .where(eq(users.id, clientUserId))
    .limit(1);
  if (!user) notFound();

  const [firm] = await db
    .select({ mode: organizations.clientBillingMode, price: organizations.clientPriceMode })
    .from(organizations)
    .where(eq(organizations.id, link.enterpriseId))
    .limit(1);

  // The client's orgs + every subscription on them (for invoices + the header).
  const subs = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      status: organizationSubscriptions.status,
      periodStart: organizationSubscriptions.currentPeriodStart,
      periodEnd: organizationSubscriptions.currentPeriodEnd,
      stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
      featureKey: billingProducts.featureKey,
    })
    .from(organizations)
    .leftJoin(organizationSubscriptions, eq(organizationSubscriptions.organizationId, organizations.id))
    .leftJoin(billingProducts, eq(billingProducts.id, organizationSubscriptions.billingProductId))
    .where(eq(organizations.ownerUserId, clientUserId));

  const orgName = subs.find((s) => s.orgName)?.orgName ?? null;
  const clientName = orgName?.trim() || user.fullName?.trim() || user.email;

  // Current sub = a real (non-demo) one with the latest period start.
  const realSubs = subs.filter((s) => s.stripeSubscriptionId);
  const currentSub =
    realSubs
      .slice()
      .sort((a, b) => {
        const ad = a.featureKey && a.featureKey !== 'demo_full' ? 1 : 0;
        const bd = b.featureKey && b.featureKey !== 'demo_full' ? 1 : 0;
        if (ad !== bd) return bd - ad;
        return (b.periodStart ?? '').localeCompare(a.periodStart ?? '');
      })[0] ?? null;

  const { billingMode, priceMode } = effectiveClientBilling({
    enterpriseMode: firm?.mode ?? null,
    enterprisePrice: firm?.price ?? null,
    clientMode: link.clientMode,
    clientPrice: link.clientPrice,
  });
  const arrangement =
    billingMode === 'firm_pays'
      ? 'You pay — $69/mo'
      : billingMode === 'client_pays'
        ? priceMode === 'discount_69'
          ? 'Client pays — $69/mo'
          : 'Client pays — $89/mo'
        : 'No billing arrangement';
  // Billing day = the day of the month they actually get charged (next-bill /
  // period-end day), which is correct for trials too; fall back to period start.
  const billingDaySource = currentSub?.periodEnd ?? currentSub?.periodStart ?? null;
  const billingDay = billingDaySource ? ordinal(new Date(String(billingDaySource)).getUTCDate()) : '—';
  const status = currentSub?.status ?? 'none';

  // Who pays for this client → which Stripe customer a manual charge lands on.
  const clientOrgId = subs.find((s) => s.orgId)?.orgId ?? null;
  const payingOrgId = billingMode === 'firm_pays' ? link.enterpriseId : clientOrgId;
  const [payerBilling] = payingOrgId
    ? await db
        .select({ customerId: organizationBilling.stripeCustomerId })
        .from(organizationBilling)
        .where(eq(organizationBilling.organizationId, payingOrgId))
        .limit(1)
    : [undefined];
  const payingCustomerId = payerBilling?.customerId ?? null;
  const cardOnFile = payingCustomerId ? await customerHasPaymentMethod(payingCustomerId) : false;
  const payerLabel = billingMode === 'firm_pays' ? 'your firm' : 'the client';

  const invoices = await listClientInvoices({
    stripeSubscriptionIds: realSubs.map((s) => s.stripeSubscriptionId!).filter(Boolean),
    manual: payingCustomerId && clientOrgId ? { customerId: payingCustomerId, orgId: clientOrgId } : undefined,
  });

  return (
    <AdminPage
      title={clientName}
      crumbs={[{ label: 'Enterprise' }, { label: 'Billing', href: '/enterprise/billing' }, { label: clientName }]}
    >
      <Panel>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Arrangement</dt>
            <dd className="mt-0.5 font-medium">{arrangement}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Status</dt>
            <dd className="mt-0.5">
              <Badge tone={status === 'active' ? 'green' : status === 'past_due' ? 'amber' : 'zinc'}>
                {status === 'none' ? 'Not billed' : status.replace('_', ' ')}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Billing day</dt>
            <dd className="mt-0.5 font-medium">{billingDay}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Next bill</dt>
            <dd className="mt-0.5 font-medium">{fmtDate(currentSub?.periodEnd ? String(currentSub.periodEnd) : null)}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Charge client">
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          Bill a one-off amount to {payerLabel === 'your firm' ? 'your firm (this client is firm-paid)' : "the client's card on file"}. It posts as a Stripe invoice with a receipt.
        </p>
        <ChargeClientForm clientUserId={clientUserId} payerLabel={payerLabel} cardOnFile={cardOnFile} />
      </Panel>

      <Panel title="Billing history" className="overflow-hidden">
        {invoices.length === 0 ? (
          <EmptyHint>No charges yet{billingMode ? ` — ${arrangement.toLowerCase()}.` : '.'}</EmptyHint>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Amount</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                  <td className="py-2.5 pr-4 text-zinc-700 dark:text-zinc-200">
                    {new Date(inv.date * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums text-zinc-700 dark:text-zinc-200">{fmtMoney(inv.amountCents, inv.currency)}</td>
                  <td className="py-2.5 pr-4">{invoiceBadge(inv.status)}</td>
                  <td className="py-2.5 pr-4">
                    {inv.hostedInvoiceUrl || inv.invoicePdf ? (
                      <a
                        href={(inv.hostedInvoiceUrl || inv.invoicePdf)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        View
                      </a>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div>
        <Link href="/enterprise/billing" className="text-sm text-zinc-500 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300">
          ← Back to billing
        </Link>
      </div>
    </AdminPage>
  );
}
