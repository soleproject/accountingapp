import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { chatCompletion } from '@/lib/ai/openai';
import { normalizeContactNameForMatch } from '@/lib/accounting/normalize-contact-name';
import { logger } from '@/lib/logger';

export interface ResolveVendorContactResult {
  contactId: string | null;
  source: 'exact_match' | 'ai_match' | 'created' | 'skipped';
  contactName: string | null;
}

/**
 * Receipt-specific vendor → contact resolver. Three tiers:
 *
 *   1. Normalized exact match. Cheap, deterministic — handles
 *      "Walmart" ↔ "WALMART" ↔ "Walmart, Inc." via the shared
 *      normalizeContactNameForMatch helper (lowercases + strips corp
 *      suffixes). No AI call when this hits.
 *
 *   2. AI semantic match. When tier 1 misses, ask gpt-4o-mini whether
 *      the OCR'd vendor name corresponds to one of the org's existing
 *      contacts ("WinCo Foods" ↔ existing "WinCo", "Mc Donalds" ↔
 *      "McDonald's", etc.). Skipped when the org has zero contacts —
 *      no candidates to match against.
 *
 *   3. Auto-create. If tier 1 and 2 both miss, insert a new
 *      contact and return its id. Tagged as vendor (typeTags=['vendor'])
 *      and flagged createdByAi=true / needsReview=true so the contact
 *      list surfaces it for the user to confirm.
 *
 * Failures (network, malformed JSON, no API key) silently degrade —
 * tier 3 still runs so the receipt always ends up linked to *some*
 * contact when Veryfi gave us a vendor name.
 */
export async function resolveVendorContact(input: {
  organizationId: string;
  vendorName: string | null | undefined;
  actorUserId?: string | null;
}): Promise<ResolveVendorContactResult> {
  const raw = input.vendorName?.trim();
  if (!raw) return { contactId: null, source: 'skipped', contactName: null };

  const existing = await db
    .select({ id: contacts.id, name: contacts.contactName })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, input.organizationId),
        eq(contacts.isActive, true),
      ),
    );

  // Tier 1: normalized exact match.
  const vendorKey = normalizeContactNameForMatch(raw);
  const exact = existing.find((c) => normalizeContactNameForMatch(c.name) === vendorKey);
  if (exact) {
    return { contactId: exact.id, source: 'exact_match', contactName: exact.name };
  }

  // Tier 2: AI fuzzy match. Only when there's a candidate pool worth asking
  // about. Single LLM call per upload; degrade silently on failure.
  if (existing.length > 0) {
    const aiMatch = await aiFindMatchingContact({
      vendor: raw,
      candidates: existing,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? null,
    });
    if (aiMatch) {
      return { contactId: aiMatch.id, source: 'ai_match', contactName: aiMatch.name };
    }
  }

  // Tier 3: create.
  const id = randomUUID();
  try {
    await db.insert(contacts).values({
      id,
      organizationId: input.organizationId,
      contactName: raw,
      typeTags: ['vendor'],
      isActive: true,
      createdByAi: true,
      needsReview: true,
    });
    logger.info({ contactId: id, vendor: raw, orgId: input.organizationId }, 'created contact from receipt vendor');
    return { contactId: id, source: 'created', contactName: raw };
  } catch (err) {
    // Race against a concurrent insert / DB-level unique constraint on
    // normalized contact name. Re-query with the normalized key and
    // converge on whichever row won.
    const refetched = await db
      .select({ id: contacts.id, name: contacts.contactName })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, input.organizationId),
          eq(contacts.isActive, true),
        ),
      );
    const winner = refetched.find((c) => normalizeContactNameForMatch(c.name) === vendorKey);
    if (winner) return { contactId: winner.id, source: 'exact_match', contactName: winner.name };
    logger.error(
      { err: err instanceof Error ? err.message : String(err), vendor: raw },
      'resolveVendorContact: insert failed and no winning row found',
    );
    return { contactId: null, source: 'skipped', contactName: null };
  }
}

async function aiFindMatchingContact(args: {
  vendor: string;
  candidates: Array<{ id: string; name: string }>;
  organizationId: string;
  actorUserId: string | null;
}): Promise<{ id: string; name: string } | null> {
  const list = args.candidates.map((c) => `- ${c.id} :: ${c.name}`).join('\n');
  const prompt = `A receipt OCR returned this vendor name: "${args.vendor}"

The user already has these contacts in their address book:
${list}

If the receipt's vendor is clearly the same business as one of these contacts (ignoring corporate suffixes like Inc/LLC/Foods/Co, abbreviations, capitalization, punctuation, spacing) — return that contact's id. Otherwise return null.

Be conservative: only match when you're confident it's the same entity. Examples that SHOULD match:
- "WinCo Foods" ↔ "WinCo"
- "Mc Donalds" ↔ "McDonald's"
- "AT&T Wireless" ↔ "AT&T"
- "Walmart Supercenter" ↔ "Walmart"
- "Whole Foods Market" ↔ "Whole Foods"

Examples that should NOT match:
- "Apple Inc" ↔ "Apple Bee's" (different companies)
- "Target" ↔ "Target Optical" (related but distinct)
- "Bank of America" ↔ "Bank of the West" (different banks)`;

  try {
    const response = await chatCompletion(
      { userId: args.actorUserId, orgId: args.organizationId, actor: 'system', feature: 'receipt-vendor-match' },
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'VendorMatch',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['matchId', 'reason'],
              properties: {
                matchId: { type: ['string', 'null'] },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
    );
    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw) as { matchId: string | null; reason: string };
    // gpt-4o-mini occasionally returns the literal string "null" (or "None")
    // instead of JSON null even when the schema permits both. Treat those
    // as no-match so we don't fall through to the hallucination check.
    if (!parsed.matchId || /^null$/i.test(parsed.matchId.trim()) || /^none$/i.test(parsed.matchId.trim())) {
      return null;
    }
    // Sanity: model occasionally hallucinates ids. Verify the id is in the
    // candidate list we sent it.
    const match = args.candidates.find((c) => c.id === parsed.matchId);
    if (!match) {
      logger.warn({ vendor: args.vendor, hallucinatedId: parsed.matchId }, 'aiFindMatchingContact: model returned unknown id');
      return null;
    }
    logger.info({ vendor: args.vendor, matchedTo: match.name, reason: parsed.reason }, 'AI matched receipt vendor to existing contact');
    return match;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), vendor: args.vendor },
      'aiFindMatchingContact failed — caller will create a new contact',
    );
    return null;
  }
}
