import React from "react";
import { X } from "lucide-react";
import StatementsTab from "@/components/StatementsTab";

export function StatementUploadModal({ companyId, item, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="statement-upload-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">{item.period_label} · to finish reconciling</div>
            <h2 className="font-heading text-xl">{item.account_name} statement needed</h2>
            <p className="text-xs text-slate-500 mt-0.5">Drop the PDF or a photo of the statement. We read every line, match it to the bank, and file it — you can close this when the upload finishes.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900" data-testid="statement-upload-close"><X size={16} /></button>
        </div>
        <StatementsTab companyId={companyId} bare defaultAccountId={item.account_id} />
      </div>
    </div>
  );
}
