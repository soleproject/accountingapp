import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { BooksCard, ProfitCard, CashCard, AttentionCard, TeamStrip } from "@/components/owner/OverviewCards";
import MoneyTab from "@/components/owner/MoneyTab";
import DocumentsTab from "@/components/owner/DocumentsTab";
import TeamTab from "@/components/owner/TeamTab";
import { Button } from "@/components/owner/ui";

const TABS = [
  { key: "overview", label: "Overview", path: "/owner" },
  { key: "money", label: "Money", path: "/owner/money" },
  { key: "documents", label: "Documents", path: "/owner/documents" },
  { key: "team", label: "Your team", path: "/owner/team" },
];

const HEADLINES = {
  overview: (d) => [`${d.user.greeting}${d.user.first_name ? `, ${d.user.first_name}` : ""}.`, `Here's where ${d.company.name} stands — numbers pulled live from your books and bank.`],
  money: () => ["Know what's coming and going.", "Cash, collections and commitments in one place."],
  documents: () => ["A home for your paperwork.", "Send it once. Your bookkeeping team handles the rest."],
  team: () => ["Your books have a team behind them.", "See what's done, what's next, and where you can help."],
};

function periodOptions() {
  const out = [];
  const d = new Date(); d.setDate(1);
  for (let i = 0; i < 8; i++) {
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({ ym, label: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }) });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export default function OwnerDashboard() {
  const { tab = "overview" } = useParams();
  const navigate = useNavigate();
  const { currentId } = useCompany();
  const { user } = useAuth();
  const fmt = useMoneyFmt();
  const [period, setPeriod] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const options = useMemo(periodOptions, []);

  const load = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/owner-dashboard`, { params: period ? { period } : {} });
      setData(r.data);
      if (!period) setPeriod(r.data.period.ym);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load your dashboard.");
    } finally { setLoading(false); }
  }, [currentId, period]);

  useEffect(() => { load(); }, [load]);

  const onAttention = (it) => {
    if (it.href) navigate(it.href);
  };

  if (!data) {
    return <div className="flex items-center gap-2 text-slate-500 p-10" data-testid="owner-dashboard-loading"><Loader2 className="animate-spin" size={16} /> Loading your business…</div>;
  }
  const [h1, sub] = HEADLINES[tab](data);
  const b = data.banner;

  return (
    <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-6 sm:py-8" data-testid="owner-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <nav className="flex gap-1 bg-slate-100 p-1 rounded-xl" data-testid="owner-tabs">
          {TABS.map(t => (
            <button key={t.key} onClick={() => navigate(t.path)} className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === t.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`} data-testid={`owner-tab-${t.key}`}>{t.label}</button>
          ))}
        </nav>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {loading && <Loader2 className="animate-spin" size={14} />}
          <span>{user?.role === "client" ? "" : "Previewing as owner · "}</span>
          <label className="flex items-center gap-2 border border-slate-200 bg-white rounded-lg px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-[0.08em]">Period</span>
            <select value={period} onChange={e => setPeriod(e.target.value)} className="text-sm font-semibold text-slate-900 bg-transparent outline-none" data-testid="owner-period-select">
              {options.map(o => <option key={o.ym} value={o.ym}>{o.label}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <h1 className="font-heading text-3xl sm:text-4xl text-slate-900" data-testid="owner-headline">{h1}</h1>
          <p className="text-slate-500 mt-1 text-sm">{sub}</p>
        </div>
      </div>

      {tab === "overview" && (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 px-5 py-3.5 mb-5" data-testid="owner-banner">
            <span className="w-2.5 h-2.5 rounded-full bg-primary" />
            <div className="flex-1 text-sm">
              <b>Your bookkeeping is moving along.</b> Your team handled <b>{b.handled_this_week} item{b.handled_this_week === 1 ? "" : "s"}</b> this week.
              {b.needs_you > 0 ? <> <b>{b.needs_you} thing{b.needs_you > 1 ? "s" : ""}</b> from you will help finish {b.period_label}.</> : <> Nothing is waiting on you.</>}
            </div>
            {b.needs_you > 0 && b.needs_you_href && <Button primary onClick={() => navigate(b.needs_you_href)} data-testid="owner-banner-cta">Answer now →</Button>}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <BooksCard books={data.books} fmt={fmt} />
            <ProfitCard profit={data.profit} periodLabel={data.period.label.split(" ")[0]} fmt={fmt} />
            <CashCard cash={data.cash} fmt={fmt} />
            <AttentionCard items={data.attention} onAction={onAttention} />
          </div>
          <TeamStrip team={data.team} companyId={currentId} />
          <div className="flex flex-wrap justify-between text-xs text-slate-500 mt-6">
            <span>{data.books.preliminary ? `Figures are live — preliminary until ${data.books.period_label}'s open items are resolved.` : "Figures are live and reconciled."}</span>
            <span>Last synced {data.books.last_sync_at ? new Date(data.books.last_sync_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</span>
          </div>
        </>
      )}
      {tab === "money" && <MoneyTab data={data} fmt={fmt} companyId={currentId} reload={load} />}
      {tab === "documents" && <DocumentsTab data={data} companyId={currentId} />}
      {tab === "team" && <TeamTab data={data} />}
    </div>
  );
}
