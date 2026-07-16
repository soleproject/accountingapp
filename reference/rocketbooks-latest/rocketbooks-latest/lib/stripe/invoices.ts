import 'server-only';
import type Stripe from 'stripe';
import { stripe } from './client';

export interface ClientInvoice {
  id: string;
  /** Unix seconds (invoice created). */
  date: number;
  amountCents: number;
  currency: string;
  /** Stripe invoice status: paid | open | uncollectible | void | draft. */
  status: string;
  description: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

function toClientInvoice(inv: Stripe.Invoice, fallbackKey: string): ClientInvoice {
  return {
    id: inv.id ?? `${fallbackKey}-${inv.created}`,
    date: inv.created,
    amountCents: inv.amount_paid || inv.total || 0,
    currency: inv.currency,
    status: inv.status ?? 'unknown',
    description: inv.lines?.data?.[0]?.description ?? null,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    invoicePdf: inv.invoice_pdf ?? null,
  };
}

/**
 * The actual charges for a client, pulled live from Stripe — recurring invoices
 * by subscription (works for firm-paid subs too, since the invoice is tied to
 * the subscription regardless of which customer is charged), plus any one-off
 * manual charges tagged for this client. The manual pass lists a customer's
 * invoices and keeps only those tagged manual_charge + this client's org, so a
 * firm-paid manual charge on the shared firm customer attributes to the right
 * client. Deduped by invoice id, newest first. Best-effort: a Stripe error for
 * one source is logged and skipped, never thrown, so the page still renders.
 */
export async function listClientInvoices(args: {
  stripeSubscriptionIds: string[];
  /** Surface manual one-off charges tagged for orgId on this customer. */
  manual?: { customerId: string; orgId: string };
}): Promise<ClientInvoice[]> {
  const byId = new Map<string, ClientInvoice>();

  const subIds = [...new Set(args.stripeSubscriptionIds.filter(Boolean))];
  for (const subId of subIds) {
    try {
      const res = await stripe().invoices.list({ subscription: subId, limit: 100 });
      for (const inv of res.data) {
        const ci = toClientInvoice(inv, subId);
        byId.set(ci.id, ci);
      }
    } catch (e) {
      console.error('listClientInvoices: Stripe error for subscription', subId, e);
    }
  }

  if (args.manual?.customerId) {
    try {
      const res = await stripe().invoices.list({ customer: args.manual.customerId, limit: 100 });
      for (const inv of res.data) {
        if (inv.metadata?.manual_charge !== 'true') continue;
        if (inv.metadata?.organization_id !== args.manual.orgId) continue;
        const ci = toClientInvoice(inv, args.manual.customerId);
        byId.set(ci.id, ci);
      }
    } catch (e) {
      console.error('listClientInvoices: Stripe error for customer', args.manual.customerId, e);
    }
  }

  return [...byId.values()].sort((a, b) => b.date - a.date);
}
