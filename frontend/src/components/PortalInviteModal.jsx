import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { X, Copy, Send, Loader2, Link as LinkIcon } from "lucide-react";

// --------------------------------------------------------------------------
// PortalInviteModal — CPA-side dialog. Given a company_id, either:
//   (1) create a portal for a client_email + copy or email the link
//   (2) show the existing portal URL if one exists
//
// Called from Close Board card quick actions, Cockpit Requests toolbar,
// and (eventually) client-contact detail pages.
// --------------------------------------------------------------------------

export default function PortalInviteModal({ open, onClose, companyId, defaultEmail, defaultName }) {
  const [email, setEmail] = useState(defaultEmail || "");
  const [name, setName] = useState(defaultName || "");
  const [busy, setBusy] = useState(false);
  const [portal, setPortal] = useState(null);
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (open) {
      setEmail(defaultEmail || "");
      setName(defaultName || "");
      setPortal(null);
      setUrl("");
    }
  }, [open, defaultEmail, defaultName]);

  if (!open) return null;

  const createOrGet = async () => {
    if (!email.trim()) {
      toast.error("Client email is required.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post(`/companies/${companyId}/client-portals`, {
        client_email: email.trim(),
        client_name: name.trim() || null,
      });
      setPortal(r.data.portal);
      setUrl(r.data.url);
      toast.success("Portal ready.");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to create portal.");
    } finally {
      setBusy(false);
    }
  };

  const sendInvite = async () => {
    if (!portal) return;
    setBusy(true);
    try {
      await api.post(`/companies/${companyId}/client-portals/${portal.id}/send-invite`);
      toast.success(`Invite sent to ${email}.`);
      onClose?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to send invite.");
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Portal link copied.");
    } catch {
      toast.error("Copy failed — select the URL manually.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="portal-invite-modal">
      <div className="bg-white rounded-xl w-full max-w-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LinkIcon size={18} className="text-indigo-500" />
            <h2 className="text-lg font-semibold text-slate-900">Set up client portal</h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            data-testid="portal-invite-close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {!portal && (
            <>
              <p className="text-sm text-slate-600">
                One shareable magic-link URL per client. Every question, receipt request,
                and doc ask lands in the same queue — they answer at their own pace, and
                Close Board cards unblock automatically as answers come in.
              </p>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Client email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="owner@example.com"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                  data-testid="portal-invite-email"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Client name <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="First Last"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                  data-testid="portal-invite-name"
                />
              </div>
            </>
          )}

          {portal && (
            <div className="space-y-3">
              <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-sm text-emerald-800">
                Portal is live for <b>{portal.client_email}</b>. Share the URL below or
                email the invite directly.
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Magic link URL
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={url}
                    onFocus={(e) => e.target.select()}
                    className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded bg-slate-50 font-mono"
                    data-testid="portal-invite-url"
                  />
                  <button
                    onClick={copyUrl}
                    className="p-2 border border-slate-300 rounded hover:bg-slate-50"
                    data-testid="portal-invite-copy"
                    title="Copy URL"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-100"
            data-testid="portal-invite-cancel"
          >
            {portal ? "Done" : "Cancel"}
          </button>
          {!portal && (
            <button
              onClick={createOrGet}
              disabled={busy || !email.trim()}
              className="text-sm px-4 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
              data-testid="portal-invite-create"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              Create portal
            </button>
          )}
          {portal && (
            <button
              onClick={sendInvite}
              disabled={busy}
              className="text-sm px-4 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
              data-testid="portal-invite-send"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              Email invite
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
