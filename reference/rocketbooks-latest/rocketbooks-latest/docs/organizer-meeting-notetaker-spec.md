# Spec: Organizer Meeting Note-Taker (Zoom / Teams bot)

**Status:** Draft · **Date:** 2026-05-29 · **Owner:** Michael
**Relationship:** Phase 2 of the existing Organizer **Recorder** feature. Reuses the Recorder's notes/tasks tables and AI-drafting pipeline. This spec covers *only* the "bot joins the meeting" capture source that was deferred out of Recorder Phase 1.

---

## Goal
Let users have an automated note-taker join their Zoom and Microsoft Teams meetings (like Otter.ai), capture diarized audio, and auto-draft notes + follow-up tasks into the Organizer — without the user needing to be present or keep a browser tab open.

## Why now
Recorder Phase 1 covers device-side capture (mic everywhere + desktop tab-audio for *web* clients). It does **not** cover: native desktop apps, calendar auto-join, or absent-user recording. Those are the things that make it feel like Otter, and they require a meeting bot.

## Non-goals (this phase)
- Phone-call capture (Recorder Phase 3/4).
- Real-time in-meeting features (live prompts, live coaching).
- Building/maintaining our own Zoom & Teams bots (see Decisions).

---

## Approach & decision

**Vendor: Recall.ai** — one unified API runs the bot across Zoom, Teams, Google Meet, etc. POST a meeting URL → their bot joins → we receive diarized audio/transcript via webhook.

| Option | Verdict |
|---|---|
| **Recall.ai bot** | ✅ Chosen. One integration, all platforms, no client-maintenance tax. |
| Zoom RTMS (no bot, Zoom-only) | Defer. Cleanest for Zoom but account-level enable + Marketplace app + contact-sales pricing. Recall can front RTMS later behind the same pipeline. |
| Build our own bots | ✗ Rejected. Continuous maintenance as Zoom/Teams break their clients. |

**Cost (2026):** $0.50/recording-hour (bot) + $0.05/hr storage after 7 free days. **Skip** Recall's $0.15/hr STT — keep Deepgram Nova-3 to match the Recorder pipeline. Prorated to the second, no platform fee. Effective ~$0.55/hr.
> Per *keep-features-cheap*: this is a paid path, so it's **opt-in / paid-tier**, not on the free path. The free mic/tab-audio capture stays as the no-cost default.

---

## User flow (Otter-like)
1. User connects calendar (Google Calendar already wired) and enables "Send a notetaker to my meetings."
2. App scans calendar for events containing a Zoom/Teams join URL.
3. At start time, app sends the join URL to Recall; bot joins and announces itself.
4. On meeting end, Recall webhook returns diarized transcript → existing **Deepgram-or-passthrough → AI draft notes + follow-up tasks** pipeline.
5. Notes/tasks appear in Organizer with `source = "zoom_bot" | "teams_bot"`, linked to contacts.

## Architecture (deltas only)
- **New capture source**, not a new feature surface. The bot is one more way audio enters the existing Recorder pipeline.
- `POST /api/recorder/bot/dispatch` — sends a meeting URL to Recall, stores a `bot_session`.
- `POST /api/recorder/bot/webhook` — receives Recall completion, pulls transcript, hands to existing drafting job.
- New table `recorder_bot_sessions` (recall_bot_id, meeting_url, platform, calendar_event_id, status, recording_url, cost_seconds). Per *schema-drift*: hand-written SQL, **not** `drizzle-kit generate`.

