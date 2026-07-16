import 'server-only';

// GoHighLevel (HighLevel / LeadConnector) v2 API client — pure HTTP, no DB.
//
// Scope: OAuth token exchange/refresh + authenticated GET helpers for the
// resources Phase 1 ingests (payments/transactions, contacts). DB
// persistence of tokens lives elsewhere (the connection store / sync job);
// this module only talks to GHL so it stays easy to test and reason about.
//
// Docs: https://marketplace.gohighlevel.com/docs
//   - OAuth:        /docs/Authorization/OAuth2.0
//   - Transactions: /docs/ghl/payments/list-transactions
//
// Env:
//   GHL_CLIENT_ID, GHL_CLIENT_SECRET — marketplace app credentials.

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_TOKEN_URL = `${GHL_API_BASE}/oauth/token`;

// Version header GHL requires on every v2 API call. Pinned per docs; a few
// endpoints date-stamp differently — pass `version` to ghlGet to override.
const GHL_DEFAULT_VERSION = '2021-07-28';

// We request Location-level tokens: one connection == one GHL sub-account,
// which matches our per-org model.
const GHL_USER_TYPE = 'Location';

// Where the OAuth round-trip starts. /chooselocation lets the user pick the
// sub-account to grant, yielding a Location-level install.
export const GHL_OAUTH_AUTHORIZE_URL =
  'https://marketplace.gohighlevel.com/oauth/chooselocation';

// Phase 1 is read-only ingestion, so request only read scopes (least
// privilege). Space-separated per the OAuth spec.
export const GHL_OAUTH_SCOPE = [
  'payments/transactions.readonly',
  'payments/orders.readonly',
  'contacts.readonly',
  'invoices.readonly',
].join(' ');

function clientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GHL_CLIENT_ID and GHL_CLIENT_SECRET are required');
  }
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export interface GhlTokenResponse {
  access_token: string;
  token_type: string; // 'Bearer'
  expires_in: number; // seconds (~86399 / 24h)
  refresh_token: string; // single-use; rotated on every refresh
  scope: string;
  userType: string; // 'Location'
  companyId?: string;
  userId: string;
  /** Present for Location-level installs — the GHL sub-account id. */
  locationId?: string;
  refreshTokenId?: string;
  isBulkInstallation?: boolean;
}

// The token endpoint is documented inconsistently (JSON for code exchange,
// form-urlencoded for refresh). In practice it reliably accepts
// application/x-www-form-urlencoded for both, so we use that uniformly.
async function postToken(params: Record<string, string>): Promise<GhlTokenResponse> {
  const res = await fetch(GHL_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GHL token request failed (${res.status}): ${detail.slice(0, 500)}`);
  }
  return (await res.json()) as GhlTokenResponse;
}

/** Exchange the OAuth `code` from the install/redirect for tokens. */
export async function exchangeCodeForTokens(args: {
  code: string;
  redirectUri: string;
}): Promise<GhlTokenResponse> {
  const { clientId, clientSecret } = clientCreds();
  return postToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code: args.code,
    user_type: GHL_USER_TYPE,
    redirect_uri: args.redirectUri,
  });
}

/**
 * Exchange a refresh token for a fresh access token. GHL rotates the refresh
 * token on every call and invalidates the old one, so the caller MUST persist
 * the new `refresh_token` from the response or the connection will break.
 */
export async function refreshAccessToken(args: {
  refreshToken: string;
}): Promise<GhlTokenResponse> {
  const { clientId, clientSecret } = clientCreds();
  return postToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    user_type: GHL_USER_TYPE,
  });
}

// ---------------------------------------------------------------------------
// Authenticated GET
// ---------------------------------------------------------------------------

export class GhlApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GhlApiError';
  }
}

async function ghlGet<T>(
  path: string,
  opts: {
    accessToken: string;
    query?: Record<string, string | number | undefined>;
    version?: string;
  },
): Promise<T> {
  const url = new URL(`${GHL_API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Version: opts.version ?? GHL_DEFAULT_VERSION,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GhlApiError(
      `GHL GET ${path} failed (${res.status})`,
      res.status,
      body.slice(0, 1000),
    );
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Payments / transactions
// ---------------------------------------------------------------------------

// Partial shape — only the fields Phase 1 relies on are typed. The full
// object is preserved verbatim into ghl_raw_payments.raw_json, and exact
// field mapping (amount sign, contact name path, date field) is finalized
// in lib/accounting/ghl-promote.ts against real payloads.
export interface GhlTransaction {
  _id: string;
  amount?: number;
  status?: string;
  contactId?: string;
  contactName?: string;
  createdAt?: string;
  currency?: string;
  [key: string]: unknown;
}

export interface GhlListTransactionsResponse {
  data: GhlTransaction[];
  // GHL returns a totalCount (occasionally wrapped); kept loose on purpose.
  totalCount?: number | Array<{ total?: number }>;
  [key: string]: unknown;
}

/**
 * One page of a location's payment transactions. `altId`/`altType` is GHL's
 * scoping convention for payments endpoints (altType 'location' + the
 * location id). Caller paginates by advancing `offset` until a short page.
 */
export async function listTransactions(args: {
  accessToken: string;
  locationId: string;
  limit?: number;
  offset?: number;
  startAt?: string; // ISO date — incremental sync watermark
  endAt?: string;
}): Promise<GhlListTransactionsResponse> {
  return ghlGet<GhlListTransactionsResponse>('/payments/transactions', {
    accessToken: args.accessToken,
    query: {
      altId: args.locationId,
      altType: 'location',
      limit: args.limit ?? 100,
      offset: args.offset ?? 0,
      startAt: args.startAt,
      endAt: args.endAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  contactName?: string;
  name?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  [key: string]: unknown;
}

/** Fetch a single contact by id (used to enrich a payment's payer). */
export async function getContact(args: {
  accessToken: string;
  contactId: string;
}): Promise<{ contact: GhlContact }> {
  return ghlGet<{ contact: GhlContact }>(`/contacts/${args.contactId}`, {
    accessToken: args.accessToken,
  });
}

export { GHL_API_BASE, GHL_DEFAULT_VERSION, GHL_USER_TYPE };
