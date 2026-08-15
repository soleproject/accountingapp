import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";

/**
 * useFeedbackUnread — polls the two unread-count endpoints and returns
 * `{reporter, admin}` for the profile-menu + sidebar badges. Refreshes
 * every 60s and immediately whenever `refreshKey` changes (so callers
 * can force a bump right after they mark-read).
 */
export function useFeedbackUnread({ isSuperadmin, refreshKey = 0 } = {}) {
  const [reporter, setReporter] = useState(0);
  const [admin, setAdmin] = useState(0);

  const fetchNow = useCallback(async () => {
    try {
      const r = await api.get("/feedback/mine/unread-count");
      setReporter(r.data?.unread || 0);
    } catch { /* non-fatal */ }
    if (isSuperadmin) {
      try {
        const r = await api.get("/feedback/unread-count");
        setAdmin(r.data?.unread || 0);
      } catch { /* non-fatal */ }
    }
  }, [isSuperadmin]);

  useEffect(() => {
    fetchNow();
    const h = setInterval(fetchNow, 60_000);
    return () => clearInterval(h);
  }, [fetchNow, refreshKey]);

  return { reporter, admin, refresh: fetchNow };
}
