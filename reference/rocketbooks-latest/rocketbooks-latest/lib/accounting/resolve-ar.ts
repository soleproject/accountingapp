/**
 * Resolve an organization's Accounts Receivable account. Used by the
 * transaction-record invoice-payment flow when the user picks an invoice
 * in the Category picker — we need to know which AR account to credit on
 * the JE.
 *
 * Preference order: detail_type=accounts_receivable → strict name match
 * ("Accounts Receivable" / "* A/R" / contains "receivable"). Returns
 * null if no AR-like asset account exists.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';

const AR_GAAP_TYPES = ['asset', 'current_asset'];

export async function resolveArAccountId(orgId: string): Promise<string | null> {
  const accts = await db
    .select({
      id: chartOfAccounts.id,
      accountName: chartOfAccounts.accountName,
      detailType: chartOfAccounts.detailType,
      gaapType: chartOfAccounts.gaapType,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)));
  const asset = accts.filter((a) => AR_GAAP_TYPES.includes((a.gaapType ?? '').toLowerCase()));
  const strict = asset.filter((a) => {
    const dt = (a.detailType ?? '').toLowerCase();
    if (dt === 'accounts_receivable') return true;
    const n = a.accountName.toLowerCase();
    return (
      n === 'accounts receivable' ||
      n.startsWith('accounts receivable ') ||
      n.endsWith(' a/r') ||
      n.includes('receivable')
    );
  });
  if (strict.length > 0) return strict[0]!.id;
  return null;
}
