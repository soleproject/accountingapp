import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  Share2, Copy, Check, Users, DollarSign, Loader2, Pencil, Save,
  ExternalLink, Calendar, Download, X,
} from "lucide-react";

/**
 * Affiliate share page — refactored Feb 2026 to fold in vanity slug
 * editing, per-firm buy-page URL, a referrals table, and a payout
 * report with month + custom date-range views.
 *
 * The overview (link + counts) is the default; the "Referrals" and
 * "Payouts" tabs load lazily to keep the initial paint fast.
 */
export default function Share() {
  const [tab, setTab] = useState("overview");
  const [data, setData] = useState(null);

  const load = () =>
    api.get("/share").then(r => setData(r.data)).catch(() => setData({}));

  useEffect(() => { load(); }, []);

  if (!data) return (
    <div className="p-10 text-center text-slate-400 text-sm">
      <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
    </div>
  );

  return (
    <div className="p-6 max-w-5xl mx-auto" data-testid="share-page">
      <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
        <Share2 size={14} /> Affiliate
      </div>
      <h1 className="text-2xl font-heading font-bold text-slate-900">Refer &amp; earn</h1>
      <p className="text-sm text-slate-500 mt-1 mb-6">
        Share your link. When someone signs up and pays, you get credited
        automatically — first month and every month after, for as long
        as they pay.
      </p>

      <div className="mb-5 border-b border-slate-200 flex gap-1">
        {[
          { id: "overview", label: "Overview" },
          { id: "referrals", label: "Referrals" },
          { id: "payouts",   label: "Payouts" },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            data-testid={`share-tab-${t.id}`}
            className={
              "px-4 py-2 text-sm border-b-2 -mb-px transition " +
              (tab === t.id
                ? "border-cyan-600 text-cyan-700 font-medium"
                : "border-transparent text-slate-500 hover:text-slate-700")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview"  && <OverviewTab data={data} onChanged={load} />}
      {tab === "referrals" && <ReferralsTab />}
      {tab === "payouts"   && <PayoutsTab />}
    </div>
  );
}

// --------------------------------------------------------------------------
// OVERVIEW — stats + editable slug + shareable link + QR code.
// --------------------------------------------------------------------------
function OverviewTab({ data, onChanged }) {
  const [copied, setCopied] = useState(false);
  const [slugEditing, setSlugEditing] = useState(false);
  const [slugDraft, setSlugDraft] = useState(data.slug || "");
  const [slugBusy, setSlugBusy] = useState(false);

  useEffect(() => { setSlugDraft(data.slug || ""); }, [data.slug]);

  const copy = async () => {
    if (!data?.link) return;
    await navigator.clipboard.writeText(data.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadQR = () => {
    const svg = document.querySelector('[data-testid="share-qr-svg"]');
    if (!svg) return;
    const src = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([src], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `referral-${data.slug}.svg`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const saveSlug = async () => {
    setSlugBusy(true);
    try {
      await api.put("/share/slug", { slug: slugDraft.trim() });
      toast.success("Slug updated");
      setSlugEditing(false);
      onChanged();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't update slug");
    } finally {
      setSlugBusy(false);
    }
  };

  return (
    <>
      <div className="grid md:grid-cols-2 gap-4 mb-6">
        <StatCard icon={Users}      label="Signups"        value={data.referred_count ?? 0} accent="cyan" />
        <StatCard icon={Users}      label="Paying"         value={data.paying_count ?? 0}   accent="emerald" />
        <StatCard icon={DollarSign} label="Earned"         value={fmtUsd(data.earnings_cents)} accent="emerald" />
        <StatCard icon={DollarSign} label="Pending payout" value={fmtUsd(data.pending_cents)}  accent="amber" />
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Your referral link</div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            readOnly
            value={data.link || ""}
            onFocus={e => e.target.select()}
            className="flex-1 min-w-[260px] border border-slate-200 rounded-md px-3 py-2 text-sm font-mono bg-slate-50"
            data-testid="share-link-input"
          />
          <button
            onClick={copy}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800"
            data-testid="share-copy-btn"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="mt-1.5 text-[11px] text-slate-500 flex items-center gap-2">
          {data.link_source === "firm_buy_page" && <>Uses your firm's Buy page URL.</>}
          {data.link_source === "firm_subdomain" && <>Uses your private-label subdomain.</>}
          {data.link_source === "platform" && (
            <>
              Set a Buy page URL in
              <a href="/settings" className="text-cyan-700 hover:underline inline-flex items-center gap-0.5">
                Settings <ExternalLink size={11} />
              </a>
              to route referrals to your own pricing page.
            </>
          )}
        </div>

        {/* Editable slug */}
        <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
          <span>Your affiliate slug:</span>
          {slugEditing ? (
            <>
              <input
                autoFocus
                value={slugDraft}
                onChange={e => setSlugDraft(e.target.value.toLowerCase())}
                className="border border-slate-300 rounded px-2 py-0.5 text-xs font-mono w-56"
                data-testid="share-slug-input"
              />
              <button
                onClick={saveSlug}
                disabled={slugBusy || !slugDraft.trim() || slugDraft === data.slug}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50"
                data-testid="share-slug-save"
              >
                {slugBusy ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save
              </button>
              <button
                onClick={() => { setSlugEditing(false); setSlugDraft(data.slug); }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border hover:bg-slate-50"
                data-testid="share-slug-cancel"
              >
                <X size={11} /> Cancel
              </button>
            </>
          ) : (
            <>
              <span className="font-mono font-medium text-slate-700">{data.slug}</span>
              <button
                onClick={() => setSlugEditing(true)}
                className="inline-flex items-center gap-1 text-cyan-700 hover:underline"
                data-testid="share-slug-edit"
              >
                <Pencil size={11} /> personalize
              </button>
            </>
          )}
        </div>

        <div className="mt-6 grid md:grid-cols-[220px_1fr] gap-6 items-start">
          <div className="p-4 rounded-lg bg-white border border-slate-200 flex flex-col items-center">
            <QRCodeSVG
              value={data.link || ""}
              size={180}
              level="M"
              includeMargin
              data-testid="share-qr-svg"
            />
            <button
              onClick={downloadQR}
              className="mt-3 text-xs text-cyan-700 hover:underline"
              data-testid="share-qr-download"
            >
              Download SVG
            </button>
          </div>
          <div className="text-sm text-slate-600 space-y-2 leading-relaxed">
            <p><b>How it works</b></p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Share your link or QR code. Signups that come through it are permanently credited to you.</li>
              <li>When a referral becomes a paying subscriber, you earn a fixed payout on every invoice they pay — for as long as they pay.</li>
              <li>Payouts appear in <span className="font-medium">Earned</span> once the billing period closes.</li>
            </ul>
            <table className="mt-3 text-xs">
              <tbody className="divide-y divide-slate-100">
                {[
                  ["$38 plan", "$7"],
                  ["$79 plan", "$15"],
                  ["$95 plan", "$20"],
                  ["$149 plan", "$30"],
                ].map(([svc, payout]) => (
                  <tr key={svc}>
                    <td className="pr-4 py-1 text-slate-500">{svc}</td>
                    <td className="py-1 text-slate-700 font-medium">{payout}/mo payout</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// --------------------------------------------------------------------------
// REFERRALS — table of every user who signed up under this affiliate.
// --------------------------------------------------------------------------
function ReferralsTab() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.get("/share/referrals").then(r => setRows(r.data.referrals || [])).catch(() => setRows([]));
  }, []);
  if (rows === null) return <Loading />;
  if (rows.length === 0) return (
    <EmptyBox
      title="No referrals yet"
      body="Share your link (or QR code) with a colleague. As soon as they sign up under your affiliate slug they'll appear here."
    />
  );
  return (
    <div className="bg-white rounded-lg border overflow-hidden" data-testid="referrals-table">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <Th>Name / email</Th>
            <Th>Signed up</Th>
            <Th>Status</Th>
            <Th className="text-right">Payments</Th>
            <Th className="text-right">Total earned</Th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(r => (
            <tr key={r.user_id} data-testid={`referral-row-${r.user_id}`}>
              <td className="px-3 py-2">
                <div className="text-slate-800 font-medium">{r.name || "—"}</div>
                <div className="text-xs text-slate-500">{r.email}</div>
              </td>
              <td className="px-3 py-2 text-slate-600 text-xs">{fmtDate(r.signed_up_at)}</td>
              <td className="px-3 py-2">
                <StatusPill status={r.status} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.payments}</td>
              <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700">
                {fmtUsd(r.earned_cents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------------
// PAYOUTS — this month + custom date range picker + line-by-line CSV export.
// --------------------------------------------------------------------------
function PayoutsTab() {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const monthStart = useMemo(() => today.slice(0, 8) + "01", [today]);
  const [start, setStart] = useState(monthStart);
  const [end, setEnd] = useState(today);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async (s = start, e = end) => {
    setBusy(true);
    try {
      const r = await api.get(`/share/report`, {
        params: { start: `${s}T00:00:00Z`, end: `${e}T23:59:59Z` },
      });
      setData(r.data);
    } catch { setData({ totals: {}, lines: [] }); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const setPreset = (which) => {
    const t = new Date();
    if (which === "this_month") {
      const s = new Date(t.getFullYear(), t.getMonth(), 1);
      setStart(s.toISOString().slice(0, 10)); setEnd(today);
      load(s.toISOString().slice(0, 10), today);
    } else if (which === "last_month") {
      const s = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const e = new Date(t.getFullYear(), t.getMonth(), 0);
      setStart(s.toISOString().slice(0, 10)); setEnd(e.toISOString().slice(0, 10));
      load(s.toISOString().slice(0, 10), e.toISOString().slice(0, 10));
    } else if (which === "ytd") {
      const s = new Date(t.getFullYear(), 0, 1);
      setStart(s.toISOString().slice(0, 10)); setEnd(today);
      load(s.toISOString().slice(0, 10), today);
    }
  };

  const exportCsv = () => {
    if (!data?.lines?.length) return;
    const header = ["date","referred_email","referred_name","gross_usd","share_usd","effective_pct","status"];
    const rows = data.lines.map(l => [
      l.date, l.referred_email || "", l.referred_name || "",
      (l.gross_cents / 100).toFixed(2),
      (l.share_cents / 100).toFixed(2),
      (l.share_bps / 100).toFixed(2) + "%",
      l.status,
    ]);
    const csv = [header, ...rows].map(r => r.map(v => `"${(v ?? "").toString().replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `payouts-${start}_to_${end}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  if (!data) return <Loading />;
  const t = data.totals || {};

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-lg border p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Calendar size={14} className="text-slate-500" />
          <input
            type="date" value={start} onChange={e => setStart(e.target.value)}
            className="border rounded px-2 py-1 text-sm" data-testid="payouts-start"
          />
          <span className="text-slate-400 text-sm">→</span>
          <input
            type="date" value={end} onChange={e => setEnd(e.target.value)}
            className="border rounded px-2 py-1 text-sm" data-testid="payouts-end"
          />
          <button
            onClick={() => load()} disabled={busy}
            className="px-3 py-1 rounded bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
            data-testid="payouts-apply"
          >
            {busy ? <Loader2 size={12} className="animate-spin inline" /> : "Apply"}
          </button>
          <div className="ml-auto flex gap-1">
            {[["this_month","This month"],["last_month","Last month"],["ytd","YTD"]].map(([k,l]) => (
              <button
                key={k} onClick={() => setPreset(k)}
                className="px-2 py-1 text-xs border rounded hover:bg-slate-50"
                data-testid={`payouts-preset-${k}`}
              >{l}</button>
            ))}
            <button
              onClick={exportCsv} disabled={!data.lines?.length}
              className="px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-40 inline-flex items-center gap-1"
              data-testid="payouts-export"
            >
              <Download size={11} /> CSV
            </button>
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-4 gap-3">
        <SummaryTile label="Invoices"   value={t.invoice_count ?? 0} />
        <SummaryTile label="Gross"      value={fmtUsd(t.gross_cents)} />
        <SummaryTile label="Payout"     value={fmtUsd(t.total_cents)} accent="emerald" />
        <SummaryTile label="Pending"    value={fmtUsd(t.accrued_cents)} accent="amber" />
      </div>

      {data.lines?.length === 0 ? (
        <EmptyBox
          title="No payouts in this window"
          body="Adjust the date range or pick a preset above."
        />
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden" data-testid="payouts-table">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <Th>Date</Th><Th>Referral</Th>
                <Th className="text-right">Gross</Th>
                <Th className="text-right">Payout</Th>
                <Th className="text-right">Rate</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-3 py-2 text-slate-600 text-xs">{fmtDate(l.date)}</td>
                  <td className="px-3 py-2 text-slate-800">{l.referred_email || "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(l.gross_cents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700">
                    {fmtUsd(l.share_cents)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-500">
                    {(l.share_bps / 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2"><StatusPill status={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Presentational helpers.
// --------------------------------------------------------------------------
function StatCard({ icon: Icon, label, value, accent }) {
  const tone = {
    cyan: "text-cyan-700 bg-cyan-50 border-cyan-100",
    emerald: "text-emerald-700 bg-emerald-50 border-emerald-100",
    amber: "text-amber-700 bg-amber-50 border-amber-100",
  }[accent] || "text-slate-700 bg-slate-50 border-slate-100";
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-md flex items-center justify-center border ${tone}`}>
          <Icon size={14} />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
          <div className="text-xl font-heading font-bold text-slate-900 tabular-nums">{value}</div>
        </div>
      </div>
    </div>
  );
}

function SummaryTile({ label, value, accent }) {
  const tone = accent === "emerald" ? "text-emerald-700" :
               accent === "amber"   ? "text-amber-700"   : "text-slate-900";
  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-lg font-heading font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    accrued:      ["Pending",     "bg-amber-50 text-amber-700 border-amber-200"],
    paid_out:     ["Paid out",    "bg-emerald-50 text-emerald-700 border-emerald-200"],
    paying:       ["Paying",      "bg-emerald-50 text-emerald-700 border-emerald-200"],
    signup_only:  ["Signed up",   "bg-slate-100 text-slate-600 border-slate-200"],
  };
  const [label, cls] = map[status] || [status, "bg-slate-100 text-slate-600 border-slate-200"];
  return (
    <span className={`inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${cls}`}>
      {label}
    </span>
  );
}

function Th({ children, className = "" }) {
  return <th className={`px-3 py-2 text-left font-medium ${className}`}>{children}</th>;
}

function Loading() {
  return <div className="p-10 text-center text-slate-400 text-sm">
    <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
  </div>;
}

function EmptyBox({ title, body }) {
  return (
    <div className="bg-white border rounded-lg p-10 text-center">
      <div className="text-slate-700 font-medium">{title}</div>
      <div className="text-sm text-slate-500 mt-1 max-w-md mx-auto">{body}</div>
    </div>
  );
}

function fmtUsd(cents) {
  return `$${(((cents ?? 0)) / 100).toFixed(2)}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined,
      { year: "numeric", month: "short", day: "numeric" });
  } catch { return iso; }
}
