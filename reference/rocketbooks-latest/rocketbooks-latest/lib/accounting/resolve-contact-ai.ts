import 'server-only';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { chatCompletion } from '@/lib/ai/openai';
import { logger } from '@/lib/logger';
import { normalizeContactNameForMatch } from './normalize-contact-name';

/**
 * Step 2.a / 2.a.i of the Plaid promotion pipeline.
 *
 *   2.a   Contact = merchant_name, if no merchant_name then →
 *   2.a.i Look for a contact in the description (Plaid's `name` field).
 *         If a viable counterparty exists, semantically match it against the
 *         org's existing contacts (so "PayPal" matches "PayPal Inc.",
 *         "Romeo Ugali" matches "Romeo G Ugali", etc.). Reuse on match,
 *         create otherwise.
 *
 * Internal/no-counterparty rows (account-to-account transfers, monthly
 * maintenance fees, interest credits) return null — the caller leaves
 * `contact_id` null on those.
 *
 * Anti-bug guard: this function never returns the raw bank description as a
 * contact name. The previous pipeline did, which is what produced the junk
 * "Online Banking transfer to CHK 6084 Confirmation# XXXXX..." contacts.
 */

const ResolutionSchema = z.object({
  has_counterparty: z
    .boolean()
    .describe('false for internal transfers between the user\'s own accounts, monthly fees, interest, etc.'),
  extracted_name: z
    .string()
    .nullable()
    .describe('The clean counterparty name to use as the contact, e.g. "Romeo Ugali" not "Zelle payment to Romeo Ugali Conf# xxxx"'),
  match_existing_id: z
    .string()
    .nullable()
    .describe('id of an existing contact that semantically represents the same counterparty, or null to create a new one'),
  reason: z.string(),
});
type Resolution = z.infer<typeof ResolutionSchema>;

export interface ResolveContactArgs {
  organizationId: string;
  /** Plaid raw_json.merchant_name when present. */
  merchantName: string | null;
  /** Plaid raw_json.name (the bank-side description). */
  description: string | null;
  /** Plaid PFC primary, used as a strong "is this a transfer?" signal. */
  pfcPrimary: string | null;
  /** 'deposit' | 'withdrawal'; used for new-contact typeTags inference. */
  type: 'deposit' | 'withdrawal' | null;
  /** For ai_usage_events attribution. */
  actorUserId?: string | null;
  actor?: string;
}

export interface ResolveContactResult {
  contactId: string | null;
  source: 'merchant_name' | 'ai_match_existing' | 'ai_new_contact' | 'no_counterparty';
  contactName: string | null;
  reason?: string;
}

/**
 * Idempotent fast path: case-insensitive exact match on contact_name.
 * Used when Plaid gave us merchant_name directly — that field is already
 * normalized and we don't need an LLM round-trip to decide if it's a
 * "real" counterparty. The slow AI path is only for missing-merchant rows.
 */
async function findExactContact(orgId: string, name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, orgId),
        eq(contacts.isActive, true),
      ),
    )
    .limit(500);
  // `eq` on case-insensitive comparison via raw SQL is messier; iterate in JS
  // since we have to load contacts for the AI path anyway.
  return null; // placeholder — real implementation in resolveContact below
}
void findExactContact;

async function insertContact(args: {
  organizationId: string;
  contactName: string;
  type: 'deposit' | 'withdrawal' | null;
}): Promise<string> {
  const tags = args.type === 'deposit' ? ['customer'] : args.type === 'withdrawal' ? ['vendor'] : [];
  const id = randomUUID();
  try {
    await db.insert(contacts).values({
      id,
      organizationId: args.organizationId,
      contactName: args.contactName,
      typeTags: tags,
      isActive: true,
      createdByAi: true,
      needsReview: true,
    });
    return id;
  } catch (err) {
    // Race / unique-index conflict: a concurrent insert (or the DB-level
    // unique partial index on lower(trim(contact_name))) rejected this one.
    // Re-query using the same normalized comparison the resolver uses
    // upstream so we converge on whichever row won.
    const candidates = await db
      .select({ id: contacts.id, contactName: contacts.contactName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, args.organizationId), eq(contacts.isActive, true)));
    const target = normalizeContactNameForMatch(args.contactName);
    const existing = candidates.find(
      (c) => normalizeContactNameForMatch(c.contactName) === target,
    );
    if (existing) return existing.id;
    throw err;
  }
}

