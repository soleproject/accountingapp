import React from "react";
import { useNavigate } from "react-router-dom";
import { AreaChart, Area, BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { HelpCircle, Receipt, AlertTriangle, FileUp, ArrowRight, Paperclip } from "lucide-react";
import { Card, Pill, Why, Big, Kpi, Button, fmtDay, fmtWhole, TONE } from "./ui";

const BOOK_STATUS = { complete: ["ok", "Complete"], nearly: ["ok", "Nearly complete"], behind: ["warn", "Catching up"] };

export function BooksCard({ books, fmt, onCatchup, onReview }) {
  const [tone, label] = BOOK_STATUS[books.status] || BOOK_STATUS.behind;
  return (
    <Card eyebrow="Bookkeeping" title="Are my books up to date?" tag={<Pill tone={tone} data-testid="owner-books-status">{label}</Pill>} data-testid="owner-books-card">
      <div className="flex justify-between text-sm">
        <span>Updated through <b>{fmtDay(books.updated_through)}</b></span>
        <span className="text-xs text-slate-500">Last bank sync · {books.last_sync_at ? new Date(books.last_sync_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden mt-3 mb-1.5"><div className="h-full bg-emerald-500 rounded-full transition-[width] duration-700" style={{ width: `${books.categorized_pct}%` }} /></div>
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          <b className="text-slate-900">{books.categorized_pct}%</b> of {books.period_label}'s {books.total_txns} transactions categorized
          {books.awaiting_answers > 0 && <> · <b className="text-amber-700">{books.awaiting_answers} awaiting your answers</b></>}
        </span>
        {books.awaiting_answers > 0 && onReview && (
          <Button onClick={onReview} className="shrink-0" data-testid="owner-books-review-btn">Review</Button>
        )}
      </div>
      <div className="mt-4 divide-y divide-dashed divide-slate-200">
        {books.accounts.map(a => (
          <div key={a.id} className="flex items-center justify-between py-2.5" data-testid={`owner-books-account-${a.id}`}>
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-lg bg-slate-100 grid place-items-center text-[11px] font-semibold text-slate-500">{a.kind === "card" ? "CC" : "BK"}</span>
              <div>
                <div className="text-sm font-semibold">{a.name}</div>
                <div className="text-xs text-slate-500">{a.total ? `${a.reconciled} of ${a.total} reconciled` : "No activity this period"}{a.to_review ? ` · ${a.to_review} to review` : ""}</div>
              </div>
            </div>
            <Pill tone={a.tone}>{a.state}</Pill>
          </div>
        ))}
      </div>
      <div className="text-xs text-slate-500 mt-3">
        {books.period_label} close: <b className="text-slate-900">{books.checkpoints_green} of {books.checkpoints_total} checkpoints</b> green
        {books.preliminary && " — figures are preliminary until open items are resolved."}
      </div>
      {books.cleanup && books.cleanup.total > 0 && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3" data-testid="owner-books-cleanup">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Older items · {books.cleanup.pending + books.cleanup.in_catchup} to clear</div>
            <div className="text-xs text-slate-500">{books.cleanup.done} of {books.cleanup.total} done · older than 30 days, worked at your pace</div>
            <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden mt-2 w-48"><div className="h-full bg-slate-700 rounded-full" style={{ width: `${Math.round(100 * books.cleanup.done / Math.max(1, books.cleanup.total))}%` }} /></div>
          </div>
          {onCatchup && (books.cleanup.pending + books.cleanup.in_catchup) > 0 && (
            <Button onClick={onCatchup} data-testid="owner-books-catchup-btn">{books.cleanup.open_catchup_token ? "Continue catch-up" : "Start a catch-up"}</Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function ProfitCard({ profit, periodLabel, fmt }) {
  const d = profit.delta_pct_vs_prev;
  const up = profit.net >= 0;
  return (
    <Card eyebrow="Profitability" title="Am I making money?" tag={<Pill tone="mute" className="capitalize">{profit.basis} basis</Pill>} data-testid="owner-profit-card">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-xs text-slate-500">Net profit · {periodLabel}</div>
          <Big tone={up ? "up" : "down"} data-testid="owner-profit-net">{fmtWhole(fmt, profit.net)}</Big>
        </div>
        {d != null && <Pill tone={d >= 0 ? "ok" : "bad"}>{d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(0)}% vs {profit.prev_label}</Pill>}
      </div>
      <div className="grid grid-cols-3 gap-3 my-4">
        <Kpi label="Revenue" value={fmtWhole(fmt, profit.revenue)} />
        <Kpi label="Expenses" value={fmtWhole(fmt, profit.expenses)} />
        <Kpi label="Margin" value={profit.margin_pct == null ? "—" : `${profit.margin_pct}%`} />
      </div>
      <div className="h-[110px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={profit.months} barGap={2} margin={{ top: 4, left: 0, right: 0, bottom: 0 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v, n) => [fmt(v), n === "revenue" ? "Revenue" : "Expenses"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
            <Bar dataKey="revenue" fill="#0891b2" radius={[3, 3, 0, 0]} />
            <Bar dataKey="expenses" fill="#334155" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex gap-4 text-[11px] text-slate-500 mt-1"><span><i className="inline-block w-4 h-0.5 bg-cyan-600 align-middle mr-1.5" />Revenue</span><span><i className="inline-block w-4 h-0.5 bg-slate-700 align-middle mr-1.5" />Expenses</span></div>
      <Why testId="owner-profit-why">{profit.why}</Why>
    </Card>
  );
}

export function CashCard({ cash, fmt }) {
  const conf = cash.confidence || {};
  const confTone = { high: "ok", medium: "warn", low: "bad" }[conf.level] || "mute";
  return (
    <Card eyebrow="Cash outlook · next 30 days" title="Can I cover what's coming due?" tag={<Pill tone={confTone} title={(conf.reasons || []).join(" · ")} data-testid="owner-cash-confidence">Forecast confidence · <span className="capitalize">{conf.level || "—"}</span></Pill>} data-testid="owner-cash-card">
      <div className="text-xs text-slate-500">Cash available now · {cash.accounts.length} account{cash.accounts.length === 1 ? "" : "s"} · as of {fmtDay(cash.accounts[0]?.as_of || "")}</div>
      <Big data-testid="owner-cash-today">{fmtWhole(fmt, cash.cash_today)}</Big>
      <div className="grid grid-cols-3 gap-3 my-4">
        <Kpi label="Expected collections" value={`+ ${fmtWhole(fmt, cash.collections_30d)}`} tone="up" />
        <Kpi label="Upcoming obligations" value={`− ${fmtWhole(fmt, Math.abs(cash.obligations_30d))}`} tone="down" />
        <Kpi label="Ending cash · 30 days" value={fmtWhole(fmt, cash.ending_30d)} />
      </div>
      <div className="h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={cash.timeline} margin={{ top: 4, left: 0, right: 0, bottom: 0 }}>
            <defs><linearGradient id="ownerCash" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity={0.45} /><stop offset="100%" stopColor="#22d3ee" stopOpacity={0.03} /></linearGradient></defs>
            <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} interval={9} />
            <Tooltip formatter={(v, n) => [fmt(v), n === "conservative" ? "If no invoices get paid" : "Expected"]} labelFormatter={fmtDay} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
            <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="3 3" />
            <Area type="monotone" dataKey="cash" stroke="#0891b2" strokeWidth={2} fill="url(#ownerCash)" />
            <Area type="monotone" dataKey="conservative" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="5 4" fill="none" connectNulls />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex gap-4 text-[11px] text-slate-500 mt-1">
        <span><i className="inline-block w-4 h-0.5 bg-cyan-600 align-middle mr-1.5" />Expected</span>
        <span><i className="inline-block w-4 border-t border-dashed border-slate-400 align-middle mr-1.5" />If no invoices get paid — lowest point {fmtWhole(fmt, cash.conservative_low_30d ?? cash.low_30d)}</span>
      </div>
      <Why testId="owner-cash-why">{cash.why}</Why>
    </Card>
  );
}

const ICONS = { question: HelpCircle, receipt: Receipt, receipt_verify: Paperclip, invoice: AlertTriangle, statement: FileUp };

export function AttentionCard({ items, onAction }) {
  return (
    <Card eyebrow="Your attention" title="What needs me?" tag={<Pill tone={items.length ? "warn" : "ok"} data-testid="owner-attention-count">{items.length ? `${items.length} item${items.length > 1 ? "s" : ""}` : "All clear"}</Pill>} data-testid="owner-attention-card">
      {items.length === 0 && <div className="text-sm text-slate-500 py-6">Nothing needs you right now. Your team has it handled.</div>}
      <div className="divide-y divide-slate-200">
        {items.map(it => {
          const Icon = ICONS[it.kind] || HelpCircle;
          return (
            <div key={it.id} className="flex items-center gap-3.5 py-3.5" data-testid={`owner-attention-${it.id}`}>
              <span className={`flex-none w-9 h-9 rounded-xl grid place-items-center border ${TONE[it.tone] || TONE.mute}`}><Icon size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">{it.title}</div>
                <div className="text-xs text-slate-500 truncate">{it.subtitle}</div>
              </div>
              <Button primary={it.kind === "question"} onClick={() => onAction(it)} data-testid={`owner-attention-action-${it.id}`}>{it.action_label}</Button>
            </div>
          );
        })}
      </div>
      <div className="text-xs text-slate-500 mt-3">Routine bookkeeping is handled. These need your input or a decision.</div>
    </Card>
  );
}

export function TeamStrip({ team, companyId }) {
  const navigate = useNavigate();
  const w = team.weekly;
  return (
    <Card className="mt-5" data-testid="owner-team-strip">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] tracking-[0.12em] uppercase text-slate-500 font-semibold mb-1">Your bookkeeping team</div>
          <h2 className="font-heading text-xl text-slate-900">Here's what we handled this week <span className="text-sm text-slate-500 font-sans">· {w.label}</span></h2>
        </div>
        <div className="flex items-center gap-2">
          {team.members.map(m => <Pill key={m.name} tone="mute">{m.name}</Pill>)}
          <Button onClick={() => navigate("/owner/team")} data-testid="owner-team-strip-link">Your team <ArrowRight size={12} className="inline ml-1" /></Button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
        {[["Transactions categorized", w.categorized], ["Receipts matched to bank activity", w.receipts_matched], ["Bank transactions reconciled", w.reconciled]].map(([l, v]) => (
          <div key={l} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"><div className="font-mono-num text-2xl font-medium">{v}</div><div className="text-xs text-slate-500">{l}</div></div>
        ))}
      </div>
    </Card>
  );
}
