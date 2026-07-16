/**
 * Clear all organizer-surface data for a single org. Intended for the
 * michael@bigsaas.ai "RocketBooks" TEST org (see memory). Deletes in
 * child -> parent order so foreign keys are satisfied even where ON DELETE
 * CASCADE isn't declared.
 *
 *   npx tsx scripts/clear-organizer.ts          # clear michael's org
 *   npx tsx scripts/clear-organizer.ts <orgId>  # clear a specific org
 *
 * DESTRUCTIVE. Only run against a test org.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

async function main() {
	const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });

	let org = process.argv[2];
	if (!org) {
		const [u] = await sql`
			select coalesce(active_organization_id, organization_id) as org
			from public.users where lower(email) = 'michael@bigsaas.ai' limit 1`;
		if (!u?.org) throw new Error('Could not resolve michael@bigsaas.ai org');
		org = u.org as string;
	}

	const recIds = (await sql`select id from public.recordings where organization_id = ${org}`).map((r) => r.id as string);

	// Meeting follow-up graph (action items cascade off followups, but be explicit).
	await sql`delete from public.meeting_action_items where organization_id = ${org}`;
	await sql`delete from public.meeting_followups where organization_id = ${org}`;

	// Recording graph (segments/outputs cascade off recordings, but be explicit).
	if (recIds.length) {
		await sql`delete from public.recording_segments where recording_id in ${sql(recIds)}`;
		await sql`delete from public.recording_outputs where recording_id in ${sql(recIds)}`;
		await sql`delete from public.recording_bot_sessions where recording_id in ${sql(recIds)}`;
	}
	await sql`delete from public.recordings where organization_id = ${org}`;

	// Tasks + their links, notes, documents, appointments, contacts.
	await sql`delete from public.task_links where organization_id = ${org}`;
	await sql`delete from public.tasks where organization_id = ${org}`;
	await sql`delete from public.notes where organization_id = ${org}`;
	await sql`delete from public.organizer_documents where organization_id = ${org}`;
	await sql`delete from public.appointments where organization_id = ${org}`;
	await sql`delete from public.contacts where organization_id = ${org}`;

	console.log(`Cleared organizer data for org ${org}.`);
	await sql.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
