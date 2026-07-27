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
import { NextStepCard } from "@/components/CleanupCopilot";

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
      count: String(g.count ?? 0),
      total_amount: String(g.total_amount ?? 0),
      filter: "uncategorized",
    });
    // Preserve `tour=1` (and optional `replay=1`) through the redirect
    // so first-time clients see the guided walkthrough on the AI
    // Transaction Questions page — and the Settings replay button can
    // force it again.
    if (params.get("tour") === "1") qs.set("tour", "1");
    if (params.get("replay") === "1") qs.set("replay", "1");
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
    navigate(`/accounting/transactions?${qs.toString()}`, { replace: true });
  }, [groups, currentIdx, navigate]);

  if (!groups) {
    return <div className="p-6 text-sm text-slate-500">Loading vendor groups…</div>;
  }
  if (groups.length === 0) {
    // Step 2 is clean — bounce the CPA back to the AI Transaction
    // Questions layout (Transactions.jsx with `letsReview=1&done=1`) so
    // the copilot header + blue "Step 2: Let's review" card stay
    // visible, and the table area is replaced with a NextStepCard
    // handoff. Matches the AI Cleanup Review page's empty-state UX.
    return <LetsReviewDoneRedirect />;
  }
  // While redirecting, avoid a flash of raw layout.
  return null;
}

function LetsReviewDoneRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/accounting/transactions?letsReview=1&done=1", { replace: true });
  }, [navigate]);
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
