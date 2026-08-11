import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  Loader2, RefreshCw, AlertTriangle, CheckCircle2, Ban,
  XCircle, Info, ChevronRight, ChevronDown, Copy,
} from "lucide-react";

/**
 * Superadmin — Stripe Webhook Diagnostics.
 *
 * Surfaces every Stripe webhook we've received alongside its OUTCOME
 * (user_created / user_existing / bailed_no_email / handler_exception).
 * Purpose: when a signup doesn't create a user (as happened for CypherPro
 * after the operator changed the Payment Link products), one glance at
 * this table shows exactly why — and what Stripe Dashboard toggle to fix.
 *
 * Endpoint: GET /api/admin/stripe/webhook-events
 */

const STATUS_META = {
  user_created:      { label: "User created",        cls: "bg-emerald-50 border-emerald-200 text-emerald-800", icon: CheckCircle2 },
  user_existing:     { label: "User existed",        cls: "bg-slate-50 border-slate-200 text-slate-700",       icon: Info },
  bailed_no_email:   { label: "Bailed — no email",   cls: "bg-rose-50 border-rose-300 text-rose-800",           icon: Ban },
  handler_exception: { label: "Handler crashed",     cls: "bg-amber-50 border-amber-300 text-amber-800",        icon: AlertTriangle },
  ignored_event_type:{ label: "Ignored",             cls: "bg-slate-50 border-slate-200 text-slate-500",        icon: XCircle },
  pending:           { label: "Pending",             cls: "bg-blue-50 border-blue-200 text-blue-700",           icon: Loader2 },
};

const EVENT_TYPES = [
  { key: "",                                label: "All events" },
  { key: "checkout.session.completed",      label: "checkout.session.completed" },
  { key: "invoice.paid",                    label: "invoice.paid" },
  { key: "invoice.payment_failed",          label: "invoice.payment_failed" },
  { key: "customer.subscription.updated",   label: "customer.subscription.updated" },
  { key: "customer.subscription.deleted",   label: "customer.subscription.deleted" },
];

const OUTCOMES = [
  { key: "", label: "All outcomes" },
  { key: "user_created",       label: "user_created" },
  { key: "user_existing",      label: "user_existing" },
  { key: "bailed_no_email",    label: "bailed_no_email" },
  { key: "handler_exception",  label: "handler_exception" },
];

function fmtWhen(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}

