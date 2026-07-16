import 'server-only';
import { getOnboardingStatus } from '@/lib/accounting/onboarding';

/**
 * Map each onboarding phase to the standalone page it corresponds to. When the
 * org is still on that (incomplete) phase and the assistant tries to send the
 * user to that page, we instead route them into the onboarding wizard so they
 * complete the step in context. Once onboarding is done, the same request goes
 * to the standalone page (e.g. a bank reconnect → /integrations/plaid).
 */
const PHASE_PATH: Record<string, string> = {
  business_info: '/businesses',
  quickbooks: '/integrations/qbo',
  plaid: '/integrations/plaid',
  bank_statements: '/imports',
  receipts: '/receipts',
};

export const ONBOARDING_WIZARD_PATH = '/ai-chat?onboarding=start';

/** Redirect a destination to the onboarding wizard when it IS the org's current
 * incomplete onboarding step; otherwise return the path unchanged. Best-effort. */
export async function onboardingAwarePath(orgId: string, path: string): Promise<string> {
  try {
    const ob = await getOnboardingStatus(orgId);
    if (ob && !ob.completed) {
      const stepPath = PHASE_PATH[ob.phase];
      if (stepPath && path.split('?')[0] === stepPath) return ONBOARDING_WIZARD_PATH;
    }
  } catch {
    /* best effort — fall through to the requested path */
  }
  return path;
}
