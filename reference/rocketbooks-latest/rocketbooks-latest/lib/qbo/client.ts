import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboConnections } from '@/db/schema/schema';
import { logger } from '@/lib/logger';

const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

const SANDBOX_API_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const PRODUCTION_API_BASE = 'https://quickbooks.api.intuit.com';

// Refresh slightly before expiry so a request that takes ~30s to dispatch
// doesn't sneak past on a freshly-stale token.
const REFRESH_SKEW_MS = 60_000;

export type QboConnection = typeof qboConnections.$inferSelect;

export class QboNotConnectedError extends Error {
  readonly code = 'QBO_NOT_CONNECTED';
  constructor(orgId: string) {
    super(`No active QBO connection for org ${orgId}`);
  }
}

export class QboApiError extends Error {
  readonly code = 'QBO_API_ERROR';
  constructor(
    public readonly status: number,
    public readonly body: string,
    message?: string,
    public readonly intuitTid?: string | null,
  ) {
    const tidSuffix = intuitTid ? ` (intuit_tid=${intuitTid})` : '';
    super((message ?? `QBO API ${status}: ${body.slice(0, 200)}`) + tidSuffix);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function apiBase(): string {
  const env = process.env.QBO_ENVIRONMENT ?? 'sandbox';
  return env === 'production' ? PRODUCTION_API_BASE : SANDBOX_API_BASE;
}

function basicAuthHeader(): string {
  const id = requireEnv('QBO_CLIENT_ID');
  const secret = requireEnv('QBO_CLIENT_SECRET');
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

export async function getConnectionForOrg(orgId: string): Promise<QboConnection | null> {
  const [row] = await db.select().from(qboConnections).where(eq(qboConnections.orgId, orgId)).limit(1);
  return row ?? null;
}

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;            // seconds, typically 3600
  x_refresh_token_expires_in: number; // seconds, typically ~8.6M (100 days)
  token_type: 'bearer';
}

/**
 * Refresh-token coalescing: if two requests for the same org both see an
 * expired access token at the same time, we want exactly one network round-
 * trip to Intuit, not two. Intuit issues a NEW refresh_token on every
 * refresh and accepts the previous one only briefly — racing two refreshes
 * is the easiest way to brick a connection. The Map keys on connection.id
 * (not orgId) so reconnects after disconnect get a fresh slot.
 */
const inflightRefresh = new Map<string, Promise<QboConnection>>();

async function refreshAccessToken(connection: QboConnection): Promise<QboConnection> {
  const existing = inflightRefresh.get(connection.id);
  if (existing) return existing;

  const promise = (async () => {
    const res = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': basicAuthHeader(),
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: connection.refreshToken,
      }).toString(),
    });
    const body = await res.text();
    const intuitTid = res.headers.get('intuit_tid');
    if (!res.ok) {
      logger.error({ orgId: connection.orgId, realmId: connection.realmId, status: res.status, body, intuitTid }, 'qbo token refresh failed');
      throw new QboApiError(res.status, body, 'QBO refresh_token rejected — user must reconnect', intuitTid);
    }
    const json = JSON.parse(body) as RefreshResponse;
    const now = Date.now();
    const accessExpiresAt = new Date(now + json.expires_in * 1000).toISOString();
    const refreshExpiresAt = new Date(now + json.x_refresh_token_expires_in * 1000).toISOString();

    const [updated] = await db
      .update(qboConnections)
      .set({
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        accessTokenExpiresAt: accessExpiresAt,
        refreshTokenExpiresAt: refreshExpiresAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(qboConnections.id, connection.id))
      .returning();
    return updated;
  })();

  inflightRefresh.set(connection.id, promise);
  try {
    return await promise;
  } finally {
    inflightRefresh.delete(connection.id);
  }
}

