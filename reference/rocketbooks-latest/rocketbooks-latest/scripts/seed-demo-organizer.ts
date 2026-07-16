/**
 * Populate the demo workspace ("Demo Co, LLC") with Organizer fixtures so the
 * organizer pages — Dashboard, Calendar, Tasks, Texts, Inbox, Recorder — render
 * with real-looking data instead of empty states. Companion to
 * scripts/seed-demo-fixtures.ts (which seeds the accounting side).
 *
 *   npx tsx scripts/seed-demo-organizer.ts            # seed only if empty
 *   npx tsx scripts/seed-demo-organizer.ts --force    # wipe organizer demo data first
 *
 * Organizer pages are normally user-scoped, but the demo org is shared and
 * read-only, so everything here is owned by the demo SYSTEM user and the
 * organizer pages drop their user filter when the org is the demo (see the
 * isDemoOrg branches in the organizer pages + InboxView). Contacts are reused
 * from the accounting fixtures — run seed-demo-fixtures.ts first.
 *
 * IMPORTANT: writes go directly to the DB. No real ingestion paths (Twilio,
 * IMAP, Deepgram, Google Calendar) are touched — this is sample data.
 */
import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

// Mirrors lib/auth/demo.ts. Keep in sync.
const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000000';
const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';

// The demo org's own "business" phone, used as the from/to counterpart for SMS.
const DEMO_BUSINESS_PHONE = '+18773319648';

const force = process.argv.includes('--force');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

function isoDaysFromNow(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Today (local) at the given hour:minute, as an ISO timestamp. */
function todayAt(hour: number, minute = 0, dayOffset = 0): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute).toISOString();
}

/** A date in the current month at a given day + time (local), as ISO. */
function thisMonthAt(day: number, hour: number, minute = 0): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), day, hour, minute).toISOString();
}

// ---------------- Tasks (personal organizer to-dos) ----------------
interface DemoTask {
  title: string;
  description?: string;
  module?: string;
  priority?: 'low' | 'medium' | 'high';
  status: 'OPEN' | 'DONE';
  dueInDays?: number | null;
  contact?: string; // company this task is about (drives the dashboard company filter)
}

const TASKS: DemoTask[] = [
  { title: 'Send Q2 engagement letter to Brookfield Industries', module: 'Contacts', priority: 'high', status: 'OPEN', dueInDays: 1, contact: 'Brookfield Industries' },
  { title: 'Follow up on Sunrise Retail overdue invoice', module: 'Invoices', priority: 'high', status: 'OPEN', dueInDays: 2, contact: 'Sunrise Retail Co' },
  { title: 'Review Highland Marketing Q2 retainer scope', module: 'Bills', priority: 'medium', status: 'OPEN', dueInDays: 4, contact: 'Highland Marketing' },
  { title: 'Prep agenda for Acme strategy call', module: 'Calendar', priority: 'medium', status: 'OPEN', dueInDays: 0, contact: 'Acme Corporation' },
  { title: 'Reconcile April WeWork rent', module: 'Transactions', priority: 'low', status: 'OPEN', dueInDays: 6, contact: 'WeWork' },
  { title: 'Draft sprint 5 proposal for Greenfield', module: 'Contacts', priority: 'medium', status: 'OPEN', dueInDays: 9, contact: 'Greenfield Consulting' },
  { title: 'Renew Google Workspace subscription', module: 'Bills', priority: 'low', status: 'OPEN', dueInDays: null, contact: 'Google Workspace' },
  { title: 'File Q1 sales tax', module: 'Taxes', priority: 'high', status: 'DONE', dueInDays: -12 },
  { title: 'Onboard Tech Innovations LLC', module: 'Contacts', priority: 'medium', status: 'DONE', dueInDays: -20, contact: 'Tech Innovations LLC' },
];

// ---------------- Notes (recent activity) ----------------
interface DemoNote {
  contact?: string; // contact name to attach to (optional)
  body: string;
  daysAgo: number;
}

