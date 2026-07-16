/**
 * One-off: apply migration 0069_text_messages.sql.
 * Run with: npx tsx scripts/apply-0069-text-messages.ts
 *
 * Idempotent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
	const { db } = await import('../db/client');
	const sqlPath = join(process.cwd(), 'db/migrations/0069_text_messages.sql');
	const ddl = readFileSync(sqlPath, 'utf8');
	await db.execute(sql.raw(ddl));
	console.log('✓ 0069_text_messages applied.');
	process.exit(0);
}

main().catch((err) => {
	console.error('✗ migration failed:', err);
	process.exit(1);
});
