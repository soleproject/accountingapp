import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';

export interface ResolvedContact {
  /** Resolved id, OR null when the caller meant the "no-contact-assigned" bucket. */
  id: string | null;
  contactName: string | null;
  resolvedVia: 'id' | 'name' | 'substring' | 'substring-reverse' | 'null-bucket';
}

const SUBSTRING_MIN_LEN = 4;

/**
 * Resolve a contact "candidate" against an org's contacts. Mirrors
 * resolve-account.ts but with extra leniency because gpt-4o-mini hallucinates
 * UUIDs and mangles vendor names (singular/plural, ALL CAPS, embedded ids).
 *
 * Order, all org-scoped:
 *   - candidate === null OR === "null" string  → null-bucket
 *   - UUID id match (candidate or candidateName)
 *   - case-insensitive exact name match (candidate, then candidateName)
 *   - substring: candidate is contained in contact_name (single-match required)
 *   - reverse substring: contact_name is contained in candidate (single-match required)
 *
 * Substring paths require ≥ 4 char candidate to avoid false positives like
 * "VCA" matching every contact name with VCA in it. Multi-match results are
 * ambiguous — log and fall through rather than silently picking one.
 */
export async function resolveContact(
  orgId: string,
  candidate: string | null,
  candidateName?: string,
): Promise<ResolvedContact | null> {
  // Null bucket — explicit JSON null, or the string "null" the AI sometimes
  // emits in JSON-arg confusion. Empty string is NOT bucketed; that's likely
  // a tool-arg error and we'd rather fail than auto-target every no-contact row.
  if (candidate === null || candidate === 'null') {
    return { id: null, contactName: null, resolvedVia: 'null-bucket' };
  }
  if (!candidate && !candidateName) return null;

  // 1. UUID id match — try candidate first, then candidateName as fallback.
  for (const c of [candidate, candidateName]) {
    if (!c) continue;
    const [byId] = await db
      .select({ id: contacts.id, contactName: contacts.contactName })
      .from(contacts)
      .where(and(eq(contacts.id, c), eq(contacts.organizationId, orgId)))
      .limit(1);
    if (byId) return { id: byId.id, contactName: byId.contactName, resolvedVia: 'id' };
  }

  // 2. Case-insensitive exact name match — try both candidate and candidateName.
  for (const c of [candidate, candidateName]) {
    if (!c) continue;
    const [byName] = await db
      .select({ id: contacts.id, contactName: contacts.contactName })
      .from(contacts)
      .where(
        and(
          sql`LOWER(${contacts.contactName}) = ${c.toLowerCase()}`,
          eq(contacts.organizationId, orgId),
        ),
      )
      .limit(1);
    if (byName) return { id: byName.id, contactName: byName.contactName, resolvedVia: 'name' };
  }

  // 3. Substring match (candidate ⊆ contact_name) with ambiguity guard.
  //    "VCA Animal Hospital" → "VCA Animal Hospitals" ✓ (single match)
  //    "Office" → "Office Depot" + "Office Supplies Inc" ✗ (ambiguous, fall through)
  for (const c of [candidate, candidateName]) {
    if (!c || c.length < SUBSTRING_MIN_LEN) continue;
    const matches = await db
      .select({ id: contacts.id, contactName: contacts.contactName })
      .from(contacts)
      .where(
        and(
          sql`LOWER(${contacts.contactName}) LIKE ${'%' + c.toLowerCase() + '%'}`,
          eq(contacts.organizationId, orgId),
        ),
      )
      .limit(2);
    if (matches.length === 1) {
      return {
        id: matches[0].id,
        contactName: matches[0].contactName,
        resolvedVia: 'substring',
      };
    }
  }

  // 4. Reverse substring (contact_name ⊆ candidate). Catches "Panera Bread
  //    Bakery" matching DB's "Panera Bread." Same ambiguity guard.
  for (const c of [candidate, candidateName]) {
    if (!c || c.length < SUBSTRING_MIN_LEN) continue;
    const matches = await db
      .select({ id: contacts.id, contactName: contacts.contactName })
      .from(contacts)
      .where(
        and(
          sql`${c.toLowerCase()} LIKE '%' || LOWER(${contacts.contactName}) || '%'`,
          eq(contacts.organizationId, orgId),
        ),
      )
      .limit(2);
    if (matches.length === 1) {
      return {
        id: matches[0].id,
        contactName: matches[0].contactName,
        resolvedVia: 'substring-reverse',
      };
    }
  }

  return null;
}