/**
 * True when the proposed contact name is essentially the transaction's
 * description — backstop against the model echoing raw bank text.
 *
 * Only fires for *long* names (≥ 40 chars). Legitimate merchant names —
 * "Walmart", "Mercedes-Benz Financial Services", "Internal Revenue Service",
 * "Bank of America", "Capital One, NA" — are virtually all under 40 chars,
 * so they pass through even when the description is identical (which can
 * happen on clean Plaid raw_json.name values for major merchants).
 *
 * The 40+ cases are almost exclusively echoes of bank descriptions like
 * "Recurring Payment authorized on 12/30 Icg_Sas Grenoble Fra S465… Card 6236"
 * — Layer 2's regex usually catches these on its own; this is the safety
 * net for descriptions that don't match a known noise pattern.
 */
function resemblesDescription(name: string, description: string): boolean {
  if (!name || !description) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const n = norm(name);
  const d = norm(description);
  if (n.length < 40) return false; // short names always allowed
  if (n === d) return true;
  if (d.includes(n) || n.includes(d)) return true;
  return false;
}

async function callAiResolver(args: {
  description: string;
  pfcPrimary: string | null;
  existingContacts: Array<{ id: string; name: string }>;
  organizationId: string;
  actorUserId: string | null;
  actor: string;
}): Promise<Resolution | null> {
  const model = process.env.AI_CONTACT_RESOLVE_MODEL ?? 'gpt-4o-mini';

  const contactList = args.existingContacts.length
    ? args.existingContacts.map((c) => `- ${c.id} :: ${c.name}`).join('\n')
    : '(no existing contacts)';

  const system = `You identify counterparty names from US bank-transaction descriptions and match them against an existing contact list.

Rules:
- DEFAULT to has_counterparty=true and try to extract a name. Transfer phrasing ("Online Banking transfer", "Online Transfer to/from", "TRANSFER", "WIRE TYPE", "WT Fed#…") does NOT by itself mean there is no counterparty — examine the rest of the description for a real entity (person, business, trust, fund, government, attorney, etc.).
  • "Online Transfer to Psg Spendthrift Trust Ref #lb0W2Bphy4 …" → has_counterparty=true, extracted_name="Psg Spendthrift Trust"
  • "WT Fed#02M04 Jpmorgan Chase Ban /Org=Grace&Love Trust Roman Gonzalez Srf# …" → has_counterparty=true, extracted_name="Grace&Love Trust"
  • "WIRE TYPE:WIRE OUT ORIG:ACME LLC ID:…" → has_counterparty=true, extracted_name="Acme LLC"
  • "Online Transfer From Nexxess Everyday Checking xxxxxx7776 Ref #…" → has_counterparty=true, extracted_name="Nexxess"
  • "Zelle payment to Romeo Ugali Conf# xxxx" → has_counterparty=true, extracted_name="Romeo Ugali"
- has_counterparty=false ONLY when the description is genuinely internal — it references only the user's own bank account identifiers and contains no third-party entity name. Signals: just an account number after "TO"/"FROM" ("TRANSFER TO ACCT 6084", "TO CHK 1234", "TO SAV ####"), book/internal markers with no named entity ("WELLS FARGO IFI DDA TO DDA", "WIRE TYPE BOOK" with no ORIG:/Bnf= name), bank fees ("Monthly Maintenance Fee", "Wire Transfer Fee", "Wire Trans Svc Charge"), and interest ("Interest Earned", "INTRST PYMNT", "Interest Payment"). For these set extracted_name=null and match_existing_id=null.
- has_counterparty=true for: real merchants, billers (Capital One, Citi Card, Healthy Paws Pet, etc.), Zelle/Venmo recipients (the *person* being paid, not the app), wire originators (the ORIG: or /Bnf= or /Org= field, not the bank).
- extracted_name must be the CLEAN counterparty — strip every authorization code, transaction id, card number, location code, and memo. Examples:
  • "Romeo Ugali" not "Zelle payment to Romeo Ugali Conf# xxxx"
  • "Capital One" not "CAPITAL ONE DES:MOBILE PMT ID:XXXXX44380 WEB"
  • "Healthy Paws Pet" not "Healthy Paws Pet DES:claimpymt ID:XXXXX..."
  • "Zoom" not "Recurring Payment authorized on 12/26 Zoom.Com 888-799-9 Zoom.US CA S355360700932398 Card 6236"
  • "GitHub" not "Recurring Payment authorized on 12/27 Github, Inc. Github.Com CA S355361673115061 Card 6236"
  • "Atlassian" not "Recurring Payment authorized on 12/18 Atlassian Amsterdam Nld S585353115422388 Card 6236"
  • "Adobe" not "Recurring Payment authorized on 12/14 Adobe Inc San Jose CA S305348580878822 Card 6236"
  • "Veryfi" not "Recurring Payment authorized on 12/01 Veryfi, Inc. (Very Veryfi.Com CA S355335289443283 Card 6236"
- "Recurring Payment authorized on <date> <MERCHANT> [city/state/country] [auth code] Card #####" pattern: extract just the merchant name from the middle. Drop the date prefix, drop everything after the merchant (location, S###, Card #).
- "WIRE TYPE:... ORIG:<NAME> ID:..." or "WT Fed#... /Org=<NAME>" or "WT Fed#... /Bnf=<NAME>": extract the entity name only.
- For Zelle/Venmo: the recipient (or sender) IS the counterparty. The app name is not.
- Drop trailing memos like For "birthday Pizza ;)" — those are notes, not part of the name.
- Strip middle initials when matching against existing contacts ("Romeo G Ugali" should match an existing "Romeo Ugali").
- Match semantically: "PayPal" matches "PayPal Inc.", "Capital One" matches "Capital One, NA" or "Capital One Bank", "AT&T" matches "AT&T Inc". Use match_existing_id only when you're confident it's the same entity. When uncertain, return null and let a new contact be created.
- NEVER return the raw bank description as extracted_name. If you can't confidently extract a clean name (≤ 60 chars, no Card/auth codes), set has_counterparty=false instead so a human reviews it.

Output strict JSON: {"has_counterparty": bool, "extracted_name": string|null, "match_existing_id": string|null, "reason": string}`;

  // Source-agnostic prompt — the same rules apply whether the description
  // came from Plaid (raw_json.name), Veryfi (vendor.raw_name + memo line),
  // or a CSV import. PFC is included only when caller has it (Plaid path);
  // Veryfi callers pass null and the AI relies on description heuristics.
  const user = `Description: ${args.description}
${args.pfcPrimary ? `Plaid PFC primary: ${args.pfcPrimary}\n` : ''}
Existing contacts in this org (id :: name):
${contactList}

Resolve this transaction's counterparty per the rules.`;

  try {
    const completion = await chatCompletion(
      {
        userId: args.actorUserId,
        orgId: args.organizationId,
        actor: args.actor,
        feature: 'resolve-contact',
      },
      {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      },
    );
    const text = completion.choices[0]?.message?.content ?? '{}';
    const parsed = ResolutionSchema.parse(JSON.parse(text));

    // Sanity: if the model returned an id that isn't actually in our list,
    // discard it (the model occasionally hallucinates IDs).
    if (parsed.match_existing_id) {
      const known = args.existingContacts.some((c) => c.id === parsed.match_existing_id);
      if (!known) parsed.match_existing_id = null;
    }

    // Sanity: reject extracted names that look like raw bank text. The
    // prompt asks the model not to return raw descriptions, but it
    // occasionally regresses on uncommon patterns. Patterns we treat as
    // unambiguously-junk:
    //   - longer than 60 characters (real merchant names rarely are)
    //   - contains "Card ####" or auth-code-like substrings
    //   - contains the literal "Recurring Payment authorized on" prefix
    //   - contains newlines (multi-line bank descriptions)
    //   - contains "Conf#" / "Trn#" / "Srf#" / " ID:" / " S\d{14,}"
    if (parsed.extracted_name) {
      const n = parsed.extracted_name;
      const looksJunk =
        n.length > 60 ||
        /\bCard\s*\d{4,}/i.test(n) ||
        /Recurring Payment authorized on/i.test(n) ||
        /[\n\r]/.test(n) ||
        /\bConf#|\bTrn#|\bSrf#|\sID:/.test(n) ||
        /\sS\d{12,}/.test(n);
      if (looksJunk) {
        parsed.extracted_name = null;
        parsed.match_existing_id = null;
        parsed.has_counterparty = false;
      }
    }

    // Final guard: even if the model returns something that passes the regex
    // checks, refuse to create a contact whose name is essentially the
    // transaction's description. Hard guarantee that we never end up with
    // a contact named "Recurring Payment authorized on…" / "Wire Trans Svc
    // Charge - Sequence:…" / etc. just because the model echoed the input.
    if (parsed.extracted_name && resemblesDescription(parsed.extracted_name, args.description)) {
      parsed.extracted_name = null;
      parsed.match_existing_id = null;
      parsed.has_counterparty = false;
    }
    return parsed;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'resolve-contact-ai failed; promotion will leave contact_id null',
    );
    return null;
  }
}

