import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Send, AlertTriangle, PauseCircle, CheckCircle2, ChevronDown,
  Wallet2, TrendingUp, TrendingDown, Building2, ArrowRight, Mail, X,
  Check, ArrowRight as ArrowRightIcon,
} from "lucide-react";

// --------------- helpers ---------------
function monthKey(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(k) {
  const [y, m] = k.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

// Compact greeting-name → "Priya" / "Priya Patel" / "priya" all handled.
function firstName(full) {
  if (!full) return "there";
  return String(full).trim().split(/\s+/)[0];
}

function timeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

// Tiny inline SVG donut chart. `slices` = [{amount, color}], `size` in px.
function DonutChart({ slices, size = 148, thickness = 22 }) {
  const total = slices.reduce((s, x) => s + (x.amount || 0), 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f1f5f9" strokeWidth={thickness} />
      {total > 0 && slices.map((s, i) => {
        const frac = (s.amount || 0) / total;
        const len = frac * circ;
        const dashOffset = -acc;
        acc += len;
        return (
          <circle
            key={i}
            cx={cx} cy={cy} r={r} fill="none"
            stroke={s.color} strokeWidth={thickness}
            strokeDasharray={`${len} ${circ - len}`}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        );
      })}
    </svg>
  );
}

// --------------- Firm at a Glance view ---------------
export default function FirmAtAGlance({ userName }) {
  const { currentId, current } = useCompany();
  const [month, setMonth] = useState(() => monthKey(0));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentId) return;
    setLoading(true);
    api.get(`/companies/${currentId}/dashboard/firm-glance`, { params: { month } })
      .then(r => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [currentId, month]);

  const monthOptions = useMemo(() => {
    // 12 rolling months, newest first, so users can flip back a year.
    const arr = [];
    for (let i = 0; i > -12; i--) arr.push(monthKey(i));
    return arr;
  }, []);

  const greeting = `Good ${timeOfDay()}, ${firstName(userName)}!`;

  return (
    <div className="space-y-6">
      {/* Greeting header */}
      <div className="text-center">
        <h1 className="font-heading text-3xl md:text-4xl font-bold tracking-tight text-slate-900">
          {greeting}
        </h1>
      </div>

      {/* Monthly close 3-step to-do list */}
      <MonthlyTodos todos={data?.todos} loading={loading} />

      <div className="flex items-center justify-between">
        <h2 className="font-heading text-lg font-semibold text-slate-800">Firm at a glance</h2>
        <div className="text-xs text-slate-500">
          {current?.name} · {monthLabel(month)}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* LEFT: Sales & Get Paid Funnel spans 2 cols */}
        <div className="lg:col-span-2 rounded-xl border bg-white overflow-hidden" data-testid="firm-glance-sales-funnel">
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              Sales & Get Paid Funnel
            </div>
            <MonthPicker value={month} onChange={setMonth} options={monthOptions} />
          </div>
          <div className="grid grid-cols-4 gap-0 border-t">
            {/* CTA card */}
            <div className="p-4 border-r bg-slate-50/60">
              <div className="text-sm font-semibold text-slate-900">Create a new payment request</div>
              <Link
                to="/invoices"
                className="text-[11px] text-slate-500 hover:text-slate-700 underline block mt-1"
                data-testid="firm-glance-learn-more"
              >
                Learn more
              </Link>
              <Link
                to="/invoices"
                className="mt-3 inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                data-testid="firm-glance-request-payment"
              >
                Request pay… <ChevronDown size={12} />
              </Link>
            </div>
            <FunnelCol
              title="Not paid"
              amount={data?.sales_funnel?.not_paid?.amount}
              stripe="bg-emerald-400"
              loading={loading}
              testId="firm-glance-not-paid"
              footer={
                data?.sales_funnel?.not_paid?.overdue_count ? (
                  <OverduePopover
                    overdueCount={data.sales_funnel.not_paid.overdue_count}
                    invoices={data.sales_funnel.not_paid.overdue_invoices || []}
                    onReminderSent={(iid, sentAt) => {
                      setData(d => {
                        if (!d) return d;
                        return {
                          ...d,
                          sales_funnel: {
                            ...d.sales_funnel,
                            not_paid: {
                              ...d.sales_funnel.not_paid,
                              overdue_invoices: d.sales_funnel.not_paid.overdue_invoices.map(
                                inv => inv.id === iid ? { ...inv, last_reminder_sent_at: sentAt } : inv
                              ),
                            },
                          },
                        };
                      });
                    }}
                  />
                ) : null
              }
            />
            <FunnelCol
              title="Paid"
              amount={data?.sales_funnel?.paid?.amount}
              stripe="bg-emerald-500"
              badgeIcon={<PauseCircle size={11} />}
              badgeText={data?.sales_funnel?.paid?.on_hold_count
                ? `${data.sales_funnel.paid.on_hold_count} deposit on hold`
                : null}
              badgeTone="rose"
              loading={loading}
              testId="firm-glance-paid"
            />
            <FunnelCol
              title="Deposited"
              amount={data?.sales_funnel?.deposited?.amount}
              stripe="bg-emerald-600"
              badgeIcon={<CheckCircle2 size={11} />}
              badgeText={data?.sales_funnel?.deposited?.count
                ? `${data.sales_funnel.deposited.count} deposited`
                : null}
              badgeTone="emerald"
              loading={loading}
              testId="firm-glance-deposited"
            />
          </div>
        </div>

        {/* RIGHT: Bank Accounts panel */}
        <div className="rounded-xl border bg-white p-5" data-testid="firm-glance-bank-accounts">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              Bank Accounts
            </div>
            <div className="text-[11px] text-slate-500">As of today</div>
          </div>
          <div className="text-xs text-slate-500 mt-1">Today’s bank balance</div>
          <div className="font-mono-num text-3xl font-bold text-slate-900 mb-3">
            {fmtMoney(data?.bank_accounts?.total_balance ?? 0)}
          </div>
          <div className="space-y-3">
            {(data?.bank_accounts?.accounts || []).map(a => (
              <div key={a.id} className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                  <Building2 size={14} className="text-indigo-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate">
                    {a.name} <span className="text-slate-400 font-normal">({a.code})</span>
                  </div>
                  <div className="text-[11px] text-slate-500">Bank balance</div>
                  <div className="text-[11px] text-slate-500">Updated moments ago</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono-num text-sm font-semibold text-slate-900">
                    {fmtMoney(a.balance)}
                  </div>
                  {a.to_review > 0 && (
                    <Link
                      to={`/accounting/reconcile?bank=${a.id}`}
                      className="text-[11px] text-indigo-600 hover:text-indigo-800 hover:underline"
                      data-testid={`firm-glance-bank-review-${a.id}`}
                    >
                      {a.to_review} to review
                    </Link>
                  )}
                </div>
              </div>
            ))}
            {!loading && !(data?.bank_accounts?.accounts || []).length && (
              <div className="text-xs text-slate-500 py-2">
                No bank accounts connected yet.{" "}
                <Link to="/connections" className="text-indigo-600 hover:underline">Connect a bank →</Link>
              </div>
            )}
          </div>
          <Link
            to="/connections"
            className="mt-4 inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700"
          >
            Go to registers <ArrowRight size={11} />
          </Link>
        </div>
      </div>

      {/* Second row: P&L + Expenses */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Profit & Loss */}
        <div className="rounded-xl border bg-white p-5" data-testid="firm-glance-pl">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              Profit & Loss
            </div>
            <MonthPicker value={month} onChange={setMonth} options={monthOptions} />
          </div>
          <div className="text-xs text-slate-500">Net profit for {monthLabel(month).split(" ")[0]}</div>
          <div className="flex items-baseline gap-2">
            <div className="font-mono-num text-3xl font-bold text-slate-900">
              {fmtMoney(data?.profit_loss?.net_profit ?? 0)}
            </div>
            {data?.profit_loss?.delta_pct_vs_last_quarter != null && (
              <div className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 text-[10px] px-2 py-0.5 font-medium">
                {data.profit_loss.delta_pct_vs_last_quarter >= 0 ? "↑" : "↓"} {Math.abs(data.profit_loss.delta_pct_vs_last_quarter)}%
              </div>
            )}
          </div>
          <QuarterDelta pct={data?.profit_loss?.delta_pct_vs_last_quarter} label="from this time last quarter" />

          <div className="mt-4 space-y-3">
            <PLBar
              label="Income"
              amount={data?.profit_loss?.income}
              max={Math.max(data?.profit_loss?.income || 1, data?.profit_loss?.expense || 1)}
              color="bg-emerald-500"
              reviewCount={data?.profit_loss?.income_to_review}
              testId="firm-glance-pl-income"
            />
            <PLBar
              label="Expense"
              amount={data?.profit_loss?.expense}
              max={Math.max(data?.profit_loss?.income || 1, data?.profit_loss?.expense || 1)}
              color="bg-teal-500"
              reviewCount={data?.profit_loss?.expense_to_review}
              testId="firm-glance-pl-expense"
            />
          </div>
          <Link
            to="/reports/income-statement"
            className="mt-4 inline-block text-[11px] text-slate-600 hover:text-slate-900 underline"
            data-testid="firm-glance-pl-report"
          >
            View profit and loss report
          </Link>
        </div>

        {/* Expenses donut */}
        <div className="rounded-xl border bg-white p-5" data-testid="firm-glance-expenses">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              Expenses
            </div>
            <MonthPicker value={month} onChange={setMonth} options={monthOptions} />
          </div>
          <div className="text-xs text-slate-500">Spending for {monthLabel(month).split(" ")[0]}</div>
          <div className="flex items-baseline gap-2">
            <div className="font-mono-num text-3xl font-bold text-slate-900">
              {fmtMoney(data?.expenses?.total ?? 0)}
            </div>
            {data?.expenses?.delta_pct_vs_last_month != null && (
              <div className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 text-[10px] px-2 py-0.5 font-medium">
                {data.expenses.delta_pct_vs_last_month >= 0 ? "↑" : "↓"} {Math.abs(data.expenses.delta_pct_vs_last_month)}%
              </div>
            )}
          </div>
          <QuarterDelta pct={data?.expenses?.delta_pct_vs_last_month} label="from this time last month" invert />

          <div className="mt-4 flex items-center gap-5">
            <DonutChart slices={data?.expenses?.categories || []} />
            <div className="flex-1 min-w-0 space-y-1.5">
              {(data?.expenses?.categories || []).map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color }} />
                  <span className="flex-1 truncate text-slate-700">{c.name}</span>
                  <span className="font-mono-num text-slate-500 tabular-nums">{fmtMoney(c.amount)}</span>
                </div>
              ))}
              {!loading && !(data?.expenses?.categories || []).length && (
                <div className="text-xs text-slate-500">No expenses in this month.</div>
              )}
            </div>
          </div>
          <Link
            to="/reports/income-statement"
            className="mt-4 inline-block text-[11px] text-slate-600 hover:text-slate-900 underline"
            data-testid="firm-glance-expenses-report"
          >
            View all spending
          </Link>
        </div>
      </div>
    </div>
  );
}