const NOTES: DemoNote[] = [
  { contact: 'Acme Corporation', daysAgo: 1, body: 'Call with Dana — wants to expand the retainer to include quarterly roadmap reviews. Send a revised SOW.' },
  { contact: 'Brookfield Industries', daysAgo: 2, body: 'Milestone 1 of the integration project signed off. Invoicing the next milestone after the demo on the 15th.' },
  { contact: 'Sunrise Retail Co', daysAgo: 3, body: 'Left voicemail re: overdue spring fixtures invoice. Will try again Thursday.' },
  { contact: 'Greenfield Consulting', daysAgo: 5, body: 'Discovery workshop went well. They want design mockups before committing to sprint 5.' },
  { body: 'Team offsite logistics: flights booked through Delta, hotel TBD. Confirm headcount by Friday.', daysAgo: 6 },
];

// ---------------- Appointments (calendar + today's schedule) ----------------
interface DemoAppointment {
  title: string;
  contact?: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
}

const APPOINTMENTS: DemoAppointment[] = [
  // Today — these drive the dashboard "Today's schedule" card.
  { title: 'Acme strategy call', contact: 'Acme Corporation', startsAt: todayAt(9, 30), endsAt: todayAt(10, 15), location: 'Zoom' },
  { title: 'Standup', startsAt: todayAt(11, 0), endsAt: todayAt(11, 15), location: 'Office' },
  { title: 'Lunch w/ Greenfield', contact: 'Greenfield Consulting', startsAt: todayAt(12, 30), endsAt: todayAt(13, 30), location: 'Cafe Luna' },
  { title: 'Brookfield integration demo', contact: 'Brookfield Industries', startsAt: todayAt(15, 0), endsAt: todayAt(16, 0), location: 'Google Meet' },
  // Rest of the month — fill out the calendar grid.
  { title: 'Tech Innovations check-in', contact: 'Tech Innovations LLC', startsAt: thisMonthAt(3, 14, 0), endsAt: thisMonthAt(3, 14, 30) },
  { title: 'Quarterly review prep', startsAt: thisMonthAt(8, 10, 0), endsAt: thisMonthAt(8, 11, 0) },
  { title: 'Sunrise Retail call', contact: 'Sunrise Retail Co', startsAt: thisMonthAt(12, 13, 0), endsAt: thisMonthAt(12, 13, 30) },
  { title: 'Highland Marketing kickoff', contact: 'Highland Marketing', startsAt: thisMonthAt(18, 9, 0), endsAt: thisMonthAt(18, 10, 0), location: 'Zoom' },
  { title: 'Board update', startsAt: thisMonthAt(24, 16, 0), endsAt: thisMonthAt(24, 17, 0) },
  { title: 'Greenfield sprint 5 planning', contact: 'Greenfield Consulting', startsAt: thisMonthAt(27, 11, 0), endsAt: thisMonthAt(27, 12, 0) },
];

// ---------------- Inbox (email) ----------------
interface DemoInboxMessage {
  fromName: string;
  fromAddress: string;
  contact?: string;
  subject: string;
  body: string;
  daysAgo: number;
  status: 'open' | 'triaged' | 'archived';
  aiStatus?: 'drafted' | 'sent' | 'pending' | 'failed' | null;
}

const INBOX: DemoInboxMessage[] = [
  { fromName: 'Dana Reed', fromAddress: 'dana@acme-corp.com', contact: 'Acme Corporation', subject: 'Expanding our retainer', body: 'Hi — following up on our call. We\'d like to add quarterly roadmap reviews to the retainer. Can you send a revised SOW this week?', daysAgo: 0, status: 'open', aiStatus: 'drafted' },
  { fromName: 'Accounts Payable', fromAddress: 'ap@sunriseretail.com', contact: 'Sunrise Retail Co', subject: 'RE: Invoice INV-1044', body: 'Apologies for the delay — payment is going out this Friday. Can you confirm the remittance address?', daysAgo: 1, status: 'open', aiStatus: 'pending' },
  { fromName: 'Marco Liu', fromAddress: 'finance@brookfield.com', contact: 'Brookfield Industries', subject: 'Milestone 1 sign-off', body: 'Confirming milestone 1 is approved. Go ahead and invoice. Looking forward to the demo on the 15th.', daysAgo: 2, status: 'open', aiStatus: null },
  { fromName: 'Highland Marketing', fromAddress: 'billing@highlandmkt.com', contact: 'Highland Marketing', subject: 'Q2 retainer scope', body: 'Attached is the proposed Q2 paid-social scope. Let us know if the budget split works for you.', daysAgo: 3, status: 'triaged', aiStatus: 'sent' },
  { fromName: 'Stripe', fromAddress: 'support@stripe.com', contact: 'Stripe', subject: 'Your April payout summary', body: 'Your April payouts totaled $34,250 across 9 transfers. View the full breakdown in your dashboard.', daysAgo: 4, status: 'archived', aiStatus: null },
];

