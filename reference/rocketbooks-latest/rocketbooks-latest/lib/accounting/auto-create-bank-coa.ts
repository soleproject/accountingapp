import 'server-only';
import { randomUUID } from 'crypto';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, plaidAccounts } from '@/db/schema/schema';

interface CreateBankCoaArgs {
  organizationId: string;
  plaidAccountId: string;
  institutionName: string;
  accountName: string;
  last4: string | null;
  subtype: string | null;
}

/**
 * Pick the next free four-digit account number starting from `start`.
 * Bank accounts conventionally land in the 1010-1099 range.
 */
async function nextAccountNumber(orgId: string, start = 1010): Promise<string> {
  const rows = await db
    .select({ accountNumber: chartOfAccounts.accountNumber })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, orgId));
  const used = new Set(rows.map((r) => r.accountNumber));
  for (let n = start; n < 9999; n++) {
    const candidate = String(n);
    if (!used.has(candidate)) return candidate;
  }
  return String(start);
}

function buildAccountName(args: CreateBankCoaArgs): string {
  const parts: string[] = [];
  if (args.institutionName && args.institutionName !== 'Unknown') parts.push(args.institutionName);
  if (args.accountName && args.accountName !== args.institutionName) parts.push(args.accountName);
  if (args.last4) parts.push(`···${args.last4}`);
  return parts.join(' ').trim() || 'Bank account';
}

function baseDetailFromSubtype(subtype: string | null): string {
  if (!subtype) return 'checking';
  const s = subtype.toLowerCase();
  if (s.includes('checking')) return 'checking';
  if (s.includes('savings')) return 'savings';
  if (s.includes('money market') || s.includes('money_market')) return 'money_market';
  if (s.includes('cd') || s.includes('certificate')) return 'cd';
  if (s.includes('credit')) return 'credit_card';
  return 'checking';
}

/**
 * Build a detail_type that's unique within (org, gaap_type, detail_type).
 * The COA table has a UNIQUE constraint on that triple, so two checking
 * accounts can't both have detail_type='checking' — we suffix with last4
 * (or a short random tag) so each bank account is distinct.
 */
function uniqueDetailType(base: string, last4: string | null): string {
  if (last4) return `${base}_${last4}`;
  return `${base}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a chart-of-accounts row for a freshly linked Plaid account, and
 * link it via plaid_accounts.chart_of_account_id. Idempotent: if the
 * plaid account is already mapped, returns the existing COA id without
 * creating a duplicate.
 */
export async function autoCreateBankCoa(args: CreateBankCoaArgs): Promise<string> {
  // If the plaid account already has a mapping, leave it alone
  const [existingMapping] = await db
    .select({ chartOfAccountId: plaidAccounts.chartOfAccountId })
    .from(plaidAccounts)
    .where(eq(plaidAccounts.id, args.plaidAccountId))
    .limit(1);
  if (existingMapping?.chartOfAccountId) return existingMapping.chartOfAccountId;

  const accountName = buildAccountName(args);
  const accountNumber = await nextAccountNumber(args.organizationId);
  const isCredit = (args.subtype ?? '').toLowerCase().includes('credit');

  const id = randomUUID();
  await db.insert(chartOfAccounts).values({
    id,
    organizationId: args.organizationId,
    accountNumber,
    accountName,
    gaapType: isCredit ? 'current_liability' : 'current_asset',
    accountType: isCredit ? 'credit_card' : 'bank',
    detailType: uniqueDetailType(baseDetailFromSubtype(args.subtype), args.last4),
    normalBalance: isCredit ? 'credit' : 'debit',
    isActive: true,
    createdByAi: true,
    systemGenerated: true,
    passedNameContactCheck: true,
  });

  await db
    .update(plaidAccounts)
    .set({ chartOfAccountId: id })
    .where(and(eq(plaidAccounts.id, args.plaidAccountId), eq(plaidAccounts.linkedOrganizationId, args.organizationId)));

  return id;
}

void sql;
