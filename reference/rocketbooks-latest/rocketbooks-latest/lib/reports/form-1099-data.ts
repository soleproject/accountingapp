import 'server-only';
import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, contacts, organizations } from '@/db/schema/schema';

/**
 * 1099 Summary. For a calendar year, totals what each contact was paid via
 * expense-categorized transactions (the most complete signal — contactId is set
 * on ~16k txns vs. a handful of bill_payments) and pairs it with their W-9 /
 * TIN / eligibility flags so an accountant can see who needs a 1099-NEC and
 * who's missing paperwork. The IRS threshold is $600.
 *
 * Caveat surfaced in the UI: card payments are excluded from 1099 (the
 * processor files 1099-K) and we don't track payment method, so the accountant
 * confirms eligibility per vendor (the is_1099_eligible flag).
 */

export const FORM_1099_THRESHOLD = 600;
const EXPENSE_GAAP_TYPES = ['expense', 'cost_of_goods_sold', 'cogs'];

export interface Vendor1099Row {
  contactId: string;
  name: string;
  totalPaid: number;
  meetsThreshold: boolean;
  eligible: boolean;
  w9Status: string;
  hasTaxId: boolean;
  hasEmail: boolean;
  needsAttention: boolean; // over threshold but missing W-9 or TIN
  aiSuggestion: boolean | null; // AI's eligibility guess (null = not evaluated)
  aiReason: string | null;
}

export interface Form1099Data {
  organizationName: string;
  year: number;
  threshold: number;
  rows: Vendor1099Row[];
  totals: {
    vendors: number;
    overThreshold: number;
    missingPaperwork: number;
    totalReportable: number;
  };
}

export async function loadForm1099Summary(orgId: string, year: number): Promise<Form1099Data> {
  const fromDate = `${year}-01-01`;
  const toDate = `${year}-12-31`;

  const [orgRow] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // Total paid per contact via expense-categorized transactions in the year.
  const paidRows = await db
    .select({
      contactId: transactions.contactId,
      paid: sql<string>`COALESCE(SUM(ABS(${transactions.amount})), 0)`.as('paid'),
    })
    .from(transactions)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, transactions.categoryAccountId))
    .where(
      and(
        eq(transactions.organizationId, orgId),
        isNotNull(transactions.contactId),
        inArray(chartOfAccounts.gaapType, EXPENSE_GAAP_TYPES),
        gte(transactions.date, fromDate),
        lte(transactions.date, toDate),
      ),
    )
    .groupBy(transactions.contactId);

  const paidByContact = new Map<string, number>();
  for (const r of paidRows) if (r.contactId) paidByContact.set(r.contactId, Number(r.paid));

  // All contacts flagged 1099-eligible (so they show even with $0 this year).
  const flagged = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.organizationId, orgId), eq(contacts.is1099Eligible, true)));

  const candidateIds = new Set<string>(flagged.map((c) => c.id));
  for (const [cid, paid] of paidByContact) if (paid >= FORM_1099_THRESHOLD) candidateIds.add(cid);

  if (candidateIds.size === 0) {
    return {
      organizationName: orgRow?.name ?? 'Organization',
      year,
      threshold: FORM_1099_THRESHOLD,
      rows: [],
      totals: { vendors: 0, overThreshold: 0, missingPaperwork: 0, totalReportable: 0 },
    };
  }

  const contactRows = await db
    .select({
      id: contacts.id,
      name: contacts.contactName,
      taxId: contacts.taxId,
      w9Status: contacts.w9Status,
      eligible: contacts.is1099Eligible,
      email: contacts.email,
      aiSuggestion: contacts.ai1099Suggestion,
      aiReason: contacts.ai1099Reason,
    })
    .from(contacts)
    .where(and(eq(contacts.organizationId, orgId), inArray(contacts.id, [...candidateIds])));

  const rows: Vendor1099Row[] = contactRows
    .map((c) => {
      const totalPaid = paidByContact.get(c.id) ?? 0;
      const meetsThreshold = totalPaid >= FORM_1099_THRESHOLD;
      const hasTaxId = !!c.taxId && c.taxId.trim() !== '';
      const needsAttention = (meetsThreshold || c.eligible) && (c.w9Status !== 'on_file' || !hasTaxId);
      return {
        contactId: c.id,
        name: c.name,
        totalPaid,
        meetsThreshold,
        eligible: c.eligible,
        w9Status: c.w9Status,
        hasTaxId,
        hasEmail: !!c.email && c.email.trim() !== '',
        needsAttention,
        aiSuggestion: c.aiSuggestion ?? null,
        aiReason: c.aiReason ?? null,
      };
    })
    .sort((a, b) => b.totalPaid - a.totalPaid || a.name.localeCompare(b.name));

  const totals = {
    vendors: rows.length,
    overThreshold: rows.filter((r) => r.meetsThreshold).length,
    missingPaperwork: rows.filter((r) => r.needsAttention).length,
    totalReportable: rows.filter((r) => r.meetsThreshold || r.eligible).reduce((s, r) => s + r.totalPaid, 0),
  };

  return {
    organizationName: orgRow?.name ?? 'Organization',
    year,
    threshold: FORM_1099_THRESHOLD,
    rows,
    totals,
  };
}
