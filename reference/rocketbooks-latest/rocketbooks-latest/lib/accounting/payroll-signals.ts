import 'server-only';
import { and, eq, or, ilike, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, generalLedger } from '@/db/schema/schema';

// QBO detail slots that mark a payroll account.
const PAYROLL_DETAIL_TYPES = ['PayrollExpenses', 'PayrollTaxPayable', 'PayrollClearing', 'PayrollLiabilities'];

/**
 * True when the org actually runs payroll — it has a payroll account WITH posted
 * ledger activity. The default chart of accounts seeds payroll accounts for
 * everyone, so account existence alone isn't enough; we require real activity so
 * we don't nag sole-props / no-employee businesses with Form 941 reminders.
 */
export async function hasPayrollActivity(orgId: string): Promise<boolean> {
  const accts = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.organizationId, orgId),
        or(
          inArray(chartOfAccounts.detailType, PAYROLL_DETAIL_TYPES),
          ilike(chartOfAccounts.accountName, '%payroll%'),
          ilike(chartOfAccounts.accountName, '%wages%'),
          ilike(chartOfAccounts.accountName, '%salaries%'),
        ),
      ),
    );
  if (accts.length === 0) return false;

  const [hit] = await db
    .select({ id: generalLedger.id })
    .from(generalLedger)
    .where(
      and(
        eq(generalLedger.organizationId, orgId),
        inArray(
          generalLedger.accountId,
          accts.map((a) => a.id),
        ),
      ),
    )
    .limit(1);
  return !!hit;
}
