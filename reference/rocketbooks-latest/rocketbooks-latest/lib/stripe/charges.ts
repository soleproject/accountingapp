import 'server-only';
import type Stripe from 'stripe';
import { stripe } from './client';

/**
 * Does this Stripe customer have a card we can charge off-session? Checks the
 * default payment method first, then any payment method on file. Mirrors
 * firmHasPaymentMethod but keyed by customer id (so it works for client
 * customers too). Best-effort: returns false on any Stripe error.
 */
export async function customerHasPaymentMethod(customerId: string): Promise<boolean> {
  try {
    const customer = await stripe().customers.retrieve(customerId);
    if ((customer as Stripe.DeletedCustomer).deleted) return false;
    const def = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
    if (def) return true;
    const pms = await stripe().paymentMethods.list({ customer: customerId, limit: 1 });
    return pms.data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Charge a customer a one-off amount off-session, as a finalized + paid Stripe
 * invoice (so it produces a receipt and shows up in invoice history). The
 * invoice is tagged manual_charge + organization_id so it can be attributed to
 * the right client even when it lands on a shared firm customer.
 *
 * Pass a stable idempotencyKey so a double-submit never double-charges. Never
 * throws — a decline or missing card comes back as { ok:false, error }.
 */
export async function chargeCustomerOneOff(args: {
  customerId: string;
  amountCents: number;
  currency?: string;
  description: string;
  clientOrgId: string;
  idempotencyKey: string;
}): Promise<{ ok: boolean; invoiceId?: string; status?: string; error?: string }> {
  const currency = (args.currency ?? 'usd').toLowerCase();
  try {
    // Resolve a payment method to charge.
    const customer = await stripe().customers.retrieve(args.customerId);
    if ((customer as Stripe.DeletedCustomer).deleted) return { ok: false, error: 'Customer no longer exists' };
    const def = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
    let pmId = typeof def === 'string' ? def : def?.id ?? null;
    if (!pmId) {
      const pms = await stripe().paymentMethods.list({ customer: args.customerId, limit: 1 });
      pmId = pms.data[0]?.id ?? null;
    }
    if (!pmId) return { ok: false, error: 'No card on file to charge' };

    const metadata = { manual_charge: 'true', organization_id: args.clientOrgId };

    await stripe().invoiceItems.create(
      { customer: args.customerId, amount: args.amountCents, currency, description: args.description },
      { idempotencyKey: `${args.idempotencyKey}-item` },
    );

    const invoice = await stripe().invoices.create(
      {
        customer: args.customerId,
        collection_method: 'charge_automatically',
        pending_invoice_items_behavior: 'include',
        default_payment_method: pmId,
        description: args.description,
        metadata,
        auto_advance: false,
      },
      { idempotencyKey: `${args.idempotencyKey}-inv` },
    );
    if (!invoice.id) return { ok: false, error: 'Stripe did not return an invoice id' };

    await stripe().invoices.finalizeInvoice(invoice.id);
    const paid = await stripe().invoices.pay(invoice.id, { off_session: true });
    return { ok: paid.status === 'paid', invoiceId: invoice.id, status: paid.status ?? undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Charge failed' };
  }
}
