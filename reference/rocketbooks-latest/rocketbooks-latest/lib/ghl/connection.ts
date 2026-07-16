import 'server-only';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { ghlConnections } from '@/db/schema/schema';
import { decryptGhlToken, encryptGhlToken } from './encryption';
import { refreshAccessToken, type GhlTokenResponse } from './client';
import { logger } from '@/lib/logger';

// Connection store + token manager: the bridge between the encrypted
// ghl_connections rows, the pure-HTTP client, and everything downstream
// (OAuth callback, sync job). Owns the one rule that keeps a connection
// alive: GHL rotates the refresh token on every refresh, so we MUST persist
// the new refresh_token each time or the connection dies.

export type GhlConnectionRow = typeof ghlConnections.$inferSelect;

// Refresh a little before the real expiry to absorb clock skew + request
// latency, so we never send an access token that expires mid-flight.
const EXPIRY_BUFFER_MS = 2 * 60 * 1000; // 2 minutes
// GHL doesn't return a refresh-token expiry; per docs it's ~1 year (and
// single-use, rotated on each refresh). Stored as an estimate purely for
// monitoring stale connections.
const REFRESH_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function accessExpiryFrom(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function refreshExpiryEstimate(): string {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
}

/**
 * Insert (or update in place, on re-connect) the connection for a GHL
 * location after an OAuth code exchange. Keyed on (organizationId,
 * locationId) — the unique index in migration 0113. Returns the row id.
 */
export async function saveConnection(args: {
  userId: string;
  organizationId: string;
  tokens: GhlTokenResponse;
}): Promise<string> {
  const { userId, organizationId, tokens } = args;
  const locationId = tokens.locationId;
  if (!locationId) {
    throw new Error('GHL token response has no locationId; expected a Location-level install');
  }

  const id = randomUUID();
  const nowIso = new Date().toISOString();

  const [row] = await db
    .insert(ghlConnections)
    .values({
      id,
      userId,
      organizationId,
      locationId,
      accessToken: encryptGhlToken(tokens.access_token),
      refreshToken: encryptGhlToken(tokens.refresh_token),
      accessTokenExpiresAt: accessExpiryFrom(tokens.expires_in),
      refreshTokenExpiresAt: refreshExpiryEstimate(),
      connectionStatus: 'connected',
      lastSyncError: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: [ghlConnections.organizationId, ghlConnections.locationId],
      set: {
        userId,
        accessToken: encryptGhlToken(tokens.access_token),
        refreshToken: encryptGhlToken(tokens.refresh_token),
        accessTokenExpiresAt: accessExpiryFrom(tokens.expires_in),
        refreshTokenExpiresAt: refreshExpiryEstimate(),
        connectionStatus: 'connected',
        lastSyncError: null,
        updatedAt: nowIso,
      },
    })
    .returning({ id: ghlConnections.id });

  logger.info({ organizationId, locationId, connectionId: row.id }, 'ghl connection saved');
  return row.id;
}

export async function loadConnection(connectionId: string): Promise<GhlConnectionRow | null> {
  const [row] = await db
    .select()
    .from(ghlConnections)
    .where(eq(ghlConnections.id, connectionId))
    .limit(1);
  return row ?? null;
}

/** Phase 1 is single-location: the first (and only) connection for an org. */
export async function loadConnectionByOrg(organizationId: string): Promise<GhlConnectionRow | null> {
  const [row] = await db
    .select()
    .from(ghlConnections)
    .where(eq(ghlConnections.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

/** Look up the connection a GHL webhook refers to (by its location id). */
export async function loadConnectionByLocation(
  organizationId: string,
  locationId: string,
): Promise<GhlConnectionRow | null> {
  const [row] = await db
    .select()
    .from(ghlConnections)
    .where(
      and(
        eq(ghlConnections.organizationId, organizationId),
        eq(ghlConnections.locationId, locationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * All connections for a GHL location id, across orgs. A webhook only carries
 * the location id (no org), so this is how we route an inbound event to the
 * connection(s) it belongs to. Normally one row, but the schema allows the
 * same location under multiple orgs, so we return all and sync each.
 */
export async function loadConnectionsByLocationId(locationId: string): Promise<GhlConnectionRow[]> {
  return db.select().from(ghlConnections).where(eq(ghlConnections.locationId, locationId));
}

function isExpiring(connection: GhlConnectionRow): boolean {
  const expiresAt = new Date(connection.accessTokenExpiresAt).getTime();
  return Number.isNaN(expiresAt) || expiresAt - Date.now() <= EXPIRY_BUFFER_MS;
}

/**
 * Return a usable access token for the connection, refreshing first if it's
 * expired or about to. The rotated refresh token is persisted before the new
 * access token is handed back. On refresh failure the connection is marked
 * 'error' (so the UI can prompt a re-connect) and the error rethrown.
 */
export async function getFreshAccessToken(
  connection: GhlConnectionRow,
): Promise<string> {
  if (!isExpiring(connection)) {
    return decryptGhlToken(connection.accessToken);
  }

  let tokens: GhlTokenResponse;
  try {
    tokens = await refreshAccessToken({
      refreshToken: decryptGhlToken(connection.refreshToken),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(ghlConnections)
      .set({
        connectionStatus: 'error',
        lastSyncError: `token refresh failed: ${message}`.slice(0, 500),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(ghlConnections.id, connection.id));
    logger.error({ connectionId: connection.id, err: message }, 'ghl token refresh failed');
    throw new Error(`GHL token refresh failed for connection ${connection.id}: ${message}`);
  }

  // Persist rotated tokens BEFORE returning — losing the new refresh token
  // would brick the connection.
  await db
    .update(ghlConnections)
    .set({
      accessToken: encryptGhlToken(tokens.access_token),
      refreshToken: encryptGhlToken(tokens.refresh_token),
      accessTokenExpiresAt: accessExpiryFrom(tokens.expires_in),
      refreshTokenExpiresAt: refreshExpiryEstimate(),
      connectionStatus: 'connected',
      lastSyncError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(ghlConnections.id, connection.id));

  return tokens.access_token;
}
