import { useEffect, useRef } from "react";
import { toast } from "sonner";
import confetti from "canvas-confetti";

/**
 * PaymentConfetti — celebratory canvas burst that fires whenever a
 * fresh `payment_received` notification lands on the Cockpit.
 *
 * How it hears about new payments:
 *   `NotificationBell` polls `/api/notifications` every 60s and, after
 *   each poll, dispatches a window `CustomEvent("notifications:loaded",
 *   { detail: { items } })`. We piggyback on that stream so we don't
 *   spawn a second polling loop.
 *
 * Dedup strategy:
 *   Every notification id we've already celebrated is written into
 *   `sessionStorage` under `seen_payment_confetti_ids`. This means:
 *     - Refreshing the Cockpit tab won't re-fire confetti for the same
 *       payment (session persists across route changes).
 *     - A brand-new browser session WILL fire confetti for the freshest
 *       payment if it's still in the unread window — arguably the right
 *       behavior ("welcome back, you got paid while you were away!").
 *
 * We also cap sessionStorage to the last 200 ids so it stays tiny.
 */
const STORAGE_KEY = "seen_payment_confetti_ids";
const MAX_TRACKED = 200;

function loadSeen() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function persistSeen(setLike) {
  try {
    const arr = Array.from(setLike).slice(-MAX_TRACKED);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch { /* quota — non-fatal */ }
}

/** Two side cannons + a top-down shimmer over ~1.6s. Uses a fresh
 *  z-index high enough to sit above modals but the canvas is
 *  pointer-events:none so it never blocks clicks. */
function celebrate() {
  const end = Date.now() + 1600;
  const colors = ["#34d399", "#10b981", "#fbbf24", "#f59e0b", "#60a5fa", "#a78bfa"];

  // Side cannons — angled inward from the bottom corners.
  (function frame() {
    confetti({
      particleCount: 4,
      angle: 60,
      spread: 70,
      startVelocity: 55,
      origin: { x: 0, y: 0.85 },
      colors,
      zIndex: 9999,
    });
    confetti({
      particleCount: 4,
      angle: 120,
      spread: 70,
      startVelocity: 55,
      origin: { x: 1, y: 0.85 },
      colors,
      zIndex: 9999,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();

  // Big center burst — the money shot.
  confetti({
    particleCount: 90,
    spread: 100,
    startVelocity: 42,
    origin: { x: 0.5, y: 0.35 },
    colors,
    scalar: 1.1,
    zIndex: 9999,
  });

  // Delayed shimmer for a satisfying second beat.
  setTimeout(() => {
    confetti({
      particleCount: 40,
      spread: 140,
      startVelocity: 30,
      origin: { x: 0.5, y: 0.2 },
      colors,
      shapes: ["circle", "square"],
      scalar: 0.9,
      zIndex: 9999,
    });
  }, 350);
}

export default function PaymentConfetti() {
  // We keep the "seen" set in a ref *and* sessionStorage so React
  // state churn doesn't drive re-renders on every notification poll.
  const seenRef = useRef(null);
  if (seenRef.current === null) seenRef.current = loadSeen();

  useEffect(() => {
    const onLoaded = (e) => {
      const items = e.detail?.items || [];
      const fresh = items.filter(
        (n) => n?.kind === "payment_received" && n?.id && !seenRef.current.has(n.id),
      );
      if (fresh.length === 0) return;

      // Fire once (a single burst) even if multiple new payments
      // landed between polls — batching keeps it delightful, not
      // spammy. Show a stacked toast summarizing the total.
      celebrate();
      const total = fresh.reduce((sum, n) => {
        // "You got paid — $1,240.00" → parse the amount out.
        const m = /\$([\d,]+(?:\.\d{2})?)/.exec(n.title || "");
        return sum + (m ? parseFloat(m[1].replace(/,/g, "")) : 0);
      }, 0);
      const label = total > 0
        ? `+$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} landed`
        : `${fresh.length} payment${fresh.length > 1 ? "s" : ""} received`;
      toast.success(`💰 ${label}`, {
        description: fresh.length === 1
          ? fresh[0].body
          : `${fresh.length} customers paid you just now.`,
        duration: 6000,
      });

      // Persist so a refresh doesn't re-fire.
      fresh.forEach((n) => seenRef.current.add(n.id));
      persistSeen(seenRef.current);
    };

    window.addEventListener("notifications:loaded", onLoaded);
    return () => window.removeEventListener("notifications:loaded", onLoaded);
  }, []);

  // Purely a side-effect component — nothing to render.
  return null;
}
