import React, { useEffect, useMemo, useState } from "react";
import { useCompany } from "@/lib/company";
import { labApi } from "../lib/labCompareApi";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Loader2, RefreshCw, ChevronRight, AlertCircle, CheckCircle2, Download, Search, X } from "lucide-react";
import { toast } from "sonner";

const PAGE_SIZE = 50;

const MOVEMENT_LABELS = {
  internal_transfer:    { label: "Matched transfer",      tone: "verified" },
  card_payment:         { label: "Matched card payment",  tone: "verified" },
  outside_transfer:     { label: "Outside transfer",      tone: "review"   },
  payment_app_transfer: { label: "Payment app",           tone: "review"   },
  credit_line_payment:  { label: "Credit line payment",   tone: "review"   },
  unpaired_transfer:    { label: "Unpaired transfer",     tone: "review"   },
};

// Deterministic > Enrich > LLM > skip/unresolved. Ordering here drives
// the color legend + filter dropdown order.
const CONTACT_SOURCE_META = {
  plaid_entity_id:      { label: "Plaid entity_id",    tone: "verified" },
  plaid_counterparties: { label: "Plaid counterparty", tone: "verified" },
  plaid_merchant_name:  { label: "Plaid merchant",     tone: "verified" },
  parsed_description:   { label: "Parsed description", tone: "verified" },
  descriptor_alias:     { label: "Descriptor alias",   tone: "verified" },
  normalized_name:      { label: "Normalized name",    tone: "verified" },
  bank_fee:             { label: "Bank fee",           tone: "info"  },
  enrich_merchant:      { label: "Enrich merchant",    tone: "info" },
  llm_match_live:       { label: "LLM → live",         tone: "info" },
  llm_new:              { label: "LLM (new)",          tone: "warn" },
  llm_pending:          { label: "LLM pending",        tone: "warn" },
  skip_movement:        { label: "Skipped (movement)", tone: "muted" },
  unresolved:           { label: "Unresolved",         tone: "danger" },
};

// Phase 3 — review reasons (5 buckets only per Feb-2026 spec cut).
const REVIEW_REASON_META = {
  uncategorized:              { label: "Uncategorized",        tone: "warn"  },
  unidentified_counterparty:  { label: "Unidentified party",   tone: "warn"  },
  unknown_account:            { label: "Unknown account",      tone: "warn"  },
  sensitive_first_time:       { label: "Sensitive (first)",    tone: "info"  },
  account_personal_use:       { label: "Personal-use?",        tone: "info"  },
};

function toneClass(tone) {
  return {
    verified: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    info:     "bg-sky-500/15 text-sky-300 border-sky-500/40",
    warn:     "bg-amber-500/15 text-amber-300 border-amber-500/40",
    danger:   "bg-rose-500/15 text-rose-300 border-rose-500/40",
    muted:    "bg-slate-700/60 text-slate-300 border-slate-600",
  }[tone];
}

function ContactSourceBadge({ source }) {
  if (!source) return <span className="text-xs text-slate-500">—</span>;
  const meta = CONTACT_SOURCE_META[source] || { label: source, tone: "muted" };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${toneClass(meta.tone)}`}
          data-testid={`lab-contact-source-${source}`}>
      {meta.label}
    </span>
  );
}

function ReviewReasonBadge({ reason }) {
  if (!reason) return null;
  const meta = REVIEW_REASON_META[reason] || { label: reason, tone: "warn" };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${toneClass(meta.tone)}`}
          data-testid={`lab-review-reason-${reason}`}>
      {meta.label}
    </span>
  );
}

const money = (n) => (n == null ? "" : new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 2,
}).format(Number(n)));

const fmtDate = (d) => (d ? String(d).slice(0, 10) : "");


