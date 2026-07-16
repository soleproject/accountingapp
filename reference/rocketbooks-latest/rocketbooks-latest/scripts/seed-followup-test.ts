/**
 * Seed (or clean) a fake meeting + transcript to exercise the meeting
 * follow-up loop end to end, the way the recorder would have left things:
 * a past appointment with a contact, a finished recording linked to it, a
 * diarized transcript, and a drafted summary + action items.
 *
 *   npx tsx scripts/seed-followup-test.ts          # seed (cleans prior test data first)
 *   npx tsx scripts/seed-followup-test.ts --clean  # remove all [TEST] follow-up data
 *
 * Everything is tagged "[TEST]" so it's easy to spot and remove. Targets the
 * michael@bigsaas.ai org. Raw SQL only — no app imports (the engine is
 * `server-only`); the cron route runs the real engine against this data.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

const MARK = '[TEST]';
const CONTACT_NAME = '[TEST] Acme Corp';

async function main() {
	const url = process.env.POSTGRES_URL_NON_POOLING!;
	if (!url) throw new Error('POSTGRES_URL_NON_POOLING not set');
	const sql = postgres(url, { prepare: false, max: 1 });

	const [user] = await sql`
		select id, coalesce(active_organization_id, organization_id) as org_id
		from public.users where lower(email) = 'michael@bigsaas.ai' limit 1`;
	if (!user?.org_id) throw new Error('Could not resolve michael@bigsaas.ai org');
	const userId = user.id as string;
	const orgId = user.org_id as string;

	// --- clean prior test data (also the first half of --clean) ----------------
	// Order respects FKs; meeting_* cascade off the appointment, recordings
	// cascade their segments/outputs.
	const appts = await sql`select id from public.appointments where organization_id = ${orgId} and title like ${MARK + '%'}`;
	const apptIds = appts.map((a) => a.id as string);
	if (apptIds.length) {
		await sql`delete from public.recordings where appointment_id in ${sql(apptIds)}`;
		await sql`delete from public.notes where appointment_id in ${sql(apptIds)}`;
		await sql`delete from public.appointments where id in ${sql(apptIds)}`; // cascades meeting_followups → meeting_action_items
	}
	await sql`delete from public.tasks where organization_id = ${orgId} and title like ${'%' + MARK + '%'}`;
	await sql`delete from public.contacts where organization_id = ${orgId} and contact_name = ${CONTACT_NAME}`;

	if (process.argv.includes('--clean')) {
		console.log(`Cleaned ${apptIds.length} test meeting(s) and related rows.`);
		await sql.end();
		return;
	}

	// --- enable the feature for this org ---------------------------------------
	await sql`update public.organizations set meeting_followups_enabled = true where id = ${orgId}`;

	// --- contact ---------------------------------------------------------------
	const contactId = randomUUID();
	await sql`insert into public.contacts (id, organization_id, contact_name, company_name, email, is_active, type_tags)
		values (${contactId}, ${orgId}, ${CONTACT_NAME}, 'Acme Corp', 'finance@acme.example', true, ${sql.json(['customer'])})`;

	// --- appointment (ended 2h ago) --------------------------------------------
	const now = Date.now();
	const startsAt = new Date(now - 3 * 3600_000).toISOString();
	const endsAt = new Date(now - 2 * 3600_000).toISOString();
	const apptId = randomUUID();
	await sql`insert into public.appointments (id, user_id, organization_id, contact_id, title, description, starts_at, ends_at, location, source)
		values (${apptId}, ${userId}, ${orgId}, ${contactId},
			${MARK + ' Q2 Planning Call — Acme Corp'},
			'Quarterly planning + pricing review with Acme.',
			${startsAt}, ${endsAt}, 'Google Meet', 'manual')`;

	// --- recording (ready, linked to the meeting) ------------------------------
	const recId = randomUUID();
	await sql`insert into public.recordings (id, organization_id, user_id, contact_id, appointment_id, title, source, status, duration_s, started_at)
		values (${recId}, ${orgId}, ${userId}, ${contactId}, ${apptId},
			${MARK + ' Q2 Planning Call recording'}, 'mic+tab', 'ready', 1840, ${startsAt})`;

	// --- diarized transcript ---------------------------------------------------
	// S1 = host (michael), S2 = Acme (mapped to the contact, so its action item
	// resolves to "owner is someone on the call").
	const transcript: Array<[string, string]> = [
		['S1', 'Thanks for hopping on. I wanted to walk through the Q2 plan and the pricing options we discussed last time.'],
		['S2', 'Sounds good. We are mostly aligned internally, just need to nail down the tier and the billing terms.'],
		['S1', 'Great. Based on your usage I think the Pro tier is the right fit. I will put together a revised proposal with the Pro breakdown.'],
		['S2', 'Perfect. One thing we will need to finalize is our updated headcount — it changed since last quarter. I will get you the new numbers.'],
		['S1', 'That works. Once I have the headcount I can finalize the proposal. I will also set up a follow-up demo for your finance team.'],
		['S2', 'Yes, the finance team will want to see the reporting features before we sign off.'],
		['S1', 'On billing — did you want annual or monthly?'],
		['S2', 'Let us do monthly for the first year, then we can revisit annual at renewal.'],
		['S1', 'Done. So we are moving forward on Pro, monthly billing year one, targeting an early Q3 go-live.'],
		['S2', 'Agreed. Looking forward to the proposal.'],
	];
	let t = 0;
	for (const [label, text] of transcript) {
		const startMs = t;
		const dur = 6000 + text.length * 40;
		t += dur;
		await sql`insert into public.recording_segments (id, recording_id, speaker_label, speaker_user_id, speaker_contact_id, start_ms, end_ms, text)
			values (${randomUUID()}, ${recId}, ${label},
				${label === 'S1' ? userId : null}, ${label === 'S2' ? contactId : null},
				${startMs}, ${t}, ${text})`;
	}

	// --- drafted summary + action items (what the recorder LLM would produce) ---
	const summaryMd =
		'Quarterly planning call with Acme Corp. Acme will move forward on the **Pro tier** with monthly billing for the first year, ' +
		'revisiting annual at renewal. A revised proposal is needed once Acme provides updated headcount numbers, and a follow-up demo ' +
		'will be scheduled for their finance team. Target go-live is early Q3.';
	const decisions = [
		'Move forward on the Pro tier',
		'Monthly billing for year one (revisit annual at renewal)',
		'Target go-live for early Q3',
	];
	const actionItems = [
		{ text: 'Send Acme the revised Q2 pricing proposal with the Pro tier breakdown', ownerSpeakerLabel: 'S1', dueHint: 'by Friday' },
		{ text: 'Schedule a follow-up demo for the Acme finance team', ownerSpeakerLabel: 'S1', dueHint: 'next week' },
		{ text: 'Acme to provide updated headcount numbers so the proposal can be finalized', ownerSpeakerLabel: 'S2', dueHint: null },
	];
	await sql`insert into public.recording_outputs (id, recording_id, summary_md, action_items, decisions)
		values (${randomUUID()}, ${recId}, ${summaryMd}, ${sql.json(actionItems)}, ${sql.json(decisions)})`;

	console.log('Seeded test meeting:');
	console.log('  org        ', orgId);
	console.log('  contact    ', contactId, CONTACT_NAME);
	console.log('  appointment', apptId);
	console.log('  recording  ', recId, '(ready, 3 action items, 2 speakers)');
	console.log('  feature    meeting_followups_enabled = true');
	console.log('');
	console.log('APPOINTMENT_ID=' + apptId);

	await sql.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