function OutcomeBadge({ status }) {
  const meta = STATUS_META[status] || { label: status || "unknown", cls: "bg-slate-100 border-slate-200 text-slate-700", icon: Info };
  const Icon = meta.icon;
  return (
    <span
      data-testid={`webhook-outcome-badge-${status || "unknown"}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.cls}`}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

function EventRow({ row }) {
  const [open, setOpen] = useState(false);
  const outcome = row.outcome || {};
  const snap = row.payload_snapshot || {};
  const email =
    snap.customer_details?.email
    || snap.customer_email
    || outcome.email
    || "—";
  const brand = outcome.brand || snap.metadata?.brand || "smartbooks";
  return (
    <>
      <tr className="border-t border-slate-200 hover:bg-slate-50">
        <td className="py-2 pl-3 pr-2 align-top">
          <button
            data-testid={`webhook-row-expand-${row.id}`}
            onClick={() => setOpen((v) => !v)}
            className="text-slate-500 hover:text-slate-800"
            aria-label={open ? "collapse" : "expand"}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </td>
        <td className="py-2 pr-3 align-top text-xs text-slate-500 whitespace-nowrap">
          {fmtWhen(row.received_at)}
        </td>
        <td className="py-2 pr-3 align-top text-sm text-slate-800 whitespace-nowrap">
          {row.type}
        </td>
        <td className="py-2 pr-3 align-top">
          <OutcomeBadge status={outcome.status} />
        </td>
        <td className="py-2 pr-3 align-top">
          <span
            data-testid={`webhook-brand-${brand}`}
            className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
              brand === "smartbooks"
                ? "bg-slate-100 text-slate-700"
                : "bg-indigo-50 text-indigo-800 border border-indigo-200"
            }`}
          >
            {brand}
          </span>
        </td>
        <td className="py-2 pr-3 align-top text-sm text-slate-800">
          {email}
        </td>
        <td className="py-2 pr-3 align-top text-xs text-slate-500 font-mono">
          {snap.id || row.id}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-slate-100 bg-slate-50">
          <td colSpan={7} className="p-3">
            {outcome.hint && (
              <div className="mb-3 flex gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
                <AlertTriangle className="h-5 w-5 flex-none text-rose-600" />
                <div>
                  <div className="font-semibold">How to fix</div>
                  <div className="mt-1">{outcome.hint}</div>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Outcome
                </div>
                <pre className="max-h-64 overflow-auto rounded bg-white p-3 text-xs text-slate-800 border border-slate-200">
{JSON.stringify(outcome, null, 2)}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Payload snapshot
                </div>
                <pre className="max-h-64 overflow-auto rounded bg-white p-3 text-xs text-slate-800 border border-slate-200">
{JSON.stringify(snap, null, 2)}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function SuperadminStripeWebhooks() {
  const [rows, setRows] = useState([]);
  const [breakdown, setBreakdown] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [eventType, setEventType] = useState("");
  const [outcomeStatus, setOutcomeStatus] = useState("");
  const [limit] = useState(50);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const { data } = await api.get("/admin/stripe/webhook-events", {
        params: {
          limit,
          event_type: eventType || undefined,
          outcome_status: outcomeStatus || undefined,
        },
      });
      setRows(data.events || []);
      setBreakdown(data.recent_outcome_breakdown || {});
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [eventType, outcomeStatus]);

  const badRecent = (breakdown.bailed_no_email || 0) + (breakdown.handler_exception || 0);

  return (
    <div data-testid="superadmin-stripe-webhooks-page" className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Stripe Webhook Diagnostics</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every Stripe webhook we've received, with the real outcome — so you can see instantly
            why a signup didn't create a user.
          </p>
        </div>
        <button
          data-testid="webhook-refresh-btn"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      {/* Outcome breakdown across last 200 events */}
      <div data-testid="webhook-breakdown" className="mb-4 flex flex-wrap gap-2">
        {Object.entries(breakdown).length === 0 && !loading && (
          <div className="text-sm text-slate-500">No webhook events on record yet.</div>
        )}
        {Object.entries(breakdown).map(([k, v]) => (
          <button
            key={k}
            onClick={() => setOutcomeStatus(k === outcomeStatus ? "" : k)}
            data-testid={`webhook-breakdown-chip-${k}`}
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-medium transition ${
              outcomeStatus === k
                ? "bg-indigo-50 border-indigo-300 text-indigo-800"
                : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            <OutcomeBadge status={k} />
            <span className="text-slate-500">×</span>
            <span className="font-mono">{v}</span>
          </button>
        ))}
      </div>

      {/* Callout when there are recent failures */}
      {badRecent > 0 && !outcomeStatus && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          <AlertTriangle className="h-5 w-5 flex-none text-rose-600" />
          <div>
            <div className="font-semibold">
              {badRecent} recent event{badRecent === 1 ? "" : "s"} did not create a user.
            </div>
            <div className="mt-1">
              Click the <span className="font-medium">bailed_no_email</span> or{" "}
              <span className="font-medium">handler_exception</span> chip above to see them,
              then expand a row to read the fix instructions.
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-3 flex flex-wrap gap-2">
        <select
          data-testid="webhook-filter-event-type"
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800"
        >
          {EVENT_TYPES.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        <select
          data-testid="webhook-filter-outcome"
          value={outcomeStatus}
          onChange={(e) => setOutcomeStatus(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800"
        >
          {OUTCOMES.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        {(eventType || outcomeStatus) && (
          <button
            data-testid="webhook-filter-clear"
            onClick={() => { setEventType(""); setOutcomeStatus(""); }}
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            Clear filters
          </button>
        )}
      </div>

      {err && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {err}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pl-3 pr-2 w-6"></th>
              <th className="py-2 pr-3">Received</th>
              <th className="py-2 pr-3">Event type</th>
              <th className="py-2 pr-3">Outcome</th>
              <th className="py-2 pr-3">Brand</th>
              <th className="py-2 pr-3">Payer email</th>
              <th className="py-2 pr-3">Session/event id</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-sm text-slate-500">
                <Loader2 className="mx-auto h-5 w-5 animate-spin" />
              </td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-sm text-slate-500">
                No webhook events match these filters yet.
              </td></tr>
            )}
            {rows.map((r) => <EventRow key={r.id} row={r} />)}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Showing the {rows.length} most recent event{rows.length === 1 ? "" : "s"}
        {(eventType || outcomeStatus) ? " matching your filters" : ""}. Breakdown chips summarize the last 200.
      </p>
    </div>
  );
}
