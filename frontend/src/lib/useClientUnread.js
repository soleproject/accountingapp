import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bucketOf } from "@/components/ClientMessagesCard";

export const CLIENT_MESSAGES_CHANGED = "client-messages-changed";
export const notifyClientMessagesChanged = () => window.dispatchEvent(new Event(CLIENT_MESSAGES_CHANGED));

/** Count of "Outstanding" threads for the client (accountant spoke last, not resolved). Polls + refreshes on change events. */
export function useClientUnread(companyId) {
  const { user } = useAuth();
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    if (!companyId || !user?.id) return;
    api.get(`/companies/${companyId}/client-messages`)
      .then(r => setCount((r.data.messages || []).filter(m => bucketOf(m, "client") === "outstanding").length))
      .catch(() => {});
  }, [companyId, user?.id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    window.addEventListener(CLIENT_MESSAGES_CHANGED, load);
    return () => { clearInterval(t); window.removeEventListener(CLIENT_MESSAGES_CHANGED, load); };
  }, [load]);
  return count;
}
