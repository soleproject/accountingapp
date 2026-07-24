// Let's Review — thin router that fetches the list of uncategorized-vendor
// groups from `/cleanup-suggestions` and hands off to the Transactions
// page (which handles rendering, filtering, and the AI Copilot chat).
// The URL params tell Transactions to swap its title to "AI Transaction
// Questions", show the "Contact X of Y" info box, and pre-filter to a
// single contact — one click walks through vendors like a stepper.
//
// Navigating to `/accounting/lets-review` without a `?contact_id=` picks
// the first group and redirects; a small pager under the info box lets
// the CPA walk Previous / Next through the queue.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { emitAction } from "@/lib/createBus";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";

export default function LetsReview() {
  const { currentId } = useCompany();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [groups, setGroups] = useState(null);

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/transactions/cleanup-suggestions`).then(r => {
      const gs = (r.data?.top_actions || []).filter(a => a.kind === "contact_in_uncat");
      setGroups(gs);
    });
  }, [currentId]);

  const currentIdx = useMemo(() => {
    if (!groups) return -1;
    const cid = params.get("contact_id");
    if (!cid) return 0;
    const i = groups.findIndex(g => g.contact_id === cid);
    return i >= 0 ? i : 0;
  }, [groups, params]);

  // Redirect to Transactions with the right query string as soon as we
  // know which group to show. Also fires the "cleanup-inquiry" bus action
  // that the Transactions Copilot listens to — same behavior as clicking
  // "Let's review" on a chip.
  useEffect(() => {
    if (!groups || groups.length === 0 || currentIdx < 0) return;
    const g = groups[currentIdx];
    if (!g) return;
    const qs = new URLSearchParams({
      letsReview: "1",
      contact_id: g.contact_id,
      contact_name: g.contact_name,
      idx: String(currentIdx + 1),
      total: String(groups.length),
      filter: "uncategorized",
    }).toString();
    // Give the Transactions Copilot a beat to mount its listener before
    // we emit the inquiry that populates the chat panel.
    setTimeout(() => {
      emitAction("cleanup-inquiry", {
        action: {
          kind: "contact_in_uncat",
          contact_id: g.contact_id,
          contact_name: g.contact_name,
          count: g.count,
          total_amount: g.total_amount,
          label: g.contact_name,
        },
      });
    }, 400);
    navigate(`/accounting/transactions?${qs}`, { replace: true });
  }, [groups, currentIdx, navigate]);

  if (!groups) {
    return <div className="p-6 text-sm text-slate-500">Loading vendor groups…</div>;
  }
  if (groups.length === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-xl border bg-white p-8 text-center">
          <Sparkles className="mx-auto text-emerald-500 mb-2" size={28} />
          <div className="font-semibold text-slate-900">Nothing to review</div>
          <div className="text-sm text-slate-500 mt-1">
            No uncategorized vendor groups. You're clean.
          </div>
          <Link
            to="/dashboard"
            className="mt-4 inline-block text-xs text-indigo-600 hover:text-indigo-800"
          >
            Back to Dashboard →
          </Link>
        </div>
      </div>
    );
  }
  // While redirecting, avoid a flash of raw layout.
  return null;
}

// Prev/Next helpers exported for the Transactions page toolbar (so we can
// stitch them onto the "AI Transaction Questions" header). Keeps the
// group-list source of truth here in one place.
export function useLetsReviewNav() {
  const [groups, setGroups] = useState([]);
  const [params] = useSearchParams();
  const { currentId } = useCompany();
  const navigate = useNavigate();
  const active = params.get("letsReview") === "1";
  const contactId = params.get("contact_id");

  useEffect(() => {
    if (!active || !currentId) return;
    api.get(`/companies/${currentId}/transactions/cleanup-suggestions`).then(r => {
      const gs = (r.data?.top_actions || []).filter(a => a.kind === "contact_in_uncat");
      setGroups(gs);
    });
  }, [active, currentId]);

  const idx = groups.findIndex(g => g.contact_id === contactId);
  const jumpTo = (i) => {
    const g = groups[i];
    if (!g) return;
    navigate(`/accounting/lets-review?contact_id=${g.contact_id}`);
  };
  return {
    active,
    idx,
    total: groups.length,
    prev: idx > 0 ? () => jumpTo(idx - 1) : null,
    next: idx >= 0 && idx < groups.length - 1 ? () => jumpTo(idx + 1) : null,
    exit: () => navigate("/dashboard"),
  };
}
