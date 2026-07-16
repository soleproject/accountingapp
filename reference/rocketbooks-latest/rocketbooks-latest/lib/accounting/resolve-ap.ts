/**
 * Resolve an organization's Accounts Payable account. Used by the
 * transaction-record bill-payment flow when the user picks a bill in the
 * Category picker — we need to know which AP account to debit on the JE.
 *
 * Preference order: detail_type=accounts_payable → strict name match
 * ("Accounts Payable" / "* A/P") → any liability account. Returns null
 * if the org has no liability accounts at all.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';

const AP_GAAP_TYPES = ['liability', 'current_liability'];

export async function resolveApAccountId(orgId: string): Promise<string | null> {
  const accts = await db
    .select({
      id: chartOfAccounts.id,
      accountName: chartOfAccounts.accountName,
      detailType: chartOfAccounts.detailType,
      gaapType: chartOfAccounts.gaapType,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)));
  const liab = accts.filter((a) => AP_GAAP_TYPES.includes((a.gaapType ?? '').toLowerCase()));
  const strict = liab.filter((a) => {
    const dt = (a.detailType ?? '').toLowerCase();
    if (dt === 'accounts_payable') return true;
    const n = a.accountName.toLowerCase();
    return n === 'accounts payable' || n.startsWith('accounts payable ') || n.endsWith(' a/p');
  });
  if (strict.length > 0) return strict[0]!.id;
  if (liab.length > 0) return liab[0]!.id;
  return null;
}
