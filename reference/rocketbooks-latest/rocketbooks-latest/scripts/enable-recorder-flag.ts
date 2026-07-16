/**
 * One-off: enable the Organizer Recorder for a user (across every org
 * they switch into). Sets users.recorder_enabled_at = now().
 *
 * Run with: npx tsx scripts/enable-recorder-flag.ts [email]
 * Defaults to michael@bigsaas.ai.
 *
 * The recorder is also gated per-org via the 'recorder' feature pack —
 * see lib/recorder/access.ts. Either switch being on grants access.
 */
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
	const email = process.argv[2] ?? 'michael@bigsaas.ai';
	const { db } = await import('../db/client');
	const { users } = await import('../db/schema/schema');

	const result = await db
		.update(users)
		.set({ recorderEnabledAt: new Date().toISOString() })
		.where(eq(users.email, email))
		.returning({ id: users.id });

	if (result.length === 0) {
		throw new Error(`No user with email ${email}`);
	}
	console.log(`✓ recorder enabled for ${email} (user ${result[0].id})`);
	process.exit(0);
}

main().catch((err) => {
	console.error('✗ failed:', err);
	process.exit(1);
});