async function ensureFreshToken(connection: QboConnection): Promise<QboConnection> {
  const expiresAt = new Date(connection.accessTokenExpiresAt).getTime();
  if (expiresAt - REFRESH_SKEW_MS > Date.now()) return connection;
  return refreshAccessToken(connection);
}

interface QboFetchInit extends Omit<RequestInit, 'body'> {
  body?: BodyInit | object;
  query?: Record<string, string | number | undefined>;
}

/**
 * Authenticated fetch against the QBO REST API. `path` is appended to
 * `/v3/company/{realmId}` — pass `'/invoice/123'`, not the full URL. Auto-
 * refreshes the access token if expired, and retries ONCE on 401 in case
 * the token was revoked between our check and the call. Body objects are
 * JSON-stringified; pre-serialized strings/buffers pass through.
 */
export async function qboFetch<T = unknown>(orgId: string, path: string, init: QboFetchInit = {}): Promise<T> {
  let connection = await getConnectionForOrg(orgId);
  if (!connection) throw new QboNotConnectedError(orgId);
  connection = await ensureFreshToken(connection);

  const params = new URLSearchParams();
  params.set('minorversion', '70');
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined) params.set(k, String(v));
    }
  }
  const url = `${apiBase()}/v3/company/${connection.realmId}${path}${path.includes('?') ? '&' : '?'}${params.toString()}`;

  const isJsonBody = init.body !== undefined && typeof init.body === 'object' && !(init.body instanceof ArrayBuffer) && !(init.body instanceof Uint8Array);

  const doRequest = async (token: string): Promise<Response> =>
    fetch(url, {
      ...init,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        ...(isJsonBody ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      body: isJsonBody ? JSON.stringify(init.body) : (init.body as BodyInit | undefined),
    });

  let activeToken = connection.accessToken;
  let res = await doRequest(activeToken);

  if (res.status === 401) {
    // Token may have been revoked or rotated outside our skew window. Force
    // a refresh and try once more — if THAT 401s the user must reconnect.
    logger.warn({ orgId, path, intuitTid: res.headers.get('intuit_tid') }, 'qbo 401 — forcing refresh and retrying');
    const refreshed = await refreshAccessToken({ ...connection, accessTokenExpiresAt: new Date(0).toISOString() });
    activeToken = refreshed.accessToken;
    res = await doRequest(activeToken);
  }

  // Honor QBO throttling: on 429, wait the server-provided Retry-After (or a
  // short default) and retry in-place, bounded. This lets a long migration
  // pull ride through rate limiting instead of throwing — which would fail the
  // Inngest step and restart the entity's pagination from the first page.
  for (let attempt = 0; res.status === 429 && attempt < 5; attempt++) {
    const retryAfterSec = Number(res.headers.get('retry-after')) || 3;
    logger.warn(
      { orgId, path, retryAfterSec, attempt: attempt + 1, intuitTid: res.headers.get('intuit_tid') },
      'qbo 429 rate limited — backing off and retrying',
    );
    await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000));
    res = await doRequest(activeToken);
  }

  if (!res.ok) {
    const body = await res.text();
    const intuitTid = res.headers.get('intuit_tid');
    logger.error({ orgId, path, status: res.status, body, intuitTid }, 'qbo api error');
    throw new QboApiError(res.status, body, undefined, intuitTid);
  }

  // Some QBO endpoints (revoke, batch) return 200 with empty body.
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Revoke the refresh token at Intuit. Called from the disconnect route.
 * Idempotent — Intuit returns 200 even if the token is already revoked.
 */
export async function revokeConnection(connection: QboConnection): Promise<void> {
  const res = await fetch(QBO_REVOKE_URL, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: connection.refreshToken }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn({ orgId: connection.orgId, status: res.status, body, intuitTid: res.headers.get('intuit_tid') }, 'qbo revoke returned non-200 — proceeding with local cleanup anyway');
  }
}

export const QBO_OAUTH_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_OAUTH_SCOPE = 'com.intuit.quickbooks.accounting';
