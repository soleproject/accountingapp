import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { getRequestScopedValue } from './requestScope';

declare global {
  var __pgPooled: ReturnType<typeof postgres> | undefined;
  var __drizzleDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
}

type HyperdriveBinding = {
  connectionString?: string;
};

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

function getCloudflareDbContext(): { connectionString: string; requestContext: object } | undefined {
  try {
    const context = getCloudflareContext();
    const connectionString = ((context.env as unknown as Record<string, unknown>).HYPERDRIVE as HyperdriveBinding | undefined)?.connectionString;
    return connectionString ? { connectionString, requestContext: context as object } : undefined;
  } catch {
    return undefined;
  }
}

function createDb(hyperdriveUrl?: string): DrizzleDb {
  // Only Cloudflare Workers gets the request-scoped, aggressively-recycled
  // client. Vercel/Node (and dev) is a long-lived process where a module-scope
  // pool is the correct, efficient pattern — the request-scoped client lifecycle
  // Workers needs would otherwise open a fresh connection on every db access
  // and exhaust the Supabase pooler on heavy pages (e.g. all-users).
  const onCloudflare = hyperdriveUrl !== undefined;
  const pooledUrl = hyperdriveUrl ?? process.env.POSTGRES_URL;
  if (!pooledUrl) {
    return new Proxy(
      {},
      {
        get() {
          throw new Error('POSTGRES_URL or Hyperdrive binding is required');
        },
      },
    ) as DrizzleDb;
  }

  const client =
    !onCloudflare && global.__pgPooled
      ? global.__pgPooled
      : postgres(pooledUrl, {
          prepare: false,
          max: onCloudflare ? 1 : 10,
          connect_timeout: 5,
          idle_timeout: onCloudflare ? 1 : 30,
          keep_alive: 15,
          max_lifetime: onCloudflare ? 30 : 60 * 5,
          // NOTE: do NOT set fetch_types:false — it disables postgres.js array
          // type parsing, so text[] columns (e.g. array_agg(...) on the
          // super-admin all-users page) come back as raw strings like
          // "{staff,admin}" and crash `.map()` in the client render.
          connection: { statement_timeout: onCloudflare ? 5000 : 20000 },
        });

  if (!onCloudflare) global.__pgPooled = client;
  return drizzle(client, { schema });
}

function getDb(): DrizzleDb {
  // Cloudflare Workers: do NOT cache the DB client at module scope — OpenNext
  // request I/O objects are request-scoped and a global client makes later
  // requests hang with Cloudflare 1101 "will never respond" errors. Everywhere
  // else (Vercel/Node/dev), cache a single pooled client at module scope so a
  // warm instance reuses it instead of opening a new pool per db access.
  const cloudflare = getCloudflareDbContext();
  if (cloudflare) {
    return getRequestScopedValue(cloudflare.requestContext, () => createDb(cloudflare.connectionString));
  }
  global.__drizzleDb ??= createDb();
  return global.__drizzleDb;
}

export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    const liveDb = getDb();
    const value = Reflect.get(liveDb, prop, receiver);
    return typeof value === 'function' ? value.bind(liveDb) : value;
  },
}) as DrizzleDb;

export type DB = typeof db;
