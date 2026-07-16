/**
 * Provider-neutral video-calling contract.
 *
 * The rest of the app imports ONLY from `@/lib/video` (which re-exports these
 * types and the active provider). No app code should import `./daily` directly
 * — that keeps Daily.co swappable: to move to another provider you write a new
 * file implementing `VideoProvider` and change the single binding in
 * `index.ts`. Nothing else has to change.
 *
 * All times are unix SECONDS (not millis) to match the providers' REST APIs.
 */

export interface CreateRoomOptions {
  /** Seconds until the room expires and stops accepting joins. Default ~2h. */
  expiresInSeconds?: number;
  /** Screen sharing is a core feature here, so this defaults to true. */
  enableScreenshare?: boolean;
  /** Hard cap on simultaneous participants. Omit for the provider default. */
  maxParticipants?: number;
  /** Prefix for the generated random room name (e.g. "rs"). Cosmetic. */
  namePrefix?: string;
}

export interface VideoRoom {
  /** Unguessable room name (the join secret). */
  name: string;
  /** Full URL the client/SDK joins (e.g. https://team.daily.co/<name>). */
  url: string;
  /** Unix seconds when the room expires. */
  expiresAt: number;
}

export interface MeetingTokenOptions {
  /** Room the token grants access to. */
  roomName: string;
  /** Display name shown in the call. */
  userName?: string;
  /** Owner tokens can manage the room (kick, recording, etc.). Host = true. */
  isOwner?: boolean;
  /** Seconds until the token expires. Defaults to the room's lifetime. */
  expiresInSeconds?: number;
}

export interface VideoProvider {
  /** Stable id for logging / future per-provider branching. */
  readonly id: string;
  /** True when all required env vars are present. Callers degrade gracefully. */
  isConfigured(): boolean;
  /** Create a short-lived, private, randomly-named room. */
  createRoom(opts?: CreateRoomOptions): Promise<VideoRoom>;
  /** Mint a server-side join token scoping a user to a room. */
  createMeetingToken(opts: MeetingTokenOptions): Promise<string>;
  /** Look up a room by name; null if it doesn't exist (or already expired). */
  getRoom(name: string): Promise<VideoRoom | null>;
  /** Best-effort delete (rooms also auto-expire via `exp`). */
  deleteRoom(name: string): Promise<void>;
  /** Verify a provider webhook (HMAC over timestamp + raw body). */
  verifyWebhook(timestamp: string | null, signature: string | null, body: string): boolean;
  /** Delete a stored transcript (we email from our own captured lines). */
  deleteTranscript(id: string): Promise<void>;
}
