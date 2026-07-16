import 'server-only';
import { randomUUID } from 'crypto';
import { eq, and, ilike, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import type { VeryfiBankStatement } from '@/lib/veryfi/bank-statement';

const ASSET_TYPES = ['asset', 'current_asset'];

interface ResolveResult {
  chartOfAccountId: string;
  matched: boolean; // true = existing COA found, false = new one created
  accountName: string;
}

function lastFour(s: string | null | undefined): string | null {
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 4) return digits.length > 0 ? digits : null;
  return digits.slice(-4);
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

function baseDetailFromAccountType(t: string | null | undefined): string {
  const v = (t ?? '').toLowerCase();
  if (v.includes('saving')) return 'savings';
  if (v.includes('money')) return 'money_market';
  if (v.includes('cd') || v.includes('certificate')) return 'cd';
  return 'checking';
}

/**
 * COA has a UNIQUE constraint on (organization_id, gaap_type, detail_type) —
 * suffix with last4 (or short random) so each bank account gets a unique row.
 */
function uniqueDetailType(base: string, last4: string | null): string {
  if (last4) return `${base}_${last4}`;
  return `${base}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildAccountName(args: { bank: string | null; type: string | null; last4: string | null }): string {
  const parts: string[] = [];
  if (args.bank) parts.push(args.bank);
  if (args.type) {
    const t = baseDetailFromAccountType(args.type);
    parts.push(t === 'checking' ? 'Checking' : t === 'savings' ? 'Savings' : t.replace('_', ' '));
  }
  if (args.last4) parts.push(`···${args.last4}`);
  return parts.join(' ').trim() || 'Bank account';
}

/**
 * Given a Veryfi bank-statement document, either:
 *   1. Find an existing asset/bank COA that matches the institution + last4, or
 *   2. Create a new one and return its id.
 *
 * Match heuristic (best → worst):
 *   a. Existing COA name contains the last4 (most specific)
 *   b. Existing COA name contains the institution AND has bank/cash/checking
 *      in its name and only one such match exists (fuzzy)
 * Otherwise creates a new asset COA following the same shape as the
 * Plaid auto-create helper.
 */
export async function resolveStatementCoa(args: {
  organizationId: string;
  doc: VeryfiBankStatement;
}): Promise<ResolveResult> {
  const { organizationId, doc } = args;

  const bankName = (doc.bank_name ?? '').trim() || null;
  const accountNumber = doc.account_number ?? doc.accounts?.[0]?.account_number ?? null;
  const accountType = doc.accounts?.[0]?.account_type ?? null;
  const last4 = lastFour(accountNumber);

  // Pull all org asset accounts once
  const assetCoas = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, organizationId), eq(chartOfAccounts.isActive, true)));

  const assetSet = assetCoas.filter((a) => ASSET_TYPES.includes((a.gaapType ?? '').toLowerCase()));

  // Match by last4 first
  if (last4) {
    const byLast4 = assetSet.find((a) => a.accountName.includes(last4));
    if (byLast4) {
      return { chartOfAccountId: byLast4.id, matched: true, accountName: byLast4.accountName };
    }
  }

  // Fuzzy by bank name (only if exactly one bank-flavored match exists)
  if (bankName) {
    const bankNorm = normalize(bankName);
    const candidates = assetSet.filter((a) => {
      const n = normalize(a.accountName);
      const isBanky = /bank|cash|checking|savings/.test(a.accountName.toLowerCase());
      return isBanky && n.includes(bankNorm);
    });
    if (candidates.length === 1) {
      return { chartOfAccountId: candidates[0].id, matched: true, accountName: candidates[0].accountName };
    }
  }

  // No match → create
  const accountName = buildAccountName({ bank: bankName, type: accountType, last4 });
  const accountNumberCoa = await nextAccountNumber(organizationId);
  const id = randomUUID();
  await db.insert(chartOfAccounts).values({
    id,
    organizationId,
    accountNumber: accountNumberCoa,
    accountName,
    gaapType: 'current_asset',
    accountType: 'bank',
    detailType: uniqueDetailType(baseDetailFromAccountType(accountType), last4),
    normalBalance: 'debit',
    isActive: true,
    createdByAi: true,
    systemGenerated: true,
    passedNameContactCheck: true,
  });

  return { chartOfAccountId: id, matched: false, accountName };
}

void or;
void ilike;
void sql;
