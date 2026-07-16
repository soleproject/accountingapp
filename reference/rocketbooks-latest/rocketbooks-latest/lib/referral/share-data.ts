import 'server-only';
import { and, eq, gte, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
import { db } from '@/db/client';
import { enterpriseClients, organizations } from '@/db/schema/schema';
import {
  ENTERPRISE_TIERS,
  isEnterpriseTierKey,
  projectedPartnerMonthlyCents,
  projectedReferralMonthlyCents,
  type EnterpriseTier,
} from '@/lib/enterprise/tiers';
import { ensureInviteSlug } from '@/lib/enterprise/invite-slug';
import { classifyEnterpriseClients, type EnterpriseClientCounts } from '@/lib/enterprise/clients';
import { ensureUserReferralSlug } from './user-slug';
import { classifyUserReferrals } from './user-counts';

/**
 * Everything the Share UI needs for one referrer org, pre-computed and
 * serializable so a presentational component (<ShareView />) can render it
 * without touching the DB. Shared by the enterprise Share page and the
 * per-user app Share page — `orgId` is simply the referrer org id (any org
 * can refer; tier'd enterprises are a special case via `tier`).
 */
export interface ShareData {
  orgName: string;
  /** The referral link partners hand out (marketing site + ?ref=slug). */
  inviteUrl: string;
  /** Server-rendered inline QR SVG for inviteUrl. */
  qrSvg: string;
  counts: EnterpriseClientCounts;
  totalSignups: number;
  monthSignups: number;
  /** Set only for tier'd enterprises (pl_495/pl_995/cp1); null = 20% referral. */
  tier: EnterpriseTier | null;
  /** Cap-meter numbers, tier'd orgs only. */
  cap: {
    projected: { totalCents: number; preCapClients: number; postCapClients: number };
    spotsLeft: number;
    percentUsed: number;
    overCap: boolean;
  } | null;
  /** Flat-20% projection for referral (non-tier) orgs. */
  referralProjected: { totalCents: number };
}

/**
 * Build the Share view-model for a referrer org. Lazily ensures the org has
 * an invite slug (works for any org, not just enterprises). Mirrors the math
 * the enterprise dashboard uses so both Share surfaces agree.
 */
export async function getShareData(orgId: string): Promise<ShareData> {
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      tier: organizations.enterpriseTier,
      inviteSlug: organizations.inviteSlug,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`organization ${orgId} not found`);

  const tier = isEnterpriseTierKey(org.tier) ? ENTERPRISE_TIERS[org.tier] : null;

  // Lazy slug ensure — first visit to Share self-heals an org with no slug.
  const slug = org.inviteSlug ?? (await ensureInviteSlug(org.id));

  // Referral links route through the marketing site, which forwards
  // ?ref=<slug> to /api/public/trial-signup for attribution.
  const marketingBase = (process.env.NEXT_PUBLIC_MARKETING_URL ?? 'https://www.rocketbooks.ai').replace(/\/+$/, '');
  const inviteUrl = `${marketingBase}/?ref=${slug}`;

  const qrSvg = await QRCode.toString(inviteUrl, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
    color: { dark: '#18181b', light: '#ffffff' },
  });

  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [counts, [monthRow]] = await Promise.all([
    classifyEnterpriseClients(org.id),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(enterpriseClients)
      .where(and(eq(enterpriseClients.enterpriseId, org.id), gte(enterpriseClients.createdAt, monthAgo))),
  ]);
  const totalSignups = counts.total;
  const monthSignups = monthRow?.n ?? 0;

  const cap = tier
    ? (() => {
        const projected = projectedPartnerMonthlyCents(tier, counts.paying);
        const spotsLeft = Math.max(0, tier.includedCompaniesCap - totalSignups);
        const percentUsed = Math.min(100, Math.round((totalSignups / tier.includedCompaniesCap) * 100));
        const overCap = totalSignups > tier.includedCompaniesCap;
        return { projected, spotsLeft, percentUsed, overCap };
      })()
    : null;
  const referralProjected = projectedReferralMonthlyCents(counts.paying);

  return {
    orgName: org.name,
    inviteUrl,
    qrSvg,
    counts,
    totalSignups,
    monthSignups,
    tier,
    cap,
    referralProjected,
  };
}

/**
 * Per-user variant of getShareData: the Share view-model for an individual
 * referrer (the logged-in user), independent of which workspace they're in.
 * The slug lives on the user, attribution is by organizations.referred_by_user_id,
 * and there's never a tier/cap — always the flat 20% referral model. Returns
 * the same ShareData shape so <ShareView /> renders unchanged.
 */
export async function getUserShareData(
  userId: string,
  userFullName: string,
): Promise<ShareData> {
  // Lazy slug ensure — first /share visit self-heals a user with no slug.
  const slug = await ensureUserReferralSlug(userId);

  // Referral links route through the marketing site, which forwards
  // ?ref=<slug> to /api/public/trial-signup for attribution.
  const marketingBase = (process.env.NEXT_PUBLIC_MARKETING_URL ?? 'https://www.rocketbooks.ai').replace(/\/+$/, '');
  const inviteUrl = `${marketingBase}/?ref=${slug}`;

  const qrSvg = await QRCode.toString(inviteUrl, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
    color: { dark: '#18181b', light: '#ffffff' },
  });

  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [counts, [monthRow]] = await Promise.all([
    classifyUserReferrals(userId),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(organizations)
      .where(and(eq(organizations.referredByUserId, userId), gte(organizations.createdAt, monthAgo))),
  ]);

  const referralProjected = projectedReferralMonthlyCents(counts.paying);

  return {
    // ShareView copy reads "credited to {orgName} as your referral" — for a
    // user that's their own name.
    orgName: userFullName,
    inviteUrl,
    qrSvg,
    counts,
    totalSignups: counts.total,
    monthSignups: monthRow?.n ?? 0,
    tier: null,
    cap: null,
    referralProjected,
  };
}
