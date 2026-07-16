import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { getCurrentOrgId } from '@/lib/auth/org';

const PAGE_SIZE = 50;
const VALID_FILTERS = ['outstanding', 'overdue', 'due30', 'paid_month'] as const;
export type BillFilter = (typeof VALID_FILTERS)[number];
export interface BillsSearchParams { page?: string | null; filter?: string | null }
export interface BillsSummary { outstandingTotal: number; openCount: number; overdueTotal: number; dueIn30Total: number; paidThisMonth: number; agingCurrent: number; aging30: number; aging60: number; aging90: number; aging90Plus: number }
export interface BillRow { id: string; billNumber: string | null; billDate: string; dueDate: string | null; status: string; memo: string | null; contactName: string | null; grossTotal: number; appliedTotal: number; outstanding: number }

function isoOffset(days: number): string { return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10); }
function isoToday(): string { return new Date().toISOString().slice(0, 10); }
function startOfMonth(): string { return new Date().toISOString().slice(0, 7) + '-01'; }
function money(v: unknown): number { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }
function toSummary(raw: Record<string, unknown> | null | undefined): BillsSummary { return { outstandingTotal: money(raw?.outstandingTotal), openCount: Number(raw?.openCount ?? 0), overdueTotal: money(raw?.overdueTotal), dueIn30Total: money(raw?.dueIn30Total), paidThisMonth: money(raw?.paidThisMonth), agingCurrent: money(raw?.agingCurrent), aging30: money(raw?.aging30), aging60: money(raw?.aging60), aging90: money(raw?.aging90), aging90Plus: money(raw?.aging90Plus) }; }

