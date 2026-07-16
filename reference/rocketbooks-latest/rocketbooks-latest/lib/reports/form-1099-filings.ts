import 'server-only';
import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, contacts, organizations } from '@/db/schema/schema';
import { FORM_1099_THRESHOLD } from './form-1099-data';

const EXPENSE_GAAP_TYPES = ['expense', 'cost_of_goods_sold', 'cogs'];

export interface PartyAddress {
  line1: string;
  line2: string; // "City, ST ZIP"
}

export interface Form1099Recipient {
  contactId: string;
  name: string;
  address: PartyAddress;
  tin: string;
  amount: number; // Box 1 — nonemployee compensation
}

export interface Form1099FilingData {
  year: number;
  threshold: number;
  payer: { name: string; address: PartyAddress; phone: string; tin: string };
  recipients: Form1099Recipient[];
}

function fmtAddress(a: unknown): PartyAddress {
  const o = (a ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const line1 = s(o.line1) || s(o.street) || s(o.address1) || s(o.address);
  const city = s(o.city);
  const state = s(o.state);
  const zip = s(o.postal) || s(o.zip) || s(o.postalCode);
  const line2 = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return { line1, line2 };
}

/**
 * Year-end 1099-NEC filing data: the payer (this org) plus every CONFIRMED
 * 1099-eligible vendor paid >= $600 in the year, with their TIN, address, and
 * Box 1 amount (total expense payments). Drives the generated PDF.
 */
export async function loadForm1099Filings(orgId: string, year: number): Promise<Form1099FilingData> {
  const fromDate = `${year}-01-01`;
  const toDate = `${year}-12-31`;

  const [org] = await db
    .select({ name: organizations.name, address: organizations.address, phone: organizations.phone, payerTin: organizations.payerTin })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const payer = {
    name: org?.name ?? 'Organization',
    address: fmtAddress(org?.address),
    phone: org?.phone ?? '',
    tin: org?.payerTin ?? '',
  };

  // Confirmed-eligible vendors only.
  const eligible = await db
    .select({ id: contacts.id, name: contacts.contactName, tin: contacts.taxId, address: contacts.address })
    .from(contacts)
    .where(and(eq(contacts.organizationId, orgId), eq(contacts.is1099Eligible, true)));

  if (eligible.length === 0) return { year, threshold: FORM_1099_THRESHOLD, payer, recipients: [] };

  const ids = eligible.map((c) => c.id);
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
        inArray(transactions.contactId, ids),
        inArray(chartOfAccounts.gaapType, EXPENSE_GAAP_TYPES),
        gte(transactions.date, fromDate),
        lte(transactions.date, toDate),
      ),
    )
    .groupBy(transactions.contactId);

  const paidById = new Map<string, number>();
  for (const r of paidRows) if (r.contactId) paidById.set(r.contactId, Number(r.paid));

  const recipients: Form1099Recipient[] = eligible
    .map((c) => ({
      contactId: c.id,
      name: c.name,
      address: fmtAddress(c.address),
      tin: c.tin ?? '',
      amount: paidById.get(c.id) ?? 0,
    }))
    .filter((r) => r.amount >= FORM_1099_THRESHOLD)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { year, threshold: FORM_1099_THRESHOLD, payer, recipients };
}
