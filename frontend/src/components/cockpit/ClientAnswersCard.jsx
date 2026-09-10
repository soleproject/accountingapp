/**
 * ClientAnswersCard — answered threads awaiting CPA review.
 */
import React, { useCallback, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import ClientCockpitCard from "./ClientCockpitCard";
import ThreadInbox from "./ThreadInbox";

export default function ClientAnswersCard({ companyId, companyName }) {
  const [summary, setSummary] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(
        `/companies/${companyId}/cockpit-cards/client-answers`,
        { params: { review_state: "needs_review" } },
      );
      setSummary(r.data?.counts || null);
    } finally {
      setBusy(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const needs = summary?.needs_review ?? 0;
  const reviewed = summary?.reviewed ?? 0;
  const total = needs + reviewed;
  const tone = needs > 0 ? "blue" : "green";
  const label = needs > 0 ? `${needs} to review` : total === 0 ? "No answers yet" : "All reviewed";

  return (
    <ClientCockpitCard
      testid="card-client-answers"
      icon={<CheckCircle2 size={16} className={needs > 0 ? "text-blue-600" : "text-emerald-600"} />}
      title="Client Answers & Requests"
      subtitle={
        needs > 0
          ? `${needs} answer${needs === 1 ? "" : "s"} awaiting your acknowledgement`
          : total === 0
            ? "Client answers show up here as soon as they come in."
            : `${reviewed} reviewed · ${total} lifetime`
      }
      statusLabel={label}
      statusTone={tone}
      count={needs}
      isOpen={open}
      onToggle={() => setOpen(v => !v)}
      onRefresh={load}
      refreshing={busy}
    >
      <ThreadInbox
        companyId={companyId}
        companyName={companyName}
        endpoint="client-answers"
        mode="answers"
        onDataChange={load}
      />
    </ClientCockpitCard>
  );
}
