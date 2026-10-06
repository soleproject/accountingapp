import React, { useEffect, useState } from "react";
import { Camera, X, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { RecModal } from "@/pages/Receipts";
import { Button } from "./ui";

export function MissingReceiptsModal({ companyId, items, periodLabel, onClose, onSaved }) {
  const [lookups, setLookups] = useState(null);
  const [target, setTarget] = useState(null);

  useEffect(() => {
    Promise.all([api.get(`/companies/${companyId}/accounts`), api.get(`/companies/${companyId}/contacts`)])
      .then(([a, c]) => setLookups({ accts: a.data.accounts || [], contacts: c.data.contacts || [] }))
      .catch(() => setLookups({ accts: [], contacts: [] }));
  }, [companyId]);

  if (target && lookups) {
    return (
      <RecModal
        currentId={companyId}
        accts={lookups.accts}
        contacts={lookups.contacts}
        linkTransaction={target}
        onClose={() => { setTarget(null); onSaved?.(); }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="missing-receipts-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">{items.length} item{items.length > 1 ? "s" : ""} need{items.length > 1 ? "" : "s"} you</div>
            <h2 className="font-heading text-xl">Help finish {periodLabel}'s books.</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900" data-testid="missing-receipts-close"><X size={16} /></button>
        </div>
        <div className="divide-y divide-slate-200">
          {items.map((m) => (
            <div key={m.id} className="flex items-center gap-3.5 py-3.5" data-testid={`missing-receipt-row-${m.id}`}>
              <span className="flex-none w-9 h-9 rounded-xl grid place-items-center bg-amber-50 text-amber-700 border border-amber-200"><Camera size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">{m.title}</div>
                <div className="text-xs text-slate-500 truncate">{m.detail}</div>
              </div>
              <Button primary disabled={!m.transaction || !lookups} onClick={() => setTarget(m.transaction)} data-testid={`missing-receipt-snap-${m.id}`}>
                {!lookups ? <Loader2 size={12} className="animate-spin" /> : "Snap receipt"}
              </Button>
            </div>
          ))}
        </div>
        <div className="text-xs text-slate-500 mt-2">Your team found the payment but needs the receipt to support the expense.</div>
      </div>
    </div>
  );
}