function LabStatusBadge({ movement, confidence }) {
  if (!movement) return <span className="text-xs text-slate-400">—</span>;
  const meta = MOVEMENT_LABELS[movement] || { label: movement, tone: "review" };
  const cls = meta.tone === "verified"
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${cls}`}
          data-testid={`lab-status-${movement}`}>
      {meta.tone === "verified"
        ? <CheckCircle2 className="h-3 w-3" />
        : <AlertCircle className="h-3 w-3" />}
      {meta.label}
      {confidence === "low" && <span className="opacity-60">(low)</span>}
    </span>
  );
}


function DiffCell({ children, differs }) {
  return (
    <td className={`px-3 py-2 text-sm ${differs ? "bg-amber-500/10" : ""}`}>
      {children}
    </td>
  );
}


function RawExpansion({ row }) {
  return (
    <div className="bg-slate-900/60 border-t border-slate-800 px-4 py-3 text-xs text-slate-300 space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-slate-400 uppercase text-[10px] tracking-wide mb-1">Raw Plaid fields</div>
          <div><b>merchant_name:</b> {row.raw?.merchant_name || <i>—</i>}</div>
          <div><b>original_description:</b> {row.raw?.original_description || <i>—</i>}</div>
          <div><b>merchant_entity_id:</b> {row.raw?.merchant_entity_id || <i>—</i>}</div>
          <div><b>pfc_primary:</b> {row.raw?.pfc_primary || <i>—</i>}</div>
          <div><b>pfc_detailed:</b> {row.raw?.pfc_detailed || <i>—</i>}</div>
          <div><b>transaction_code:</b> {row.raw?.transaction_code || <i>—</i>}</div>
          <div><b>payment_channel:</b> {row.raw?.payment_channel || <i>—</i>}</div>
          <div><b>counterparties:</b> {(row.raw?.counterparties || []).map((c, i) =>
            <Badge key={i} variant="outline" className="mr-1">{c.name} <span className="opacity-50 ml-1">{c.type}</span></Badge>) || <i>—</i>}</div>
        </div>
        <div>
          <div className="text-slate-400 uppercase text-[10px] tracking-wide mb-1">Lab-derived</div>
          <div><b>direction:</b> {row.direction || <i>—</i>}</div>
          <div><b>channel:</b> {row.channel || <i>—</i>}</div>
          <div><b>parsed format:</b> {row.parsed?.format || row.parsed?.format_tag || <i>unknown</i>}</div>
          {row.parsed?.format === "boa_ach" && (
            <div className="mt-1 pl-2 border-l border-slate-700">
              <div><b>originator:</b> {row.parsed.originator}</div>
              <div><b>DES:</b> {row.parsed.des}</div>
              <div><b>ID:</b> {row.parsed.id_value}</div>
              <div><b>INDN:</b> {row.parsed.indn} <span className="text-slate-500">(accountholder, never contact)</span></div>
              <div><b>CO ID:</b> {row.parsed.co_id}</div>
            </div>
          )}
          {row.paypal && (
            <div className="mt-1 pl-2 border-l border-slate-700">
              <div><b>PayPal kind:</b> {row.paypal.kind}</div>
              <div><b>reason:</b> {row.paypal.reason}</div>
            </div>
          )}
          <div className="mt-2"><b>movement_type:</b> {row.lab?.movement_type || <i>none</i>}</div>
          <div><b>movement_reason:</b> {row.lab?.movement_reason || <i>—</i>}</div>
          <div><b>movement_pair_id:</b> {row.lab?.movement_pair_id || <i>—</i>}</div>
          <div><b>linked_lab_account:</b> {row.lab?.linked_lab_account || <i>—</i>}</div>
          <div className="mt-2 pt-2 border-t border-slate-800">
            <div><b>contact (lab):</b> {row.lab?.contact || <i>blank</i>}
              {row.lab?.contact_source && <span className="ml-2"><ContactSourceBadge source={row.lab.contact_source} /></span>}
              {row.lab?.contact_new && <Badge className="ml-1 bg-amber-500/20 text-amber-200 border-amber-500/40" variant="outline">would mint</Badge>}
            </div>
            <div><b>contact reason:</b> {row.lab?.contact_reason || <i>—</i>}</div>
            {row.lab?.merchant_type && (
              <div><b>merchant_type:</b> {row.lab.merchant_type}</div>
            )}
            {row.lab?.category && (
              <div className="mt-1">
                <b>category (lab):</b> {row.lab.category.account_name || <i>blank</i>}
                {row.lab.category.account_code && <span className="ml-1 text-slate-500 font-mono text-[10px]">#{row.lab.category.account_code}</span>}
                {" "}<span className="text-slate-400">({row.lab.category_source})</span>
                {row.lab.category.is_pending && (
                  <Badge variant="outline" className="ml-2 bg-amber-500/20 text-amber-200 border-amber-500/40 text-[10px]">
                    proposed → {row.lab.category.parent_name || "parent"}
                  </Badge>
                )}
              </div>
            )}
            {row.lab?.category?.reason && (
              <div><b>category reason:</b> {row.lab.category.reason}</div>
            )}
            {row.lab?.review_reason && (
              <div className="mt-1">
                <b>review:</b> <ReviewReasonBadge reason={row.lab.review_reason} />
                {row.lab?.review_card_key && <span className="ml-2 font-mono text-[10px] text-slate-500">{row.lab.review_card_key}</span>}
              </div>
            )}
            {row.lab?.enrich_cache_key && (
              <div><b>enrich:</b> <span className="text-slate-500">{row.lab.enrich_source}</span> · <span className="font-mono text-[10px]">{row.lab.enrich_cache_key}</span></div>
            )}
          </div>
          {row.raw_overwrites?.length > 0 && (
            <div className="mt-2 text-amber-400"><b>raw overwrites:</b> {row.raw_overwrites.join(", ")}</div>
          )}
        </div>
      </div>
    </div>
  );
}


export default function LabTransactionsCompare() {
  const { currentId: cid } = useCompany();
  const [summary, setSummary] = useState(null);
  const [running, setRunning] = useState(false);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const [movementFilter, setMovementFilter] = useState("");
  const [contactSourceFilter, setContactSourceFilter] = useState("");
  const [contactChangedOnly, setContactChangedOnly] = useState(false);
  const [reviewReasonFilter, setReviewReasonFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState(null);

  // Debounce search input → query by 300ms so typing doesn't spam.
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadSummary = async () => {
    if (!cid) return;
    try {
      const r = await labApi.summary(cid);
      setSummary(r.data);
      setError(null);
    } catch (e) {
      setError(e?.response?.data?.detail || "Feature flag off or not authorized");
    }
  };

  const loadPage = async (p = page) => {
    if (!cid) return;
    setLoading(true);
    try {
      const r = await labApi.compare(cid, {
        page: p, page_size: PAGE_SIZE,
        only_differences: onlyDifferences ? "true" : undefined,
        movement_type: movementFilter || undefined,
        contact_source: contactSourceFilter || undefined,
        contact_changed: contactChangedOnly ? "true" : undefined,
        review_reason: reviewReasonFilter || undefined,
        q: searchQuery || undefined,
      });
      setRows(r.data.rows);
      setTotal(r.data.total);
      setPage(p);
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  const runPipeline = async (phase) => {
    setRunning(true);
    try {
      // Phase 3 with LLM can run for minutes; use the async job endpoint
      // and poll status so we don't hit the ingress 60s timeout.
      if (phase === 3) {
        const r = await labApi.runAsync(cid, 3);
        const jobId = r.data?.job_id;
        if (!jobId) throw new Error("no job_id");
        toast.info("Phase 3 queued — polling…");
        // Poll every 4s for up to 15 minutes.
        for (let i = 0; i < 225; i++) {
          await new Promise((res) => setTimeout(res, 4000));
          const s = await labApi.status(cid, jobId);
          if (s.data?.status === "done") {
            const dur = s.data?.result?.duration_s ?? "?";
            toast.success(`Ran Phase 3 in ${dur}s`);
            break;
          }
          if (s.data?.status === "error") {
            toast.error(s.data?.error || "Phase 3 failed");
            break;
          }
        }
      } else {
        const r = await labApi.run(cid, phase);
        if (r.data?.ok) {
          const dur = r.data.duration_s ?? "?";
          toast.success(`Ran Phase ${phase} in ${dur}s`);
        } else {
          toast.error(r.data?.reason || "Run failed");
        }
      }
      await loadSummary();
      await loadPage(1);
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message || "Run failed");
    } finally {
      setRunning(false);
    }
  };

  const downloadPfcCoaMapping = async () => {
    if (!cid) return;
    try {
      const r = await labApi.pfcCoaMappingCsv(cid);
      const blob = new Blob([r.data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pfc-coa-mapping_${cid.slice(0, 8)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Downloaded PFC → CoA mapping");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Download failed");
    }
  };

  useEffect(() => { loadSummary(); loadPage(1); /* eslint-disable-next-line */ }, [cid]);
  useEffect(() => { loadPage(1); /* eslint-disable-next-line */ },
    [onlyDifferences, movementFilter, contactSourceFilter, contactChangedOnly, reviewReasonFilter, searchQuery]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);

  return (
    <div className="p-6 space-y-4" data-testid="lab-compare-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Lab · Live vs. Lab Transactions</h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">
            Read-only reprocessing of stored Plaid transactions. Live pipeline is unchanged.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={downloadPfcCoaMapping} disabled={!cid}
                  data-testid="lab-download-pfc-coa" title="Download PFC → CoA mapping (CSV)">
            <Download className="h-4 w-4 mr-2" />
            PFC → CoA CSV
          </Button>
          <Button variant="outline" onClick={() => runPipeline(1)}
                  disabled={running || !cid} data-testid="lab-run-phase1">
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Run Phase 1
          </Button>
          <Button variant="outline" onClick={() => runPipeline(2)}
                  disabled={running || !cid} data-testid="lab-run-phase2">
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Run Phase 2 (contacts)
          </Button>
          <Button onClick={() => runPipeline(3)}
                  disabled={running || !cid} data-testid="lab-run-phase3">
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Run Phase 3 (category)
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border border-red-500/60 bg-red-950/50 p-3 text-sm text-red-100" data-testid="lab-error">
          {error}
        </Card>
      )}

      {summary && (
        <Card className="p-4 bg-slate-900 border border-slate-700" data-testid="lab-summary">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Scanned</div><div className="text-2xl font-semibold text-white mt-1" data-testid="stat-scanned">{summary.scanned}</div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Auto-booked</div><div className="text-2xl font-semibold text-emerald-400 mt-1" data-testid="stat-auto">{summary.verified || 0}<span className="text-xs text-slate-400 ml-1">{summary.auto_book_pct != null ? `(${summary.auto_book_pct}%)` : ""}</span></div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Needs review</div><div className="text-2xl font-semibold text-amber-400 mt-1" data-testid="stat-review">{summary.review || 0}</div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Contact changed</div><div className="text-2xl font-semibold text-sky-400 mt-1" data-testid="stat-contact-changed">{summary.differences?.contact_changed || 0}</div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">INDN skipped</div><div className="text-2xl font-semibold text-sky-400 mt-1" data-testid="stat-indn-skipped">{summary.differences?.indn_derived_live_skipped || 0}</div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Lab-new contacts</div><div className="text-2xl font-semibold text-white mt-1" data-testid="stat-lab-new">{summary.lab_new_contacts || 0}</div></div>
          </div>
          {summary.by_contact_source && (
            <div className="mt-4 pt-3 border-t border-slate-700">
              <div className="text-xs uppercase tracking-wide text-slate-300 mb-2">Contact source</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary.by_contact_source)
                  .sort((a, b) => b[1] - a[1])
                  .map(([src, n]) => (
                    <button key={src} className="flex items-center gap-1"
                            onClick={() => setContactSourceFilter(contactSourceFilter === src ? "" : src)}
                            data-testid={`stat-source-${src}`}>
                      <ContactSourceBadge source={src} />
                      <span className="text-sm text-slate-200 tabular-nums">{n}</span>
                    </button>
                  ))}
              </div>
            </div>
          )}
          {summary.by_review_reason && Object.keys(summary.by_review_reason).length > 0 && (
            <div className="mt-4 pt-3 border-t border-slate-700">
              <div className="text-xs uppercase tracking-wide text-slate-300 mb-2">Review reasons</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary.by_review_reason)
                  .sort((a, b) => b[1] - a[1])
                  .map(([rr, n]) => (
                    <button key={rr} className="flex items-center gap-1"
                            onClick={() => setReviewReasonFilter(reviewReasonFilter === rr ? "" : rr)}
                            data-testid={`stat-reason-${rr}`}>
                      <ReviewReasonBadge reason={rr} />
                      <span className="text-sm text-slate-200 tabular-nums">{n}</span>
                    </button>
                  ))}
              </div>
            </div>
          )}
          {summary.pending_accounts && summary.pending_accounts.length > 0 && (
            <div className="mt-4 pt-3 border-t border-slate-700" data-testid="lab-pending-accounts-banner">
              <div className="flex items-baseline justify-between mb-2">
                <div className="text-xs uppercase tracking-wide text-amber-300">
                  Proposed sub-accounts · {summary.pending_accounts.length}
                </div>
                <div className="text-[11px] text-slate-400">
                  Auto-created from credit-card / loan payments — accept to add to CoA
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {summary.pending_accounts.map((a) => (
                  <div
                    key={a.id}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border ${
                      a.is_parent_bucket
                        ? "bg-amber-500/10 border-amber-500/40 text-amber-200 font-semibold"
                        : "bg-slate-800/60 border-slate-700 text-slate-200"
                    }`}
                    title={a.is_parent_bucket
                      ? `${a.name} (parent bucket)`
                      : `${a.name} under ${a.parent_name}`}
                    data-testid={`lab-pending-account-${a.code}`}
                  >
                    <span className="font-mono text-slate-400">{a.code}</span>
                    <span>{a.name}</span>
                    {a.is_parent_bucket && (
                      <span className="text-[10px] uppercase tracking-wide ml-1 text-amber-300/80">
                        parent
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="h-4 w-4 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Search description, merchant, contact…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded pl-8 pr-8 py-1 text-sm text-slate-100 placeholder:text-slate-500 w-72 focus:outline-none focus:ring-1 focus:ring-slate-500"
            data-testid="lab-search-input"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
              data-testid="lab-search-clear"
              aria-label="Clear search">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-200" data-testid="lab-only-diff-toggle">
          <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
          Only movement differences
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-200" data-testid="lab-contact-changed-toggle">
          <input type="checkbox" checked={contactChangedOnly}
                 onChange={(e) => setContactChangedOnly(e.target.checked)} />
          Contact changed
        </label>
        <select className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100"
                data-testid="lab-movement-filter"
                value={movementFilter} onChange={(e) => setMovementFilter(e.target.value)}>
          <option value="">All movement types</option>
          {Object.keys(MOVEMENT_LABELS).map((k) => <option key={k} value={k}>{MOVEMENT_LABELS[k].label}</option>)}
        </select>
        <select className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100"
                data-testid="lab-contact-source-filter"
                value={contactSourceFilter} onChange={(e) => setContactSourceFilter(e.target.value)}>
          <option value="">All contact sources</option>
          {Object.keys(CONTACT_SOURCE_META).map((k) => <option key={k} value={k}>{CONTACT_SOURCE_META[k].label}</option>)}
        </select>
        <select className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100"
                data-testid="lab-review-reason-filter"
                value={reviewReasonFilter} onChange={(e) => setReviewReasonFilter(e.target.value)}>
          <option value="">All review reasons</option>
          {Object.keys(REVIEW_REASON_META).map((k) => <option key={k} value={k}>{REVIEW_REASON_META[k].label}</option>)}
        </select>
        <div className="ml-auto text-xs text-slate-300">
          {total} rows · page {page}/{totalPages}
        </div>
      </div>

      <Card className="overflow-hidden border border-slate-700 bg-slate-950">
        {loading ? (
          <div className="p-8 flex items-center justify-center text-slate-300"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No rows.</div>
        ) : (
          <table className="w-full text-sm" data-testid="lab-compare-table">
            <thead className="bg-slate-800">
              <tr className="text-left text-slate-100 border-b border-slate-700">
                <th className="px-3 py-2.5 w-6"></th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Date</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Contact (live)</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Contact (lab)</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Merchant / Description</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Category (lab)</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide text-right">Amount</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Lab status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const isOpen = expanded === r.txn_id;
                const movementDiffers = r.diff?.movement_gained_transfer || r.diff?.movement_lost_transfer;
                const contactDiffers = r.diff?.contact_changed;
                const needsReview = r.lab?.verified === false && r.lab?.review_reason;
                const rowTone = needsReview
                  ? "bg-amber-500/10"
                  : movementDiffers
                    ? "bg-amber-500/10"
                    : contactDiffers
                      ? "bg-sky-500/10"
                      : (idx % 2 === 0 ? "bg-slate-900" : "bg-slate-900/40");
                return (
                  <React.Fragment key={r.txn_id}>
                    <tr className={`border-b border-slate-800 hover:bg-slate-800/60 cursor-pointer ${rowTone}`}
                        onClick={() => setExpanded(isOpen ? null : r.txn_id)}
                        data-testid={`lab-row-${r.txn_id}`}>
                      <td className="px-3 py-2"><ChevronRight className={`h-3 w-3 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`} /></td>
                      <td className="px-3 py-2 text-slate-200 whitespace-nowrap tabular-nums">{fmtDate(r.date)}</td>
                      <td className="px-3 py-2 text-slate-100" data-testid={`live-contact-${r.txn_id}`}>{r.live.contact || <span className="text-slate-500">—</span>}</td>
                      <td className="px-3 py-2 text-slate-100" data-testid={`lab-contact-${r.txn_id}`}>
                        <div className="flex flex-col gap-1">
                          <span>{r.lab?.contact || <span className="text-slate-500">—</span>}</span>
                          <div className="flex gap-1 flex-wrap">
                            {r.lab?.contact_source && <ContactSourceBadge source={r.lab.contact_source} />}
                            {r.lab?.merchant_type && r.lab.merchant_type !== "unknown" && (
                              <span className="text-[10px] text-slate-400 uppercase tracking-wide">{r.lab.merchant_type}</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-100 max-w-[320px] truncate" title={r.description}>
                        <div className="font-medium">{r.merchant || <span className="text-slate-300">{r.description}</span>}</div>
                        {r.merchant && r.description && <div className="text-xs text-slate-400 truncate">{r.description}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-100" data-testid={`lab-category-${r.txn_id}`}>
                        <div className="flex flex-col gap-1">
                          <span className="flex items-center gap-1.5 flex-wrap">
                            {r.lab?.category?.account_name || <span className="text-slate-500">—</span>}
                            {r.lab?.category?.is_pending && (
                              <Badge
                                variant="outline"
                                className="bg-amber-500/20 text-amber-200 border-amber-500/40 text-[10px] px-1.5 py-0"
                                title={`Would auto-create under ${r.lab?.category?.parent_name || "parent"}`}
                                data-testid={`lab-category-proposed-${r.txn_id}`}
                              >
                                proposed
                              </Badge>
                            )}
                          </span>
                          {r.lab?.review_reason && <ReviewReasonBadge reason={r.lab.review_reason} />}
                        </div>
                      </td>
                      <td className={`px-3 py-2 text-right whitespace-nowrap tabular-nums font-medium ${Number(r.amount) < 0 ? "text-rose-300" : "text-emerald-300"}`}>
                        {money(r.amount)}
                      </td>
                      <DiffCell differs={movementDiffers}>
                        <LabStatusBadge movement={r.lab?.movement_type} confidence={r.lab?.movement_confidence} />
                      </DiffCell>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={8} className="p-0"><RawExpansion row={r} /></td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex items-center gap-2 justify-center pt-2">
        <Button variant="outline" size="sm" disabled={page <= 1 || loading}
                onClick={() => loadPage(page - 1)} data-testid="lab-prev-page">Prev</Button>
        <span className="text-xs text-slate-400">Page {page} of {totalPages}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages || loading}
                onClick={() => loadPage(page + 1)} data-testid="lab-next-page">Next</Button>
      </div>
    </div>
  );
}