// --------------- sub-components ---------------

function MonthlyTodos({ todos, loading }) {
  const steps = todos ? [todos.step1, todos.step2, todos.step3] : [null, null, null];
  return (
    <div className="rounded-xl border bg-white p-5" data-testid="dashboard-todos">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
            Monthly close checklist
          </div>
          <div className="text-sm text-slate-700 mt-0.5">
            Three steps to close the books faster.
          </div>
        </div>
        {todos && (
          <div className="text-[11px] text-slate-500">
            {[todos.step1, todos.step2, todos.step3].filter(s => (s?.count ?? 0) === 0).length} of 3 done
          </div>
        )}
      </div>

      {/* Steps rail — connector line runs behind the number circles */}
      <div className="relative">
        <div className="absolute left-0 right-0 top-6 h-0.5 bg-slate-100 -z-0" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative">
          {steps.map((step, i) => (
            <TodoStep
              key={i}
              index={i + 1}
              step={step}
              loading={loading}
              isLast={i === steps.length - 1}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TodoStep({ index, step, loading, isLast }) {
  const done = !loading && step && (step.count || 0) === 0;
  const count = step?.count ?? 0;
  return (
    <div className="relative flex items-start gap-3" data-testid={`dashboard-todo-step-${index}`}>
      {/* Numbered / checked circle */}
      <div
        className={`relative z-10 shrink-0 w-12 h-12 rounded-full border-2 flex items-center justify-center font-heading font-bold text-lg transition-colors ${
          done
            ? "bg-emerald-500 border-emerald-500 text-white"
            : count > 0
              ? "bg-white border-indigo-500 text-indigo-600"
              : "bg-white border-slate-300 text-slate-400"
        }`}
        aria-label={done ? "Step complete" : `Step ${index}`}
      >
        {done ? <Check size={20} /> : index}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-slate-50/40 hover:bg-slate-50 transition-colors p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-slate-900 truncate">
                Step {index}: {step?.title || (loading ? "Loading…" : "")}
              </div>
              {step?.coming_soon && (
                <span className="text-[9px] uppercase tracking-wider text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                  Preview
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
              {step?.subtitle || " "}
            </div>
          </div>
          {step && (
            <div className="text-right shrink-0">
              <div className={`font-mono-num text-2xl font-bold leading-none ${done ? "text-emerald-600" : count > 0 ? "text-slate-900" : "text-slate-400"}`}>
                {count}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-slate-400 mt-0.5">
                {step.unit}
              </div>
            </div>
          )}
        </div>

        {step && !done && (
          <Link
            to={step.cta_link}
            data-testid={`dashboard-todo-cta-${index}`}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium px-3 py-1.5 transition-colors"
          >
            {step.cta_label}
            <ArrowRightIcon size={12} />
          </Link>
        )}
        {step && done && (
          <div className="mt-3 inline-flex items-center gap-1 text-emerald-700 text-xs font-medium">
            <CheckCircle2 size={13} />
            All caught up
          </div>
        )}
      </div>
    </div>
  );
}

function MonthPicker({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-[11px] rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-600 hover:border-slate-300 focus:outline-none focus:ring-1 focus:ring-slate-300"
      data-testid="firm-glance-month-picker"
    >
      {options.map(k => (
        <option key={k} value={k}>{monthLabel(k)}</option>
      ))}
    </select>
  );
}

function FunnelCol({ title, amount, stripe, badgeIcon, badgeText, badgeTone, loading, testId, footer }) {
  const toneMap = {
    amber:   "bg-amber-50 text-amber-700",
    rose:    "bg-rose-50 text-rose-700",
    emerald: "bg-emerald-50 text-emerald-700",
  };
  return (
    <div className="p-4 border-r last:border-r-0 relative" data-testid={testId}>
      <div className={`absolute top-0 left-0 right-0 h-1 ${stripe}`} />
      <div className="text-xs font-medium text-slate-600 mt-1">{title}</div>
      <div className="font-mono-num text-2xl font-bold text-slate-900 mt-1">
        {loading ? "…" : fmtMoney(amount ?? 0)}
      </div>
      {badgeText && (
        <div className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${toneMap[badgeTone] || "bg-slate-100 text-slate-700"}`}>
          {badgeIcon}
          <span>{badgeText}</span>
        </div>
      )}
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
}

// ------- Overdue-invoices popover with inline "Send reminder" ---------
function OverduePopover({ overdueCount, invoices, onReminderSent }) {
  const { currentId } = useCompany();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState({}); // id → boolean
  const [emailOverrides, setEmailOverrides] = useState({}); // id → email

  const sendReminder = async (inv) => {
    const email = emailOverrides[inv.id] ?? inv.contact_email ?? "";
    if (!email) {
      toast.error("This customer doesn't have an email on file. Enter one to send.");
      return;
    }
    setSending(s => ({ ...s, [inv.id]: true }));
    try {
      await api.post(`/companies/${currentId}/communications/dunning`, {
        invoice_id: inv.id,
        to: email,
      });
      const sentAt = new Date().toISOString();
      onReminderSent?.(inv.id, sentAt);
      toast.success(`Reminder sent to ${email} — logged in Communications`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to send reminder");
    } finally {
      setSending(s => ({ ...s, [inv.id]: false }));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-1 rounded-full bg-amber-50 text-amber-700 px-2 py-0.5 text-[10px] font-medium hover:bg-amber-100 transition"
          data-testid="firm-glance-overdue-trigger"
        >
          <AlertTriangle size={11} />
          <span>{overdueCount} overdue invoice{overdueCount === 1 ? "" : "s"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[420px] p-0 border-slate-200 shadow-xl"
        data-testid="firm-glance-overdue-popover"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b bg-amber-50/70">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-600" />
            <div className="text-sm font-semibold text-slate-900">
              {overdueCount} overdue invoice{overdueCount === 1 ? "" : "s"}
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[380px] overflow-y-auto">
          {invoices.length === 0 ? (
            <div className="text-xs text-slate-500 p-4">No overdue invoices to load.</div>
          ) : invoices.map(inv => {
            const emailOnFile = inv.contact_email;
            const displayEmail = emailOverrides[inv.id] ?? emailOnFile ?? "";
            const recentlySent = inv.last_reminder_sent_at
              && (Date.now() - new Date(inv.last_reminder_sent_at).getTime()) < 24 * 3600 * 1000;
            return (
              <div key={inv.id} className="px-4 py-3 border-b last:border-b-0" data-testid={`overdue-row-${inv.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-slate-900 truncate">{inv.contact_name}</div>
                    <div className="text-[11px] text-slate-500">
                      #{inv.number || "—"} · {inv.days_overdue} day{inv.days_overdue === 1 ? "" : "s"} overdue
                    </div>
                  </div>
                  <div className="font-mono-num text-sm font-semibold text-slate-900 shrink-0">
                    {fmtMoney(inv.amount)}
                  </div>
                </div>
                {!emailOnFile && (
                  <div className="mt-2">
                    <input
                      type="email"
                      placeholder="customer@example.com"
                      value={emailOverrides[inv.id] || ""}
                      onChange={(e) => setEmailOverrides(prev => ({ ...prev, [inv.id]: e.target.value }))}
                      className="w-full text-xs rounded-md border border-slate-200 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      data-testid={`overdue-email-input-${inv.id}`}
                    />
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between">
                  <div className="text-[10px] text-slate-400 truncate">
                    {displayEmail && <span className="inline-flex items-center gap-1"><Mail size={10} />{displayEmail}</span>}
                  </div>
                  {recentlySent ? (
                    <div className="inline-flex items-center gap-1 text-[11px] text-emerald-700 font-medium">
                      <CheckCircle2 size={12} /> Reminder sent
                    </div>
                  ) : (
                    <button
                      onClick={() => sendReminder(inv)}
                      disabled={sending[inv.id] || !displayEmail}
                      data-testid={`overdue-send-${inv.id}`}
                      className="inline-flex items-center gap-1 rounded-md bg-indigo-600 text-white px-2.5 py-1 text-[11px] font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      <Send size={11} />
                      {sending[inv.id] ? "Sending…" : "Send reminder"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="px-4 py-2 border-t bg-slate-50 text-[10px] text-slate-500">
          Each reminder is logged in the Communications inbox.
        </div>
      </PopoverContent>
    </Popover>
  );
}

function QuarterDelta({ pct, label, invert = false }) {
  if (pct == null) return <div className="text-[11px] text-slate-500 mt-1">&nbsp;</div>;
  const up = pct >= 0;
  // For "expenses", up-arrow is bad news; invert the color meaning
  const goodColor = invert ? "text-rose-600" : "text-emerald-600";
  const badColor  = invert ? "text-emerald-600" : "text-rose-600";
  const tone = up ? goodColor : badColor;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <div className={`text-[11px] mt-1 flex items-center gap-1 ${tone}`}>
      <Icon size={11} /> {up ? "Up" : "Down"} {Math.abs(pct)}% {label}
    </div>
  );
}

function PLBar({ label, amount, max, color, reviewCount, testId }) {
  const w = Math.min(100, Math.max(0, ((amount || 0) / (max || 1)) * 100));
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between">
        <div className="font-mono-num font-semibold text-slate-900">{fmtMoney(amount ?? 0)}</div>
        {reviewCount ? (
          <div className="text-[11px] text-slate-500">{reviewCount} to review</div>
        ) : null}
      </div>
      <div className="mt-1 h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      <div className="text-[11px] text-slate-500 mt-1">{label}</div>
    </div>
  );
}