## Settings (per *expose-ai-config-in-ui* — surface as `/settings` controls, not constants)
- Master toggle: auto-join on/off.
- Which meetings: all w/ link · only meetings I organize · only meetings I tag.
- Bot display name.
- Retention days for bot recordings.
- (Inherits Recorder's model/diarization settings.)

## Consent & compliance — **hard requirement, not afterthought**
- Bot must announce itself ("Rocketbooks Notetaker is recording") — required for Zoom/Teams Marketplace approval.
- In-app recording disclosure + per-meeting consent handling for **two-party-consent states** (material given the accounting/legal user base). Surface a `/legal` disclosure akin to the existing SMS-disclosure pattern.

---

## Phasing
- **2a** — Recall integration + manual "paste link to send notetaker" button. Validates the full pipeline (~1 day integration). Includes consent announcement + disclosure. **(Drafted 2026-05-29; see Implementation status below.)**
- **2b** — Calendar auto-join toggle and meeting-selection rules in `/settings`.
- **2c** — Cloud-recording-API path (no bot). See below — the cheapest capture source; reuses everything downstream of "we have audio."
- **3** — If Zoom volume dominates and cost matters, move Zoom to RTMS behind the same Recall integration. No downstream changes.

## Phase 2c — Cloud-recording-API path (no bot)

**Idea:** for users on paid meeting plans, skip the bot entirely. The meeting platform (Zoom / Teams / Google) records the call **on its own cloud** under the host's account; we pull the finished file via API afterward and run it through the same Deepgram → draft → notes/tasks pipeline. We never join and never record — we consume a recording the platform already made.

**Why it matters — cost.** This is the cheapest capture source we have:

| Capture source | Marginal cost / recording-hour |
|---|---|
| Recall bot (2a) | ~$0.77 ($0.50 bot + $0.27 Deepgram) |
| Device capture (Phase 1, free path) | ~$0.27 (Deepgram only) |
| **Cloud-recording API (2c)** | **~$0.27 (Deepgram only — no bot fee, no compute fleet)** |

So 2c delivers a *server-side, no-user-present* capture (like the bot) at *device-path cost* — for the subset of users who qualify.

**Flow:**
1. Host grants OAuth (recording-read scope) for their Zoom / MS Graph / Google account.
2. Platform "recording ready" webhook fires when the meeting ends.
3. We download the file from their API → Deepgram → draft → notes/tasks (shared pipeline; just another `source`, e.g. `zoom_cloud` / `teams_cloud` / `meet_cloud`).
4. Delete our copy after processing (retention per settings).

**Architecture deltas (small):** OAuth connections per platform, a `recording ready` webhook per platform, and reuse of `runTranscription(id, { audioUrl })` (the bot path already generalized it to accept a direct media URL). The `recording_bot_sessions` sidecar can be reused/renamed, or a parallel `recording_cloud_sessions` added — TBD at build.

**Trade-offs (all flow from "it's their recording, not ours"):**
- Requires a **paid** host plan with cloud recording (Zoom Pro+, Teams business, Google Workspace Business+). Free hosts can't use this → fall back to bot/device.
- Host must **record to cloud** (manually or auto-record on).
- **Post-meeting only** — no live transcript.
- **Only the host's own meetings** (you read their account's recordings).
- Platform **retention/storage caps** — must pull promptly before auto-purge.

**Positioning:** complementary, not a replacement. Recall bot stays the catch-all (free hosts, guest meetings, users who won't manage recording settings); 2c is the low-cost default offered to qualifying hosts.

## Open questions
1. Paid-tier gating: bundled into Enterprise tiers, or per-hour metered add-on?
2. Default retention for bot recordings (Recorder Phase 1 keeps audio indefinitely — same here, or shorter?).
3. Teams: any tenant/admin-consent friction for the user base to validate before 2b.
4. **2c:** do we auto-prefer the cloud-recording path when a host qualifies (cheapest), and silently fall back to the bot when they don't? Likely yes, but it's a UX + cost-routing decision.

## Implementation status (Phase 2a, drafted 2026-05-29)
- `db/migrations/0074_recorder_bot_sessions.sql` — sidecar table `recording_bot_sessions`.
- `recordingBotSessions` added to `db/schema/schema.ts`.
- `lib/recorder/recall.ts` — Recall client (`createBot` with `automatic_leave`, `getBot`, platform detection, media-URL extraction, dependency-free Svix webhook verify).
- `app/api/recorder/bot/route.ts` (dispatch, consent-gated) + `app/api/recorder/bot/webhook/route.ts`.
- `lib/recorder/transcribe.ts` — `runTranscription(id, { audioUrl })` so any source can pass a direct media URL (used by 2c too).
- `MeetingBotPanel` in `components/recorder/RecorderWorkspace.tsx`; `RECALL_*` in `.env.example`.
- tsc + eslint clean. **Before live:** apply migration, set env keys, register Recall webhook, verify `pluckMediaUrl`/status codes against the live Recall API version.

## Sources
- Recall.ai pricing: https://www.recall.ai/pricing · https://www.recall.ai/blog/new-recall-ai-pricing-for-2026
- Recall.ai Meeting Bot API: https://www.recall.ai/product/meeting-bot-api
- Zoom RTMS: https://www.recall.ai/blog/what-is-zoom-rtms · https://www.zoom.com/en/realtime-media-streams/
- Cloud recording APIs: Zoom Cloud Recording API · Microsoft Graph cloud recordings · Google Meet recordings (Drive API)
