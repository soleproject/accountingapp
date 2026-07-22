// Dynamic <title> based on where the user is: SmartBooks on the platform host,
// the firm's name on a private-label subdomain, and a generic "Accounting App"
// on the neutral root. Mounted once inside App and updates when logins land or
// the firm's branding changes (so a rename in Enterprise Settings takes effect
// without a page reload).
import { useEffect } from "react";
import { api } from "@/lib/api";
import { useBranding } from "@/lib/branding";

const NEUTRAL_TITLE = "Accounting App";
const PLATFORM_TITLE = "SmartBooks";

export function useHostTitle() {
  const { branding } = useBranding();

  // Resolve once on mount using the current hostname. The backend knows the
  // configured PRIVATE_LABEL_ROOT + PRIMARY_HOST so the frontend doesn't need
  // to keep a copy in sync.
  useEffect(() => {
    let cancelled = false;
    api.get(`/branding/by-host?host=${encodeURIComponent(window.location.hostname)}`)
      .then(r => {
        if (cancelled) return;
        const d = r.data || {};
        if (d.mode === "firm" && d.firm_name) {
          document.title = d.firm_name;
        } else if (d.mode === "platform") {
          document.title = PLATFORM_TITLE;
        } else {
          document.title = NEUTRAL_TITLE;
        }
      })
      .catch(() => {
        // Fall back to a safe generic label rather than blank / stale text.
        document.title = NEUTRAL_TITLE;
      });
    return () => { cancelled = true; };
  }, []);

  // Once the signed-in user's branding lands, prefer THEIR firm name over
  // the host-derived one — a client using acme.accountingapp.ai should still
  // see "Acme CPAs" if the owner renames the firm.
  useEffect(() => {
    if (!branding) return;
    const name = branding.firm_name || branding.name;
    if (name) document.title = name;
  }, [branding]);
}
