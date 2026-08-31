/**
 * InstallPrompt — Phase-1 PWA install nudge.
 *
 * Renders one of three UIs depending on the browser's capability:
 *   1. Chrome/Android/Edge → "Install this app" button that fires the
 *      native `beforeinstallprompt` flow.
 *   2. iOS Safari → animated Share → Add-to-Home-Screen tutorial
 *      (no install-prompt API available on iOS, still).
 *   3. Already installed / unsupported → renders nothing.
 *
 * Two contexts:
 *   - `<InstallPromptCard/>` — inline card for Settings pages
 *   - `<InstallPromptToast/>` — floating toast on mobile-first visit
 */

import { useEffect, useState } from "react";
import {
  getInstallState, onInstallStateChange, triggerInstall, isIosSafari,
} from "@/lib/pwa";
import { Download, Share, PlusSquare, X, Smartphone } from "lucide-react";

const DISMISS_KEY = "sb_install_prompt_dismissed_at";
const DISMISS_TTL_DAYS = 14;

function isRecentlyDismissed() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (!at) return false;
    return Date.now() - at < DISMISS_TTL_DAYS * 24 * 3600 * 1000;
  } catch { return false; }
}

function markDismissed() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
}

/* --- Inline settings card (always visible in Settings if eligible). - */

export function InstallPromptCard() {
  const [state, setState] = useState(getInstallState());
  useEffect(() => onInstallStateChange(setState), []);

  if (state === "installed") {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex items-center gap-3"
           data-testid="pwa-install-installed">
        <Smartphone className="text-emerald-600" size={18} />
        <div className="text-sm">
          <div className="font-semibold text-emerald-900">Installed on this device</div>
          <div className="text-emerald-700 text-xs mt-0.5">Push notifications and offline mode are active.</div>
        </div>
      </div>
    );
  }
  if (state === "unsupported") return null;

  return (
    <div className="rounded-xl border bg-white p-5 space-y-3" data-testid="pwa-install-card">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-cyan-100 grid place-items-center shrink-0">
          <Smartphone className="text-cyan-600" size={20} />
        </div>
        <div>
          <h3 className="font-heading font-semibold text-sm">Install the mobile app</h3>
          <p className="text-xs text-slate-500 mt-0.5 leading-snug">
            Add to your home screen for one-tap access, push notifications when a bill is due, and offline reading.
          </p>
        </div>
      </div>
      {state === "prompt-available" && (
        <button
          onClick={triggerInstall}
          data-testid="pwa-install-btn"
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-semibold"
        >
          <Download size={14} /> Install app
        </button>
      )}
      {state === "ios-manual" && <IosTutorial />}
    </div>
  );
}

/* --- iOS Add-to-Home-Screen 2-step tutorial. ------------------------- */

function IosTutorial() {
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-700 leading-relaxed space-y-2">
      <div className="font-semibold text-slate-900 mb-1">To install on iPhone:</div>
      <div className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-slate-900 text-white grid place-items-center text-[10px] shrink-0">1</span>
        <span>Tap the <Share size={12} className="inline mx-0.5 -mt-0.5" /> Share button in Safari</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-slate-900 text-white grid place-items-center text-[10px] shrink-0">2</span>
        <span>Scroll down and tap <PlusSquare size={12} className="inline mx-0.5 -mt-0.5" /> <strong>Add to Home Screen</strong></span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-slate-900 text-white grid place-items-center text-[10px] shrink-0">3</span>
        <span>Open the app from your home screen — push notifications will work from there.</span>
      </div>
    </div>
  );
}

/* --- Floating first-visit toast (mobile only). ---------------------- */

/**
 * InstallRibbon — a slimmer, in-page variant of the toast that lives
 * INSIDE a page's layout (typically /home) rather than floating on
 * top. Same eligibility rules as InstallPromptToast but rendered as
 * a normal block so it doesn't cover content. Highest-converting
 * placement in a SaaS: the user is already logged-in, engaged, and
 * on their phone — this is the moment to ask for the install.
 */
