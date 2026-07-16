import 'server-only';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { normalizeContactNameForMatch } from './normalize-contact-name';

/**
 * Find or create a contact in the org by merchant/description string.
 * - Match uses normalizeContactNameForMatch (lowercase + trim + corp-suffix
 *   strip) so "GitHub" / "GitHub, Inc." / "GITHUB" collapse to the same row.
 * - If creating: isActive=true, typeTags inferred from txn type
 *   ('vendor' for withdrawal, 'customer' for deposit).
 * - Returns the contact id, or null if merchantName is empty/blank.
 *
 * Race-safe: the DB-level unique partial index on (organization_id,
 * lower(trim(contact_name))) WHERE is_active=true rejects concurrent
 * inserts; we catch the conflict and re-query.
 */
export async function findOrCreateContact(args: {
  organizationId: string;
  merchantName: string | null | undefined;
  type?: string | null;
}): Promise<string | null> {
  const name = args.merchantName?.trim();
  if (!name) return null;

  const matchKey = normalizeContactNameForMatch(name);
  if (!matchKey) return null;

  const candidates = await db
    .select({ id: contacts.id, contactName: contacts.contactName })
    .from(contacts)
    .where(and(eq(contacts.organizationId, args.organizationId), eq(contacts.isActive, true)));
  const existing = candidates.find(
    (c) => normalizeContactNameForMatch(c.contactName) === matchKey,
  );
  if (existing) return existing.id;

  const tags =
    args.type === 'deposit'
      ? ['customer']
      : args.type === 'withdrawal'
        ? ['vendor']
        : [];

  const id = randomUUID();
  try {
    await db.insert(contacts).values({
      id,
      organizationId: args.organizationId,
      contactName: name,
      typeTags: tags,
      isActive: true,
    });
    return id;
  } catch {
    // Race / unique-index conflict: another caller inserted concurrently.
    // Re-query using the same normalized comparison.
    const retry = await db
      .select({ id: contacts.id, contactName: contacts.contactName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, args.organizationId), eq(contacts.isActive, true)));
    const found = retry.find(
      (c) => normalizeContactNameForMatch(c.contactName) === matchKey,
    );
    return found?.id ?? null;
  }
}
