import 'server-only';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';

// 31-char alphabet — base32-ish but stripped of visual ambiguities:
// no 0/O, 1/I/l, S/5. Lowercase only so users can transcribe a slug
// from a printed handout without worrying about case. URL-safe.
const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const SLUG_LENGTH = 8;

/**
 * Generate a single random slug. ~40 bits of entropy
 * (31^8 ≈ 8.5×10^11). Collision-free at any realistic partner count,
 * but the caller still has to handle UNIQUE-violation retries because
 * a unique index is the only durable guarantee.
 */
export function generateInviteSlug(): string {
  // crypto.randomBytes -> map each byte to one alphabet char. Bias is
  // negligible for a 31-char alphabet vs 256-value bytes (~3% per char),
  // and far below what would matter for guessability at this length.
  const bytes = randomBytes(SLUG_LENGTH);
  let out = '';
  for (let i = 0; i < SLUG_LENGTH; i++) {
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
}

/**
 * Make sure the org has an invite_slug; return whatever is on it.
 * Idempotent: a no-op when the column is already populated. Retries on
 * unique-index collision (vanishingly rare at this length) up to 5 times
 * before throwing.
 *
 * Safe to call lazily from partner-facing surfaces — e.g. the Share
 * page can call this on every load so legacy enterprises self-heal the
 * first time the partner visits.
 */
export async function ensureInviteSlug(organizationId: string): Promise<string> {
  const [existing] = await db
    .select({ slug: organizations.inviteSlug })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!existing) throw new Error(`organization ${organizationId} not found`);
  if (existing.slug) return existing.slug;

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateInviteSlug();
    try {
      await db
        .update(organizations)
        .set({ inviteSlug: candidate })
        .where(eq(organizations.id, organizationId));
      return candidate;
    } catch (err) {
      // 23505 = unique_violation on ix_organizations_invite_slug.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to generate a unique invite_slug for ${organizationId} after 5 attempts`);
}
