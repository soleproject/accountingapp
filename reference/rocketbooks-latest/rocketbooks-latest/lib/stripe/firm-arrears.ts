import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, firmArrearsInvoices } from '@/db/schema/schema';
import { stripe } from './client';
import { getOrCreateStripeCustomer } from './customers';
import { firmHasPaymentMethod } from './firm-billing';
import { firmPaidClientOrgIds } from '@/lib/enterprise/client-billing';
import { maybeGetAccountingTier, ACCOUNTING_TIERS } from '@/lib/accounting/tiers';
import { logger } from '@/lib/logger';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type FirmBillStatus =
  | 'billed'
  | 'skipped_already'
  | 'skipped_no_clients'
  | 'skipped_no_card'
  | 'error';

export interface FirmBillResult {
  enterpriseId: string;
  status: FirmBillStatus;
  clientCount?: number;
  amountCents?: number;
  stripeInvoiceId?: string;
  error?: string;
}

/**
 * Bill ONE firm for a service month, IN ARREARS: on the 5th of month M+1 the firm
 * is invoiced for the clients it covers, each at its tier's REDUCED price
 * (Starter $29 / Plus $65 / Pro $119), as ONE consolidated Stripe invoice charged
 * automatically to the firm's card. Idempotent via firm_arrears_invoices
 * UNIQUE(enterprise, year, month) — a second run for the same period is a no-op.
 *
 * v1 bills the clients the firm CURRENTLY covers (firmPaidClientOrgIds) as the
 * proxy for "covered during the month"; per-month membership history is a later
 * refinement. `dryRun` computes the invoice without creating/charging anything.
 */
export async function billFirmForMonth(
  enterpriseId: string,
  year: number,
  month: number,
  opts?: { dryRun?: boolean },
): Promise<FirmBillResult> {
  const dryRun = opts?.dryRun ?? false;
  const periodLabel = `${MONTHS[month - 1]} ${year}`;
  const periodTag = `${year}-${String(month).padStart(2, '0')}`;

  // Idempotency: already invoiced this firm for this period?
  const [existing] = await db
    .select({ id: firmArrearsInvoices.id })
    .from(firmArrearsInvoices)
    .where(
      and(
        eq(firmArrearsInvoices.enterpriseId, enterpriseId),
        eq(firmArrearsInvoices.periodYear, year),
        eq(firmArrearsInvoices.periodMonth, month),
      ),
    )
    .limit(1);
  if (existing) return { enterpriseId, status: 'skipped_already' };

  const clientOrgIds = await firmPaidClientOrgIds(enterpriseId);
  if (clientOrgIds.length === 0) return { enterpriseId, status: 'skipped_no_clients' };

  // The firm must have a card on file to be charged. (The per-client creation
  // flows gate firm-pays on a card, so this should hold; log loudly if not.)
  if (!(await firmHasPaymentMethod(enterpriseId))) {
    logger.warn({ enterpriseId, periodTag, clientCount: clientOrgIds.length }, 'firm arrears: clients to bill but no card on file — skipping');
    return { enterpriseId, status: 'skipped_no_card', clientCount: clientOrgIds.length };
  }

  const clients = await db
    .select({ id: organizations.id, name: organizations.name, tier: organizations.accountingTier })
    .from(organizations)
    .where(inArray(organizations.id, clientOrgIds));

  const lines = clients.map((c) => {
    const tier = maybeGetAccountingTier(c.tier) ?? ACCOUNTING_TIERS.starter;
    return { orgId: c.id, name: c.name || 'Client', tierLabel: tier.label, amountCents: tier.reducedPriceCents };
  });
  const amountCents = lines.reduce((sum, l) => sum + l.amountCents, 0);

  if (dryRun) {
    return { enterpriseId, status: 'billed', clientCount: lines.length, amountCents, stripeInvoiceId: '(dry-run)' };
  }

  try {
    const customerId = await getOrCreateStripeCustomer(enterpriseId);
    // Draft invoice → add a line per client → finalize → charge.
    const invoice = await stripe().invoices.create({
      customer: customerId,
      collection_method: 'charge_automatically',
      auto_advance: false,
      description: `Client billing — ${periodLabel}`,
      metadata: { firm_arrears: 'true', enterprise_id: enterpriseId, period: periodTag },
    });
    const invoiceId = invoice.id as string;
    for (const l of lines) {
      await stripe().invoiceItems.create({
        customer: customerId,
        invoice: invoiceId,
        amount: l.amountCents,
        currency: 'usd',
        description: `${l.name} — ${l.tierLabel} (${periodLabel})`,
        metadata: { enterprise_id: enterpriseId, client_org_id: l.orgId, period: periodTag },
      });
    }
    await stripe().invoices.finalizeInvoice(invoiceId);
    try {
      await stripe().invoices.pay(invoiceId);
    } catch (payErr) {
      logger.warn({ enterpriseId, invoiceId, err: payErr }, 'firm arrears: invoice finalized but payment failed — Stripe dunning will retry');
    }

    await db.insert(firmArrearsInvoices).values({
      id: randomUUID(),
      enterpriseId,
      periodYear: year,
      periodMonth: month,
      stripeInvoiceId: invoiceId,
      clientCount: lines.length,
      amountCents,
    });

    logger.info({ enterpriseId, periodTag, clientCount: lines.length, amountCents, invoiceId }, 'firm arrears: invoiced');
    return { enterpriseId, status: 'billed', clientCount: lines.length, amountCents, stripeInvoiceId: invoiceId };
  } catch (e) {
    logger.error({ enterpriseId, periodTag, err: e }, 'firm arrears: billing failed');
    return { enterpriseId, status: 'error', error: e instanceof Error ? e.message : 'billing failed' };
  }
}

/**
 * Bill every firm that covers clients, for the given service month. Iterates all
 * enterprise orgs; firmPaidClientOrgIds returns [] for firms that cover no one, so
 * they're skipped cheaply.
 */
export async function runFirmArrearsBilling(
  year: number,
  month: number,
  opts?: { dryRun?: boolean },
): Promise<FirmBillResult[]> {
  const firms = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.planType, 'enterprise'));
  const results: FirmBillResult[] = [];
  for (const f of firms) {
    results.push(await billFirmForMonth(f.id, year, month, opts));
  }
  return results;
}
