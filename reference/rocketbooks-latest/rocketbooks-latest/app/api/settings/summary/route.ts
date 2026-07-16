import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { observeDeferredApiPhase } from '@/lib/perf/request-observability';

export const runtime = 'nodejs';

async function handleGet() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const [[org], [profile]] = await Promise.all([
    db
      .select({
        name: organizations.name,
        planType: organizations.planType,
        accountingMethod: organizations.accountingMethod,
        processingMode: organizations.processingMode,
        onboardingMode: organizations.onboardingMode,
        entityType: organizations.entityType,
        domain: organizations.domain,
        aiClientProfile: organizations.aiClientProfile,
        meetingFollowupsEnabled: organizations.meetingFollowupsEnabled,
        meetingFollowupsGraceMinutes: organizations.meetingFollowupsGraceMinutes,
        videoTranscriptionEnabled: organizations.videoTranscriptionEnabled,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
    db
      .select({
        fullName: users.fullName,
        role: users.role,
        aiThreadContextWindow: users.aiThreadContextWindow,
        aiVoiceDoc: users.aiVoiceDoc,
        emailSignature: users.emailSignature,
        weeklyDigestOptInAt: users.weeklyDigestOptInAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1),
  ]);

  return NextResponse.json({ user: { id: user.id, email: user.email ?? null }, orgId, org: org ?? null, profile: profile ?? null });
}

export function GET() {
  return observeDeferredApiPhase('settings.summary', handleGet);
}
