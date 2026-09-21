/**
 * Compliance — IRS Documentation library.
 *
 * Consolidates every compliance-relevant finding on the current
 * company into a single browsable hub grouped by IRS category:
 *   * Meals & Entertainment (§274)          — LIVE via meals_compliance
 *   * Travel (§274)                          — placeholder
 *   * Vehicle & Mileage (§274d)              — placeholder
 *   * Business Gifts (§274b)                 — placeholder
 *   * Charitable Contributions ≥ $250 (§170) — placeholder
 *
 * Each entry shows the underlying transaction, the client's answer
 * (from the batch review), any receipt attachments, and a status pill
 * (documented / awaiting client / receipt required).
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import {
  Loader2, ShieldCheck, Utensils, Plane, Car, Gift, HeartHandshake,
  Paperclip, Clock, CheckCircle2, AlertTriangle, ChevronRight,
} from "lucide-react";

const CATEGORY_META = {
  meals:      { icon: Utensils,      color: "amber",   label: "Meals & Entertainment",  code: "§274", tag: "MEAL" },
  travel:     { icon: Plane,         color: "sky",     label: "Travel",                 code: "§274", tag: "TRAVEL" },
  vehicle:    { icon: Car,           color: "indigo",  label: "Vehicle & Mileage",      code: "§274d", tag: "MILES" },
  gifts:      { icon: Gift,          color: "rose",    label: "Business Gifts",         code: "§274b · $25 cap/recipient/yr", tag: "GIFT" },
  charitable: { icon: HeartHandshake,color: "emerald", label: "Charitable ≥ $250",      code: "§170", tag: "GIVE" },
};

const CATEGORY_ORDER = ["meals", "travel", "vehicle", "gifts", "charitable"];

function StatusChip({ entry }) {
  // Answered ⇒ documented. Deferred ⇒ awaiting bookkeeper. Otherwise pending.
  if (entry.answer) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200">
        <CheckCircle2 className="h-3 w-3" /> Documented
      </span>
    );
  }
  if (entry.deferred) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-slate-100 text-slate-700 ring-1 ring-slate-300">
        <Clock className="h-3 w-3" /> Bookkeeper
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-amber-50 text-amber-800 ring-1 ring-amber-200">
      <AlertTriangle className="h-3 w-3" /> Pending client
    </span>
  );
}

function EntryRow({ entry, moneyFmt }) {
  const [expanded, setExpanded] = useState(false);
  const amount = Math.abs(Number(entry.txn_amount || 0));
  const merchant = entry.merchant || entry.txn?.merchant || "—";
  const date = entry.txn_date || entry.txn?.date || "";

  return (
    <li
      className="rounded-lg ring-1 ring-slate-200 hover:ring-slate-300 transition-all bg-white"
      data-testid={`compliance-entry-${entry.id}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center gap-3"
      >
        <ChevronRight
          className={`h-4 w-4 text-slate-400 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-slate-900 truncate">{merchant}</span>
            <span className="text-slate-500 text-sm">{date}</span>
            {(entry.attachments || []).length > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                <Paperclip className="h-3 w-3" /> {(entry.attachments || []).length}
              </span>
            )}
          </div>
          <div className="text-sm text-slate-600 line-clamp-1">
            {entry.title || entry.detail}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="font-mono-num tabular-nums text-slate-900 font-semibold">
            {moneyFmt(amount)}
          </div>
          <StatusChip entry={entry} />
        </div>
      </button>
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-3 space-y-3 bg-slate-50/50">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              AI prompt
            </div>
            <div className="text-sm text-slate-700 whitespace-pre-wrap">
              {entry.detail || entry.title}
            </div>
          </div>
          {entry.txn?.description && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Bank descriptor
              </div>
              <div className="text-sm text-slate-700 font-mono-num">
                {entry.txn.description}
              </div>
            </div>
          )}
          {entry.substantiation && Object.keys(entry.substantiation).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-indigo-700 font-semibold mb-1">
                Substantiation
              </div>
              <div className="text-sm bg-white p-3 rounded ring-1 ring-indigo-200 space-y-1.5" data-testid={`compliance-substantiation-${entry.id}`}>
                {entry.substantiation.business_purpose && (
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mr-2">Purpose</span>
                    <span className="text-slate-900">{entry.substantiation.business_purpose}</span>
                  </div>
                )}
                {entry.substantiation.attendees && (
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mr-2">Attendees</span>
                    <span className="text-slate-900">{entry.substantiation.attendees}</span>
                  </div>
                )}
                {entry.substantiation.destination && (
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mr-2">Destination</span>
                    <span className="text-slate-900">{entry.substantiation.destination}</span>
                  </div>
                )}
                {(entry.substantiation.trip_start || entry.substantiation.trip_end) && (
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mr-2">Trip</span>
                    <span className="text-slate-900 font-mono-num">
                      {entry.substantiation.trip_start || "?"} → {entry.substantiation.trip_end || "?"}
                    </span>
                  </div>
                )}
                {entry.answered_by_pro && entry.answered_by_email && (
                  <div className="pt-1 mt-1 border-t border-indigo-100 text-[11px] text-slate-500">
                    Recorded by {entry.answered_by_email}
                  </div>
                )}
              </div>
            </div>
          )}
          {entry.answer && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-semibold mb-1">
                Client answer · {entry.answered_at?.slice(0, 10)}
              </div>
              <div className="text-sm text-slate-800 whitespace-pre-wrap bg-white p-2 rounded ring-1 ring-emerald-200">
                {entry.answer}
              </div>
            </div>
          )}
          {(entry.attachments || []).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Receipts on file
              </div>
              <div className="flex flex-wrap gap-2">
                {(entry.attachments || []).map((a) => (
                  <a
                    key={a.id || a.name}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded ring-1 ring-slate-300 bg-white hover:ring-slate-400 text-slate-700"
                  >
                    <Paperclip className="h-3 w-3" /> {a.name || "receipt"}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function CategorySection({ catKey, bucket, moneyFmt }) {
  const meta = CATEGORY_META[catKey];
  const Icon = meta.icon;
  const [open, setOpen] = useState(catKey === "meals");
  const entries = bucket?.entries || [];
  const implemented = bucket?.implemented;
  const answered = entries.filter((e) => !!e.answer).length;
  const pending = entries.filter((e) => !e.answer && !e.deferred).length;

  return (
    <section
      className={`rounded-xl ring-1 bg-white transition-all ${
        open ? `ring-${meta.color}-300 shadow-sm` : "ring-slate-200"
      }`}
      data-testid={`compliance-category-${catKey}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-5 py-4 flex items-center gap-4"
      >
        <div className={`h-10 w-10 rounded-lg bg-${meta.color}-50 flex items-center justify-center ring-1 ring-${meta.color}-200`}>
          <Icon className={`h-5 w-5 text-${meta.color}-700`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-slate-900">{meta.label}</h3>
            <span className="text-xs text-slate-500 font-mono-num">{meta.code}</span>
          </div>
          <div className="text-sm text-slate-500 mt-0.5">
            {!implemented ? (
              <span className="italic">Coming soon — auto-detection in progress</span>
            ) : entries.length === 0 ? (
              <span>No entries yet — the AI will surface them as they come in</span>
            ) : (
              <span>
                {entries.length} entr{entries.length === 1 ? "y" : "ies"} · {answered} documented · {pending} pending
              </span>
            )}
          </div>
        </div>
        <ChevronRight className={`h-5 w-5 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-slate-100 px-5 py-4">
          {!implemented && entries.length === 0 ? (
            <div className="rounded-lg bg-slate-50 border border-dashed border-slate-300 px-4 py-8 text-center">
              <Icon className={`h-10 w-10 text-${meta.color}-300 mx-auto mb-2`} />
              <div className="text-sm font-medium text-slate-700 mb-1">
                {meta.label} detector coming soon
              </div>
              <div className="text-xs text-slate-500 max-w-md mx-auto">
                Once shipped, this section will list every {meta.label.toLowerCase()} transaction
                the AI detects with the IRS-required documentation captured per {meta.code}.
              </div>
            </div>
          ) : entries.length === 0 ? (
            <div className="text-sm text-slate-500 text-center py-6">
              Nothing to review — you're all caught up on {meta.label.toLowerCase()}.
            </div>
          ) : (
            <ul className="space-y-2">
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} moneyFmt={moneyFmt} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export default function CompliancePage() {
  const { currentId } = useCompany();
  const moneyFmt = useMoneyFmt();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const r = await api.get(`/companies/${currentId}/compliance/entries`);
        if (!cancelled) setData(r.data);
      } catch (e) {
        if (!cancelled) setError(e?.response?.data?.detail || e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  const totalCount = useMemo(() => {
    if (!data?.summary) return 0;
    return Object.values(data.summary).reduce((n, v) => n + (v.count || 0), 0);
  }, [data]);

  return (
    <div className="max-w-5xl mx-auto p-6" data-testid="compliance-page">
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="h-11 w-11 rounded-xl bg-slate-900 flex items-center justify-center">
            <ShieldCheck className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold text-slate-900">
              IRS Compliance Library
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Every deduction the IRS wants documented — Meals, Travel, Vehicle,
              Business Gifts, and Charitable Contributions — one page.
            </p>
          </div>
        </div>
        {!loading && !error && (
          <div className="text-xs text-slate-500 mt-4">
            {totalCount} total entr{totalCount === 1 ? "y" : "ies"} across all IRS categories
          </div>
        )}
      </header>

      {loading && (
        <div className="flex items-center justify-center py-16 text-slate-500 text-sm">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading compliance library…
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-rose-50 ring-1 ring-rose-200 text-rose-800 p-4 text-sm">
          Could not load compliance entries: {error}
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-4">
          {CATEGORY_ORDER.map((catKey) => (
            <CategorySection
              key={catKey}
              catKey={catKey}
              bucket={data?.categories?.[catKey]}
              moneyFmt={moneyFmt}
            />
          ))}
        </div>
      )}
    </div>
  );
}
