import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { enterpriseClients, organizations, users } from '@/db/schema/schema';

// Same non-confusable alphabet + length as the org invite slug
// (lib/enterprise/invite-slug.ts): no 0/O, 1/I/l, S/5. Lowercase, URL-safe.
// ~40 bits of entropy (31^8). Kept independent so the user + org slug systems
// don't share a dependency, but intentionally identical in shape.
const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const SLUG_LENGTH = 8;

/** Generate a single random per-user referral slug. */
export function generateUserReferralSlug(): string {
  const bytes = randomBytes(SLUG_LENGTH);
  let out = '';
  for (let i = 0; i < SLUG_LENGTH; i++) {
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
}

/**
 * Ensure the user has a referral_slug; return whatever is on it. Idempotent —
 * a no-op when already populated. Retries on the partial-unique-index
 * collision (ix_users_referral_slug) up to 5 times. Safe to call lazily from
 * /share on every load so existing users self-heal a slug.
 */
export async function ensureUserReferralSlug(userId: string): Promise<string> {
  const [existing] = await db
    .select({ slug: users.referralSlug })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!existing) throw new Error(`user ${userId} not found`);
  if (existing.slug) return existing.slug;

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateUserReferralSlug();
    try {
      await db.update(users).set({ referralSlug: candidate }).where(eq(users.id, userId));
      return candidate;
    } catch (err) {
      // 23505 = unique_violation on ix_users_referral_slug. drizzle may wrap
      // the driver error, so the pg code can sit on err.cause.code.
      const code = (err as { code?: unknown })?.code;
      const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code;
      if (code === '23505' || causeCode === '23505') continue;
      throw err;
    }
  }
  throw new Error(`Failed to generate a unique referral_slug for ${userId} after 5 attempts`);
}

/**
 * Resolve a ?ref=<slug> to the referring user. Active users only — a
 * deactivated referrer shouldn't accrue new referrals. Returns null when the
 * slug doesn't match (caller then falls through to host-based enterprise
 * resolution, leaving the signup unattributed to any user).
 */
export async function resolveUserFromReferralSlug(
  slug: string,
): Promise<{ id: string; fullName: string } | null> {
  const cleaned = slug.trim().toLowerCase();
  if (!cleaned) return null;
  const [row] = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(and(eq(users.referralSlug, cleaned), eq(users.isActive, true)))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the enterprise a referrer belongs to (as a client). Every regular
 * user signed up under exactly one enterprise (e.g. RocketBooks), recorded in
 * enterprise_clients. The referred org attaches there so existing entitlement
 * / host logic is unchanged, while referral credit goes to the user. Returns
 * null when the referrer isn't a client of any enterprise (caller falls back
 * to host resolution).
 */
export async function resolveReferrerEnterprise(
  referrerUserId: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(enterpriseClients)
    .innerJoin(organizations, eq(organizations.id, enterpriseClients.enterpriseId))
    .where(eq(enterpriseClients.clientUserId, referrerUserId))
    .orderBy(desc(enterpriseClients.createdAt))
    .limit(1);
  return row ?? null;
}
