'use server';

import { redirect } from 'next/navigation';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { createFirmBillingSetupSession, createEnterpriseOnboardingBillingSession } from '@/lib/stripe/checkout';

/**
 * Send the firm to Stripe Checkout (setup mode) to add/update the card used for
 * firm-paid clients. Stripe collects + vaults the card; we store nothing.
 */
export async function startFirmBillingSetupAction(formData: FormData): Promise<void> {
  const current = await getCurrentEnterprise();
  if (!current || current.id === DEMO_ENTERPRISE_ID) throw new Error('Not available for this enterprise.');
  const returnPath = String(formData.get('returnPath') ?? '/enterprise/settings');
  const url = await createFirmBillingSetupSession(current.id, returnPath);
  redirect(url);
}

/**
 * The end-of-onboarding billing step: starts the $95/mo private-label
 * subscription (and saves the card), or a card-setup checkout for firm-pays.
 * Redirects back to onboarding if there's nothing to bill.
 */
export async function startEnterpriseOnboardingBillingAction(): Promise<void> {
  const current = await getCurrentEnterprise();
  if (!current || current.id === DEMO_ENTERPRISE_ID) throw new Error('Not available for this enterprise.');
  const url = await createEnterpriseOnboardingBillingSession(current.id);
  if (url) redirect(url);
  redirect('/enterprise/onboarding?billing=none');
}
