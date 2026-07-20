import { usePlaidLink } from "react-plaid-link";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { History, Loader2 } from "lucide-react";

/**
 * Opens Plaid Link in **update mode** for the existing item and requests
 * 730 days of transaction history. When the user completes the flow, Plaid
 * will backfill older transactions and fire HISTORICAL_UPDATE webhooks.
 * We also kick off a manual-sync immediately for good measure.
 */
export default function PlaidBackfillButton({ companyId, onDone }) {
  const [linkToken, setLinkToken] = useState(null);
  const [busy, setBusy] = useState(false);

  const request = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${companyId}/plaid/backfill-history-token`);
      setLinkToken(r.data.link_token);
    } catch (e) {
      toast.error(`Backfill token error: ${e.response?.data?.detail || e.message}`);
    } finally { setBusy(false); }
  };

  const handleSuccess = useCallback(async () => {
    setBusy(true);
    try {
      toast.success("Re-authenticated. Plaid is backfilling older history — this can take a minute.");
      // Kick off an immediate sync so any newly-available older txns flow in
      try { await api.post(`/companies/${companyId}/plaid/manual-sync`); } catch {}
      onDone?.();
    } finally { setBusy(false); setLinkToken(null); }
  }, [companyId, onDone]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (pt) => {
      document.body.classList.remove("plaid-link-open");
      return handleSuccess(pt);
    },
    onExit: (err) => {
      document.body.classList.remove("plaid-link-open");
      setLinkToken(null);
      if (err) toast.error(`Plaid exited: ${err.error_message || err.error_code || "cancelled"}`);
    },
    onEvent: (eventName) => {
      if (eventName === "OPEN") document.body.classList.add("plaid-link-open");
      if (eventName === "EXIT" || eventName === "HANDOFF") {
        document.body.classList.remove("plaid-link-open");
      }
    },
  });

  // When token is fetched and Plaid Link is ready, auto-open it
  if (linkToken && ready && !busy) {
    setTimeout(() => open(), 0);
  }

  return (
    <button
      type="button"
      onClick={request}
      disabled={busy}
      data-testid="plaid-backfill-history-btn"
      className="text-[11px] px-2.5 py-1 rounded-md border border-slate-300 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1"
    >
      {busy
        ? <><Loader2 size={11} className="animate-spin" /> Requesting…</>
        : <><History size={11} /> Backfill 24 mo</>}
    </button>
  );
}
