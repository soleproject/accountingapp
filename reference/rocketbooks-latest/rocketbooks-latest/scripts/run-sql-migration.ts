/**
 * Apply a SQL migration file via the project's Drizzle/postgres client.
 * Used when psql's CLI chokes on Supabase pooler URI params (e.g.
 * "supa=base-pooler.x" → "invalid URI query parameter").
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/run-sql-migration.ts db/migrations/0037_foo.sql
 */

import { readFile } from 'fs/promises';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

async function main() {
	const path = process.argv[2];
	if (!path) {
		console.error('Usage: run-sql-migration.ts <path-to-sql>');
		process.exit(2);
	}
	const stmt = await readFile(path, 'utf8');
	console.log(`Applying ${path} (${stmt.length} chars)`);
	await db.execute(sql.raw(stmt));
	console.log('OK');
	process.exit(0);
}

main().catch((err) => {
	console.error('MIGRATION ERROR:', err);
	process.exit(1);
});
