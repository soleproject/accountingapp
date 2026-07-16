import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { journalEntryLines } from '@/db/schema/schema';

/**
 * Net outstanding balance on a beneficiary's 265.x demand-note account.
 *
 * Demand notes are credit-normal liabilities, but accounting-wise the
 * "balance" the user cares about is "how much does the beneficiary owe
 * the trust right now":
 *   - debit increases owed (trust paid for personal stuff on their behalf)
 *   - credit reduces owed (beneficiary paid back, or balance was wiped via
 *     a 310 distribution)
 *
 * Returns (sum of debits) − (sum of credits). > 0 means the beneficiary
 * still owes the trust; 0 (or negative) means demand note is exhausted and
 * a 310 distribution may proceed.
 *
 * Cheap: index on (account_id) covers this aggregation.
 */
export async function getDemandNoteOutstanding(args: {
	demandNoteAccountId: string;
}): Promise<number> {
	const [row] = await db
		.select({
			debit: sql<string>`coalesce(sum(${journalEntryLines.debit}), 0)::text`,
			credit: sql<string>`coalesce(sum(${journalEntryLines.credit}), 0)::text`,
		})
		.from(journalEntryLines)
		.where(eq(journalEntryLines.accountId, args.demandNoteAccountId));
	const debit = Number(row?.debit ?? 0);
	const credit = Number(row?.credit ?? 0);
	return Math.round((debit - credit) * 100) / 100;
}
