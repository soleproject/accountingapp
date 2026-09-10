/**
 * WaitingOnClientCard — open communications threads awaiting client reply.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { api } from "@/lib/api";
import ClientCockpitCard from "./ClientCockpitCard";
import ThreadInbox from "./ThreadInbox";

export default function WaitingOnClientCard({ companyId, companyName }) {
  const [summary, setSummary] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/cockpit-cards/waiting-on-client`);
      setSummary(r.data?.counts || null);
    } finally {
      setBusy(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const total = summary?.total ?? 0;
  const stale = summary?.stale_7d ?? 0;
  const tone = total === 0 ? "green" : stale > 0 ? "red" : "amber";
  const label = total === 0 ? "Inbox zero" : stale > 0 ? `${stale} stale 7d+` : "Awaiting reply";

  return (
    <ClientCockpitCard
      testid="card-waiting-on-client"
      icon={<Clock size={16} className={tone === "green" ? "text-emerald-600" : "text-amber-600"} />}
      title="Waiting on Client"
      subtitle={total === 0
        ? "No open questions — nothing to nudge."
        : `${total} open thread${total === 1 ? "" : "s"} · ${summary?.email ?? 0} email · ${summary?.portal ?? 0} portal · ${summary?.meeting ?? 0} meeting`}
      statusLabel={label}
      statusTone={tone}
      count={total}
      isOpen={open}
      onToggle={() => setOpen(v => !v)}
      onRefresh={load}
      refreshing={busy}
    >
      <ThreadInbox
        companyId={companyId}
        companyName={companyName}
        endpoint="waiting-on-client"
        mode="waiting"
        onDataChange={load}
      />
    </ClientCockpitCard>
  );
}
