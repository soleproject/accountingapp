// No-Contact Review (Step 3) — thin router mirroring LetsReview.jsx.
// Fetches `/no-contact-groups` (server groups uncategorized/no-contact
// txns by description signature) and hands off to Transactions.jsx with
// `?noContactReview=1&group_key=...&label=...&idx=X&total=Y&count=N&
// total_amount=Z`. The Transactions page swaps its title to "No-Contact
// Review" and filters the list to the group's txns via `no_contact=1 +
// desc_group=<key>`. Same stepper pattern as Let's Review.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { emitAction } from "@/lib/createBus";
import { Sparkles } from "lucide-react";

export default function NoContactReview() {
  const { currentId } = useCompany();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [groups, setGroups] = useState(null);

  useEffect(() => {
    if (!currentId) return;
    api
      .get(`/companies/${currentId}/transactions/no-contact-groups`)
      .then((r) => setGroups(r.data?.groups || []));
  }, [currentId]);

  const currentIdx = useMemo(() => {
    if (!groups) return -1;
    const gk = params.get("group_key");
    if (!gk) return 0;
    const i = groups.findIndex((g) => g.group_key === gk);
    return i >= 0 ? i : 0;
  }, [groups, params]);

  useEffect(() => {
    if (!groups || groups.length === 0 || currentIdx < 0) return;
    const g = groups[currentIdx];
    if (!g) return;
    const qs = new URLSearchParams({
      noContactReview: "1",
      group_key: g.group_key,
      label: g.label,
      idx: String(currentIdx + 1),
      total: String(groups.length),
      count: String(g.count ?? 0),
      total_amount: String(g.total_amount ?? 0),
    }).toString();
    // Give the Transactions Copilot a beat to mount its listener before
    // we emit the inquiry that populates the chat panel.
    setTimeout(() => {
      emitAction("cleanup-inquiry", {
        action: {
          kind: "no_contact_group",
          group_key: g.group_key,
          count: g.count,
          total_amount: g.total_amount,
          label: g.label,
        },
      });
    }, 400);
    navigate(`/accounting/transactions?${qs}`, { replace: true });
  }, [groups, currentIdx, navigate]);

  if (!groups) {
    return (
      <div className="p-6 text-sm text-slate-500">
        Loading no-contact groups…
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-xl border bg-white p-8 text-center">
          <Sparkles className="mx-auto text-emerald-500 mb-2" size={28} />
          <div className="font-semibold text-slate-900">Nothing to review</div>
          <div className="text-sm text-slate-500 mt-1">
            No uncategorized no-contact transactions. You're clean.
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
  return null;
}

// Prev/Next helpers exported for the Transactions page toolbar so we can
// stitch a stepper onto the "No-Contact Review" header — same shape as
// `useLetsReviewNav` in LetsReview.jsx.
export function useNoContactReviewNav() {
  const [groups, setGroups] = useState([]);
  const [params] = useSearchParams();
  const { currentId } = useCompany();
  const navigate = useNavigate();
  const active = params.get("noContactReview") === "1";
  const groupKey = params.get("group_key");

  useEffect(() => {
    if (!active || !currentId) return;
    api
      .get(`/companies/${currentId}/transactions/no-contact-groups`)
      .then((r) => setGroups(r.data?.groups || []));
  }, [active, currentId]);

  const idx = groups.findIndex((g) => g.group_key === groupKey);
  const jumpTo = (i) => {
    const g = groups[i];
    if (!g) return;
    navigate(`/accounting/no-contact-review?group_key=${encodeURIComponent(g.group_key)}`);
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
