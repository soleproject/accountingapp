import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { getCurrentOrgId } from '@/lib/auth/org';
import { timeDb } from '@/lib/perf/db-timing';

function money(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function int(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

type RawBundle = {
  cash?: Record<string, unknown> | null;
  ar?: Record<string, unknown> | null;
  ap?: Record<string, unknown> | null;
  transactions?: Record<string, unknown> | null;
  cashActivity?: Array<Record<string, unknown>> | null;
  transactionVolume?: Array<Record<string, unknown>> | null;
};

export type DashboardSummary = {
  generatedAt: string;
  cash: {
    cashBalance: number | null;
    incoming30: number;
    outgoing30: number;
    net30: number;
  };
  ar: {
    outstandingInvoices: number;
    overdueInvoices: number;
    dueSoonInvoices: number;
    openInvoiceCount: number;
  };
  ap: {
    outstandingBills: number;
    overdueBills: number;
    dueSoonBills: number;
    openBillCount: number;
  };
  transactions: {
    transactionsToClassify: number;
    transactionsToClassifyAmount: number;
    depositsToReview: number;
    aiToVerify: number;
  };
  cashActivity: Array<{ label: string; incoming: number; outgoing: number; net: number }>;
  transactionVolume: Array<{ label: string; deposits: number; withdrawals: number; toClassify: number }>;
  aging: Array<{ label: string; ar: number; ap: number }>;
};

export async function loadDashboardSummary(organizationId?: string): Promise<DashboardSummary> {
  const orgId = organizationId ?? await getCurrentOrgId();
  const [bundle] = await timeDb('dashboard.summaryBundle', () => db.execute(sql`
    with invoice_lines_total as (
      select invoice_id, coalesce(sum(amount), 0)::numeric as line_total from invoice_lines group by invoice_id
    ), invoice_paid as (
      select invoice_id, coalesce(sum(amount), 0)::numeric as paid
      from payments
      where organization_id = ${orgId} and type = 'received' and invoice_id is not null
      group by invoice_id
    ), invoice_open as (
      select i.id, i.due_date,
        greatest(coalesce(ilt.line_total, 0) + coalesce(i.tax_amount, 0) - coalesce(i.discount_amount, 0) - coalesce(ip.paid, 0), 0)::numeric as outstanding
      from invoices i
      left join invoice_lines_total ilt on ilt.invoice_id = i.id
      left join invoice_paid ip on ip.invoice_id = i.id
      where i.organization_id = ${orgId} and i.posted = true and (i.status is null or i.status <> 'paid')
    ), bill_lines_total as (
      select bill_id, coalesce(sum(amount), 0)::numeric as line_total from bill_lines group by bill_id
    ), modern_bill_paid as (
      select bpa.bill_id, coalesce(sum(bpa.amount_applied), 0)::numeric as paid
      from bill_payment_applications bpa
      join bill_payments bp on bp.id = bpa.bill_payment_id
      where bp.organization_id = ${orgId}
      group by bpa.bill_id
    ), legacy_bill_paid as (
      select bill_id, coalesce(sum(amount), 0)::numeric as paid
      from payments
      where organization_id = ${orgId} and type = 'sent' and bill_id is not null
      group by bill_id
    ), bill_open as (
      select b.id, b.due_date,
        greatest(coalesce(blt.line_total, 0) + coalesce(b.tax_amount, 0) - coalesce(b.discount_amount, 0) - coalesce(mbp.paid, 0) - coalesce(lbp.paid, 0), 0)::numeric as outstanding
      from bills b
      left join bill_lines_total blt on blt.bill_id = b.id
      left join modern_bill_paid mbp on mbp.bill_id = b.id
      left join legacy_bill_paid lbp on lbp.bill_id = b.id
      where b.organization_id = ${orgId} and b.status = 'posted'
    ), transaction_base as (
      select date, type, coalesce(amount, 0)::float8 as amount, reviewed, verified, category_account_id, journal_entry_id
      from transactions
      where organization_id = ${orgId}
    ), cash_weeks as (
      select to_char(date_trunc('week', date)::date, 'Mon DD') as label,
        coalesce(sum(case when type = 'deposit' then amount else 0 end), 0)::float8 as incoming,
        abs(coalesce(sum(case when type = 'withdrawal' then amount else 0 end), 0))::float8 as outgoing,
        coalesce(sum(case when type = 'deposit' then amount else -abs(amount) end), 0)::float8 as net,
        date_trunc('week', date)::date as sort_key
      from transaction_base
      where date >= current_date - interval '30 days'
      group by sort_key
      order by sort_key
    ), transaction_months as (
      select to_char(date_trunc('month', date)::date, 'Mon YYYY') as label,
        count(*) filter (where type = 'deposit')::int as deposits,
        count(*) filter (where type = 'withdrawal')::int as withdrawals,
        count(*) filter (where journal_entry_id is null and (category_account_id is null or reviewed = false or verified = false))::int as to_classify,
        date_trunc('month', date)::date as sort_key
      from transaction_base
      where date >= date_trunc('month', current_date) - interval '1 month'
      group by sort_key
      order by sort_key
    )
    select jsonb_build_object(
      'cash', jsonb_build_object(
        'cashBalance', (select cash_balance from dashboard_snapshots where org_id = ${orgId} limit 1),
        'incoming30', (select coalesce(sum(amount), 0)::float8 from transaction_base where type = 'deposit' and date >= current_date - interval '30 days'),
        'outgoing30', (select abs(coalesce(sum(amount), 0))::float8 from transaction_base where type = 'withdrawal' and date >= current_date - interval '30 days'),
        'net30', (select coalesce(sum(case when type = 'deposit' then amount else -abs(amount) end), 0)::float8 from transaction_base where date >= current_date - interval '30 days')
      ),
      'ar', jsonb_build_object(
        'outstandingInvoices', (select coalesce(sum(outstanding), 0)::float8 from invoice_open where outstanding > 0),
        'overdueInvoices', (select coalesce(sum(outstanding), 0)::float8 from invoice_open where outstanding > 0 and due_date is not null and due_date < current_date),
        'dueSoonInvoices', (select coalesce(sum(outstanding), 0)::float8 from invoice_open where outstanding > 0 and due_date is not null and due_date >= current_date and due_date <= current_date + interval '30 days'),
        'openInvoiceCount', (select count(*)::int from invoice_open where outstanding > 0),
        'agingCurrent', (select coalesce(sum(outstanding), 0)::float8 from invoice_open where outstanding > 0 and (due_date is null or due_date >= current_date)),
        'aging30', (select coalesce(sum(outstanding), 0)::float8 from invoice_open where outstanding > 0 and due_date is not null and current_date - due_date between 1 and 30),
        'aging60', (select coalesce(sum(outstanding), 0)::float8 from invoice_open where outstanding > 0 and due_date is not null and current_date - due_date between 31 and 60),
        'aging90', (select coalesce(sum(outstanding), 0)::float8 from invoice_open where outstanding > 0 and due_date is not null and current_date - due_date between 61 and 90),
        'aging90Plus', (select coalesce(sum(outstanding), 0)::float8 from invoice_open where outstanding > 0 and due_date is not null and current_date - due_date > 90)
      ),
      'ap', jsonb_build_object(
        'outstandingBills', (select coalesce(sum(outstanding), 0)::float8 from bill_open where outstanding > 0),
        'overdueBills', (select coalesce(sum(outstanding), 0)::float8 from bill_open where outstanding > 0 and due_date is not null and due_date < current_date),
        'dueSoonBills', (select coalesce(sum(outstanding), 0)::float8 from bill_open where outstanding > 0 and due_date is not null and due_date >= current_date and due_date <= current_date + interval '30 days'),
        'openBillCount', (select count(*)::int from bill_open where outstanding > 0),
        'agingCurrent', (select coalesce(sum(outstanding), 0)::float8 from bill_open where outstanding > 0 and (due_date is null or due_date >= current_date)),
        'aging30', (select coalesce(sum(outstanding), 0)::float8 from bill_open where outstanding > 0 and due_date is not null and current_date - due_date between 1 and 30),
        'aging60', (select coalesce(sum(outstanding), 0)::float8 from bill_open where outstanding > 0 and due_date is not null and current_date - due_date between 31 and 60),
        'aging90', (select coalesce(sum(outstanding), 0)::float8 from bill_open where outstanding > 0 and due_date is not null and current_date - due_date between 61 and 90),
        'aging90Plus', (select coalesce(sum(outstanding), 0)::float8 from bill_open where outstanding > 0 and due_date is not null and current_date - due_date > 90)
      ),
      'transactions', jsonb_build_object(
        'transactionsToClassify', (select count(*)::int from transaction_base where journal_entry_id is null and (category_account_id is null or reviewed = false or verified = false)),
        'transactionsToClassifyAmount', (select coalesce(sum(abs(amount)), 0)::float8 from transaction_base where journal_entry_id is null and (category_account_id is null or reviewed = false or verified = false)),
        'depositsToReview', (select count(*)::int from transaction_base where type = 'deposit' and (reviewed = false or reviewed is null)),
        'aiToVerify', (select count(*)::int from transaction_base where reviewed = true and verified = false)
      ),
      'cashActivity', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'incoming', incoming, 'outgoing', outgoing, 'net', net) order by sort_key) from cash_weeks), '[]'::jsonb),
      'transactionVolume', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'deposits', deposits, 'withdrawals', withdrawals, 'toClassify', to_classify) order by sort_key) from transaction_months), '[]'::jsonb)
    ) as data
  `)) as unknown as [{ data: RawBundle }];

  const data = bundle?.data ?? {};
  const cash = data.cash ?? {};
  const ar = data.ar ?? {};
  const ap = data.ap ?? {};
  const transactions = data.transactions ?? {};
  const cashBalanceRaw = cash.cashBalance;

  return {
    generatedAt: new Date().toISOString(),
    cash: {
      cashBalance: cashBalanceRaw == null ? null : money(cashBalanceRaw),
      incoming30: money(cash.incoming30),
      outgoing30: money(cash.outgoing30),
      net30: money(cash.net30),
    },
    ar: {
      outstandingInvoices: money(ar.outstandingInvoices),
      overdueInvoices: money(ar.overdueInvoices),
      dueSoonInvoices: money(ar.dueSoonInvoices),
      openInvoiceCount: int(ar.openInvoiceCount),
    },
    ap: {
      outstandingBills: money(ap.outstandingBills),
      overdueBills: money(ap.overdueBills),
      dueSoonBills: money(ap.dueSoonBills),
      openBillCount: int(ap.openBillCount),
    },
    transactions: {
      transactionsToClassify: int(transactions.transactionsToClassify),
      transactionsToClassifyAmount: money(transactions.transactionsToClassifyAmount),
      depositsToReview: int(transactions.depositsToReview),
      aiToVerify: int(transactions.aiToVerify),
    },
    cashActivity: arr<Record<string, unknown>>(data.cashActivity).map((row) => ({
      label: String(row.label ?? ''),
      incoming: money(row.incoming),
      outgoing: money(row.outgoing),
      net: money(row.net),
    })),
    transactionVolume: arr<Record<string, unknown>>(data.transactionVolume).map((row) => ({
      label: String(row.label ?? ''),
      deposits: int(row.deposits),
      withdrawals: int(row.withdrawals),
      toClassify: int(row.toClassify),
    })),
    aging: [
      { label: 'Current', ar: money(ar.agingCurrent), ap: money(ap.agingCurrent) },
      { label: '1–30', ar: money(ar.aging30), ap: money(ap.aging30) },
      { label: '31–60', ar: money(ar.aging60), ap: money(ap.aging60) },
      { label: '61–90', ar: money(ar.aging90), ap: money(ap.aging90) },
      { label: '90+', ar: money(ar.aging90Plus), ap: money(ap.aging90Plus) },
    ],
  };
}
