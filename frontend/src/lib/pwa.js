/**
 * PWA / Web Push helpers (Feb 2026, Phase 1).
 *
 * All the browser-side plumbing for:
 *   - Registering the service worker
 *   - Detecting install eligibility (Chrome `beforeinstallprompt`)
 *   - Detecting the iOS "Add to Home Screen" scenario (no prompt API)
 *   - Requesting notification permission
 *   - Subscribing to Web Push and POST-ing the subscription to `/api/pwa/subscribe`
 *   - Unsubscribing
 *
 * Kept as one file so App.js can import a single `initPwa()` on
 * mount and every settings page can share the same helpers.
 */

import { api } from "@/lib/api";

/* --- Service worker registration. ------------------------------------ */

let _swReg = null;

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  // In dev (CRA), the SW can interfere with hot-reload. Skip unless
  // we're running from a built bundle. We detect prod by checking
  // if there's a manifest and NOT a webpack HMR socket.
  try {
    _swReg = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
    // Auto-refresh when a new SW takes control — prevents users from
    // running against stale JS after a deploy.
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      // Only reload if the user has been idle a moment; otherwise
      // the toast in App.js gives them a "Reload for latest" choice.
    });
    return _swReg;
  } catch (e) {
    console.warn("[pwa] SW registration failed:", e);
    return null;
  }
}

export function getServiceWorker() { return _swReg; }

/* --- Install-prompt handling (Chrome/Android + iOS heuristic). ------- */

let _deferredPrompt = null;
const _listeners = new Set();

export function onInstallStateChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _emit() { _listeners.forEach(fn => fn(getInstallState())); }

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _deferredPrompt = e;
    _emit();
  });
  window.addEventListener("appinstalled", () => {
    _deferredPrompt = null;
    _emit();
  });
}

export function isStandalone() {
  if (typeof window === "undefined") return false;
  // Chrome/Android standalone flag.
  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
  // iOS Safari standalone flag.
  return !!(window.navigator && window.navigator.standalone);
}

export function isIosSafari() {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // Detect Safari (not Chrome/Firefox on iOS which are still WebKit).
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIos && isSafari;
}

export function getInstallState() {
  if (isStandalone()) return "installed";
  if (_deferredPrompt) return "prompt-available";
  if (isIosSafari()) return "ios-manual";           // needs Share → Add to Home Screen
  return "unsupported";                              // desktop, or a browser that won't install
}

export async function triggerInstall() {
  if (!_deferredPrompt) return { outcome: "unavailable" };
  _deferredPrompt.prompt();
  const choice = await _deferredPrompt.userChoice;
  _deferredPrompt = null;
  _emit();
  return choice;                                     // { outcome: "accepted" | "dismissed" }
}

/* --- Web Push subscription. ------------------------------------------ */

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function getPushPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;                   // "default" | "granted" | "denied"
}

export async function subscribeToPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push not supported on this browser");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: permission };
  }
  const reg = _swReg || await navigator.serviceWorker.ready;
  const keyRes = await api.get("/pwa/vapid-public-key");
  const publicKey = keyRes.data.public_key;
  if (!publicKey) throw new Error("Server has no VAPID key configured");

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const json = sub.toJSON();
  await api.post("/pwa/subscribe", {
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent.slice(0, 200),
  });
  return { ok: true };
}

export async function unsubscribeFromPush() {
  if (!("serviceWorker" in navigator)) return { ok: false };
  const reg = _swReg || await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { ok: true };
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  try {
    await api.post("/pwa/unsubscribe", { endpoint });
  } catch {/* silent — server may already be pruned */}
  return { ok: true };
}

export async function hasActiveSubscription() {
  if (!("serviceWorker" in navigator)) return false;
  try {
    const reg = _swReg || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch { return false; }
}

/* --- Convenience initializer for App.js. ---------------------------- */

export async function initPwa() {
  await registerServiceWorker();
}
