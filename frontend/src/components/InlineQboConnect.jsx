/**
 * InlineQboConnect — compact QBO connect + preview + migrate flow
 * intended for embedding inside a larger page (currently: the
 * onboarding wizard's step 2). Reuses the same `/api/companies/{cid}/qbo/*`
 * endpoints as the standalone /connections/qbo page so nothing
 * diverges — the migration state lives on the backend, both surfaces
 * poll the same job doc.
 *
 * Design choices:
 *   * `returnPath` is passed to `/oauth/start` so the callback lands
 *     the user back INSIDE the onboarding wizard rather than on the
 *     standalone connect page. Falls back to `/connections/qbo` if
 *     omitted.
 *   * Deliberately does NOT render the "Open Live Mirror", "Re-run",
 *     "Rebuild account hierarchy" or "Resend email" buttons — those
 *     are power-user features that the user can access later at
 *     /connections/qbo. Onboarding is about the one-time first-run
 *     experience.
 *   * On success, hides the "Connect" button and shows a compact
 *     summary + a "See full migration console" link that opens the
 *     standalone page in a new tab.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Link2, CheckCircle2, Loader2, Play, ShieldCheck, ExternalLink,
  Mail,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const POLL_MS = 2000;

export default function InlineQboConnect({
  returnPath = "/connections/qbo",
}) {
  const { currentId } = useCompany();
  const [status, setStatus] = useState(null); // { connected, realm_id, ... }
  const [preview, setPreview] = useState(null);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  // Two-stage migration UX (mirrors /connections/qbo): confirm modal
  // that promises an email, then post-start modal that reassures the
  // user they can safely close the tab. Users on onboarding are
  // especially likely to sit and wait — so the "you can leave" nudge
  // is worth its weight here.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [startedOpen, setStartedOpen] = useState(false);
  const pollRef = useRef(null);

  const refreshStatus = async () => {
    if (!currentId) return;
    try {
      const r = await api.get(`/companies/${currentId}/qbo/status`);
      setStatus(r.data);
      // Same rehydration pattern as the standalone Connect QBO page:
      // seed local `preview` + `job` from the cached history on the
      // status doc so revisits (page refresh, wizard back-nav) keep
      // the "Migration complete" state visible instead of resetting
      // to the initial "Preview" button.
      if (r.data.preview && !preview) setPreview(r.data.preview);
      if (r.data.last_job && !job) setJob(r.data.last_job);
    } catch (e) {
      // Silent — the outer page can still function without status.
    }
  };
  useEffect(() => { refreshStatus(); }, [currentId]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const connect = async () => {
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/qbo/oauth/start`,
        { return_path: returnPath },
      );
      window.location.href = r.data.url;
    } catch (e) {
      const detail = e.response?.data?.detail || "Failed to start QBO connection";
      toast.error(detail, {
        duration: /not configured/i.test(detail) ? 20000 : 6000,
      });
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect from QuickBooks Online?")) return;
    setBusy(true);
    try {
      await api.post(`/companies/${currentId}/qbo/disconnect`);
      setStatus({ connected: false });
      setPreview(null);
      setJob(null);
      toast.success("Disconnected");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Disconnect failed");
    } finally { setBusy(false); }
  };

  const runPreview = async () => {
    setBusy(true);
    try {
      const r = await api.get(`/companies/${currentId}/qbo/preview`);
      setPreview(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Preview failed");
    } finally { setBusy(false); }
  };

  const pollOnce = async (jid) => {
    try {
      const r = await api.get(`/companies/${currentId}/qbo/migrations/${jid}`);
      setJob(r.data);
      if (["done", "failed", "cancelled"].includes(r.data.status)) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        if (r.data.status === "done") toast.success("Migration complete — email sent");
        else if (r.data.status === "failed") toast.error(`Migration failed: ${r.data.error || "unknown"}`);
      }
    } catch (e) { /* transient — keep polling */ }
  };
  const startPolling = (jid) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollOnce(jid);
    pollRef.current = setInterval(() => pollOnce(jid), POLL_MS);
  };

  const startMigration = async () => {
    setConfirmOpen(false);
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/qbo/migrations`);
      setJob({ job_id: r.data.job_id, status: "queued", processed: 0 });
      startPolling(r.data.job_id);
      // Follow-up "we've got it" modal — the safe-to-close reassurance.
      setStartedOpen(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Migration failed to start");
    } finally { setBusy(false); }
  };

  const running = job && (job.status === "queued" || job.status === "running");
  const done = job && job.status === "done";
  const previewTotal = preview?.total ?? 0;

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 size={14} className="animate-spin" /> Checking QuickBooks connection…
      </div>
    );
  }

  // ─── Not yet connected: show the connect CTA ────────────────────
  if (!status.connected) {
    return (
      <div
        data-testid="inline-qbo-not-connected"
        className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4"
      >
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck size={16} className="text-emerald-700" />
          <span className="text-sm font-semibold text-emerald-900">
            Connect QuickBooks Online
          </span>
        </div>
        <p className="text-xs text-slate-600 mb-3">
          You&apos;ll be redirected to Intuit&apos;s consent screen, then bounced
          back here to finish onboarding. Nothing is imported until you
          click <b>Start migration</b> on the next step.
        </p>
        <button
          data-testid="inline-qbo-connect-btn"
          onClick={connect}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
          Connect to QuickBooks Online
        </button>
      </div>
    );
  }

  // ─── Connected: show preview + migrate ──────────────────────────
  return (
    <div
      data-testid="inline-qbo-connected"
      className="space-y-3"
    >
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 size={14} className="text-emerald-600" />
              Connected · Realm {status.realm_id}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Environment: {status.connection_env || status.environment || "—"}
            </div>
          </div>
          <button
            data-testid="inline-qbo-disconnect-btn"
            onClick={disconnect}
            disabled={busy || running}
            className="text-xs text-slate-500 hover:text-red-600 underline"
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* Step: Preview */}
      {!preview && !job && (
        <button
          data-testid="inline-qbo-preview-btn"
          onClick={runPreview}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50 shadow-sm"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Preview what will import
        </button>
      )}

      {preview && !job && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <div className="text-sm">
            <b>{previewTotal.toLocaleString()}</b> records across{" "}
            <b>{Object.keys(preview.counts || {}).length}</b> object types will be
            imported. Nothing writes to QuickBooks — this is a one-way pull.
          </div>
          <button
            data-testid="inline-qbo-migrate-btn"
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Start migration
          </button>
        </div>
      )}

      {/* Step: Migration progress / done */}
      {job && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-700">
              {done
                ? "Migration complete"
                : job.entity
                  ? `Importing ${job.entity}…`
                  : job.phase || "Starting…"}
            </span>
            <span className="font-mono text-xs text-slate-500">
              {(job.processed || 0).toLocaleString()} records
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 transition-all"
              style={{
                width: `${done ? 100 : Math.min(90, ((job.processed || 0) / Math.max(1, previewTotal)) * 100)}%`,
              }}
            />
          </div>
          {done && (
            <div
              data-testid="inline-qbo-done"
              className="pt-2 text-xs text-emerald-800/90 flex items-center gap-1.5"
            >
              <CheckCircle2 size={13} /> Your books are mirrored. We&apos;ll email
              you the final summary shortly.
            </div>
          )}
          <a
            data-testid="inline-qbo-full-console-link"
            href="/connections/qbo"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-cyan-700 hover:text-cyan-900 pt-1"
          >
            <ExternalLink size={11} /> Open full migration console
          </a>
        </div>
      )}

      {/* Confirm-start dialog — mirrors the standalone /connections/qbo
          page. Promises an email so users don't sit and watch. */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="inline-qbo-migrate-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Play size={16} className="text-emerald-600" />
              Start QuickBooks migration?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-slate-600">
                <p>
                  We&apos;ll import every listed record from QuickBooks Online
                  into your ledger. Safe to re-run — records are matched by
                  QBO ID, so duplicates won&apos;t stack up.
                </p>
                <div className="flex items-start gap-2 rounded-md bg-cyan-50 border border-cyan-200 p-3 text-cyan-900">
                  <Mail size={14} className="mt-0.5 shrink-0" />
                  <span className="text-xs leading-relaxed">
                    Migrations can take a few minutes. You can safely close
                    this tab — we&apos;ll <b>email you as soon as it&apos;s done</b>.
                  </span>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="inline-qbo-migrate-confirm-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="inline-qbo-migrate-confirm-start"
              onClick={startMigration}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              Start migration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Post-start dialog — reassures the user the email is coming so
          they don't sit and watch the progress bar. */}
      <Dialog open={startedOpen} onOpenChange={setStartedOpen}>
        <DialogContent data-testid="inline-qbo-migrate-started-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail size={16} className="text-cyan-600" />
              We&apos;re migrating your QuickBooks data
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm text-slate-600 pt-1">
                <p>
                  Your import is running in the background — nothing to
                  babysit. As soon as it wraps up, we&apos;ll send you an
                  email with the final counts and a link back to your books.
                </p>
                <p className="text-xs text-slate-500">
                  You can close this tab or keep it open to watch progress —
                  either way works.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              data-testid="inline-qbo-migrate-started-ack"
              onClick={() => setStartedOpen(false)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-600 text-white text-sm hover:bg-cyan-700"
            >
              Got it
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
