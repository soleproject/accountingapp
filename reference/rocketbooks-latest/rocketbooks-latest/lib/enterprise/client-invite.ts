import 'server-only';
import { eq } from 'drizzle-orm';
import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { sendTransactionalEmail, isResendConfigured } from '@/lib/email/resend';
import { logger } from '@/lib/logger';
import type { UsageCtx } from '@/lib/ai/usage';
import type { WelcomeEmailConfig } from './onboarding';

export interface InviteClientResult {
  userId?: string;
  error?: string;
  /** True when our branded email was used; false when Supabase's plain invite was. */
  branded?: boolean;
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || full;
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Default welcome-email copy by new-client-setup choice + client type — mirrors
 *  the wizard preview's defaults, used when the firm hasn't customized the copy. */
function defaultCopy(handoff: string | null, type: 'new' | 'switching', firm: string, ai: string): WelcomeEmailConfig {
  const NEW: Record<string, WelcomeEmailConfig> = {
    meeting: {
      subject: `Welcome to ${firm} — let's set up your books`,
      body: `Thanks for joining ${firm}! ${ai} will help get you up and running. Use the button below to get started, then book a quick setup call.`,
      cta: 'Get started',
    },
    self: {
      subject: `Welcome to ${firm}!`,
      body: `You're all set to get started. Sign in and ${ai} will walk you through setting up your books — it only takes a few minutes.`,
      cta: 'Get started',
    },
    pro: {
      subject: `Welcome to ${firm}!`,
      body: `Great news — there's nothing you need to do. Our team will set up your books for you and let you know the moment everything's ready. Sign in any time to follow along.`,
      cta: 'Sign in',
    },
  };
  const SWITCHING: Record<string, WelcomeEmailConfig> = {
    meeting: {
      subject: `Welcome to ${firm} — let's move your books over`,
      body: `Thanks for moving to ${firm}! ${ai} will help migrate your books from your old system. Book a quick call below and we'll handle the transition for you.`,
      cta: 'Book your transition call',
    },
    self: {
      subject: `Welcome to ${firm} — let's bring your books over`,
      body: `We're moving your books to our new system. Sign in and ${ai} will walk you through bringing your existing data over — it's quick.`,
      cta: 'Get started',
    },
    pro: {
      subject: `Welcome to ${firm}!`,
      body: `We're migrating your books from your old system — nothing for you to do. We'll let you know the moment everything's moved over. Sign in any time to follow along.`,
      cta: 'Sign in',
    },
  };
  const table = type === 'switching' ? SWITCHING : NEW;
  return table[handoff ?? 'meeting'] ?? table.meeting;
}

export function renderClientWelcomeEmail(args: {
  firmName: string;
  aiName: string;
  logoUrl: string | null;
  brandColor: string;
  config: WelcomeEmailConfig | null;
  handoff: string | null;
  fullName: string;
  actionLink: string;
  /** Scheduling link — used as the CTA href when clients book a setup meeting. */
  bookingUrl?: string | null;
  /** 'new' (default) | 'switching' — selects the default-copy variant. */
  type?: 'new' | 'switching';
}): { subject: string; text: string; html: string } {
  const copy = args.config ?? defaultCopy(args.handoff, args.type ?? 'new', args.firmName, args.aiName);
  const color = args.brandColor?.trim() || '#2563eb';
  const name = firstName(args.fullName);
  // When the firm books a setup meeting and gave a booking link, the CTA points
  // there; otherwise it's the sign-in/invite link.
  const ctaHref = args.handoff === 'meeting' && args.bookingUrl ? args.bookingUrl : args.actionLink;
  const text = `Hi ${name},\n\n${copy.body}\n\n${copy.cta}: ${ctaHref}\n\n— ${args.firmName}`;
  const logo = args.logoUrl
    ? `<img src="${esc(args.logoUrl)}" alt="${esc(args.firmName)}" style="height:36px;max-width:60%;object-fit:contain" />`
    : `<strong style="font-size:18px">${esc(args.firmName)}</strong>`;
  const html =
    `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;max-width:560px;margin:24px auto;padding:0 16px;line-height:1.5">` +
    `<div style="margin-bottom:16px">${logo}</div>` +
    `<p>Hi ${esc(name)},</p>` +
    `<p>${esc(copy.body)}</p>` +
    `<p><a href="${esc(ctaHref)}" style="display:inline-block;background:${esc(color)};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">${esc(copy.cta)}</a></p>` +
    `<p style="color:#888;font-size:12px;border-top:1px solid #eee;padding-top:12px;margin-top:24px">Sent by ${esc(args.firmName)}</p>` +
    `</body></html>`;
  return { subject: copy.subject, text, html };
}

/**
 * Invite a client into a firm. For a private-label firm (with Resend
 * configured) we create the user + generate the invite link ourselves and send
 * a firm-branded welcome email (their custom copy, logo, color, name, reply-to).
 * Otherwise — and on any failure of the branded path — we fall back to
 * Supabase's standard invite email, so client onboarding never breaks.
 *
 * Safety: generateLink creates the auth user. If it succeeds but the branded
 * email send fails, we still return success (the user exists) and only log —
 * we never re-invite (which would error on the now-existing user).
 */
export async function inviteEnterpriseClient(args: {
  supabase: SupabaseClient;
  email: string;
  fullName: string;
  redirectTo: string;
  enterpriseId: string;
  /** Only brand for actual clients (not staff/owner invites). */
  brandEligible: boolean;
  /** 'new' (default) | 'switching' — picks the welcome-email variant. */
  clientType?: 'new' | 'switching';
  usage?: UsageCtx;
  /** Per-invite overrides (e.g. the Add a Company wizard's edited email + the
   *  per-company setup choice). Any provided field replaces the firm's stored
   *  value when rendering the branded welcome email. */
  emailOverride?: {
    config?: WelcomeEmailConfig | null;
    handoff?: string | null;
    bookingUrl?: string | null;
    aiName?: string | null;
  };
}): Promise<InviteClientResult> {
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
      welcomeEmailConfigSwitching: organizations.welcomeEmailConfigSwitching,
      clientBookingUrl: organizations.clientBookingUrl,
    })
    .from(organizations)
    .where(eq(organizations.id, args.enterpriseId))
    .limit(1);

  const canBrand = args.brandEligible && !!firm?.privateLabel && isResendConfigured();

  if (canBrand && firm) {
    // generateLink creates the user AND returns a sign-in link without sending
    // Supabase's email. Only fall back to a plain invite if THIS fails (no user
    // created yet).
    let created: { userId: string; link: string } | null = null;
    try {
      const { data, error } = await args.supabase.auth.admin.generateLink({
        type: 'invite',
        email: args.email,
        options: { data: { full_name: args.fullName }, redirectTo: args.redirectTo },
      });
      const link = (data?.properties as { action_link?: string } | undefined)?.action_link;
      if (error || !data?.user || !link) throw new Error(error?.message || 'generateLink returned no link');
      created = { userId: data.user.id, link };
    } catch (e) {
      logger.warn({ email: args.email, err: e instanceof Error ? e.message : e }, 'branded invite generateLink failed — falling back to Supabase invite');
      created = null;
    }

    if (created) {
      const firmConfig = ((args.clientType === 'switching' ? firm.welcomeEmailConfigSwitching : firm.welcomeEmailConfig) as WelcomeEmailConfig | null) ?? null;
      const rendered = renderClientWelcomeEmail({
        firmName: firm.name || 'your firm',
        aiName: args.emailOverride?.aiName || firm.aiName || 'your assistant',
        logoUrl: firm.logoUrl ?? null,
        brandColor: firm.brandColor || '#2563eb',
        config: args.emailOverride && 'config' in args.emailOverride ? (args.emailOverride.config ?? null) : firmConfig,
        handoff: args.emailOverride?.handoff ?? firm.handoff ?? null,
        fullName: args.fullName,
        actionLink: created.link,
        bookingUrl: args.emailOverride?.bookingUrl ?? firm.clientBookingUrl ?? null,
        type: args.clientType ?? 'new',
      });
      const r = await sendTransactionalEmail({
        to: args.email,
        ...rendered,
        ...(firm.name ? { fromName: firm.name } : {}),
        ...(firm.sendingFromEmail ? { replyTo: firm.sendingFromEmail } : {}),
        ...(args.usage ? { usage: args.usage } : {}),
      });
      if (!r.sent) {
        logger.warn({ email: args.email, err: r.error }, 'branded welcome email failed to send (user was created)');
      }
      return { userId: created.userId, branded: true };
    }
  }

  // Standard Supabase invite (Supabase sends its own email).
  const { data, error } = await args.supabase.auth.admin.inviteUserByEmail(args.email, {
    data: { full_name: args.fullName },
    redirectTo: args.redirectTo,
  });
  if (error || !data?.user) return { error: error?.message || 'Invite failed' };
  return { userId: data.user.id, branded: false };
}
