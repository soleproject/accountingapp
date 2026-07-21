import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useCompany } from "@/lib/company";
import {
  CheckCircle2, Circle, ChevronLeft, ChevronRight, Lock, LayoutGrid,
  CalendarCheck, ListChecks, FileText, Receipt, Banknote, Loader2,
} from "lucide-react";

// Month Close — 5-item close-out checklist per calendar month.
// Two views: "This month" (detail with per-checkpoint actions) and
// "12 months" (grid overview with red / green pills).

const CHECKPOINTS = [
  { key: "txns_reviewed", label: "All Transactions Reviewed", icon: ListChecks, auto: true },
  { key: "invoices",      label: "Outstanding Invoices Reviewed & signed off", icon: FileText },
  { key: "bills",         label: "Outstanding Bills Reviewed & signed off",     icon: Receipt },
  { key: "recon",         label: "Reconciliation Complete",                     icon: Banknote },
  { key: "closed",        label: "Closed",                                       icon: Lock },
];

function monthLabel(y, m) {
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}
function currentYm() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}
function shiftYm(y, m, delta) {
  const d = new Date(y, m - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}
function ymKey(y, m) { return `${y}-${String(m).padStart(2, "0")}`; }

export default function MonthClose() {
  const { currentId } = useCompany();
  const [view, setView] = useState("detail"); // "detail" | "list"
  const [cursor, setCursor] = useState(currentYm()); // { year, month }
  const [monthData, setMonthData] = useState(null);
  const [monthsList, setMonthsList] = useState([]);
  const [busy, setBusy] = useState(false);

  const loadDetail = async (ym) => {
    if (!currentId) return;
    try {
      const r = await api.get(`/companies/${currentId}/month-close/${ymKey(ym.year, ym.month)}`);
      setMonthData(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load month");
    }
  };
  const loadList = async () => {
    if (!currentId) return;
    try {
      const r = await api.get(`/companies/${currentId}/month-close/months?count=12`);
      setMonthsList(r.data.months || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load months");
    }
  };
  useEffect(() => { if (view === "detail") loadDetail(cursor); }, [cursor, currentId, view]);
  useEffect(() => { if (view === "list") loadList(); }, [view, currentId]);

  const sign = async (kind, signed) => {
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/month-close/${ymKey(cursor.year, cursor.month)}/checkpoint`,
        { kind, signed },
      );
      setMonthData(r.data);
      toast.success(signed
        ? `${kind === "closed" ? "Month closed" : "Signed off"}.`
        : "Un-signed.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  if (!currentId) return <div className="p-6 text-sm text-slate-500">Select a company.</div>;

  return (
    <div className="space-y-4" data-testid="month-close-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <CalendarCheck size={24} className="text-slate-500" /> Month Close
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Five checkpoints per month. Sign each off before locking the period.
          </p>
        </div>
        <div className="inline-flex rounded-lg border bg-slate-50 p-1" data-testid="month-close-view-toggle">
          <button
            onClick={() => setView("detail")}
            className={`px-3 py-1.5 text-xs rounded-md transition inline-flex items-center gap-1.5 ${
              view === "detail" ? "bg-white shadow-sm text-slate-900" : "text-slate-600"
            }`}
            data-testid="month-close-view-detail"
          >
            <CalendarCheck size={13} /> This month
          </button>
          <button
            onClick={() => setView("list")}
            className={`px-3 py-1.5 text-xs rounded-md transition inline-flex items-center gap-1.5 ${
              view === "list" ? "bg-white shadow-sm text-slate-900" : "text-slate-600"
            }`}
            data-testid="month-close-view-list"
          >
            <LayoutGrid size={13} /> 12 months
          </button>
        </div>
      </div>

      {view === "detail" ? (
        <DetailView
          cursor={cursor}
          setCursor={setCursor}
          data={monthData}
          onSign={sign}
          busy={busy}
        />
      ) : (
        <ListView
          months={monthsList}
          onPickMonth={(y, m) => { setCursor({ year: y, month: m }); setView("detail"); }}
        />
      )}
    </div>
  );
}

function DetailView({ cursor, setCursor, data, onSign, busy }) {
  const isFuture = useMemo(() => {
    const c = currentYm();
    return cursor.year > c.year || (cursor.year === c.year && cursor.month > c.month);
  }, [cursor]);

  return (
    <>
      {/* Month navigator */}
      <div className="flex items-center gap-2 rounded-xl border bg-white px-3 py-2" data-testid="month-close-navigator">
        <button
          onClick={() => setCursor(shiftYm(cursor.year, cursor.month, -1))}
          className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-slate-100"
          aria-label="Previous month"
          data-testid="month-close-prev"
        >
          <ChevronLeft size={16} className="text-slate-600" />
        </button>
        <div className="flex-1 text-center">
          <div className="font-heading font-semibold text-lg" data-testid="month-close-title">
            {monthLabel(cursor.year, cursor.month)}
          </div>
          {data?.period_start && (
            <div className="text-[11px] text-slate-500 font-mono-num">
              {data.period_start} → {data.period_end}
            </div>
          )}
        </div>
        <button
          onClick={() => setCursor(shiftYm(cursor.year, cursor.month, 1))}
          disabled={isFuture}
          className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-slate-100 disabled:opacity-30"
          aria-label="Next month"
          data-testid="month-close-next"
        >
          <ChevronRight size={16} className="text-slate-600" />
        </button>
        <button
          onClick={() => setCursor(currentYm())}
          className="text-xs px-2 py-1 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          data-testid="month-close-today"
        >
          Today
        </button>
      </div>

      {/* Checklist */}
      <div className="rounded-xl border bg-white overflow-hidden">
        {CHECKPOINTS.map((cp, idx) => {
          const c = data?.checkpoints?.[cp.key];
          return (
            <CheckpointRow
              key={cp.key}
              meta={cp}
              c={c}
              onSign={onSign}
              busy={busy}
              divider={idx > 0}
              cursorMonth={cursor}
            />
          );
        })}
      </div>
    </>
  );
}

function CheckpointRow({ meta, c, onSign, busy, divider, cursorMonth }) {
  const Icon = meta.icon;
  const green = Boolean(c?.green);
  // A row is auto-driven either statically (Txns Reviewed) or dynamically
  // when the server says nothing needs a signoff (e.g. 0 outstanding
  // invoices/bills for the month). Closed is always manual.
  const isAuto = (meta.auto || Boolean(c?.auto)) && meta.key !== "closed";
  const canToggle = !isAuto;

  // Contextual status text per checkpoint — clickable link where possible
  // so the pro can jump straight to what needs review.
  let statusEl = null;
  if (meta.key === "txns_reviewed") {
    if (!c) statusEl = null;
    else if (c.total === 0) statusEl = <em className="text-slate-400 text-xs">No transactions this month.</em>;
    else if (green) statusEl = <span className="text-xs text-emerald-700">{c.total} transactions, all categorized & reviewed.</span>;
    else statusEl = (
      <span className="text-xs text-slate-600">
        {c.uncategorized > 0 && (
          <>
            <Link to={`/accounting/transactions?status=uncategorized`} className="text-cyan-700 hover:underline">
              {c.uncategorized} uncategorized
            </Link>
            {c.unreviewed > 0 && " · "}
          </>
        )}
        {c.unreviewed > 0 && (
          <Link to={`/accounting/transactions?status=unapproved`} className="text-cyan-700 hover:underline">
            {c.unreviewed} unreviewed
          </Link>
        )}
      </span>
    );
  } else if (meta.key === "invoices") {
    statusEl = <Link to="/invoices" className="text-xs text-cyan-700 hover:underline">{c?.outstanding ?? 0} outstanding invoices</Link>;
  } else if (meta.key === "bills") {
    statusEl = <Link to="/bills" className="text-xs text-cyan-700 hover:underline">{c?.outstanding ?? 0} outstanding bills</Link>;
  } else if (meta.key === "recon") {
    statusEl = <Link to="/accounting/reconciliation" className="text-xs text-cyan-700 hover:underline">Open reconciliation</Link>;
  }

  return (
    <div className={`px-4 py-4 flex items-start gap-4 ${divider ? "border-t" : ""}`} data-testid={`month-close-cp-${meta.key}`}>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
        green ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
      }`}>
        <Icon size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm text-slate-900">{meta.label}</span>
          {isAuto && (
            <span className="text-[10px] uppercase tracking-widest text-slate-400 border rounded px-1.5 py-0.5">
              auto
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 flex-wrap">
          {statusEl}
          {c?.signed_at && (
            <span className="text-[11px] text-slate-500">
              signed by {c.signed_by} · {new Date(c.signed_at).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0">
        {green ? (
          canToggle ? (
            <button
              onClick={() => onSign(meta.key, false)}
              disabled={busy}
              data-testid={`month-close-unsign-${meta.key}`}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50"
            >
              <CheckCircle2 size={13} /> Signed
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-emerald-700 bg-emerald-50 border border-emerald-200">
              <CheckCircle2 size={13} /> Auto
            </span>
          )
        ) : canToggle ? (
          <button
            onClick={() => onSign(meta.key, true)}
            disabled={busy || (meta.key === "closed" && !allPrereqsMet(c, cursorMonth))}
            data-testid={`month-close-sign-${meta.key}`}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Circle size={13} />}
            {meta.key === "closed" ? "Close month" : "Sign off"}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-slate-500 bg-slate-50 border">
            <Circle size={13} /> Pending
          </span>
        )}
      </div>
    </div>
  );
}

// Whether the "Close month" button is enabled. We can't check other rows'
// state from this row alone, so the backend enforces the same rule; this
// just prevents an obviously-unclosable button from being clickable.
function allPrereqsMet(closedRow /* not enough info here */, _cursor) {
  // Optimistic: let user try. Backend returns 409 with the specific missing
  // checkpoint if the click was wrong; that's a nicer error than a grayed-out
  // button with no explanation.
  return true;
}

function ListView({ months, onPickMonth }) {
  if (!months || months.length === 0) {
    return (
      <div className="rounded-xl border bg-white p-6 text-sm text-slate-500">Loading…</div>
    );
  }
  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="month-close-list">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
          <tr>
            <th className="px-4 py-2 text-left">Month</th>
            {CHECKPOINTS.map(cp => (
              <th key={cp.key} className="px-2 py-2 text-center whitespace-nowrap" title={cp.label}>
                <span className="inline-flex items-center gap-1">
                  <cp.icon size={11} /> {shortLabel(cp.key)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map(m => {
            const closed = m.checkpoints.closed.green;
            return (
              <tr key={`${m.year}-${m.month}`} className={`border-b hover:bg-slate-50 cursor-pointer ${closed ? "" : ""}`}
                  onClick={() => onPickMonth(m.year, m.month)}
                  data-testid={`month-close-row-${m.year}-${m.month}`}>
                <td className="px-4 py-2 font-medium">
                  {monthLabel(m.year, m.month)}
                  {closed && <Lock size={11} className="inline ml-2 text-emerald-600" />}
                </td>
                {CHECKPOINTS.map(cp => {
                  const c = m.checkpoints[cp.key];
                  const g = Boolean(c?.green);
                  return (
                    <td key={cp.key} className="px-2 py-2 text-center">
                      <span
                        className={`inline-block w-4 h-4 rounded-full ${g ? "bg-emerald-500" : "bg-red-500"}`}
                        title={g ? "Signed" : "Open"}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function shortLabel(key) {
  return {
    txns_reviewed: "Txns",
    invoices: "Inv",
    bills: "Bills",
    recon: "Recon",
    closed: "Closed",
  }[key] || key;
}
