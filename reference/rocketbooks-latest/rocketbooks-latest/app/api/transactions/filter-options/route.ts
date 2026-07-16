import { NextRequest, NextResponse } from 'next/server';
import { asc, eq, ilike, and, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, contacts } from '@/db/schema/schema';
import { requirePermission } from '@/lib/auth/permissions';
import { getCurrentOrgId } from '@/lib/auth/org';
import { timeDb } from '@/lib/perf/db-timing';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  await requirePermission('accounting.transactions.view');
  const orgId = await getCurrentOrgId();
  const searchParams = req.nextUrl.searchParams;
  const kind = searchParams.get('kind');
  const q = searchParams.get('q')?.trim() ?? '';

  if (kind !== 'contacts' && kind !== 'accounts') {
    return NextResponse.json({ error: 'Unsupported filter option kind' }, { status: 400 });
  }

  if (kind === 'accounts') {
    const accounts = await timeDb(
      'transactions.filterOptions.accounts',
      () =>
        db
          .select({
            id: chartOfAccounts.id,
            accountNumber: chartOfAccounts.accountNumber,
            accountName: chartOfAccounts.accountName,
            accountType: chartOfAccounts.accountType,
          })
          .from(chartOfAccounts)
          .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
          .orderBy(asc(chartOfAccounts.accountNumber)),
      { route: '/api/transactions/filter-options', kind: 'accounts' },
    );
    return NextResponse.json({
      bankAccounts: accounts.filter((a) => a.accountType === 'bank'),
      categoryAccounts: accounts.filter((a) => a.accountType !== 'bank'),
    });
  }

  const search = q ? `%${q}%` : null;
  const options = await timeDb(
    'transactions.filterOptions.contacts',
    () =>
      db
        .select({ id: contacts.id, contactName: contacts.contactName })
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, orgId),
            eq(contacts.isActive, true),
            search
              ? or(
                  ilike(contacts.contactName, search),
                  ilike(contacts.email, search),
                  ilike(contacts.companyName, search),
                )
              : undefined,
          ),
        )
        .orderBy(asc(contacts.contactName))
        .limit(100),
    { route: '/api/transactions/filter-options', kind: 'contacts', hasQuery: !!q },
  );

  return NextResponse.json({ contacts: options });
}
