import { eq, and, asc, count, ilike, or, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

const PAGE_SIZE = 50;
const VALID_STATUS = ['active', 'archived', 'all'] as const;
export type StatusFilter = (typeof VALID_STATUS)[number];
export interface ContactsSearchParams { page?: string | null; q?: string | null; status?: string | null }

export async function loadContactsSummary(params: ContactsSearchParams) {
  const orgId = await getCurrentOrgId();
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const q = params.q?.trim() || null;
  const status: StatusFilter = (VALID_STATUS as readonly string[]).includes(params.status ?? '') ? (params.status as StatusFilter) : 'active';

  const conditions = [eq(contacts.organizationId, orgId)];
  if (q) {
    const pattern = `%${q}%`;
    conditions.push(or(ilike(contacts.contactName, pattern), ilike(contacts.companyName, pattern), ilike(contacts.email, pattern))!);
  }
  if (status === 'active') conditions.push(or(eq(contacts.isActive, true), isNull(contacts.isActive))!);
  else if (status === 'archived') conditions.push(eq(contacts.isActive, false));
  const where = conditions.length > 1 ? and(...conditions) : conditions[0];

  const [[total], rows, [statusCounts]] = await Promise.all([
    db.select({ n: count() }).from(contacts).where(where),
    db.select({ id: contacts.id, contactName: contacts.contactName, companyName: contacts.companyName, email: contacts.email, phone: contacts.phone, isActive: contacts.isActive, createdByAi: contacts.createdByAi }).from(contacts).where(where).orderBy(asc(contacts.contactName)).limit(PAGE_SIZE).offset(offset),
    db.select({ active: sql<number>`COUNT(*) FILTER (WHERE ${contacts.isActive} = TRUE OR ${contacts.isActive} IS NULL)::int`.as('active'), archived: sql<number>`COUNT(*) FILTER (WHERE ${contacts.isActive} = FALSE)::int`.as('archived'), all: sql<number>`COUNT(*)::int`.as('all') }).from(contacts).where(eq(contacts.organizationId, orgId)),
  ]);
  const totalCount = total?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const allContactsForMerge = rows.map((row) => ({ id: row.id, contactName: row.contactName }));
  return { page, pageCount, q, status, totalCount, rows, allContactsForMerge, statusCounts: statusCounts ?? { active: 0, archived: 0, all: 0 } };
}