export function InstallRibbon() {
  const [state, setState] = useState(getInstallState());
  const [dismissed, setDismissed] = useState(isRecentlyDismissed());
  const [expanded, setExpanded] = useState(false);
  useEffect(() => onInstallStateChange(setState), []);

  const isMobile = typeof window !== "undefined" && window.innerWidth <= 900;
  if (!isMobile) return null;
  if (dismissed) return null;
  if (state === "installed" || state === "unsupported") return null;

  const close = () => { markDismissed(); setDismissed(true); };

  if (state === "prompt-available") {
    return (
      <div className="rounded-xl bg-gradient-to-r from-cyan-600 to-cyan-500 text-white p-3 flex items-center gap-3 shadow-sm"
           data-testid="install-ribbon">
        <div className="w-9 h-9 rounded-lg bg-white/20 grid place-items-center shrink-0">
          <Smartphone size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">Install this app on your phone</div>
          <div className="text-xs text-white/80 truncate">Home-screen icon + push notifications, no app store</div>
        </div>
        <button
          onClick={async () => { await triggerInstall(); close(); }}
          data-testid="install-ribbon-btn"
          className="px-3 py-1.5 rounded-md bg-white text-cyan-700 text-xs font-semibold shrink-0 hover:bg-cyan-50"
        >Install</button>
        <button onClick={close} className="text-white/80 hover:text-white shrink-0"
                data-testid="install-ribbon-close" aria-label="Dismiss">
          <X size={16} />
        </button>
      </div>
    );
  }
  if (state === "ios-manual") {
    return (
      <div className="rounded-xl bg-gradient-to-r from-cyan-600 to-cyan-500 text-white p-3"
           data-testid="install-ribbon-ios">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-white/20 grid place-items-center shrink-0">
            <Smartphone size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">Add SmartBooks to your Home Screen</div>
            <div className="text-xs text-white/80 truncate">Push notifications + offline mode</div>
          </div>
          <button onClick={() => setExpanded(v => !v)}
                  className="px-3 py-1.5 rounded-md bg-white text-cyan-700 text-xs font-semibold shrink-0 hover:bg-cyan-50">
            {expanded ? "Hide" : "Show me"}
          </button>
          <button onClick={close} className="text-white/80 hover:text-white shrink-0"
                  aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
        {expanded && (
          <div className="mt-3 bg-white rounded-lg p-3"><IosTutorial /></div>
        )}
      </div>
    );
  }
  return null;
}

/* --- Floating first-visit toast (mobile only). ---------------------- */

export function InstallPromptToast() {
  const [state, setState] = useState(getInstallState());
  const [dismissed, setDismissed] = useState(isRecentlyDismissed());
  const [expanded, setExpanded] = useState(false);
  useEffect(() => onInstallStateChange(setState), []);

  // Only show on mobile viewports.
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 900;
  if (!isMobile) return null;
  if (dismissed) return null;
  if (state === "installed" || state === "unsupported") return null;
  // The Home page has its own inline InstallRibbon — don't
  // double-nag the user by floating a second CTA over it.
  if (typeof window !== "undefined" && window.location.pathname === "/home") return null;

  const close = () => { markDismissed(); setDismissed(true); };

  if (state === "prompt-available") {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-40 rounded-xl border border-slate-200 bg-white shadow-lg p-3 flex items-center gap-3"
           data-testid="pwa-install-toast">
        <Smartphone className="text-cyan-600 shrink-0" size={20} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-900">Install this app</div>
          <div className="text-xs text-slate-500 truncate">Home-screen icon + push notifications</div>
        </div>
        <button
          onClick={async () => { await triggerInstall(); close(); }}
          data-testid="pwa-install-toast-btn"
          className="px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shrink-0"
        >Install</button>
        <button onClick={close} className="text-slate-400 hover:text-slate-600 shrink-0" aria-label="Dismiss">
          <X size={16} />
        </button>
      </div>
    );
  }
  if (state === "ios-manual") {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-40 rounded-xl border border-slate-200 bg-white shadow-lg p-3"
           data-testid="pwa-install-toast-ios">
        <div className="flex items-center gap-3">
          <Smartphone className="text-cyan-600 shrink-0" size={20} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900">Add to Home Screen</div>
            <div className="text-xs text-slate-500 truncate">Get push notifications + offline mode</div>
          </div>
          <button onClick={() => setExpanded(v => !v)}
                  className="px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs font-semibold shrink-0">
            {expanded ? "Hide" : "How"}
          </button>
          <button onClick={close} className="text-slate-400 hover:text-slate-600 shrink-0" aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
        {expanded && (<div className="mt-3"><IosTutorial /></div>)}
      </div>
    );
  }
  return null;
}
