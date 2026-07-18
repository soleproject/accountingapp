// Global "create/open" event bus for voice-driven UX.
//
// When the user says "create an invoice for John Doe for $500", the voice
// command router:
//   1) navigates to the target page,
//   2) calls emitCreate('invoice', {prefill}).
//
// The target page registers a listener with useCreateListener(kind, cb).
// A short-lived queue (5s window) handles the race where the event fires
// before the page has mounted and attached its listener.

import { useEffect } from "react";

const CH = "axiom:create";
const CH_ACTION = "axiom:action";
const WINDOW_MS = 5000;

let queue = [];

export function emitCreate(kind, prefill = {}) {
  const detail = { kind, prefill, at: Date.now() };
  queue = queue.filter(x => Date.now() - x.at < WINDOW_MS).concat(detail);
  window.dispatchEvent(new CustomEvent(CH, { detail }));
}

export function emitAction(kind, payload = {}) {
  // Fire-and-forget actions that pages can react to without opening a modal
  // (e.g. "confirm-save-current-modal", "close-current-modal").
  window.dispatchEvent(new CustomEvent(CH_ACTION, { detail: { kind, payload, at: Date.now() } }));
}

export function useCreateListener(kind, handler) {
  useEffect(() => {
    // Drain the queue for any recent events targeting this kind — handles
    // the case where a voice command dispatched the event before this page
    // finished mounting.
    const now = Date.now();
    const drain = queue.filter(x => x.kind === kind && now - x.at < WINDOW_MS);
    queue = queue.filter(x => x.kind !== kind);
    drain.forEach(x => { try { handler(x.prefill); } catch {} });

    const listener = (e) => {
      const d = e.detail;
      if (d && d.kind === kind) {
        try { handler(d.prefill); } catch {}
      }
    };
    window.addEventListener(CH, listener);
    return () => window.removeEventListener(CH, listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function useActionListener(kind, handler) {
  useEffect(() => {
    const listener = (e) => {
      const d = e.detail;
      if (d && d.kind === kind) {
        try { handler(d.payload); } catch {}
      }
    };
    window.addEventListener(CH_ACTION, listener);
    return () => window.removeEventListener(CH_ACTION, listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