// ---------------- Texts (SMS threads) ----------------
interface DemoText {
  contact: string;
  direction: 'inbound' | 'outbound';
  body: string;
  minutesAgo: number;
  unread?: boolean; // inbound only — leaves read_at null
}

const TEXTS: DemoText[] = [
  { contact: 'Acme Corporation', direction: 'outbound', body: 'Hi Dana — sending over the revised SOW this afternoon.', minutesAgo: 240 },
  { contact: 'Acme Corporation', direction: 'inbound', body: 'Perfect, thank you! Looking forward to it.', minutesAgo: 215, unread: true },
  { contact: 'Sunrise Retail Co', direction: 'outbound', body: 'Just a friendly reminder on invoice INV-1044 — let me know if you need anything.', minutesAgo: 1440 },
  { contact: 'Sunrise Retail Co', direction: 'inbound', body: 'Payment going out Friday, sorry for the delay!', minutesAgo: 1380, unread: true },
  { contact: 'Brookfield Industries', direction: 'inbound', body: 'Are we still on for the demo on the 15th?', minutesAgo: 60, unread: true },
  { contact: 'Greenfield Consulting', direction: 'outbound', body: 'Mockups are ready for review whenever you have a minute.', minutesAgo: 2880 },
];

// ---------------- Recordings ----------------
interface DemoRecording {
  title: string;
  contact?: string;
  daysAgo: number;
  durationS: number;
  status: string;
}

const RECORDINGS: DemoRecording[] = [
  { title: 'Acme strategy call', contact: 'Acme Corporation', daysAgo: 0, durationS: 2730, status: 'ready' },
  { title: 'Brookfield milestone review', contact: 'Brookfield Industries', daysAgo: 2, durationS: 1875, status: 'ready' },
  { title: 'Greenfield discovery workshop', contact: 'Greenfield Consulting', daysAgo: 5, durationS: 3420, status: 'ready' },
];

async function loadContactIds(): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; contact_name: string }[]>`
    SELECT id, contact_name FROM contacts WHERE organization_id = ${DEMO_ORG_ID}
  `;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.contact_name, r.id);
  return map;
}

async function loadContactPhones(): Promise<Map<string, string>> {
  const rows = await sql<{ contact_name: string; phone: string | null }[]>`
    SELECT contact_name, phone FROM contacts WHERE organization_id = ${DEMO_ORG_ID}
  `;
  const map = new Map<string, string>();
  for (const r of rows) if (r.phone) map.set(r.contact_name, r.phone);
  return map;
}

