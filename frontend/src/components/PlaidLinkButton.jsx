import { usePlaidLink } from "react-plaid-link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { TID } from "@/constants/testIds";
import { Loader2, Link2 } from "lucide-react";
import { toast } from "sonner";

export default function PlaidLinkButton({ companyId, onSuccess, disabled }) {
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
    setLoading(true);
    try {
      const r = await api.post(`/companies/${companyId}/onboarding/plaid/exchange`, { public_token });
      toast.success(`Linked ${r.data.accounts.length} accounts`);
      onSuccess?.(r.data.accounts);
    } catch (e) {
      toast.error(`Plaid exchange failed: ${e.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, [companyId, onSuccess]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: handleSuccess,
    onExit: (err) => { if (err) console.warn("Plaid exit", err); },
  });

  return (
    <button
      data-testid={TID.onboardingMockPlaid}
      disabled={disabled || !ready || loading || !linkToken}
      onClick={() => open()}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50"
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
      Launch Plaid Link
    </button>
  );
}
