# Plan: Calendly-style availability + public booking links

Let external people self-book meetings with a rocketsuite user, on that user's own
availability, from a shareable public link.

## What the user gets
- A **Booking settings** section (Calendar/Settings) where each user defines:
  - Weekly recurring availability (per weekday on/off + time windows, e.g. Mon 9–12 & 1–5).
  - Date overrides (block a specific day, or add one-off hours).
  - Timezone, minimum notice, max days out, buffer between meetings.
  - One or more **event types** (name, duration, description) — each gets its own link.
  - A personal slug + copyable public link, plus a "Copy link" button per event type.
- A **public booking page** (`/book/[slug]` and `/book/[slug]/[eventType]`) that anyone can open
  logged-out: pick an event type → see real open slots → enter name/email/phone → confirm.
- On a confirmed booking the system:
  - Creates an `appointments` row (shows on the host's calendar immediately).
  - Pushes the event to the host's Google Calendar (with the booker as attendee) when connected.
  - Auto-creates/links a contact for the booker.
  - Emails a confirmation to booker + host (Resend).
  - Texts the booker a confirmation **only if** a valid phone was given **and** Texts is enabled
    for the org (`isTextsEnabledForOrg`).

## Data model (new migration `0078_booking.sql`, hand-written SQL per schema-drift memory)
1. `booking_profiles` — one per user. `id, userId (unique), organizationId, slug (unique),
   timezone, minNoticeMinutes, maxDaysOut, bufferMinutes, isActive, createdAt, updatedAt`.
2. `booking_event_types` — `id, bookingProfileId, organizationId, name, slug, durationMinutes,
   description, color, isActive, sortOrder, createdAt, updatedAt`. Unique(bookingProfileId, slug).
3. `booking_availability_rules` — weekly recurring windows.
   `id, bookingProfileId, weekday (0–6), startMinute, endMinute`. (minutes from midnight, local tz)
4. `booking_date_overrides` — `id, bookingProfileId, date, isBlocked, startMinute, endMinute`.
5. Extend `appointments`: add `source` value `'booking'` (already a free varchar — no DDL needed)
   and add nullable `bookingEventTypeId`, `bookerEmail`, `bookerPhone`, `bookerName`, `bookingId`
   columns so booked meetings are identifiable. Mirror new columns in `db/schema/schema.ts`.
6. `bookings` — the booking record (audit + idempotency): `id, organizationId, hostUserId,
   bookingEventTypeId, appointmentId, contactId, bookerName, bookerEmail, bookerPhone,
   startsAt, endsAt, status ('confirmed'|'canceled'), emailStatus, smsStatus, googleEventId,
   createdAt`. Used for cancel links and to prevent double-submit.

## Server-side: availability + slot computation
- `lib/booking/availability.ts`:
  - `getOpenSlots({ userId, eventType, fromDate, toDate })`:
    1. Expand weekly rules + date overrides into candidate windows in the profile timezone.
    2. Slice into `durationMinutes` slots respecting `bufferMinutes`, `minNoticeMinutes`, `maxDaysOut`.
    3. Subtract busy time: existing `appointments` for that user (app side) **and** Google Calendar
       busy events. Reuse the already-synced Google appointments (source `'google'`) in the
       `appointments` table so we don't need a separate freebusy call — both conflict sources are
       already in one table. (Chosen approach: "Both Google + app".)
    4. Return available start times.
- Timezone handling via the host's stored timezone; render slots in the booker's local tz on the client.

## Public booking flow (outside `(app)` group — no `requireSession`)
- `app/book/[slug]/page.tsx` — resolve `booking_profiles` by slug → list active event types.
- `app/book/[slug]/[eventType]/page.tsx` — server-render the booker UI; client component fetches
  open slots from a public API and submits.
- `app/api/public/booking/[slug]/slots/route.ts` (GET) — returns open slots for an event type/date range.
- `app/api/public/booking/[slug]/book/route.ts` (POST) — validates the slot is still free
  (re-check conflicts to avoid races), then runs the booking transaction (below).
- Add `/api/public/booking` to the middleware public matcher so it isn't session-gated.
- `app/book/cancel/[bookingId]/page.tsx` — simple cancel page (deletes appt + Google event, marks
  booking canceled, notifies host). Link included in confirmation email.

## Booking transaction (`lib/booking/createBooking.ts`)
Ordered, each step best-effort after the appointment is committed:
1. Re-validate slot is free (app + Google appointments) → 409 if taken.
2. Upsert contact by email within org (`.onConflictDoNothing()` to respect the
   `UNIQUE(org,is_active,contact_name)` constraint; match by email first).
3. Insert `appointments` row (`source:'booking'`, link contactId, booker fields) + `bookings` row.
4. `createGoogleEvent(hostUserId, {... attendees:[booker]})` if connected; store returned eventId as
   `appointments.googleEventId` + `bookings.googleEventId` (prevents next sync creating a duplicate).
5. `sendEmail()` confirmation to booker and host (include cancel link). Record `emailStatus`.
6. If `normalizePhoneE164(bookerPhone)` is non-null **and** `isTextsEnabledForOrg(orgId)` →
   `sendSms()` confirmation. Record `smsStatus`. Otherwise skip silently.

## Settings UI (authenticated)
- `app/(app)/settings/_actions/booking.ts` — server actions: upsert profile/slug, CRUD event types,
  save weekly rules + overrides.
- `app/(app)/settings/_components/BookingSettings.tsx` — availability editor (weekday rows + windows),
  event-type list, slug + copy-link buttons. Add a Calendar settings entry point (also surface a
  "Booking links" button on the Calendar page header so it's discoverable from the screenshot view).
- Wire into the settings page. (Per "expose AI/config in UI" preference, all tunables are UI controls.)

## Notes / decisions baked in
- Per-individual-user links (not org-level).
- Multiple event types per user.
- Conflict check = Google + app, sourced from the unified `appointments` table.
- Card/CTA copy stays truthful (only verbs backed by real behavior).
- Idempotency: a booking re-POST for the same slot returns the existing booking, not a duplicate.

## Build order
1. Migration `0078` + schema.ts mirroring (+ `appointments` new columns).
2. `lib/booking/availability.ts` (slot engine) with the conflict subtraction.
3. Settings actions + `BookingSettings.tsx`.
4. Public pages + public API routes (+ middleware matcher).
5. `createBooking.ts` transaction wiring email/SMS/Google/contact.
6. Cancel page + flow.
7. Manual verification on the RocketBooks test org (seed availability, book a slot end-to-end).

## Out of scope for v1 (note for later)
Reminders before the meeting, reschedule flow, round-robin/team links, payment, custom intake
questions, ICS attachment in email.
