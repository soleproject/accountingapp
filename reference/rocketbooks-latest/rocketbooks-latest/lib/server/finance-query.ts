import 'server-only';
import { and, eq, gte, lte, sql, desc, asc } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { generalLedger, chartOfAccounts, contacts, organizations } from '@/db/schema/schema';
import { generalLedgerBasisFilter, getOrgBasis, type ReportBasis } from '@/lib/reports/basis-filter';
import { getOutstandingInvoices } from '@/lib/accounting/invoices-outstanding';
import { getOutstandingBills } from '@/lib/accounting/bills-outstanding';
import { chatCompletion } from '@/lib/ai/openai';

/**
 * Natural-language finance Q&A for the dashboard. The LLM never writes SQL — it
 * emits a constrained spec (a `kind` plus enum/ISO-date/number fields) which we
 * validate and run as parameterized aggregations. Supported kinds:
 *   aggregate — totals/trends/breakdowns of revenue/expenses/net (optional
 *               accountLike filter, e.g. "rent")
 *   ar        — outstanding invoices (who owes you)
 *   ap        — outstanding bills (who you owe)
 *   compare   — a metric across 2-4 named periods
 *   movers    — biggest category changes between two periods ("what changed")
 */

const REV = ['revenue', 'income', 'other_income'];
const EXP = ['expense', 'cost_of_goods_sold', 'cogs', 'other_expense'];
type Metric = 'revenue' | 'expenses' | 'net';
type GroupBy = 'month' | 'category' | 'contact' | 'none';

export interface FinanceAnswer {
  title: string;
  chart: 'line' | 'bar' | 'number';
  data: { label: string; value: number }[];
}

function inLower(col: AnyPgColumn, vals: string[]) {
  return sql`LOWER(${col}) IN (${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`;
}
function isoOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : fallback;
}
const clampLimit = (n: unknown, def = 10) => (Number.isFinite(n) ? Math.min(Math.max(Number(n), 1), 50) : def);

function valueExprFor(metric: Metric) {
  if (metric === 'revenue') return sql<string>`SUM(${generalLedger.credit} - ${generalLedger.debit})`;
  if (metric === 'expenses') return sql<string>`SUM(${generalLedger.debit} - ${generalLedger.credit})`;
  return sql<string>`SUM(CASE WHEN ${inLower(chartOfAccounts.gaapType, REV)} THEN ${generalLedger.credit} - ${generalLedger.debit} ELSE -(${generalLedger.debit} - ${generalLedger.credit}) END)`;
}
function gaapFilterFor(metric: Metric) {
  return metric === 'revenue' ? inLower(chartOfAccounts.gaapType, REV) : metric === 'expenses' ? inLower(chartOfAccounts.gaapType, EXP) : inLower(chartOfAccounts.gaapType, [...REV, ...EXP]);
}

async function byGroup(
  orgId: string,
  basis: ReportBasis,
  opts: { metric: Metric; groupBy: GroupBy; from: string; to: string; accountLike?: string; limit?: number },
): Promise<{ label: string; value: number }[]> {
  const valueExpr = valueExprFor(opts.metric);
  const groupExpr =
    opts.groupBy === 'month'
      ? sql<string>`TO_CHAR(${generalLedger.date}, 'YYYY-MM')`
      : opts.groupBy === 'category'
        ? sql<string>`COALESCE(${chartOfAccounts.accountName}, 'Uncategorized')`
        : opts.groupBy === 'contact'
          ? sql<string>`COALESCE(${contacts.contactName}, 'Unknown')`
          : sql<string>`'Total'`;

  let q = db.select({ label: groupExpr.as('label'), value: valueExpr.as('value') }).from(generalLedger).innerJoin(chartOfAccounts, eq(chartOfAccounts.id, generalLedger.accountId)).$dynamic();
  if (opts.groupBy === 'contact') q = q.leftJoin(contacts, eq(contacts.id, generalLedger.contactId));

  const conds = [eq(generalLedger.organizationId, orgId), gte(generalLedger.date, `${opts.from}T00:00:00`), lte(generalLedger.date, `${opts.to}T23:59:59`), generalLedgerBasisFilter(basis), gaapFilterFor(opts.metric)];
  if (opts.accountLike) conds.push(sql`${chartOfAccounts.accountName} ILIKE ${'%' + opts.accountLike + '%'}`);
  q = q.where(and(...conds));

  if (opts.groupBy === 'month') q = q.groupBy(groupExpr).orderBy(asc(groupExpr));
  else if (opts.groupBy !== 'none') q = q.groupBy(groupExpr).orderBy(desc(valueExpr)).limit(clampLimit(opts.limit));

  const rows = await q;
  return rows.map((r) => ({ label: String(r.label), value: Number(r.value) }));
}

