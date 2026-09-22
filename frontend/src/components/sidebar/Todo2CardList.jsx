/**
 * Todo2CardList — the sidebar's "cards mode" for the To Do 2 link.
 * Renders one clickable card per still-open item from the same
 * `/companies/{cid}/responsibilities/status` endpoint the /accounting/todo
 * page uses, so the sidebar cards mirror the page 1:1.
 *
 * Each card deep-links to the exact place the task lives — either an
 * `area_link` page (bills, invoices, receipts, …) OR back onto the
 * To Do page anchored at that section, so the CPA lands where they
 * can act. `return_to` + `return_label` query params ride along so
 * the target page can show a breadcrumb back to the sidebar view.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useUserPref } from "@/hooks/useUserPref";
import {
  ArrowLeft, Loader2, ChevronRight, CircleAlert, User, Bot, Wrench,
  LayoutDashboard, FileText, Receipt, ArrowLeftRight, ScrollText, BarChart3,
} from "lucide-react";

// Sidebar-card label overrides — shorter, action-oriented names that
// fit a rail-width column. Keep the mapping tight so a new catalog
// entry falls back to `item.label` on the backend if we forget it here.
const CARD_LABELS = {
  monitoring_cash_flow:        "Cash Flow",
  reviewing_transactions:      "Transactions",
  paying_bills:                "Bills",
  following_up_invoices:       "Invoices",
  monitoring_inventory:        "Inventory",
  issuing_payroll:             "Payroll",
  reconciling_accounts:        "Reconcile",
  paying_sales_tax:            "Sales Tax",
  eom_closing:                 "Close",
  paying_payroll_liabilities:  "Payroll Liabilities",
  liability_payments:          "Liability Payments",
  checks_no_payee:             "Checks",
  receipt_followup:            "Receipts",
  irs_compliance:              "IRS",
  ai_auto_cleanup:             "AI Cleanup",
};

// Explicit sort order matching the CPA's mental model:
// cash first (survival), receivables + payables (working capital),
// inventory + core-cleanup (bookkeeping loop), then obligations
// (compliance/reconcile/close). Anything not in this map sinks to
// the bottom so a brand-new catalog entry is still discoverable.
const CARD_ORDER = [
  "monitoring_cash_flow",
  "following_up_invoices",
  "paying_bills",
  "monitoring_inventory",
  "reviewing_transactions",
  "liability_payments",
  "checks_no_payee",
  "receipt_followup",
  "irs_compliance",
  "issuing_payroll",
  "reconciling_accounts",
  "paying_sales_tax",
  "eom_closing",
];

// Tier mapping — same three-tier model the Cockpit uses.
// ai = things the AI can (or should) still resolve on its own → 🟢
// assistant = light-touch, delegate-able → 🟣
// pro = needs CPA judgment → 🟡 (default for everything tracked)
const TIER = {
  monitoring_cash_flow:      { tier: "pro",       label: "Professional" },
  reviewing_transactions:    { tier: "ai",        label: "AI Junior" },
  paying_bills:              { tier: "assistant", label: "Assistant" },
  following_up_invoices:     { tier: "assistant", label: "Assistant" },
  monitoring_inventory:      { tier: "assistant", label: "Assistant" },
  issuing_payroll:           { tier: "pro",       label: "Professional" },
  reconciling_accounts:      { tier: "pro",       label: "Professional" },
  paying_sales_tax:          { tier: "pro",       label: "Professional" },
  paying_payroll_liabilities:{ tier: "pro",       label: "Professional" },
  eom_closing:               { tier: "pro",       label: "Professional" },
  liability_payments:        { tier: "assistant", label: "Assistant" },
  checks_no_payee:           { tier: "assistant", label: "Assistant" },
  receipt_followup:          { tier: "assistant", label: "Assistant" },
  irs_compliance:            { tier: "pro",       label: "Professional" },
  ai_auto_cleanup:           { tier: "ai",        label: "AI Junior" },
};
const TIER_STYLES = {
  ai:        { border: "border-l-emerald-400", bg: "bg-emerald-50/40", chip: "text-emerald-700 bg-emerald-100", Icon: Bot },
  assistant: { border: "border-l-indigo-400",  bg: "bg-indigo-50/40",  chip: "text-indigo-700 bg-indigo-100",   Icon: User },
  pro:       { border: "border-l-amber-400",   bg: "bg-amber-50/40",   chip: "text-amber-800 bg-amber-100",     Icon: Wrench },
};

// Sort priority: pro → assistant → ai (only-you-can-do-it first).
const TIER_ORDER = { pro: 0, assistant: 1, ai: 2 };

// Per-catalog filter params so the destination page opens ALREADY
// scoped to the items the card represents. If a page doesn't accept
// a filter, the entry stays null and the page opens unfiltered.
const CARD_FILTERS = {
  paying_bills:          { outstanding: "1" },   // /bills — balance_due>0
  following_up_invoices: { overdue: "1" },       // /invoices — past-due only
  reconciling_accounts:  { filter: "unreconciled" }, // /accounting/reconciliation
};

const _buildOpenHref = (href, returnTo, returnLabel, extraParams = {}) => {
  if (!href) return null;
  const params = new URLSearchParams();
  // Filter params first — they belong to the target page.
  for (const [k, v] of Object.entries(extraParams || {})) {
    if (v !== null && v !== undefined && v !== "") params.set(k, String(v));
  }
  if (returnTo)    params.set("return_to", returnTo);
  if (returnLabel) params.set("return_label", returnLabel);
  const qs = params.toString();
  if (!qs) return href;
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}${qs}`;
};

// Quick-nav strip shown above the first card in expanded To Do 2
// mode. Same routes surfaced elsewhere in the sidebar — repeated
// here so the CPA doesn't have to bounce back to the full menu
// just to jump into Invoices/Bills/etc. while triaging tasks.
const QUICK_LINKS = [
  { to: "/dashboard",             label: "Dashboard",    icon: LayoutDashboard },
  { to: "/invoices",              label: "Invoices",     icon: FileText },
  { to: "/bills",                 label: "Bills",        icon: Receipt },
  { to: "/accounting/transactions", label: "Transactions", icon: ArrowLeftRight },
  { to: "/receipts",              label: "Receipts",     icon: ScrollText },
  { to: "/reports",               label: "Reports",      icon: BarChart3 },
];

export default function Todo2CardList({ onExit, collapsed = false, returnPath = "/accounting/todo", variant = "both" }) {
  const { currentId, current } = useCompany();
  const navigate = useNavigate();
  const location = useLocation();
  const showQuickLinks = variant === "both";
  const [items, setItems]   = useState([]);
  const [cashFlow, setCashFlow] = useState(null);
  const [loading, setLoad]  = useState(true);
  const [error, setError]   = useState(null);

  // Mirror the ResponsibilitiesPanel's per-company Review-mode pref
  // so the "Reviewing Transactions" card routes to the surface the
  // user has actually chosen (Review Chat vs. Checklist / Standard).
  // Same storage key used by the panel — no drift.
  const reviewModeKey = `reviewMode.${currentId || "_"}`;
  const [reviewMode] = useUserPref(reviewModeKey, "chat", { localFallback: reviewModeKey });

  useEffect(() => {
    if (!currentId) { setLoad(false); return; }
    let cancelled = false;
    (async () => {
      setLoad(true);
      try {
        const [statusR, cashR] = await Promise.allSettled([
          api.get(`/companies/${currentId}/responsibilities/status`,
            { params: { scope: "both" } }),
          api.get(`/companies/${currentId}/cockpit-cards/cashflow-snapshot`),
        ]);
        if (cancelled) return;
        if (statusR.status === "fulfilled") {
          setItems(statusR.value.data?.items || []);
        } else {
          setError(statusR.reason?.response?.data?.detail || "Couldn't load To Do");
        }
        if (cashR.status === "fulfilled") {
          setCashFlow(cashR.value.data || null);
        } else {
          setCashFlow(null);
        }
      } finally {
        if (!cancelled) setLoad(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  // Filter to only actionable, open items.
  // - Drop "done" and "n/a" (as intended by the panel).
  // - Drop items with no count AND no manual completion flag (nothing
  //   for the CPA to actually do — e.g. a tracked item that's inert).
  // - Prepend a synthetic Cash Flow card when the runway is not
  //   healthy (warning or critical) — it's not a backend catalog item.
  const openItems = useMemo(() => {
    const list = items.filter(it => {
      if (it.status === "done" || it.status === "n/a") return false;
      // For tracked items with a numeric count, require count > 0.
      if (it.tracked && typeof it.count === "number" && it.count === 0
          && !it.manual_complete && it.status !== "in_progress") {
        return false;
      }
      return true;
    });
    // Synthetic Cash Flow card — only surfaces when the projections
    // engine flags the account as watch-runway or critical. Healthy
    // runway means no action needed → card hidden.
    if (cashFlow && cashFlow.health && cashFlow.health !== "healthy") {
      const runway = cashFlow.runway_days;
      const detail = runway == null
        ? "Cash flow needs attention"
        : (runway < 60
            ? `Only ~${runway}d of runway — burn $${Math.round(cashFlow.avg_daily_burn || 0)}/d`
            : `~${runway}d of runway — watch spend closely`);
      list.unshift({
        key:       "monitoring_cash_flow",
        label:     "Monitoring Cash Flow",
        status:    cashFlow.health === "critical" ? "in_progress" : "in_progress",
        detail,
        count:     runway || null,
        area_link: cashFlow.open_link || "/accounting/projections",
        tracked:   true,
      });
    }
    // Explicit CPA-mental-model order (see CARD_ORDER above). Items
    // not in the map sink to the bottom so any new catalog entry is
    // still discoverable.
    const orderIdx = (key) => {
      const idx = CARD_ORDER.indexOf(key);
      return idx === -1 ? 999 : idx;
    };
    return list.sort((a, b) => {
      const oa = orderIdx(a.key), ob = orderIdx(b.key);
      if (oa !== ob) return oa - ob;
      // Same bucket — bigger backlog first.
      return (b.count ?? 0) - (a.count ?? 0);
    });
  }, [items, cashFlow]);

  const clickCard = (item) => {
    // Reviewing Transactions has two surfaces controlled by a per-user,
    // per-company pref: "chat" → the Review Chat page; "checklist" →
    // the AI Cleanup Review page (the item's default area_link).
    // In chat mode we also deep-link to whichever bucket has the most
    // items so the CPA lands where the work is heaviest.
    if (item.key === "reviewing_transactions") {
      if (reviewMode === "chat") {
        const cc = item.chat_counts || {};
        // Pick the biggest non-zero bucket; fall back to no_category.
        const entries = [
          ["no_category",  cc.no_category  || 0],
          ["transactions", cc.transactions || 0],
          ["checks",       cc.checks       || 0],
        ];
        entries.sort((a, b) => b[1] - a[1]);
        const tab = entries[0][1] > 0 ? entries[0][0] : "no_category";
        navigate(_buildOpenHref("/accounting/review-chat",
          "/accounting/todo", "To Do", { tab }));
      } else {
        navigate(_buildOpenHref(item.area_link || "/accounting/ai-cleanup-review",
          "/accounting/todo", "To Do"));
      }
      return;
    }
    // Prefer the item's own area link, appending any per-card filter
    // params so the destination page opens scoped to the work the
    // sidebar card represents (e.g. Bills → outstanding only).
    const filters = { ...(CARD_FILTERS[item.key] || {}) };
    // Close card → land on the PREVIOUS calendar month (the one you
    // actually close), not the current in-progress month.
    if (item.key === "eom_closing") {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      filters.ym = `${y}-${m}`;
    }
    const target = item.area_link
      ? _buildOpenHref(item.area_link, "/accounting/todo", "To Do", filters)
      : `/accounting/todo#${item.key}`;
    navigate(target);
  };

  const companyLabel = current?.name || "This client";

  // Compute the base pathname a card would navigate to — used to
  // highlight the card matching the current URL as "selected". Pure
  // pathname, no query, so filter params don't break the match.
  const targetPathFor = (item) => {
    if (item.key === "reviewing_transactions") {
      return reviewMode === "chat"
        ? "/accounting/review-chat"
        : (item.area_link || "/accounting/ai-cleanup-review").split("?")[0];
    }
    if (!item.area_link) return "/accounting/todo";
    return item.area_link.split("?")[0];
  };
  const isSelected = (item) => {
    const p = targetPathFor(item);
    return location.pathname === p;
  };

  return (
    <div className="flex flex-col h-full" data-testid="sidebar-todo2">
      {/* Back-to-menu + Menu/Page toggle removed — the sidebar-level
          3-way toggle (SidebarModeToggle) now owns all layout
          switching. In the collapsed rail we keep a lone back-arrow
          so users can exit card mode when there's no room for the
          full toggle. */}
      {collapsed && (
        <button
          type="button"
          onClick={onExit}
          title="Back to menu"
          className="mx-auto mb-2 inline-flex items-center justify-center w-8 h-8 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition"
          data-testid="sidebar-todo2-back"
        >
          <ArrowLeft size={14} />
        </button>
      )}

      {!collapsed && showQuickLinks && (
        <>
          {/* Quick-links — same look as the normal sidebar Item rows.
              Clicking one navigates but stays in card mode so the
              user can keep triaging tasks while jumping around.
              Hidden when the sidebar is in the "todo" (cards-only)
              variant — that mode intentionally shows nothing but
              the top-level toggle and the task cards. */}
          <div className="mb-2" data-testid="sidebar-todo2-quick-links">
            {QUICK_LINKS.map((l) => {
              const active = location.pathname === l.to;
              const Icon = l.icon;
              return (
                <button
                  key={l.to}
                  type="button"
                  onClick={() => navigate(l.to)}
                  className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors ${
                    active ? "bg-slate-100 text-slate-900 font-medium" : "text-slate-700 hover:bg-slate-100"
                  }`}
                  data-testid={`sidebar-todo2-quick-link-${l.label.toLowerCase()}`}
                >
                  <Icon size={16} className="text-slate-500" strokeWidth={2} />
                  <span className="truncate">{l.label}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className={`flex-1 overflow-y-auto pb-3 ${collapsed ? "px-0 space-y-1" : "px-1.5 space-y-1.5"}`}>
        {loading && (
          <div className="flex items-center justify-center py-6 text-slate-400" data-testid="sidebar-todo2-loading">
            <Loader2 size={14} className="animate-spin" />
          </div>
        )}
        {error && !loading && !collapsed && (
          <div className="rounded-md border border-red-200 bg-red-50 px-2 py-2 text-[11px] text-red-700 flex items-start gap-1.5" data-testid="sidebar-todo2-error">
            <CircleAlert size={12} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {error && !loading && collapsed && (
          <div className="flex justify-center py-2 text-red-600" title={error} data-testid="sidebar-todo2-error">
            <CircleAlert size={16} />
          </div>
        )}
        {!loading && !error && openItems.length === 0 && !collapsed && (
          <div className="rounded-md border border-dashed border-emerald-200 bg-emerald-50/40 px-3 py-4 text-center text-[12px] text-emerald-700"
               data-testid="sidebar-todo2-empty">
            🎉 You're clear.<br/>Enjoy the quiet.
          </div>
        )}
        {!loading && !error && openItems.map((it) => {
          const meta = TIER[it.key] || { tier: "pro", label: "Professional" };
          const style = TIER_STYLES[meta.tier];
          const Icon = style.Icon;
          const cardLabel = CARD_LABELS[it.key] || it.label;
          // For Reviewing Transactions in chat mode we show the 3-bucket
          // breakdown that the Review Chat page uses (No Category ·
          // Transactions · Checks) instead of the raw needs-review
          // total, so the sidebar reads like the destination.
          const chatCounts = it.chat_counts;
          const isTxnChat = it.key === "reviewing_transactions"
            && reviewMode === "chat" && chatCounts;
          const chatTotal = isTxnChat
            ? (chatCounts.no_category || 0)
              + (chatCounts.transactions || 0)
              + (chatCounts.checks || 0)
            : null;
          const countChip = isTxnChat
            ? (chatTotal > 0 ? chatTotal : null)
            : (typeof it.count === "number" && it.count > 0 ? it.count : null);

          const selected = isSelected(it);

          // Collapsed rail: icon-only tile. Uses the same gray base +
          // blue-glow-when-selected treatment as the expanded card so
          // both modes read consistently.
          if (collapsed) {
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => clickCard(it)}
                title={cardLabel}
                aria-label={cardLabel}
                aria-current={selected ? "page" : undefined}
                className={`group mx-auto flex items-center justify-center w-10 h-10 rounded-md border transition-all ${
                  selected
                    ? "bg-blue-50 border-blue-400 ring-2 ring-blue-400/60 shadow-md shadow-blue-400/30"
                    : "bg-slate-100 border-slate-200 hover:bg-slate-50 hover:-translate-y-[1px]"
                }`}
                data-testid={`sidebar-todo2-card-${it.key}`}
              >
                <Icon size={16} className={selected ? "text-blue-700" : "text-slate-500"} />
              </button>
            );
          }

          return (
            <button
              key={it.key}
              type="button"
              onClick={() => clickCard(it)}
              aria-current={selected ? "page" : undefined}
              className={`group w-full text-left rounded-md border transition-all ${
                selected
                  ? "bg-blue-50 border-blue-400 ring-2 ring-blue-400/60 shadow-md shadow-blue-400/30"
                  : "bg-slate-100 border-slate-200 hover:bg-slate-50 hover:-translate-y-[1px]"
              }`}
              data-testid={`sidebar-todo2-card-${it.key}`}
            >
              <div className="p-2">
                <div className="flex items-start gap-1.5 mb-1">
                  <div className={`text-[12px] font-semibold leading-tight flex-1 min-w-0 ${
                    selected ? "text-blue-800" : "text-blue-700"
                  }`}>
                    {cardLabel}
                  </div>
                  {countChip !== null && (
                    <span className={`shrink-0 text-[10px] font-mono-num font-semibold border rounded px-1.5 ${
                      selected
                        ? "text-blue-800 bg-white border-blue-200"
                        : "text-slate-700 bg-white border-slate-200"
                    }`}>
                      {countChip}
                    </span>
                  )}
                </div>
                {isTxnChat ? (
                  <div className="text-[11px] text-slate-600 mt-0.5">
                    {chatTotal} {chatTotal === 1 ? "Question" : "Questions"}
                  </div>
                ) : it.detail && (
                  <div className="text-[11px] text-slate-600 mt-0.5 line-clamp-2">
                    {it.detail}
                  </div>
                )}
                <div className={`flex items-center justify-end mt-1 transition-colors ${
                  selected ? "text-blue-600" : "text-slate-400 group-hover:text-blue-600"
                }`}>
                  <ChevronRight size={12} />
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
