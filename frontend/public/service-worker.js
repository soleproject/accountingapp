/**
 * SmartBooks Service Worker (Feb 2026, PWA Phase 1).
 *
 * Responsibilities:
 *   1. `install` — precache the app shell + a lightweight offline page.
 *   2. `activate` — clean up old caches from previous versions.
 *   3. `fetch`  — network-first for API, cache-first for static
 *                 assets, and serve the offline page when both fail.
 *   4. `push`   — decode the encrypted payload and show a system
 *                 notification with the brand icon.
 *   5. `notificationclick` — bring the tab back or open the URL that
 *                            was tucked into the payload.
 *
 * Versioning: bump `CACHE_VERSION` when we cut a release that must
 * invalidate cached shells. The activate handler will nuke every
 * cache that doesn't match this version — that's the mechanism that
 * makes updates propagate to installed PWAs the moment the user
 * next opens the app.
 */

const CACHE_VERSION = "smartbooks-v9";
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const OFFLINE_URL = "/offline.html";

/* -------------------------------------------------------------------- */
/* install — warm the runtime cache with essential shell URLs.          */
/* -------------------------------------------------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    // Best-effort — if any URL 404s (e.g. offline.html not deployed
    // yet), continue without it rather than blocking the install.
    try {
      await cache.addAll([OFFLINE_URL]);
    } catch (e) {
      console.warn("[sw] precache soft-failed:", e);
    }
    // skipWaiting so a new SW takes over IMMEDIATELY instead of
    // waiting for every open tab to close. Paired with `clientsClaim`
    // in activate, this is what makes PWA updates feel instant.
    self.skipWaiting();
  })());
});

/* -------------------------------------------------------------------- */
/* activate — drop old caches and claim every open tab.                 */
/* -------------------------------------------------------------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => !k.startsWith(CACHE_VERSION))
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* -------------------------------------------------------------------- */
/* fetch — network-first for API + navigations, cache-first for assets. */
/* -------------------------------------------------------------------- */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                    // don't touch mutations
  const url = new URL(req.url);
  // Don't cache API POSTs, auth exchanges, or SSE streams.
  if (url.pathname.startsWith("/api/")) {
    // Cache read-only dashboard GETs so a cold-network open still
    // shows the last-known cash balance, unpaid bills, etc. Anything
    // sensitive (auth, session, sockets) is left alone.
    const cacheable = /\/api\/(companies\/[^/]+\/(home|dashboard|reports|transactions|bills)|auth\/me)/.test(url.pathname);
    event.respondWith(networkFirst(req, cacheable));
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(navigateWithOfflineFallback(req));
    return;
  }
  // Static asset — try cache first, fall back to network.
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req, cacheable) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if (cacheable && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    if (cacheable) {
      const cached = await cache.match(req);
      if (cached) return cached;
    }
    throw e;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    // Static asset offline → let the request fail; the app shell will
    // handle it gracefully.
    throw e;
  }
}

async function navigateWithOfflineFallback(req) {
  try {
    return await fetch(req);
  } catch (e) {
    const cache = await caches.open(RUNTIME_CACHE);
    const off = await cache.match(OFFLINE_URL);
    if (off) return off;
    return new Response("Offline. Reconnect to load the app.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

/* -------------------------------------------------------------------- */
/* push — decode payload, show OS notification with brand icon.         */
/* -------------------------------------------------------------------- */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: "SmartBooks", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "SmartBooks";
  const options = {
    body: payload.body || "",
    // Use the dynamic branded icon endpoint so notifications shown
    // on the OS notification-tray carry the tenant's logo.
    icon: payload.icon || "/api/pwa/icon.png?size=192",
    badge: "/api/pwa/icon.png?size=192",
    tag: payload.tag,                                // coalesce duplicates
    renotify: !!payload.tag,
    data: { url: payload.url || "/", category: payload.category || "system" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* -------------------------------------------------------------------- */
/* notificationclick — refocus an open tab or open the target URL.      */
/* -------------------------------------------------------------------- */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      // If any tab is already on this app, focus it + navigate.
      if ("focus" in c) {
        try { await c.focus(); } catch {}
        try { c.navigate(target); } catch {}
        return;
      }
    }
    // No tab open — spawn a new window at the target URL.
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
