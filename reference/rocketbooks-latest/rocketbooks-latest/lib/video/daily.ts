import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  CreateRoomOptions,
  MeetingTokenOptions,
  VideoProvider,
  VideoRoom,
} from './types';

/**
 * Daily.co implementation of the VideoProvider contract (Organizer Video).
 *
 * Prebuilt-frame integration: this module is the ONLY place that talks to the
 * Daily REST API. The client renders Daily Prebuilt via @daily-co/daily-js,
 * but room creation and token minting happen exclusively here, server-side, so
 * DAILY_API_KEY never reaches the browser.
 *
 * Rooms are created `private` with a short `exp`, a random name, and screen
 * sharing on. Tokens are minted per-join (owner for the host, non-owner for
 * guests). Nothing is publicly listable.
 *
 * Env:
 *   DAILY_API_KEY  — required. Server-side secret (NOT NEXT_PUBLIC). Without it
 *                    every call here throws and the feature reports "not
 *                    configured" (503) rather than half-working.
 *   DAILY_API_BASE — optional. Defaults to https://api.daily.co/v1.
 *
 * Cost note: rooms/tokens are free; you're billed for participant-minutes.
 * RECORDING is intentionally NOT enabled here — see the marked hook in
 * `createRoom`. Turning it on adds Daily storage/egress cost, so it's a
 * deliberate later decision.
 */

const DEFAULT_BASE = 'https://api.daily.co/v1';
const DEFAULT_ROOM_TTL_SECONDS = 60 * 90; // 90 min — generous for a 1:1 call
// Hard cap so a shared invite link can't pull in a crowd — keeps this a 1:1
// product and bounds per-minute cost (esp. transcription, billed per unmuted
// participant). Callers can override via CreateRoomOptions.maxParticipants.
const DEFAULT_MAX_PARTICIPANTS = 2;

function base(): string {
  return (process.env.DAILY_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

function apiKey(): string {
  const k = process.env.DAILY_API_KEY;
  if (!k) throw new Error('DAILY_API_KEY is required');
  return k;
}

/** Unix seconds, `secondsFromNow` in the future. */
function expFromNow(secondsFromNow: number): number {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}

/** Unguessable room name: `<prefix>-<22 url-safe chars>`, within Daily's 41-char limit. */
function randomRoomName(prefix: string): string {
  const slug = randomBytes(16).toString('base64url'); // ~22 chars, [A-Za-z0-9_-]
  return `${prefix}-${slug}`;
}

async function dailyFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${base()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/** Shape of the Daily room payload fields we read. */
interface DailyRoomResponse {
  name?: string;
  url?: string;
  config?: { exp?: number };
}

function toVideoRoom(json: DailyRoomResponse): VideoRoom {
  if (!json.name || !json.url) throw new Error('Daily room response missing name/url');
  return {
    name: json.name,
    url: json.url,
    expiresAt: json.config?.exp ?? 0,
  };
}

async function createRoom(opts: CreateRoomOptions = {}): Promise<VideoRoom> {
  const ttl = opts.expiresInSeconds ?? DEFAULT_ROOM_TTL_SECONDS;
  const exp = expFromNow(ttl);
  const name = randomRoomName(opts.namePrefix ?? 'rs');

  const res = await dailyFetch('/rooms', {
    method: 'POST',
    body: JSON.stringify({
      name,
      // Private + token-gated: not joinable without a meeting token, and not
      // discoverable by listing the domain.
      privacy: 'private',
      properties: {
        exp,
        // Remove anyone still connected when the room expires.
        eject_at_room_exp: true,
        // Screen sharing is a first-class feature of this product.
        enable_screenshare: opts.enableScreenshare ?? true,
        // Device-check / name-entry screen before joining — nicer for guests.
        enable_prejoin_ui: true,
        max_participants: opts.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,

        // ── RECORDING HOOK (intentionally disabled this pass) ──────────────
        // To enable later, set `enable_recording` here and gate it behind a
        // setting/feature flag. Cloud recording incurs Daily storage + egress
        // cost and a webhook to fetch the artifact, so it's a separate decision.
        //   enable_recording: 'cloud',           // 'cloud' | 'local' | 'raw-tracks'
        // The matching token (createMeetingToken) would also need
        //   enable_recording_ui: true (host) and/or permission to start it.
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Daily createRoom ${res.status}: ${body.slice(0, 500)}`);
  }
  return toVideoRoom((await res.json()) as DailyRoomResponse);
}

async function createMeetingToken(opts: MeetingTokenOptions): Promise<string> {
  const res = await dailyFetch('/meeting-tokens', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        room_name: opts.roomName,
        is_owner: opts.isOwner ?? false,
        ...(opts.userName ? { user_name: opts.userName } : {}),
        exp: expFromNow(opts.expiresInSeconds ?? DEFAULT_ROOM_TTL_SECONDS),
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Daily createMeetingToken ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error('Daily createMeetingToken returned no token');
  return json.token;
}

async function getRoom(name: string): Promise<VideoRoom | null> {
  const res = await dailyFetch(`/rooms/${encodeURIComponent(name)}`, { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Daily getRoom ${res.status}: ${body.slice(0, 500)}`);
  }
  return toVideoRoom((await res.json()) as DailyRoomResponse);
}

async function deleteRoom(name: string): Promise<void> {
  const res = await dailyFetch(`/rooms/${encodeURIComponent(name)}`, { method: 'DELETE' });
  // 404 = already gone (expired/deleted); treat as success.
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Daily deleteRoom ${res.status}: ${body.slice(0, 500)}`);
  }
}

/**
 * Verify a Daily webhook signature. Daily signs `${timestamp}${rawBody}` with
 * HMAC-SHA256 keyed by the base64-decoded `DAILY_WEBHOOK_SECRET`, and sends the
 * base64 digest in `X-Webhook-Signature` (+ `X-Webhook-Timestamp`). Dependency-
 * free. NOTE: adjust the concatenation/encoding here if Daily rejects — their
 * exact scheme can vary by webhook version (mirrors the Recall caveat).
 */
function verifyWebhook(timestamp: string | null, signature: string | null, body: string): boolean {
  const secret = process.env.DAILY_WEBHOOK_SECRET;
  if (!secret) throw new Error('DAILY_WEBHOOK_SECRET is required to verify webhooks');
  if (!timestamp || !signature) return false;
  const key = Buffer.from(secret, 'base64');
  const expected = createHmac('sha256', key).update(`${timestamp}${body}`).digest('base64');
  const sig = Buffer.from(signature);
  const exp = Buffer.from(expected);
  return sig.length === exp.length && timingSafeEqual(sig, exp);
}

async function deleteTranscript(id: string): Promise<void> {
  const res = await dailyFetch(`/transcript/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Daily deleteTranscript ${res.status}: ${body.slice(0, 500)}`);
  }
}

export const dailyProvider: VideoProvider = {
  id: 'daily',
  isConfigured: () => !!process.env.DAILY_API_KEY,
  createRoom,
  createMeetingToken,
  getRoom,
  deleteRoom,
  verifyWebhook,
  deleteTranscript,
};
