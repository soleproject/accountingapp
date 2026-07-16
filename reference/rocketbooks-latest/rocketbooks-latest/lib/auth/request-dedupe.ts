const DEFAULT_TTL_MS = 15_000;
const MAX_ENTRIES = 256;

type CacheEntry = {
  expiresAt: number;
  promise: Promise<unknown>;
};

type RequestPromiseStore = Map<string, CacheEntry>;

type GlobalWithRequestPromiseStore = typeof globalThis & {
  __rocketSuiteRequestPromiseStore?: RequestPromiseStore;
};

function getStore(): RequestPromiseStore {
  const sharedGlobal = globalThis as GlobalWithRequestPromiseStore;
  sharedGlobal.__rocketSuiteRequestPromiseStore ??= new Map();
  return sharedGlobal.__rocketSuiteRequestPromiseStore;
}

function prune(store: RequestPromiseStore, now: number) {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  while (store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value as string | undefined;
    if (!oldestKey) break;
    store.delete(oldestKey);
  }
}

/**
 * Shares one promise across duplicate module instances/call sites in a single request.
 * Request IDs are middleware-generated UUIDs; missing or malformed keys bypass caching.
 * Entries are short-lived and globally bounded to prevent cross-request retention.
 */
export function getRequestScopedPromise<T>(
  requestId: string | null | undefined,
  namespace: string,
  loader: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  if (!requestId || requestId.length > 128 || !namespace || namespace.length > 64) {
    return loader();
  }

  const store = getStore();
  const now = Date.now();
  prune(store, now);
  const key = `${namespace}:${requestId}`;
  const existing = store.get(key);
  if (existing && existing.expiresAt > now) return existing.promise as Promise<T>;

  const promise = loader();
  const entry: CacheEntry = {
    expiresAt: now + Math.max(1_000, Math.min(ttlMs, 30_000)),
    promise,
  };
  store.set(key, entry);
  void promise.catch(() => {
    if (store.get(key) === entry) store.delete(key);
  });
  return promise;
}

export function resetRequestScopedPromisesForTests() {
  getStore().clear();
}
