import { usePlaidLink } from "react-plaid-link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { TID } from "@/constants/testIds";
import { Loader2, Link2 } from "lucide-react";
import { toast } from "sonner";
import { useActionListener } from "@/lib/createBus";

export default function PlaidLinkButton({ companyId, onSuccess, disabled, label }) {
  const [linkToken, setLinkToken] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!companyId || linkToken) return;
    setLoading(true);
    api.post(`/companies/${companyId}/onboarding/plaid/link-token`)
      .then(r => setLinkToken(r.data.link_token))
      .catch(e => toast.error(`Plaid link-token error: ${e.response?.data?.detail || e.message}`))
      .finally(() => setLoading(false));
  }, [companyId, linkToken]);

  const handleSuccess = useCallback(async (public_token) => {
    document.body.classList.remove("plaid-link-open");
    setLoading(true);
    try {
      const r = await api.post(`/companies/${companyId}/onboarding/plaid/exchange`, { public_token });
      toast.success(`Linked ${r.data.accounts.length} accounts`);
      onSuccess?.(r.data.accounts);
    } catch (e) {
      toast.error(`Plaid exchange failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
      // Force a fresh link_token for the next click so the user can link a
      // second institution in the same session.
      setLinkToken(null);
    }
  }, [companyId, onSuccess]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: handleSuccess,
    onExit: (err) => {
      document.body.classList.remove("plaid-link-open");
      if (err) console.warn("Plaid exit", err);
    },
    onEvent: (eventName) => {
      // Toggle a body class so global CSS can shrink Plaid's full-viewport
      // iframe and keep the AI chat panel accessible on the right.
      if (eventName === "OPEN") document.body.classList.add("plaid-link-open");
      if (eventName === "EXIT" || eventName === "HANDOFF") {
        document.body.classList.remove("plaid-link-open");
      }
    },
  });

  // Voice/chat-driven launch — the onboarding coach emits `plaid-launch`
  // when the user says "yes"/"connect"/"link it" on the Plaid step. Route
  // through a ref so the listener always sees the latest `open`/`ready`.
  const openRef = useRef(open);
  const readyRef = useRef(ready);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { readyRef.current = ready; }, [ready]);
  useActionListener("plaid-launch", () => {
    if (readyRef.current) {
      openRef.current?.();
    } else {
      toast.info("Plaid Link is still loading — try again in a moment.");
    }
  });

  return (
    <button
      data-testid={TID.onboardingMockPlaid}
      disabled={disabled || !ready || loading || !linkToken}
      onClick={() => open()}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50"
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
      {label || "Launch Plaid Link"}
    </button>
  );
}