/**
 * Resolve a contact for a Plaid transaction per the pipeline spec
 * (steps 2.a / 2.a.i). Returns null contactId for internal transfers, fees,
 * interest — those rows leave contact_id NULL by design.
 */
export async function resolveContact(args: ResolveContactArgs): Promise<ResolveContactResult> {
  // 2.a. merchant_name fast path. Plaid/Veryfi-supplied merchant name — use it
  //      directly, with normalized matching against existing contacts (lowercase
  //      + trim + corp-suffix-strip), so "GitHub" / "GitHub, Inc." / "GITHUB"
  //      all resolve to the same existing row. No AI round-trip for this case.
  const merchant = args.merchantName?.trim();
  if (merchant) {
    const existingByName = await db
      .select({ id: contacts.id, contactName: contacts.contactName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, args.organizationId), eq(contacts.isActive, true)));
    const merchantKey = normalizeContactNameForMatch(merchant);
    const existing = existingByName.find(
      (c) => normalizeContactNameForMatch(c.contactName) === merchantKey,
    );
    if (existing) {
      return { contactId: existing.id, source: 'merchant_name', contactName: existing.contactName };
    }
    const newId = await insertContact({
      organizationId: args.organizationId,
      contactName: merchant,
      type: args.type,
    });
    return { contactId: newId, source: 'merchant_name', contactName: merchant };
  }

  // 2.a.i. AI-semantic resolution from description.
  const description = args.description?.trim();
  if (!description) {
    return { contactId: null, source: 'no_counterparty', contactName: null, reason: 'no description' };
  }

  const existingContacts = await db
    .select({ id: contacts.id, name: contacts.contactName })
    .from(contacts)
    .where(and(eq(contacts.organizationId, args.organizationId), eq(contacts.isActive, true)));

  const ai = await callAiResolver({
    description,
    pfcPrimary: args.pfcPrimary,
    existingContacts,
    organizationId: args.organizationId,
    actorUserId: args.actorUserId ?? null,
    actor: args.actor ?? 'system',
  });
  if (!ai) {
    return { contactId: null, source: 'no_counterparty', contactName: null, reason: 'ai unavailable' };
  }
  if (!ai.has_counterparty) {
    return { contactId: null, source: 'no_counterparty', contactName: null, reason: ai.reason };
  }

  if (ai.match_existing_id) {
    const matched = existingContacts.find((c) => c.id === ai.match_existing_id);
    return {
      contactId: ai.match_existing_id,
      source: 'ai_match_existing',
      contactName: matched?.name ?? ai.extracted_name,
      reason: ai.reason,
    };
  }

  if (!ai.extracted_name) {
    return { contactId: null, source: 'no_counterparty', contactName: null, reason: ai.reason };
  }

  // Deterministic exact-match on extracted_name BEFORE inserting. The AI is
  // asked to set match_existing_id when it sees a semantic match, but it
  // sometimes returns null even when the strings are literally identical
  // ("GitHub" extracted, "GitHub" already in the contacts list). Without this
  // check, every Veryfi import re-extracts the same name and we INSERT a
  // fresh duplicate — which is exactly the dupe pattern in the contacts page.
  // Use the same normalize helper as the merchant_name path so this is the
  // single source of truth for "is this the same vendor as one we already
  // have?" — works for any vendor name, not just GitHub.
  const extractedKey = normalizeContactNameForMatch(ai.extracted_name);
  if (extractedKey) {
    const sameByName = existingContacts.find(
      (c) => normalizeContactNameForMatch(c.name) === extractedKey,
    );
    if (sameByName) {
      return {
        contactId: sameByName.id,
        source: 'ai_match_existing',
        contactName: sameByName.name,
        reason: `${ai.reason} (matched existing by normalized name)`,
      };
    }
  }

  const newId = await insertContact({
    organizationId: args.organizationId,
    contactName: ai.extracted_name,
    type: args.type,
  });
  return { contactId: newId, source: 'ai_new_contact', contactName: ai.extracted_name, reason: ai.reason };
}
