import { usePlaidLink } from "react-plaid-link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { TID } from "@/constants/testIds";
import { Loader2, Link2 } from "lucide-react";
import { toast } from "sonner";
import { useActionListener } from "@/lib/createBus";
import PlaidStartDateModal from "@/components/PlaidStartDateModal";

/**
 * PlaidLinkButton — kicks off the Plaid Link flow with a pre-Link
 * "how far back?" modal (Feb 2026). Flow:
 *   1. User clicks Launch → open PlaidStartDateModal.
 *   2. User picks "This year" / "As far back as possible" / "Custom".
 *   3. We request a link_token with matching `days_requested` +
 *      remember the chosen `import_start_date`.
 *   4. Plaid Link opens.
 *   5. On success, we POST /plaid/exchange with the SAME
 *      import_start_date so it's stamped on the plaid_items row for
 *      every future sync to respect.
 */
export default function PlaidLinkButton({ companyId, onSuccess, disabled, label }) {
  const [linkToken, setLinkToken] = useState(null);
  const [loading, setLoading] = useState(false);
  // Modal state + the chosen ISO date. `null` means the user hasn't
  // picked yet; `"YYYY-MM-DD"` means we're ready to mint the token
  // and open Link.
  const [modalOpen, setModalOpen] = useState(false);
  const [importStartDate, setImportStartDate] = useState(null);
  // Once the user has confirmed the date and the link_token is ready,
  // we auto-open Plaid Link exactly once. Guarded by this ref so a
  // re-render doesn't re-open.
  const autoOpenPendingRef = useRef(false);

  const handleSuccess = useCallback(async (public_token) => {
    document.body.classList.remove("plaid-link-open");
    setLoading(true);
    try {
      const r = await api.post(
        `/companies/${companyId}/onboarding/plaid/exchange`,
        { public_token, import_start_date: importStartDate },
      );
      toast.success(`Linked ${r.data.accounts.length} accounts`);
      onSuccess?.(r.data.accounts);
    } catch (e) {
      toast.error(`Plaid exchange failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
      setLinkToken(null);
      setImportStartDate(null);
    }
  }, [companyId, onSuccess, importStartDate]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: handleSuccess,
    onExit: (err) => {
      document.body.classList.remove("plaid-link-open");
      if (err) console.warn("Plaid exit", err);
      // User cancelled — clear both so a re-click reopens the modal.
      setLinkToken(null);
      setImportStartDate(null);
      autoOpenPendingRef.current = false;
    },
    onEvent: (eventName) => {
      if (eventName === "OPEN") document.body.classList.add("plaid-link-open");
      if (eventName === "EXIT" || eventName === "HANDOFF") {
        document.body.classList.remove("plaid-link-open");
      }
    },
  });

  // As soon as the link_token is minted AND we're ready, auto-launch
  // Plaid Link. Sequenced this way because usePlaidLink can't be
  // called imperatively before `ready === true`.
  useEffect(() => {
    if (linkToken && ready && autoOpenPendingRef.current) {
      autoOpenPendingRef.current = false;
      open();
    }
  }, [linkToken, ready, open]);

  const handleLaunchClick = () => {
    // Reset any leftover state, then open the "how far back?" modal.
    setImportStartDate(null);
    setLinkToken(null);
    setModalOpen(true);
  };

  const handleDateConfirmed = async (isoDate) => {
    setImportStartDate(isoDate);
    setLoading(true);
    try {
      const r = await api.post(
        `/companies/${companyId}/onboarding/plaid/link-token`,
        { import_start_date: isoDate },
      );
      setLinkToken(r.data.link_token);
      // Queue auto-open. Fires from the effect above once `ready`.
      autoOpenPendingRef.current = true;
    } catch (e) {
      toast.error(`Plaid link-token error: ${e.response?.data?.detail || e.message}`);
      setImportStartDate(null);
    } finally {
      setLoading(false);
    }
  };

  // Voice/chat-driven launch — the onboarding coach emits
  // `plaid-launch` when the user says yes/connect/link it. Route it
  // through the same modal-first flow so voice users still pick a
  // cutoff.
  useActionListener("plaid-launch", () => {
    handleLaunchClick();
  });

  return (
    <>
      <button
        data-testid={TID.onboardingMockPlaid}
        disabled={disabled || loading}
        onClick={handleLaunchClick}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50"
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
        {label || "Launch Plaid Link"}
      </button>

      <PlaidStartDateModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onConfirm={handleDateConfirmed}
      />
    </>
  );
}
