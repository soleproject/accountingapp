import { NextResponse } from 'next/server';
import { eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { csvRow, CSV_BOM } from '@/lib/csv';

export async function GET() {
  const orgId = await getCurrentOrgId();
  const rows = await db
    .select({
      id: contacts.id,
      contactName: contacts.contactName,
      companyName: contacts.companyName,
      email: contacts.email,
      phone: contacts.phone,
      isActive: contacts.isActive,
    })
    .from(contacts)
    .where(eq(contacts.organizationId, orgId))
    .orderBy(asc(contacts.contactName));

  const lines = [csvRow(['name', 'company', 'email', 'phone', 'active'])];
  for (const r of rows) {
    lines.push(csvRow([r.contactName, r.companyName, r.email, r.phone, r.isActive]));
  }
  return new NextResponse(CSV_BOM + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