async function alreadySeeded(): Promise<boolean> {
  const rows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM appointments WHERE organization_id = ${DEMO_ORG_ID}
  `;
  return (rows[0]?.n ?? 0) > 0;
}

async function wipe(): Promise<void> {
  console.log('Wiping existing organizer demo data…');
  await sql`DELETE FROM task_links WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM text_messages WHERE organization_id = ${DEMO_ORG_ID}`;
  // recording_segments / recording_outputs cascade from recordings.
  await sql`DELETE FROM recordings WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM appointments WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM notes WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM inbox_messages WHERE organization_id = ${DEMO_ORG_ID}`;
  await sql`DELETE FROM email_accounts WHERE user_id = ${DEMO_USER_ID}`;
  await sql`DELETE FROM tasks WHERE organization_id = ${DEMO_ORG_ID} AND product = 'organizer'`;
}

async function main() {
  if (await alreadySeeded()) {
    if (!force) {
      console.log('Organizer demo data already present. Re-run with --force to wipe and re-seed.');
      await sql.end();
      return;
    }
    await wipe();
  }

  const contactIds = await loadContactIds();
  const contactPhones = await loadContactPhones();
  if (contactIds.size === 0) {
    console.warn('No demo contacts found — run scripts/seed-demo-fixtures.ts first so notes/texts/etc. can link to contacts.');
  }

  // 1. Tasks. assigned_to_contacts links the task to a company so the
  // dashboard company filter (jsonb_exists on that array) can scope to it.
  console.log(`Seeding ${TASKS.length} tasks…`);
  for (const t of TASKS) {
    const contactId = t.contact ? contactIds.get(t.contact) ?? null : null;
    await sql`
      INSERT INTO tasks (
        id, user_id, organization_id, product, title, module, priority, status,
        due_date, source, subitems, assigned_to_contacts, created_at, updated_at
      ) VALUES (
        ${randomUUID()}, ${DEMO_USER_ID}, ${DEMO_ORG_ID}, 'organizer', ${t.title},
        ${t.module ?? null}, ${t.priority ?? null}, ${t.status},
        ${t.dueInDays == null ? null : isoDaysFromNow(t.dueInDays)}, 'demo',
        ${sql.json([])}, ${sql.json(contactId ? [contactId] : [])}, NOW(), NOW()
      )
    `;
  }

  // 2. Notes
  console.log(`Seeding ${NOTES.length} notes…`);
  for (const n of NOTES) {
    const contactId = n.contact ? contactIds.get(n.contact) ?? null : null;
    const createdAt = isoDaysFromNow(-n.daysAgo);
    await sql`
      INSERT INTO notes (id, user_id, organization_id, contact_id, body, source, created_at, updated_at)
      VALUES (${randomUUID()}, ${DEMO_USER_ID}, ${DEMO_ORG_ID}, ${contactId}, ${n.body}, 'demo', ${createdAt}, ${createdAt})
    `;
  }

  // 3. Appointments
  console.log(`Seeding ${APPOINTMENTS.length} appointments…`);
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

  // 4. Inbox: one connected mailbox + recent messages.
  console.log('Seeding demo mailbox + inbox messages…');
  await sql`
    INSERT INTO email_accounts (
      id, user_id, email_address, encrypted_password, encryption_iv, encryption_auth_tag,
      provider, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      last_polled_at, connection_status, is_active, created_at, updated_at
    ) VALUES (
      ${randomUUID()}, ${DEMO_USER_ID}, 'hello@democo.example', 'demo', 'demo', 'demo',
      'gmail', 'imap.gmail.com', 993, true, 'smtp.gmail.com', 465, true,
      ${isoDaysFromNow(0)}, 'ok', true, NOW(), NOW()
    )
  `;
  for (const m of INBOX) {
    const contactId = m.contact ? contactIds.get(m.contact) ?? null : null;
    const receivedAt = isoDaysFromNow(-m.daysAgo);
    await sql`
      INSERT INTO inbox_messages (
        id, user_id, organization_id, contact_id, source, from_address, from_name,
        subject, body, received_at, status, ai_status, created_at
      ) VALUES (
        ${randomUUID()}, ${DEMO_USER_ID}, ${DEMO_ORG_ID}, ${contactId}, 'email', ${m.fromAddress}, ${m.fromName},
        ${m.subject}, ${m.body}, ${receivedAt}, ${m.status}, ${m.aiStatus ?? null}, ${receivedAt}
      )
    `;
  }

  // 5. Texts
  console.log(`Seeding ${TEXTS.length} text messages…`);
  let textsSeeded = 0;
  for (const t of TEXTS) {
    const contactId = contactIds.get(t.contact);
    const phone = contactPhones.get(t.contact);
    if (!contactId || !phone) {
      console.warn(`skip text to ${t.contact} — contact or phone not found`);
      continue;
    }
    const createdAt = new Date(Date.now() - t.minutesAgo * 60 * 1000).toISOString();
    const fromPhone = t.direction === 'inbound' ? phone : DEMO_BUSINESS_PHONE;
    const toPhone = t.direction === 'inbound' ? DEMO_BUSINESS_PHONE : phone;
    const readAt = t.direction === 'inbound' && t.unread ? null : createdAt;
    await sql`
      INSERT INTO text_messages (
        id, organization_id, contact_id, direction, from_phone, to_phone, body,
        status, sent_by_user_id, read_at, created_at
      ) VALUES (
        ${randomUUID()}, ${DEMO_ORG_ID}, ${contactId}, ${t.direction}, ${fromPhone}, ${toPhone}, ${t.body},
        ${t.direction === 'outbound' ? 'delivered' : 'received'},
        ${t.direction === 'outbound' ? DEMO_USER_ID : null}, ${readAt}, ${createdAt}
      )
    `;
    textsSeeded++;
  }

  // 6. Recordings
  console.log(`Seeding ${RECORDINGS.length} recordings…`);
  for (const r of RECORDINGS) {
    const contactId = r.contact ? contactIds.get(r.contact) ?? null : null;
    const createdAt = isoDaysFromNow(-r.daysAgo);
    await sql`
      INSERT INTO recordings (
        id, organization_id, user_id, contact_id, title, source, status,
        duration_s, started_at, created_at, updated_at
      ) VALUES (
        ${randomUUID()}, ${DEMO_ORG_ID}, ${DEMO_USER_ID}, ${contactId}, ${r.title}, 'demo', ${r.status},
        ${r.durationS}, ${createdAt}, ${createdAt}, ${createdAt}
      )
    `;
  }

  // 7. Task links — cross-link a couple of tasks to a note / meeting / email /
  // text so the bidirectional linking feature has demo data (contacts are
  // already linked via assigned_to_contacts from the tasks seed above).
  console.log('Linking tasks to related items…');
  const firstId = async (rows: { id: string }[]) => rows[0]?.id ?? null;
  const taskByTitle = (title: string) =>
    sql<{ id: string }[]>`SELECT id FROM tasks WHERE organization_id=${DEMO_ORG_ID} AND product='organizer' AND title=${title} LIMIT 1`.then(firstId);
  const apptByTitle = (title: string) =>
    sql<{ id: string }[]>`SELECT id FROM appointments WHERE organization_id=${DEMO_ORG_ID} AND title=${title} LIMIT 1`.then(firstId);
  const inboxBySubject = (subject: string) =>
    sql<{ id: string }[]>`SELECT id FROM inbox_messages WHERE organization_id=${DEMO_ORG_ID} AND subject=${subject} LIMIT 1`.then(firstId);
  const noteByLike = (frag: string) =>
    sql<{ id: string }[]>`SELECT id FROM notes WHERE organization_id=${DEMO_ORG_ID} AND body ILIKE ${`%${frag}%`} LIMIT 1`.then(firstId);
  const textForContact = (name: string) =>
    sql<{ id: string }[]>`SELECT tm.id FROM text_messages tm JOIN contacts c ON c.id = tm.contact_id WHERE tm.organization_id=${DEMO_ORG_ID} AND c.contact_name=${name} ORDER BY tm.created_at DESC LIMIT 1`.then(firstId);

  const link = async (taskId: string | null, entityType: string, entityId: string | null) => {
    if (!taskId || !entityId) return 0;
    await sql`
      INSERT INTO task_links (id, organization_id, task_id, entity_type, entity_id)
      VALUES (${randomUUID()}, ${DEMO_ORG_ID}, ${taskId}, ${entityType}, ${entityId})
      ON CONFLICT (task_id, entity_type, entity_id) DO NOTHING
    `;
    return 1;
  };

  let linksSeeded = 0;
  const acmeTask = await taskByTitle('Prep agenda for Acme strategy call');
  linksSeeded += await link(acmeTask, 'appointment', await apptByTitle('Acme strategy call'));
  linksSeeded += await link(acmeTask, 'inbox_message', await inboxBySubject('Expanding our retainer'));
  linksSeeded += await link(acmeTask, 'note', await noteByLike('Dana'));

  const sunriseTask = await taskByTitle('Follow up on Sunrise Retail overdue invoice');
  linksSeeded += await link(sunriseTask, 'inbox_message', await inboxBySubject('RE: Invoice INV-1044'));
  linksSeeded += await link(sunriseTask, 'text_message', await textForContact('Sunrise Retail Co'));

  const brookfieldTask = await taskByTitle('Send Q2 engagement letter to Brookfield Industries');
  linksSeeded += await link(brookfieldTask, 'inbox_message', await inboxBySubject('Milestone 1 sign-off'));

  await sql.end();
  console.log(`Linked ${linksSeeded} task ↔ entity relationships.`);
  console.log(
    `\nDone — organizer demo seeded: ${TASKS.length} tasks, ${NOTES.length} notes, ` +
      `${APPOINTMENTS.length} appointments, ${INBOX.length} inbox messages, ` +
      `${textsSeeded} texts, ${RECORDINGS.length} recordings.`,
  );
}

main().catch(async (e) => {
  console.error('seed-demo-organizer failed:', e);
  try { await sql.end(); } catch { /* noop */ }
  process.exit(1);
});
