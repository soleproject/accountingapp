import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';
import { inboundConfigured } from '@/lib/email/inbound-token';

export const runtime = 'nodejs';

export async function GET() {
  const canManageAutomation = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);
  if (!canManageAutomation) {
    return NextResponse.json({ canManageAutomation: false, inboundReady: false, org: null });
  }

  const orgId = await getCurrentOrgId();
  const [org] = await db
    .select({
      aiAutoPostEnabled: organizations.aiAutoPostEnabled,
      aiAutoPostThreshold: organizations.aiAutoPostThreshold,
      monthlyReportEnabled: organizations.monthlyReportEnabled,
      monthlyReportRecipients: organizations.monthlyReportRecipients,
      reviewAutoOutreachEnabled: organizations.reviewAutoOutreachEnabled,
      contactInquiryEnabled: organizations.contactInquiryEnabled,
      substantiationEnabled: organizations.substantiationEnabled,
      payerTin: organizations.payerTin,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return NextResponse.json({ canManageAutomation: true, inboundReady: inboundConfigured(), org: org ?? null });
}
