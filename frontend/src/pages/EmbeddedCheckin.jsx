import { useEffect, useState } from "react";
import { Loader2, Inbox } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import ClientReviewPage from "@/pages/ClientReviewPage";

// Quick Check-in item types (see client_review.py ITEM_* constants).
export const CHECKIN_SCOPES = {
  liability_payments: { title: "Liability Payments", types: [9] },
  receipt_followup:   { title: "Receipt Follow-up",  types: [3] },
  checks:             { title: "Checks",             types: [11, 13] },
};

// Renders the live Quick Check-in session for the current company inside
// the normal app shell, scoped to one bucket of item types.
export default function EmbeddedCheckin({ scope }) {
  const { currentId } = useCompany();
  const cfg = CHECKIN_SCOPES[scope];
  const [state, setState] = useState({ loading: true, token: null });

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    setState({ loading: true, token: null });
    api.get(`/client-review/latest-for-company/${currentId}`)
      .then(r => { if (!cancelled) setState({ loading: false, token: r.data?.has_pending ? r.data.client_token : null }); })
      .catch(() => { if (!cancelled) setState({ loading: false, token: null }); });
    return () => { cancelled = true; };
  }, [currentId]);

  if (state.loading) {
    return <div className="flex items-center gap-2 text-sm text-slate-500 py-10 justify-center" data-testid="embedded-checkin-loading"><Loader2 size={16} className="animate-spin" /> Loading check-in…</div>;
  }
  if (!state.token) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center" data-testid="embedded-checkin-empty">
        <Inbox size={26} className="mx-auto text-slate-400 mb-2" />
        <div className="text-base font-semibold text-slate-900">{cfg.title}</div>
        <div className="text-sm text-slate-600 mt-1">No open Quick Check-in for this client right now.</div>
      </div>
    );
  }
  return <ClientReviewPage key={`${scope}:${currentId}:${state.token}`} embedded token={state.token} itemTypes={cfg.types} embeddedTitle={cfg.title} />;
}
