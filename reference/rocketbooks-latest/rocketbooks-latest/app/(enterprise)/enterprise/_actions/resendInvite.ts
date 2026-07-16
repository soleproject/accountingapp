'use server';

import { and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '@/db/client';
import { users, enterpriseClients, organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { createServiceClient } from '@/lib/supabase/service';
import { requestOrigin } from '@/lib/http/origin';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { renderClientWelcomeEmail } from '@/lib/enterprise/client-invite';
import type { WelcomeEmailConfig } from '@/lib/enterprise/onboarding';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';

/**
 * Re-send a client's invite. Generates a fresh sign-in (magic) link for the
 * existing user and emails it — firm-branded for private-label firms, plain
 * otherwise. Used when a client hasn't accepted their invite yet.
 */
export async function resendClientInviteAction(formData: FormData): Promise<void> {
  await requireSession();
  const current = await getCurrentEnterprise();
  const userId = String(formData.get('userId') ?? '');
  if (!current || current.id === DEMO_ENTERPRISE_ID || !userId) {
    redirect('/enterprise/clients?resent=error');
  }

  // Confirm this user really is a client of the acting enterprise.
  const [client] = await db
    .select({ id: enterpriseClients.id })
    .from(enterpriseClients)
    .where(and(eq(enterpriseClients.enterpriseId, current.id), eq(enterpriseClients.clientUserId, userId)))
    .limit(1);
  if (!client) redirect('/enterprise/clients?resent=error');

  const [u] = await db.select({ email: users.email, fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u?.email) redirect('/enterprise/clients?resent=error');

  const [firm] = await db
    .select({
      name: organizations.name,
      privateLabel: organizations.privateLabelEnabled,
      logoUrl: organizations.logoUrl,
      brandColor: organizations.brandColorHex,
      aiName: organizations.aiAssistantName,
      sendingFromEmail: organizations.sendingFromEmail,
      handoff: organizations.clientOnboardingHandoff,
      welcomeEmailConfig: organizations.welcomeEmailConfig,
    })
    .from(organizations)
    .where(eq(organizations.id, current.id))
    .limit(1);

  const supabase = createServiceClient();
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: u.email,
    options: { redirectTo: await requestOrigin() },
  });
  const link = (data?.properties as { action_link?: string } | undefined)?.action_link;
  if (error || !link) redirect('/enterprise/clients?resent=error');

  const rendered = renderClientWelcomeEmail({
    firmName: firm?.name || 'your firm',
    aiName: firm?.aiName || 'your assistant',
    logoUrl: firm?.logoUrl ?? null,
    brandColor: firm?.brandColor || '#2563eb',
    config: (firm?.welcomeEmailConfig as WelcomeEmailConfig | null) ?? null,
    handoff: firm?.handoff ?? null,
    fullName: u.fullName ?? u.email,
    actionLink: link!,
  });
  const r = await sendTransactionalEmail({
    to: u.email,
    ...rendered,
    ...(firm?.privateLabel && firm?.name ? { fromName: firm.name } : {}),
    ...(firm?.privateLabel && firm?.sendingFromEmail ? { replyTo: firm.sendingFromEmail } : {}),
    usage: { userId: null, orgId: current.id, actor: 'enterprise', feature: 'client-invite-resend' },
  });
  redirect(`/enterprise/clients?resent=${r.sent ? 'ok' : 'error'}`);
}
