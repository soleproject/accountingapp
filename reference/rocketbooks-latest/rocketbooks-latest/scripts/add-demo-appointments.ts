/**
 * Add a handful of appointments dated for TODAY to the demo workspace
 * ("Demo Co, LLC") so the Organizer dashboard "Today's schedule" card renders
 * with real-looking data. The original seed (scripts/seed-demo-organizer.ts)
 * stamps "today" appointments at seed time, so they go stale once the date
 * rolls over — this top-up re-creates them for the current day.
 *
 *   npx tsx scripts/add-demo-appointments.ts
 *
 * Idempotent-ish: it first deletes any demo appointments that already start
 * today, then inserts the fresh set, so re-running won't pile up duplicates.
 */
import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

// Mirrors lib/auth/demo.ts.
const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000000';
const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';

const sql = postgres(DB_URL, { prepare: false, max: 1 });

/** Today (local) at the given hour:minute, as an ISO timestamp. */
function todayAt(hour: number, minute = 0): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).toISOString();
}

interface DemoAppointment {
  title: string;
  contact?: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
}

const APPOINTMENTS: DemoAppointment[] = [
  { title: 'Acme strategy call', contact: 'Acme Corporation', startsAt: todayAt(9, 0), endsAt: todayAt(9, 45), location: 'Zoom' },
  { title: 'Standup', startsAt: todayAt(10, 0), endsAt: todayAt(10, 15), location: 'Office' },
  { title: 'Sunrise Retail invoice review', contact: 'Sunrise Retail Co', startsAt: todayAt(11, 30), endsAt: todayAt(12, 0), location: 'Phone' },
  { title: 'Lunch w/ Greenfield', contact: 'Greenfield Consulting', startsAt: todayAt(12, 30), endsAt: todayAt(13, 30), location: 'Cafe Luna' },
  { title: 'Highland Marketing Q2 retainer sync', contact: 'Highland Marketing', startsAt: todayAt(14, 0), endsAt: todayAt(14, 45), location: 'Google Meet' },
  { title: 'Brookfield integration demo', contact: 'Brookfield Industries', startsAt: todayAt(15, 30), endsAt: todayAt(16, 30), location: 'Google Meet' },
];

async function loadContactIds(): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; contact_name: string }[]>`
    SELECT id, contact_name FROM contacts WHERE organization_id = ${DEMO_ORG_ID}
  `;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.contact_name, r.id);
  return map;
}

async function main() {
  const contactIds = await loadContactIds();

  // Clear out any demo appointments that already start today so re-running is safe.
  const startOfToday = todayAt(0, 0);
  const startOfTomorrow = new Date(new Date(startOfToday).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const deleted = await sql`
    DELETE FROM appointments
    WHERE organization_id = ${DEMO_ORG_ID}
      AND source = 'demo'
      AND starts_at >= ${startOfToday}
      AND starts_at < ${startOfTomorrow}
  `;
  console.log(`Cleared ${deleted.count} existing demo appointment(s) for today.`);

  console.log(`Inserting ${APPOINTMENTS.length} appointments for today…`);
  for (const a of APPOINTMENTS) {
    const contactId = a.contact ? contactIds.get(a.contact) ?? null : null;
    await sql`
      INSERT INTO appointments (
        id, user_id, organization_id, contact_id, title, starts_at, ends_at,
        location, source, created_at, updated_at
      ) VALUES (
        ${randomUUID()}, ${DEMO_USER_ID}, ${DEMO_ORG_ID}, ${contactId}, ${a.title},
        ${a.startsAt}, ${a.endsAt ?? null}, ${a.location ?? null}, 'demo', NOW(), NOW()
      )
    `;
  }

  await sql.end();
  console.log(`Done — added ${APPOINTMENTS.length} appointments to Demo Co, LLC for today.`);
}

main().catch(async (e) => {
  console.error('add-demo-appointments failed:', e);
  try { await sql.end(); } catch { /* noop */ }
  process.exit(1);
});