async function loadBillsData({ orgId, filter, today, in30, monthStart, limit, offset }: { orgId: string; filter: BillFilter | null; today: string; in30: string; monthStart: string; limit: number; offset: number }) {
  const result = await db.execute(sql<{ total_count: number; summary: Record<string, unknown> | null; rows: BillRow[] | null }>`
    with line_totals as (
      select bill_id, coalesce(sum(amount), 0)::numeric as line_total from bill_lines group by bill_id
    ), modern_applied as (
      select bpa.bill_id, coalesce(sum(bpa.amount_applied), 0)::numeric as applied from bill_payment_applications bpa join bill_payments bp on bp.id = bpa.bill_payment_id where bp.organization_id = ${orgId} group by bpa.bill_id
    ), legacy_applied as (
      select bill_id, coalesce(sum(amount), 0)::numeric as applied from payments where organization_id = ${orgId} and type = 'sent' and bill_id is not null group by bill_id
    ), paid_month as (
      select coalesce(sum(amount), 0)::numeric as total from (
        select bp.amount::numeric as amount from bill_payments bp where bp.organization_id = ${orgId} and bp.payment_date >= ${monthStart}::date and bp.payment_date <= ${today}::date
        union all
        select p.amount::numeric as amount from payments p where p.organization_id = ${orgId} and p.type = 'sent' and p.payment_date >= ${monthStart} and p.payment_date <= ${today}
      ) paid
    ), all_bills as (
      select b.id, b.bill_number, b.bill_date, b.due_date, b.status, b.memo, b.created_at, c.contact_name,
        (coalesce(lt.line_total, 0) + coalesce(b.tax_amount, 0) - coalesce(b.discount_amount, 0))::numeric as gross_total,
        (coalesce(ma.applied, 0) + coalesce(la.applied, 0))::numeric as applied_total,
        greatest((coalesce(lt.line_total, 0) + coalesce(b.tax_amount, 0) - coalesce(b.discount_amount, 0)) - (coalesce(ma.applied, 0) + coalesce(la.applied, 0)), 0)::numeric as outstanding
      from bills b left join contacts c on c.id = b.contact_id left join line_totals lt on lt.bill_id = b.id left join modern_applied ma on ma.bill_id = b.id left join legacy_applied la on la.bill_id = b.id where b.organization_id = ${orgId}
    ), filtered as (
      select * from all_bills b where ${filter}::text is null
        or (${filter}::text = 'outstanding' and b.status = 'posted' and b.outstanding > 0)
        or (${filter}::text = 'overdue' and b.status = 'posted' and b.outstanding > 0 and b.due_date is not null and b.due_date < ${today}::date)
        or (${filter}::text = 'due30' and b.status = 'posted' and b.outstanding > 0 and b.due_date is not null and b.due_date >= ${today}::date and b.due_date <= ${in30}::date)
        or (${filter}::text = 'paid_month' and exists (
          select 1 from bill_payment_applications bpa join bill_payments bp on bp.id = bpa.bill_payment_id where bpa.bill_id = b.id and bp.organization_id = ${orgId} and bp.payment_date >= ${monthStart}::date and bp.payment_date <= ${today}::date
          union all
          select 1 from payments p where p.bill_id = b.id and p.organization_id = ${orgId} and p.type = 'sent' and p.payment_date >= ${monthStart} and p.payment_date <= ${today}
        ))
    ), summary as (
      select jsonb_build_object(
        'outstandingTotal', coalesce(sum(outstanding) filter (where outstanding > 0), 0),
        'openCount', coalesce(count(*) filter (where outstanding > 0), 0),
        'overdueTotal', coalesce(sum(outstanding) filter (where outstanding > 0 and due_date is not null and due_date < ${today}::date), 0),
        'dueIn30Total', coalesce(sum(outstanding) filter (where outstanding > 0 and due_date is not null and due_date >= ${today}::date and due_date <= ${in30}::date), 0),
        'paidThisMonth', (select total from paid_month),
        'agingCurrent', coalesce(sum(outstanding) filter (where outstanding > 0 and (due_date is null or due_date >= ${today}::date)), 0),
        'aging30', coalesce(sum(outstanding) filter (where outstanding > 0 and due_date is not null and ${today}::date - due_date between 1 and 30), 0),
        'aging60', coalesce(sum(outstanding) filter (where outstanding > 0 and due_date is not null and ${today}::date - due_date between 31 and 60), 0),
        'aging90', coalesce(sum(outstanding) filter (where outstanding > 0 and due_date is not null and ${today}::date - due_date between 61 and 90), 0),
        'aging90Plus', coalesce(sum(outstanding) filter (where outstanding > 0 and due_date is not null and ${today}::date - due_date > 90), 0)
      ) as data from all_bills
    ), paged as (
      select id, bill_number as "billNumber", bill_date as "billDate", due_date as "dueDate", status, memo, contact_name as "contactName", gross_total::float8 as "grossTotal", applied_total::float8 as "appliedTotal", outstanding::float8 as outstanding from filtered order by bill_date desc nulls last, created_at desc nulls last limit ${limit} offset ${offset}
    )
    select (select count(*)::int from filtered) as total_count, (select data from summary) as summary, coalesce((select jsonb_agg(to_jsonb(paged)) from paged), '[]'::jsonb) as rows
  `);
  const first = result[0] as { total_count?: number; summary?: Record<string, unknown> | null; rows?: BillRow[] | null } | undefined;
  const rows = (first?.rows ?? []) as BillRow[];
  return { totalCount: Number(first?.total_count ?? 0), summary: toSummary(first?.summary), rows: rows.map((row) => ({ ...row, grossTotal: money(row.grossTotal), appliedTotal: money(row.appliedTotal), outstanding: money(row.outstanding) })) };
}

export async function loadBillsSummary(params: BillsSearchParams) {
  const orgId = await getCurrentOrgId();
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const filter: BillFilter | null = (VALID_FILTERS as readonly string[]).includes(params.filter ?? '') ? (params.filter as BillFilter) : null;
  const today = isoToday(); const in30 = isoOffset(30); const monthStart = startOfMonth();
  const { totalCount, summary, rows } = await loadBillsData({ orgId, filter, today, in30, monthStart, limit: PAGE_SIZE, offset });
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const agingTotal = summary.agingCurrent + summary.aging30 + summary.aging60 + summary.aging90 + summary.aging90Plus;
  return { page, pageCount, totalCount, filter, today, in30, monthStart, summary, rows, agingTotal };
}