async function runAr(orgId: string, groupBy: GroupBy, limit?: number): Promise<FinanceAnswer> {
  const inv = await getOutstandingInvoices(orgId);
  if (groupBy === 'none') return { title: 'Total outstanding invoices', chart: 'number', data: [{ label: 'Outstanding', value: inv.reduce((s, i) => s + i.balance, 0) }] };
  const m = new Map<string, number>();
  for (const i of inv) m.set(i.customerName ?? 'Unknown', (m.get(i.customerName ?? 'Unknown') ?? 0) + i.balance);
  const data = [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, clampLimit(limit));
  return { title: 'Who owes you (outstanding invoices)', chart: 'bar', data };
}

async function runAp(orgId: string, groupBy: GroupBy, limit?: number): Promise<FinanceAnswer> {
  const bills = await getOutstandingBills(orgId);
  if (groupBy === 'none') return { title: 'Total outstanding bills', chart: 'number', data: [{ label: 'Outstanding', value: bills.reduce((s, b) => s + b.balance, 0) }] };
  const m = new Map<string, number>();
  for (const b of bills) m.set(b.vendorName ?? 'Unknown', (m.get(b.vendorName ?? 'Unknown') ?? 0) + b.balance);
  const data = [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, clampLimit(limit));
  return { title: 'Who you owe (outstanding bills)', chart: 'bar', data };
}

