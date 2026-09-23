/**
 * ApproveModal + DeclineModal for the underwriter portal.
 *
 * Shared by MerchantReviewDetail so a merchant record's status can
 * be advanced (approve with NMI keys, decline with a reason) from
 * one canonical UI.
 */
import React, { useEffect, useState } from "react";
import { Loader2, ShieldCheck, XCircle, MessageSquareWarning, Key, AlertTriangle } from "lucide-react";

export function ApproveModal({ open, onClose, onSubmit, working, keysConfigured = false }) {
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
  // If keys are already on file (pre-provisioned via the Gateway
  // Keys tab), the underwriter can approve without re-entering.
  const valid = keysConfigured
    || (form.nmi_security_key.trim().length >= 8 && form.nmi_tokenization_key.trim().length >= 8);
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" data-testid="approve-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="p-5 border-b border-slate-200">
          <div className="flex items-center gap-2 text-emerald-700">
            <ShieldCheck size={16} />
            <div className="text-[10px] uppercase tracking-widest font-semibold">Underwriter · Approve</div>
          </div>
          <div className="text-lg font-bold text-slate-900 mt-1">Enable payments for this merchant</div>
          <div className="text-[12px] text-slate-500 mt-1">
            {keysConfigured
              ? "Gateway credentials are already on file. You can approve as-is or replace them below."
              : "Enter the merchant's NMI credentials (from their Merchant Portal → Settings → Security Keys). Encrypted at rest, only decrypted server-side."}
          </div>
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
            onClick={() => {
              // If keys are already on file and the underwriter didn't
              // re-enter them, send null so the backend keeps the existing
              // credentials as-is (avoids min_length validation error).
              const suppliedKeys = form.nmi_security_key.trim() && form.nmi_tokenization_key.trim();
              onSubmit({
                ...form,
                nmi_security_key:     suppliedKeys ? form.nmi_security_key : null,
                nmi_tokenization_key: suppliedKeys ? form.nmi_tokenization_key : null,
                surcharge_pct: parseFloat(form.surcharge_pct || 0),
              });
            }}
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


/**
 * RequestInfoModal — underwriter asks the client for more info. The
 * note is emailed to the merchant and mirrored as a banner on their
 * Payments Application page. Bounces the app to `waiting_on_client`.
 */
export function RequestInfoModal({ open, onClose, onSubmit, working }) {
  const [note, setNote] = useState("");
  const [responseType, setResponseType] = useState("either");
  useEffect(() => { if (open) { setNote(""); setResponseType("either"); } }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" data-testid="request-info-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="p-5 border-b border-slate-200">
          <div className="flex items-center gap-2 text-orange-700">
            <MessageSquareWarning size={16} />
            <div className="text-[10px] uppercase tracking-widest font-semibold">Underwriter · Request Info</div>
          </div>
          <div className="text-lg font-bold text-slate-900 mt-1">Ask the client for more info</div>
          <div className="text-[12px] text-slate-500 mt-1">
            The client will get an email and see this note as a banner on their Payments Application.
            When they re-submit, the app lands in the "Info Received" bucket.
          </div>
        </div>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">What do you need from them? *</div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              placeholder="e.g. Please upload a business bank statement from the last 60 days showing the legal name and address on the application."
              data-testid="request-info-note"
            />
            <div className="text-[11px] text-slate-400 mt-1">Written as if you're talking directly to the merchant — they see this verbatim.</div>
          </label>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">What are you expecting back? *</div>
            <div className="grid grid-cols-3 gap-2" data-testid="request-info-type">
              {[
                { v: "docs",   label: "Documents",   sub: "File upload required" },
                { v: "text",   label: "Written reply", sub: "Text response required" },
                { v: "either", label: "Either / both", sub: "Client picks" },
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setResponseType(opt.v)}
                  className={`text-left rounded-lg border p-2.5 transition ${
                    responseType === opt.v
                      ? "border-orange-500 bg-orange-50 shadow-sm ring-2 ring-orange-200"
                      : "border-slate-200 hover:border-slate-300 bg-white"
                  }`}
                  data-testid={`request-info-type-${opt.v}`}
                >
                  <div className="text-[12px] font-semibold text-slate-900">{opt.label}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{opt.sub}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-5 border-t border-slate-200 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-slate-700 hover:text-slate-900" data-testid="request-info-cancel">Cancel</button>
          <button
            type="button"
            disabled={note.trim().length < 4 || working}
            onClick={() => onSubmit({ note: note.trim(), response_type: responseType })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-orange-600 hover:bg-orange-700 text-white font-semibold shadow disabled:opacity-50"
            data-testid="request-info-submit"
          >
            {working && <Loader2 size={13} className="animate-spin" />}
            Send to client
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * GatewayKeysModal — set or rotate a merchant's NMI credentials.
 * Decoupled from the Approve action so keys can be staged before the
 * business decision is made. Every field is replace-all: we never
 * try to persist a partial-update because NMI's key permission model
 * makes surgical updates fragile.
 */
export function GatewayKeysModal({ open, onClose, onSubmit, working, merchantName = "this merchant", initialEnvironment = "sandbox", initialSurcharge = 0, existingLast4 = null }) {
  const [form, setForm] = useState({
    nmi_security_key: "",
    nmi_tokenization_key: "",
    nmi_processor_id: "",
    webhook_secret: "",
    environment: initialEnvironment,
    surcharge_pct: initialSurcharge ? String(initialSurcharge) : "",
    confirm_live: false,
  });
  useEffect(() => {
    if (open) {
      setForm({
        nmi_security_key: "",
        nmi_tokenization_key: "",
        nmi_processor_id: "",
        webhook_secret: "",
        environment: initialEnvironment || "sandbox",
        surcharge_pct: initialSurcharge ? String(initialSurcharge) : "",
        confirm_live: false,
      });
    }
  }, [open, initialEnvironment, initialSurcharge]);
  if (!open) return null;
  const goingLive = form.environment === "production";
  const valid = form.nmi_security_key.trim().length >= 8
             && form.nmi_tokenization_key.trim().length >= 8
             && (!goingLive || form.confirm_live);
  const isRotation = !!existingLast4;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" data-testid="gateway-keys-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="p-5 border-b border-slate-200">
          <div className="flex items-center gap-2 text-emerald-700">
            <Key size={16} />
            <div className="text-[10px] uppercase tracking-widest font-semibold">
              Underwriter · {isRotation ? "Rotate merchant keys" : "Set merchant keys"}
            </div>
          </div>
          <div className="text-lg font-bold text-slate-900 mt-1">
            {isRotation ? "Rotate this merchant's gateway credentials" : "Set this merchant's gateway credentials"}
          </div>
          <div className="text-[12px] text-slate-500 mt-1">
            These are the keys you generated inside <b>this merchant's</b> NMI Merchant Portal.
            Path: <b>Options → Settings → Security Keys → Add a New Private Key</b>. Both keys are
            encrypted at rest and only decrypted server-side for API calls.
          </div>
          {isRotation && (
            <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-[12px] px-3 py-2 flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <div>
                Replacing keys is immediate — every new charge, void, or refund uses the new ones the
                moment you save. Current key ends in <b className="font-mono">…{existingLast4}</b>.
              </div>
            </div>
          )}
        </div>
        <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Environment</div>
            <select
              value={form.environment}
              onChange={(e) => setForm({ ...form, environment: e.target.value, confirm_live: false })}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm bg-white"
              data-testid="gk-env"
            >
              <option value="sandbox">Sandbox (test)</option>
              <option value="production">Production (live)</option>
            </select>
          </label>
          {goingLive && (
            <div className="rounded-lg border-2 border-rose-300 bg-rose-50 p-3" data-testid="gk-live-confirm">
              <div className="flex items-start gap-2 text-rose-900">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <div>
                  <div className="text-[13px] font-bold">You're enabling LIVE payments.</div>
                  <div className="text-[12px] mt-0.5">
                    The next charge, void, or refund for <b>{merchantName}</b> will hit a real credit card.
                    Confirm before saving.
                  </div>
                  <label className="mt-2.5 inline-flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.confirm_live}
                      onChange={(e) => setForm({ ...form, confirm_live: e.target.checked })}
                      className="mt-0.5"
                      data-testid="gk-confirm-live"
                    />
                    <span className="text-[12px] text-rose-900 font-semibold">
                      Yes, enable LIVE payments for <span className="underline">{merchantName}</span>.
                    </span>
                  </label>
                </div>
              </div>
            </div>
          )}
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">NMI Security Key *</div>
            <input
              type="password" value={form.nmi_security_key}
              onChange={(e) => setForm({ ...form, nmi_security_key: e.target.value })}
              placeholder="private, server-side only"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              data-testid="gk-sec-key"
            />
            <div className="text-[11px] text-slate-400 mt-1">
              From <i>this merchant's</i> NMI Merchant Portal → Settings → Security Keys → Private key.
            </div>
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">NMI Tokenization (Public) Key *</div>
            <input
              type="text" value={form.nmi_tokenization_key}
              onChange={(e) => setForm({ ...form, nmi_tokenization_key: e.target.value })}
              placeholder="public — browser-facing"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              data-testid="gk-tok-key"
            />
            <div className="text-[11px] text-slate-400 mt-1">
              From the same panel → Public key (for Collect.js / Payment Component).
            </div>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Processor / Gateway ID</div>
              <input
                type="text" value={form.nmi_processor_id}
                onChange={(e) => setForm({ ...form, nmi_processor_id: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
                data-testid="gk-proc-id"
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
                data-testid="gk-surcharge"
              />
            </label>
          </div>
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Webhook Secret (optional)</div>
            <input
              type="password" value={form.webhook_secret}
              onChange={(e) => setForm({ ...form, webhook_secret: e.target.value })}
              placeholder="HMAC signing secret for /webhook"
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
              data-testid="gk-webhook-secret"
            />
          </label>
        </div>
        <div className="p-5 border-t border-slate-200 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-slate-700 hover:text-slate-900" data-testid="gk-cancel">Cancel</button>
          <button
            type="button"
            disabled={!valid || working}
            onClick={() => onSubmit({
              ...form,
              surcharge_pct: parseFloat(form.surcharge_pct || 0) || 0,
            })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow disabled:opacity-50"
            data-testid="gk-submit"
          >
            {working && <Loader2 size={13} className="animate-spin" />}
            {isRotation ? "Rotate keys" : "Save credentials"}
          </button>
        </div>
      </div>
    </div>
  );
}
