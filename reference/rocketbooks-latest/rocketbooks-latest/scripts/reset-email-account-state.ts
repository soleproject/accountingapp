/**
 * One-shot: clear the IMAP watermark on a connected email account so
 * the next poll cycle re-runs the 7-day backfill.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/reset-email-account-state.ts <email-address>
 *
 * Sets:
 *   last_uid_seen        → NULL
 *   last_uidvalidity     → NULL
 *   connection_status    → 'unknown'
 *   last_error           → NULL
 *
 * Does NOT touch the encrypted credentials, is_active, or any
 * inbox_messages rows. If you want to wipe the messages too, do that
 * separately — this script is intentionally narrow.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { emailAccounts } from '@/db/schema/schema';

async function main() {
	const email = process.argv[2];
	if (!email) {
		console.error('Usage: reset-email-account-state.ts <email-address>');
		process.exit(2);
	}
	const normalized = email.trim().toLowerCase();

	const before = await db
		.select({
			id: emailAccounts.id,
			emailAddress: emailAccounts.emailAddress,
			lastUidSeen: emailAccounts.lastUidSeen,
			lastUidvalidity: emailAccounts.lastUidvalidity,
			connectionStatus: emailAccounts.connectionStatus,
			lastError: emailAccounts.lastError,
		})
		.from(emailAccounts)
		.where(sql`lower(${emailAccounts.emailAddress}) = ${normalized}`);

	if (before.length === 0) {
		console.error(`No email_accounts row found for ${normalized}`);
		process.exit(1);
	}

	console.log('Before:');
	for (const r of before) console.log(`  ${r.id}  ${r.emailAddress}  uid=${r.lastUidSeen}  uv=${r.lastUidvalidity}  status=${r.connectionStatus}  err=${r.lastError ?? '—'}`);

	const ids = before.map((r) => r.id);
	for (const id of ids) {
		await db
			.update(emailAccounts)
			.set({
				lastUidSeen: null,
				lastUidvalidity: null,
				connectionStatus: 'unknown',
				lastError: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(emailAccounts.id, id));
	}

	console.log(`Reset ${ids.length} row(s). Next poll cycle will re-run the 7-day backfill.`);
	process.exit(0);
}

main().catch((err) => {
	console.error('RESET ERROR:', err);
	process.exit(1);
});
