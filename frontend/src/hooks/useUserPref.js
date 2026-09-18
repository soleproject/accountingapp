/**
 * Cross-device user preferences hook.
 *
 * Backed by `GET/PATCH /api/users/me/prefs` — persisted on the server so
 * UI toggles follow the user across devices (laptop ↔ tablet ↔ browser)
 * rather than living in localStorage per-device.
 *
 * The hook keeps a module-scope in-memory cache + a lazy first-fetch
 * shared promise so opening N tiles on a page results in ONE GET call
 * instead of N. Writes are optimistic — we update the cache
 * synchronously and then PATCH the server; on failure the cache is
 * rolled back and a toast fires.
 *
 * Optional `localFallback`: seeds the initial value from localStorage
 * for a snappy first paint before the server round-trip completes,
 * useful for pre-existing localStorage-backed keys we're migrating.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

let cache = null;              // { [key]: value } — server truth
let inflight = null;           // Promise while first GET is in flight
const listeners = new Set();   // fns to call after cache updates

function notify() { for (const fn of listeners) fn(); }

async function ensureLoaded() {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = api.get("/users/me/prefs")
    .then(r => {
      cache = r.data?.prefs || {};
      inflight = null;
      notify();
      return cache;
    })
    .catch(() => {
      cache = {};
      inflight = null;
      notify();
      return cache;
    });
  return inflight;
}

export function useUserPref(key, defaultValue, { localFallback } = {}) {
  const [value, setValue] = useState(() => {
    if (cache && key in cache) return cache[key];
    if (localFallback && typeof window !== "undefined") {
      const v = window.localStorage.getItem(localFallback);
      if (v !== null) return v;
    }
    return defaultValue;
  });

  useEffect(() => {
    let alive = true;
    ensureLoaded().then(c => {
      if (!alive) return;
      if (c && key in c) setValue(c[key]);
    });
    const fn = () => { if (cache && key in cache) setValue(cache[key]); };
    listeners.add(fn);
    return () => { alive = false; listeners.delete(fn); };
  }, [key]);

  const write = async (next) => {
    const prev = value;
    // Optimistic — flip the UI immediately, keep cache in sync.
    setValue(next);
    cache = { ...(cache || {}), [key]: next };
    notify();
    if (localFallback && typeof window !== "undefined") {
      window.localStorage.setItem(localFallback, String(next));
    }
    try {
      await api.patch("/users/me/prefs", { key, value: next });
    } catch (e) {
      // Roll back on server failure so the UI reflects reality.
      setValue(prev);
      cache = { ...(cache || {}), [key]: prev };
      notify();
      toast.error("Couldn't save your preference — reverted.");
    }
  };

  return [value, write];
}

/** Reset cached prefs on logout / user switch. */
export function resetUserPrefCache() { cache = null; inflight = null; }