export async function answerFinanceQuestion(orgId: string, question: string): Promise<{ ok: boolean; answer?: FinanceAnswer; error?: string }> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const yearAgo = new Date(today.getFullYear() - 1, today.getMonth(), 1).toISOString().slice(0, 10);
  const basis = await getOrgBasis(orgId);
  const [org] = await db.select({ ownerUserId: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);

  const system =
    `Convert a small-business owner's finance question into a JSON query spec. Today is ${todayStr}. Pick ONE "kind":\n` +
    `- "aggregate": totals/trends/breakdowns of money in/out. Fields: metric ("revenue"|"expenses"|"net"), groupBy ("month"|"category"|"contact"|"none"), from, to (YYYY-MM-DD), limit (optional, for top-N), accountLike (optional substring to filter to one account/category, e.g. "rent","payroll","software").\n` +
    `- "ar": who owes the business / outstanding invoices / receivables. Fields: groupBy ("contact"|"none"), limit (optional).\n` +
    `- "ap": who the business owes / outstanding bills / payables. Fields: groupBy ("contact"|"none"), limit (optional).\n` +
    `- "compare": a metric across named periods. Fields: metric, periods (array of {label, from, to}, 2-4 entries).\n` +
    `- "movers": what changed / biggest increases or decreases. Fields: metric ("expenses"|"revenue"), periodA {from,to} (earlier), periodB {from,to} (later), limit (optional).\n` +
    `Rules: "net" = revenue minus expenses. Use groupBy "month" for trends, "category" for by-type/where-money-goes, "contact" for by customer/vendor, "none" for a single total. If no period is given use the last 12 months (${yearAgo} to ${todayStr}). Always include a short "title". Return ONLY the JSON object.`;

  let raw: Record<string, unknown>;
  try {
    const c = await chatCompletion(
      { userId: org?.ownerUserId ?? null, orgId, actor: 'system', feature: 'finance_qa' },
      { model: process.env.AI_CATEGORIZE_MODEL ?? 'gpt-4o', messages: [{ role: 'system', content: system }, { role: 'user', content: question.slice(0, 500) }], response_format: { type: 'json_object' }, temperature: 0 },
    );
    raw = JSON.parse(c.choices[0]?.message?.content ?? '{}');
  } catch (e) {
    console.error('finance-query: parse failed', e);
    return { ok: false, error: 'Could not understand that question.' };
  }

  const kind = ['aggregate', 'ar', 'ap', 'compare', 'movers'].includes(String(raw.kind)) ? (raw.kind as string) : 'aggregate';
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : 'Result';
  const metric: Metric = ['revenue', 'expenses', 'net'].includes(String(raw.metric)) ? (raw.metric as Metric) : 'expenses';

  try {
    let answer: FinanceAnswer;

    if (kind === 'ar' || kind === 'ap') {
      const groupBy: GroupBy = raw.groupBy === 'none' ? 'none' : 'contact';
      answer = kind === 'ar' ? await runAr(orgId, groupBy, raw.limit as number) : await runAp(orgId, groupBy, raw.limit as number);
    } else if (kind === 'compare') {
      const periodsRaw = Array.isArray(raw.periods) ? (raw.periods as { label?: string; from?: string; to?: string }[]).slice(0, 4) : [];
      const periods = periodsRaw.map((p, i) => ({ label: typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 20) : `Period ${i + 1}`, from: isoOr(p.from, yearAgo), to: isoOr(p.to, todayStr) }));
      if (periods.length < 2) return { ok: false, error: 'Need at least two periods to compare.' };
      const data = await Promise.all(periods.map(async (p) => ({ label: p.label, value: (await byGroup(orgId, basis, { metric, groupBy: 'none', from: p.from, to: p.to }))[0]?.value ?? 0 })));
      answer = { title, chart: 'bar', data };
    } else if (kind === 'movers') {
      const mMetric: Metric = metric === 'revenue' ? 'revenue' : 'expenses';
      const a = raw.periodA as { from?: string; to?: string } | undefined;
      const b = raw.periodB as { from?: string; to?: string } | undefined;
      const pa = { from: isoOr(a?.from, yearAgo), to: isoOr(a?.to, todayStr) };
      const pb = { from: isoOr(b?.from, yearAgo), to: isoOr(b?.to, todayStr) };
      const [rowsA, rowsB] = await Promise.all([
        byGroup(orgId, basis, { metric: mMetric, groupBy: 'category', from: pa.from, to: pa.to, limit: 50 }),
        byGroup(orgId, basis, { metric: mMetric, groupBy: 'category', from: pb.from, to: pb.to, limit: 50 }),
      ]);
      const mapA = new Map(rowsA.map((r) => [r.label, r.value]));
      const labels = new Set([...rowsA.map((r) => r.label), ...rowsB.map((r) => r.label)]);
      const deltas = [...labels].map((label) => ({ label, value: (rowsB.find((r) => r.label === label)?.value ?? 0) - (mapA.get(label) ?? 0) }));
      const data = deltas.filter((d) => Math.abs(d.value) > 0.5).sort((x, y) => Math.abs(y.value) - Math.abs(x.value)).slice(0, clampLimit(raw.limit));
      answer = { title, chart: 'bar', data };
    } else {
      const groupBy: GroupBy = ['month', 'category', 'contact', 'none'].includes(String(raw.groupBy)) ? (raw.groupBy as GroupBy) : 'month';
      const accountLike = typeof raw.accountLike === 'string' && raw.accountLike.trim() ? raw.accountLike.trim().slice(0, 40) : undefined;
      const rows = await byGroup(orgId, basis, { metric, groupBy, from: isoOr(raw.from, yearAgo), to: isoOr(raw.to, todayStr), accountLike, limit: raw.limit as number });
      const data = rows.filter((r) => groupBy === 'month' || groupBy === 'none' || r.value !== 0);
      const chart: FinanceAnswer['chart'] = groupBy === 'none' ? 'number' : groupBy === 'month' ? 'line' : 'bar';
      answer = { title, chart, data };
    }

    if (answer.data.length === 0) return { ok: false, error: 'No data found for that question.' };
    return { ok: true, answer };
  } catch (e) {
    console.error('finance-query: run failed', e);
    return { ok: false, error: 'Could not run that query.' };
  }
}
