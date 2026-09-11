/**
 * OverdueInvoicesTile
 *
 * Inline expandable content for the "Following up with invoices" row
 * on the Responsibilities panel. Mirrors the ReconciliationAccountsTile
 * layout — slate header + one row per overdue invoice with Number,
 * Customer, Due, Total, Balance, Status pill, and per-row actions
 * (Send reminder / Edit / Delete).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import {
  Loader2, RefreshCw, Pencil, Trash2, Send, ExternalLink, X, Plus, BellOff, BellRing, Undo2, CalendarClock, History,
} from "lucide-react";
import { AIFollowupModal } from "@/pages/Invoices";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";

const STATUS_TONES = {
  draft:      "bg-slate-100 text-slate-700 border-slate-200",
  sent:       "bg-blue-100 text-blue-800 border-blue-200",
  partial:    "bg-amber-100 text-amber-900 border-amber-200",
  overdue:    "bg-red-100 text-red-800 border-red-200",
  paid:       "bg-emerald-100 text-emerald-800 border-emerald-200",
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
};

export default function OverdueInvoicesTile({ companyId, returnPath, returnLabel }) {
  const fmtMoney = useMoneyFmt();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [snoozing, setSnoozing] = useState(null);
  const [unsnoozing, setUnsnoozing] = useState(null);
  const [viewMode, setViewMode] = useState("overdue"); // overdue | snoozed
  const [scheduleForInvoice, setScheduleForInvoice] = useState(null);
  const [showFollowupModal, setShowFollowupModal] = useState(false);

  const buildHref = (base) => {
    if (!base) return "#";
    if (!returnPath) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}return_to=${encodeURIComponent(returnPath)}&return_label=${encodeURIComponent(returnLabel || "")}`;
  };

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/responsibilities/overdue-invoices`);
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load overdue invoices.");
    } finally {
      setBusy(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const snoozeInvoice = async (inv, until, reason) => {
    setSnoozing(inv.id);
    try {
      await api.post(`/companies/${companyId}/invoices/${inv.id}/cockpit-snooze`, {
        until, reason: reason || null,
      });
      const readable = new Date(until).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      toast.success(`Snoozed ${inv.number} until ${readable}`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Snooze failed");
    } finally {
      setSnoozing(null);
    }
  };

  const unsnoozeInvoice = async (inv) => {
    setUnsnoozing(inv.id);
    try {
      await api.delete(`/companies/${companyId}/invoices/${inv.id}/cockpit-snooze`);
      toast.success(`${inv.number} is back on the cockpit`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Un-snooze failed");
    } finally {
      setUnsnoozing(null);
    }
  };

  const deleteInvoice = async (inv) => {
    if (!window.confirm(`Delete invoice ${inv.number}? This cannot be undone.`)) return;
    setDeleting(inv.id);
    try {
      await api.delete(`/companies/${companyId}/invoices/${inv.id}`);
      toast.success(`Deleted ${inv.number}`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    } finally {
      setDeleting(null);
    }
  };

  if (busy && !data) {
    return (
      <div className="rounded-lg border bg-white p-4 flex items-center justify-center text-slate-400" data-testid="overdue-invoices-tile-loading">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }
  const invoices = data?.invoices || [];
  const snoozedInvoices = data?.snoozed_invoices || [];
  const snoozedCount = data?.snoozed_count ?? 0;

  const snoozedChip = snoozedCount > 0 && viewMode === "overdue" && (
    <button
      onClick={() => setViewMode("snoozed")}
      className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
      data-testid="overdue-invoices-snoozed-chip"
    >
      <BellRing size={11} /> {snoozedCount} snoozed
    </button>
  );
  const overdueChip = viewMode === "snoozed" && (
    <button
      onClick={() => setViewMode("overdue")}
      className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
      data-testid="overdue-invoices-back-to-overdue"
    >
      <Undo2 size={11} /> {invoices.length} overdue
    </button>
  );

  const activeList = viewMode === "snoozed" ? snoozedInvoices : invoices;
  const emptyState = viewMode === "overdue" && invoices.length === 0;
  if (emptyState) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500 space-y-2" data-testid="overdue-invoices-tile-empty">
        <div>No invoices past due — <b className="text-slate-800">inbox zero</b>.</div>
        <div className="flex items-center justify-center gap-2">
          <Link
            to={buildHref(`/invoices/new`)}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-700"
            data-testid="overdue-invoices-tile-create-empty"
          >
            <Plus size={11} /> Create invoice
          </Link>
          {snoozedChip}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white overflow-hidden" data-testid="overdue-invoices-tile">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-slate-50 text-[11px] gap-2 flex-wrap">
        <div className="text-slate-600 flex items-center gap-2">
          {viewMode === "snoozed" ? (
            <span>Showing <b className="text-amber-800">snoozed</b> · {snoozedInvoices.length}</span>
          ) : (
            <span>Showing <b>overdue</b> · {invoices.length} of {data.total_open_count}</span>
          )}
          {snoozedChip}
          {overdueChip}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={buildHref(`/invoices/new`)}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-700"
            data-testid="overdue-invoices-tile-create"
          >
            <Plus size={11} /> Create invoice
          </Link>
          <Link
            to={buildHref(`/invoices?filter=overdue`)}
            className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            data-testid="overdue-invoices-tile-clear"
          >
            <X size={11} /> Clear filters
          </Link>
          <button
            onClick={load}
            disabled={busy}
            className="text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-40"
            data-testid="overdue-invoices-tile-refresh"
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-500 bg-white border-b">
              <th className="text-left px-3 py-2 font-semibold">Number</th>
              <th className="text-left px-3 py-2 font-semibold">Customer</th>
              <th className="text-left px-3 py-2 font-semibold">Due</th>
              <th className="text-right px-3 py-2 font-semibold">Total</th>
              <th className="text-right px-3 py-2 font-semibold">Balance</th>
              <th className="text-left px-3 py-2 font-semibold">Status</th>
              <th className="text-right px-3 py-2 font-semibold w-[110px]"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {activeList.map(inv => {
              const tone = STATUS_TONES[inv.status] || STATUS_TONES.sent;
              const isSnoozed = viewMode === "snoozed";
              return (
                <tr key={inv.id} className="hover:bg-slate-50" data-testid={`${isSnoozed ? "snoozed" : "overdue"}-invoice-row-${inv.id}`}>
                  <td className="px-3 py-2 font-mono-num">
                    <Link
                      to={buildHref(`/invoices/${inv.id}`)}
                      className="text-slate-900 hover:underline"
                    >
                      {inv.number}
                    </Link>
                    {isSnoozed && inv.snoozed_reason && (
                      <div className="text-[10px] text-slate-500 italic mt-0.5 non-mono-font truncate max-w-[180px]" title={inv.snoozed_reason}>
                        "{inv.snoozed_reason}"
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-900 truncate max-w-[220px]">{inv.customer_name}</td>
                  <td className="px-3 py-2 text-slate-600 font-mono-num">
                    {fmtDate(inv.due_date)}
                    {isSnoozed && inv.snoozed_until && (
                      <div className="text-[10px] text-amber-700 mt-0.5 non-mono-font">
                        reappears {fmtDate(inv.snoozed_until)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-num tabular-nums">{fmtMoney(inv.total)}</td>
                  <td className="px-3 py-2 text-right font-mono-num tabular-nums text-slate-900">{fmtMoney(inv.balance)}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border ${
                      isSnoozed ? "bg-amber-100 text-amber-900 border-amber-200" : tone
                    }`}>
                      {isSnoozed ? "snoozed" : inv.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {isSnoozed ? (
                      <button
                        onClick={() => unsnoozeInvoice(inv)}
                        disabled={unsnoozing === inv.id}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-50 disabled:opacity-40"
                        data-testid={`snoozed-invoice-unsnooze-${inv.id}`}
                      >
                        {unsnoozing === inv.id ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
                        Un-snooze
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => setShowFollowupModal(true)}
                          title="Draft AI follow-up email"
                          className="text-indigo-500 hover:text-indigo-700 p-1"
                          data-testid={`overdue-send-reminder-${inv.id}`}
                        >
                          <Send size={13} />
                        </button>
                        <button
                          onClick={() => setScheduleForInvoice(inv)}
                          title="Schedule auto follow-ups + view history"
                          className={`p-1 ${inv.followup_schedule?.enabled ? "text-emerald-600 hover:text-emerald-800" : "text-slate-500 hover:text-slate-800"}`}
                          data-testid={`overdue-schedule-${inv.id}`}
                        >
                          <CalendarClock size={13} />
                        </button>
                        <InvoiceSnoozePopover
                          invoice={inv}
                          busy={snoozing === inv.id}
                          onSnooze={(until, reason) => snoozeInvoice(inv, until, reason)}
                        />
                        <Link
                          to={buildHref(`/invoices/${inv.id}/edit`)}
                          title="Edit"
                          className="inline-flex text-slate-500 hover:text-slate-800 p-1"
                          data-testid={`overdue-edit-${inv.id}`}
                        >
                          <Pencil size={13} />
                        </Link>
                        <button
                          onClick={() => deleteInvoice(inv)}
                          disabled={deleting === inv.id}
                          title="Delete"
                          className="text-red-500 hover:text-red-700 p-1 disabled:opacity-40"
                          data-testid={`overdue-delete-${inv.id}`}
                        >
                          {deleting === inv.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 border-t bg-slate-50 text-right">
        <Link
          to={buildHref("/invoices?filter=overdue")}
          className="text-[11px] text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          data-testid="overdue-invoices-open-all"
        >
          Open in Invoices <ExternalLink size={10} />
        </Link>
      </div>
      {showFollowupModal && (
        <AIFollowupModal
          currentId={companyId}
          onClose={() => {
            setShowFollowupModal(false);
            load();
          }}
        />
      )}
      {scheduleForInvoice && (
        <FollowupScheduleModal
          companyId={companyId}
          invoice={scheduleForInvoice}
          onClose={() => {
            setScheduleForInvoice(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/**
 * InvoiceSnoozePopover — mirror of the bill snooze popover.
 */
