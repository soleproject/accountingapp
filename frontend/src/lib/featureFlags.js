// Frontend feature-flag reader. Mirrors the backend contract in
// `backend/feature_flags.py` — global scope or per-company scope,
// company override wins.
//
// Phase 0 (Feb 2026): the ONLY flag we care about is
// `regions.uk_enabled`, which stays false. Nothing UK-visible renders
// while this returns false, so every US user is unaffected.
//
// Backend endpoint (Phase 0.1, ships alongside the frontend hook):
//   GET /api/feature-flags → { flags: { "regions.uk_enabled": false, … } }
// If the endpoint 404s or errors, we treat all flags as disabled
// (fail-closed for beta features == safe default).

import { useEffect, useState } from "react";
import { api } from "./api";

let _cache = null;      // { flags: { key: bool } } once loaded
let _inflight = null;   // Promise dedup so N components mounting at
                        // once don't fire N requests

const _fetchAll = async () => {
  if (_cache) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await api.get("/feature-flags");
      _cache = r.data || { flags: {} };
    } catch {
      // Fail-closed — every flag reads as disabled if the endpoint
      // is missing or errors. Safest possible default for a beta
      // gating system.
      _cache = { flags: {} };
    } finally {
      _inflight = null;
    }
    return _cache;
  })();
  return _inflight;
};

/**
 * React hook — returns the current boolean value for a flag key.
 * Suspense-free: renders `false` until the fetch completes, which
 * matches the fail-closed semantics above.
 */
export const useFeatureFlag = (key) => {
  const [value, setValue] = useState(() => {
    // Warm the value synchronously if the cache is already primed.
    return Boolean(_cache?.flags?.[key]);
  });
  useEffect(() => {
    let mounted = true;
    _fetchAll().then((res) => {
      if (mounted) setValue(Boolean(res.flags?.[key]));
    });
    return () => { mounted = false; };
  }, [key]);
  return value;
};

// Test hook — never called in production. Lets pytest-driven UI
// harnesses reset state between cases without a full page reload.
export const _resetFeatureFlagCache = () => { _cache = null; _inflight = null; };
