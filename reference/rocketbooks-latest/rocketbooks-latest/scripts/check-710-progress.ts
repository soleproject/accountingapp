import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

async function main() {
	const [r] = await db.execute(
		sql`SELECT COUNT(*)::int AS n FROM trust_review_findings WHERE code = 'TRUST_710_REROUTED_TO_DEMAND_NOTE' OR code = 'TRUST_710_REROUTED_TO_FOOD'`,
	);
	console.log(`Reroute findings inserted so far: ${(r as { n: number }).n}`);
	process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