function InvoiceSnoozePopover({ invoice, busy, onSnooze }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [reason, setReason] = useState("");
  const addDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const PRESETS = [
    { label: "1 day",   until: addDays(1) },
    { label: "3 days",  until: addDays(3) },
    { label: "1 week",  until: addDays(7) },
    { label: "2 weeks", until: addDays(14) },
    { label: "1 month", until: addDays(30) },
  ];
  const submit = (until) => {
    if (!until) return;
    onSnooze(until, reason.trim() || null);
    setOpen(false);
    setCustom("");
    setReason("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          title="Dismiss / snooze"
          className="inline-flex text-amber-600 hover:text-amber-800 p-1 disabled:opacity-40"
          disabled={busy}
          data-testid={`overdue-snooze-invoice-${invoice.id}`}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <BellOff size={13} />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Dismiss until</div>
          <div className="text-xs text-slate-600 mt-0.5">
            How long until <b>{invoice.number}</b> reappears in the cockpit + to-do?
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => submit(p.until)}
              className="text-[11px] px-2 py-1 rounded-full border border-slate-300 bg-white hover:bg-slate-100"
              data-testid={`invoice-snooze-preset-${p.label.replace(/\s/g, '-').toLowerCase()}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="pt-1 border-t space-y-1">
          <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Or pick a specific date</label>
          <input
            type="date"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            min={new Date().toISOString().slice(0, 10)}
            className="w-full text-xs border rounded px-2 py-1"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Reason (optional)</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. customer promised payment Friday"
            className="w-full text-xs border rounded px-2 py-1"
          />
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={() => { setOpen(false); setCustom(""); setReason(""); }}
            className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={() => submit(custom)}
            disabled={!custom}
            className="text-[11px] px-2 py-1 rounded bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Snooze
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * FollowupScheduleModal — schedule automated follow-ups for a single
 * invoice + toggle to view previously sent follow-ups.
 */
function FollowupScheduleModal({ companyId, invoice, onClose }) {
  const [tab, setTab] = useState("schedule"); // schedule | history
  const [enabled, setEnabled] = useState(false);
  const [steps, setSteps] = useState([]);           // [{ days_from_now, run_at?, sent_at? }]
  const [history, setHistory] = useState([]);
  const [autoUsed, setAutoUsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  // Inline "Add email now" state — keyed off the invoice's customer.
  const [customerEmail, setCustomerEmail] = useState(invoice.customer_email || "");
  const [emailDraft, setEmailDraft] = useState(invoice.customer_email || "");
  const [savingEmail, setSavingEmail] = useState(false);
  const hasCustomerEmail = !!(customerEmail && customerEmail.includes("@"));
  const canEditEmail = !!invoice.contact_id;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, h] = await Promise.all([
          api.get(`/companies/${companyId}/invoices/${invoice.id}/followup-schedule`),
          api.get(`/companies/${companyId}/invoices/${invoice.id}/followup-history`),
        ]);
        if (cancelled) return;
        const sch = s.data?.schedule || {};
        setEnabled(!!sch.enabled);
        setSteps(
          (sch.steps || []).map(x => ({
            days_from_now: Number(x.days_from_now || 0),
            run_at: x.run_at || null,
            sent_at: x.sent_at || null,
          })),
        );
        setAutoUsed(s.data?.auto_sends_used || 0);
        setHistory(h.data?.history || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, invoice.id]);

  const nextDefaultOffset = () => {
    // Suggest 7 days after the last step. First step defaults to 3.
    if (!steps.length) return 3;
    const last = Math.max(...steps.map(s => s.days_from_now || 0));
    return last + 7;
  };
  const addStep = () => {
    setSteps(prev => [...prev, { days_from_now: nextDefaultOffset() }]);
    // Auto-enable the toggle the moment the user schedules their first
    // follow-up — the toggle is really an on/off switch, not a gate.
    if (!enabled) setEnabled(true);
  };
  const removeStep = (idx) => setSteps(prev => prev.filter((_, i) => i !== idx));
  const setStepDays = (idx, v) =>
    setSteps(prev => prev.map((s, i) => i === idx ? { ...s, days_from_now: Math.max(0, Number(v || 0)) } : s));

  const nextPending = enabled
    ? [...steps]
        .map((s, i) => ({ ...s, i }))
        .filter(s => !s.sent_at)
        .sort((a, b) => a.days_from_now - b.days_from_now)[0]
    : null;

  const previewDate = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + Math.max(0, Number(offsetDays || 0)));
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const save = async () => {
    if (enabled && steps.length > 0 && !hasCustomerEmail) {
      toast.error("Add a customer email before saving the schedule.");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/invoices/${invoice.id}/followup-schedule`, {
        enabled,
        steps: steps.map(s => ({ days_from_now: Math.max(0, Number(s.days_from_now || 0)) })),
      });
      toast.success(enabled ? "Auto follow-ups enabled" : "Auto follow-ups paused");
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveCustomerEmail = async () => {
    const clean = (emailDraft || "").trim();
    if (!clean || !clean.includes("@")) {
      toast.error("Enter a valid email address");
      return;
    }
    if (!invoice.contact_id) {
      toast.error("This invoice has no linked customer. Edit the invoice to attach one.");
      return;
    }
    setSavingEmail(true);
    try {
      await api.patch(`/companies/${companyId}/contacts/${invoice.contact_id}`, { email: clean });
      setCustomerEmail(clean);
      toast.success(`Saved email for ${invoice.customer_name}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save email");
    } finally {
      setSavingEmail(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" data-testid="followup-schedule-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock size={16} className="text-indigo-600" />
            Follow-up schedule · <span className="font-mono-num">{invoice.number}</span>
          </DialogTitle>
          <DialogDescription>
            Automate chase emails to <b>{invoice.customer_name}</b> and review everything already sent.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1 border-b -mx-6 px-6 pb-0">
          <button
            onClick={() => setTab("schedule")}
            className={`text-xs px-3 py-1.5 border-b-2 ${tab === "schedule" ? "border-indigo-500 text-slate-900 font-semibold" : "border-transparent text-slate-500 hover:text-slate-700"}`}
            data-testid="followup-tab-schedule"
          >
            Schedule
          </button>
          <button
            onClick={() => setTab("history")}
            className={`text-xs px-3 py-1.5 border-b-2 inline-flex items-center gap-1 ${tab === "history" ? "border-indigo-500 text-slate-900 font-semibold" : "border-transparent text-slate-500 hover:text-slate-700"}`}
            data-testid="followup-tab-history"
          >
            <History size={11} /> Previous follow-ups
            <span className="text-[10px] font-mono-num px-1 rounded bg-slate-100 text-slate-700 font-semibold">
              {history.length}
            </span>
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-slate-400">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : tab === "schedule" ? (
          <div className="space-y-3">
            {!hasCustomerEmail && (
              <div
                className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2"
                data-testid="followup-missing-email-banner"
              >
                <div className="text-xs text-amber-900">
                  <b>{invoice.customer_name}</b> has no email on file. Add one below so
                  auto follow-ups can actually send — otherwise saving is blocked.
                </div>
                {canEditEmail ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="email"
                      value={emailDraft}
                      onChange={(e) => setEmailDraft(e.target.value)}
                      placeholder="customer@example.com"
                      className="flex-1 border rounded px-2 py-1 text-sm font-mono-num"
                      data-testid="followup-add-email-input"
                    />
                    <button
                      onClick={saveCustomerEmail}
                      disabled={savingEmail || !emailDraft.trim() || !emailDraft.includes("@")}
                      className="text-[11px] px-2 py-1 rounded bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-40 inline-flex items-center gap-1"
                      data-testid="followup-add-email-save"
                    >
                      {savingEmail ? <Loader2 size={11} className="animate-spin" /> : null}
                      Save to customer
                    </button>
                  </div>
                ) : (
                  <div className="text-[11px] text-amber-800 italic">
                    This invoice has no linked customer record. Edit the invoice to
                    attach one, then come back here.
                  </div>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 accent-indigo-600"
                data-testid="followup-schedule-enabled"
              />
              Send automatic AI follow-ups
            </label>

            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                Scheduled follow-ups
              </div>
              {steps.length === 0 && (
                <div className="text-xs text-slate-500 italic">
                  Add a follow-up below to schedule the first send.
                </div>
              )}
              <ul className="space-y-1.5">
                {steps.map((s, idx) => (
                  <li key={idx} className="flex items-center gap-2" data-testid={`followup-step-${idx}`}>
                    <span className="text-xs text-slate-500 shrink-0 w-4 text-right font-mono-num">
                      {idx + 1}.
                    </span>
                    <span className="text-xs text-slate-600 shrink-0">In</span>
                    <input
                      type="number"
                      min={0}
                      max={365}
                      disabled={!!s.sent_at}
                      value={s.days_from_now}
                      onChange={(e) => setStepDays(idx, e.target.value)}
                      className="w-16 border rounded px-2 py-1 text-sm font-mono-num disabled:bg-slate-50"
                      data-testid={`followup-step-days-${idx}`}
                    />
                    <span className="text-xs text-slate-600 shrink-0">days</span>
                    <span className="text-[11px] text-slate-500 flex-1 truncate">
                      → {previewDate(s.days_from_now)}
                    </span>
                    {s.sent_at ? (
                      <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border bg-emerald-50 border-emerald-200 text-emerald-800">
                        sent
                      </span>
                    ) : (
                      <button
                        onClick={() => removeStep(idx)}
                        title="Remove"
                        className="text-slate-400 hover:text-red-600 p-1"
                        data-testid={`followup-step-remove-${idx}`}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <button
                onClick={addStep}
                className="text-[11px] px-2 py-1 rounded border border-dashed border-slate-300 hover:border-slate-500 hover:bg-slate-50 inline-flex items-center gap-1"
                data-testid="followup-step-add"
              >
                <Plus size={11} /> Add follow-up
              </button>
            </div>

            <div className="rounded-md bg-slate-50 border p-2 text-[11px] text-slate-600 space-y-0.5">
              <div>
                Auto sends used: <b className="font-mono-num text-slate-900">{autoUsed}</b>
                <span className="mx-1.5 text-slate-300">·</span>
                Scheduled: <b className="font-mono-num text-slate-900">{steps.filter(s => !s.sent_at).length}</b>
              </div>
              <div>
                Next auto send:{" "}
                <b>
                  {enabled
                    ? nextPending
                        ? previewDate(nextPending.days_from_now)
                        : "None scheduled yet"
                    : "Paused"}
                </b>
              </div>
              <div className="text-slate-400">Follows the same firm-connected inbox as manual sends.</div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2 border-t">
              <button
                onClick={onClose}
                className="text-xs px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving || (enabled && steps.length > 0 && !hasCustomerEmail)}
                title={enabled && steps.length > 0 && !hasCustomerEmail ? "Add a customer email above to enable saving" : ""}
                className="text-xs px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-500 inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="followup-schedule-save"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : null}
                Save schedule
              </button>
            </div>
          </div>
        ) : (
          <div className="max-h-[380px] overflow-y-auto">
            {history.length === 0 ? (
              <div className="text-center py-8 text-sm text-slate-500">
                No follow-ups sent yet.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {history.map((h, idx) => (
                  <li key={idx} className="py-2" data-testid={`followup-history-row-${idx}`}>
                    <div className="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
                      <span className="font-mono-num">{h.sent_at ? new Date(h.sent_at).toLocaleString() : "—"}</span>
                      {h.origin && (
                        <span className={`text-[9px] uppercase px-1.5 rounded border ${
                          h.origin === "auto" || h.origin === "schedule"
                            ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                            : "bg-slate-50 border-slate-200 text-slate-600"
                        }`}>
                          {h.origin === "auto" || h.origin === "schedule" ? "auto" : "manual"}
                        </span>
                      )}
                      {h.to_email && <span className="text-slate-600">to <span className="font-mono-num">{h.to_email}</span></span>}
                    </div>
                    {h.subject && <div className="text-sm text-slate-900 mt-0.5">{h.subject}</div>}
                    {h.body && <div className="text-[11px] text-slate-500 mt-0.5 whitespace-pre-line line-clamp-3">{h.body}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
