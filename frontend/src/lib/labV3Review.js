/**
 * Lab v3 review counter — single source for the sidebar badge, cockpit
 * tile, transactions banner, and agent-inquiries link. Every consumer
 * calls `useLabV3ReviewCount()` with the current company id; the hook
 * dedupes concurrent fetches per company via a tiny in-module cache
 * so we don't re-hit the backend once per component mount.
 *
 * Backend endpoint: GET /companies/{cid}/reviewv2/lab-v3-count
 *
 * Consumers should treat `is_lab_v3 === false` as "hide the UI" — the
 * endpoint still returns a well-formed zero-count payload for standard
 * companies so we never need to branch on error.
 */
import { useEffect, useState } from "react";
import { api } from "./api";

// Route users navigate to from every entry point. Keep in one place so
// a future rename (e.g. `/accounting/review`) is one-line.
export const LAB_V3_REVIEW_ROUTE = "/accounting/review";

const CACHE = new Map();      // cid → { data, promise, ts }
const TTL_MS = 30_000;        // 30s — long enough to dedupe mount storms

async function _fetch(cid) {
  const r = await api.get(`/companies/${cid}/reviewv2/lab-v3-count`);
  return r.data;
}

export function invalidateLabV3Count(cid) {
  CACHE.delete(cid);
}

export function useLabV3ReviewCount(cid) {
  const [state, setState] = useState(() => ({
    loading: !!cid, data: null, error: null,
  }));

  useEffect(() => {
    if (!cid) { setState({ loading: false, data: null, error: null }); return; }
    let live = true;

    const cached = CACHE.get(cid);
    // Only serve from cache when we have actual data. A cached entry
    // with `data: null` is a placeholder for an in-flight fetch —
    // subsequent mounts must await the promise, not fall through to
    // an empty state.
    if (cached && cached.data && (Date.now() - cached.ts) < TTL_MS) {
      setState({ loading: false, data: cached.data, error: null });
      return () => { live = false; };
    }

    const p = cached?.promise || _fetch(cid);
    CACHE.set(cid, { data: cached?.data || null, promise: p, ts: Date.now() });

    p.then((data) => {
      CACHE.set(cid, { data, promise: null, ts: Date.now() });
      if (live) setState({ loading: false, data, error: null });
    }).catch((error) => {
      CACHE.delete(cid);
      if (live) setState({ loading: false, data: null, error });
    });

    return () => { live = false; };
  }, [cid]);

  return state;   // { loading, data, error }
}
