/**
 * ApproveModal + DeclineModal for the underwriter portal.
 *
 * Shared by MerchantReviewDetail so a merchant record's status can
 * be advanced (approve with NMI keys, decline with a reason) from
 * one canonical UI.
 */
import React, { useEffect, useState } from "react";
import { Loader2, ShieldCheck, XCircle } from "lucide-react";

export function ApproveModal({ open, onClose, onSubmit, working }) {
  const [form, setForm] = useState({
    nmi_security_key: "",
    nmi_tokenization_key: "",
    nmi_processor_id: "",
    webhook_secret: "",
    environment: "sandbox",
    surcharge_pct: "",
    note: "",
  });
  useEffect(() => {
    // Blank out the sensitive fields every time the modal reopens.
    if (open) setForm((f) => ({ ...f, nmi_security_key: "", nmi_tokenization_key: "" }));
  }, [open]);
  if (!open) return null;
  const valid = form.nmi_security_key.trim().length >= 8 && form.nmi_tokenization_key.trim().length >= 8;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" data-testid="approve-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="p-5 border-b border-slate-200">
          <div className="flex items-center gap-2 text-emerald-700">
            <ShieldCheck size={16} />
            <div className="text-[10px] uppercase tracking-widest font-semibold">Underwriter · Approve</div>
          </div>
          <div className="text-lg font-bold text-slate-900 mt-1">Enable payments for this merchant</div>
          <div className="text-[12px] text-slate-500 mt-1">Keys are encrypted at rest and only decrypted server-side for API calls.</div>
        </div>
        <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Environment</div>
            <select
              value={form.environment}
              onChange={(e) => setForm({ ...form, environment: e.target.value })}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm bg-white"
              data-testid="approve-env"
            >
              <option value="sandbox">Sandbox (test)</option>
              <option value="production">Production (live)</option>
            </select>
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">NMI Security Key *</div>
            <input
              type="password" value={form.nmi_security_key}
              onChange={(e) => setForm({ ...form, nmi_security_key: e.target.value })}
              placeholder="private, server-side only"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              data-testid="approve-sec-key"
            />
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">NMI Tokenization Key *</div>
            <input
              type="text" value={form.nmi_tokenization_key}
              onChange={(e) => setForm({ ...form, nmi_tokenization_key: e.target.value })}
              placeholder="public — browser-facing"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              data-testid="approve-tok-key"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Processor ID / Gateway ID</div>
              <input
                type="text" value={form.nmi_processor_id}
                onChange={(e) => setForm({ ...form, nmi_processor_id: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
                data-testid="approve-proc-id"
              />
            </label>
            <label className="block">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Surcharge %</div>
              <input
                type="number" step="0.01" min="0" max="10"
                value={form.surcharge_pct}
                onChange={(e) => setForm({ ...form, surcharge_pct: e.target.value })}
                placeholder="0"
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                data-testid="approve-surcharge"
              />
            </label>
          </div>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Webhook Secret</div>
            <input
              type="password" value={form.webhook_secret}
              onChange={(e) => setForm({ ...form, webhook_secret: e.target.value })}
              placeholder="HMAC signing secret for /webhook"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              data-testid="approve-webhook-secret"
            />
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Internal note (optional)</div>
            <textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              data-testid="approve-note"
            />
          </label>
        </div>
        <div className="p-5 border-t border-slate-200 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-slate-700 hover:text-slate-900" data-testid="approve-cancel">Cancel</button>
          <button
            type="button"
            disabled={!valid || working}
            onClick={() => onSubmit({ ...form, surcharge_pct: parseFloat(form.surcharge_pct || 0) })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow disabled:opacity-50"
            data-testid="approve-submit"
          >
            {working && <Loader2 size={13} className="animate-spin" />}
            Approve & enable payments
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeclineModal({ open, onClose, onSubmit, working }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { if (open) { setReason(""); setNote(""); } }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" data-testid="decline-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="p-5 border-b border-slate-200">
          <div className="flex items-center gap-2 text-rose-700">
            <XCircle size={16} />
            <div className="text-[10px] uppercase tracking-widest font-semibold">Underwriter · Decline</div>
          </div>
          <div className="text-lg font-bold text-slate-900 mt-1">Decline this application</div>
          <div className="text-[12px] text-slate-500 mt-1">The client sees the reason in their inbox and can update and resubmit.</div>
        </div>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Reason (visible to client) *</div>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              placeholder="e.g. Need a business bank statement showing the legal name and address."
              data-testid="decline-reason"
            />
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Internal note</div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              data-testid="decline-note"
            />
          </label>
        </div>
        <div className="p-5 border-t border-slate-200 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-slate-700 hover:text-slate-900">Cancel</button>
          <button
            type="button"
            disabled={reason.trim().length < 4 || working}
            onClick={() => onSubmit({ reason: reason.trim(), note })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-rose-600 hover:bg-rose-700 text-white font-semibold shadow disabled:opacity-50"
            data-testid="decline-submit"
          >
            {working && <Loader2 size={13} className="animate-spin" />}
            Send decline
          </button>
        </div>
      </div>
    </div>
  );
}
