import 'server-only';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, contacts, aiClientOutreach, categorizationRules } from '@/db/schema/schema';

/**
 * Recent transactions whose other party the AI doesn't know yet — grouped by
 * merchant/party. "Unknown" = no contact, OR a contact with no confirmed
 * history, OR a generic payment processor (PayPal/Venmo/Zelle/etc.) where the
 * REAL party is hidden in the description. Processor transactions are grouped by
 * description so each distinct underlying party gets its own inquiry — and once
 * a party has a rule (or its txns are reviewed) it drops out. Excludes anything
 * already asked about or already covered by a categorization rule.
 */

const GENERIC_PROCESSORS = ['paypal', 'venmo', 'zelle', 'cash app', 'cashapp', 'square', 'stripe', 'wise', 'remitly'];

function isProcessor(name: string | null, desc: string | null): boolean {
  const s = `${name ?? ''} ${desc ?? ''}`.toLowerCase();
  return GENERIC_PROCESSORS.some((p) => s.includes(p));
}

export interface UnknownContactGroup {
  merchant: string;
  contactId: string | null;
  txnIds: string[];
  count: number;
  total: number;
  sample: { date: string | null; amount: number | null; description: string | null };
}

export async function findUnknownContactGroups(orgId: string, days = 5): Promise<UnknownContactGroup[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const knownRows = await db
    .selectDistinct({ contactId: transactions.contactId })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, orgId),
        eq(transactions.reviewed, true),
        sql`${transactions.journalEntryId} is not null`,
        sql`${transactions.contactId} is not null`,
      ),
    );
  const knownContactIds = new Set(knownRows.map((k) => k.contactId).filter((x): x is string => !!x));

  const prior = await db
    .select({ context: aiClientOutreach.context })
    .from(aiClientOutreach)
    .where(and(eq(aiClientOutreach.organizationId, orgId), eq(aiClientOutreach.issueType, 'contact_inquiry')));
  const asked = new Set<string>();
  for (const p of prior) {
    const ids = (p.context as { transactionIds?: string[] } | null)?.transactionIds;
    if (Array.isArray(ids)) for (const id of ids) asked.add(id);
  }

  // A txn already covered by a deterministic rule will auto-categorize — don't ask.
  const ruleRows = await db
    .select({ pattern: categorizationRules.pattern })
    .from(categorizationRules)
    .where(eq(categorizationRules.organizationId, orgId));
  const rulePatterns = ruleRows.map((r) => (r.pattern ?? '').toLowerCase()).filter((p) => p.length >= 3);

  const rows = await db
    .select({
      id: transactions.id,
      contactId: transactions.contactId,
      contactName: contacts.contactName,
      date: transactions.date,
      amount: transactions.amount,
      bankDescription: transactions.bankDescription,
      description: transactions.description,
    })
    .from(transactions)
    .leftJoin(contacts, eq(transactions.contactId, contacts.id))
    .where(
      and(
        eq(transactions.organizationId, orgId),
        or(eq(transactions.reviewed, false), isNull(transactions.reviewed)),
        sql`${transactions.createdAt} >= ${cutoff}`,
      ),
    );

  const groups = new Map<string, UnknownContactGroup>();
  for (const r of rows) {
    if (asked.has(r.id)) continue;
    const desc = r.bankDescription ?? r.description ?? '';
    const descLc = desc.toLowerCase();
    if (rulePatterns.some((p) => descLc.includes(p))) continue; // a rule already handles it

    const proc = isProcessor(r.contactName, desc);
    const known = !!r.contactId && knownContactIds.has(r.contactId);
    if (known && !proc) continue; // genuinely known, non-processor → AI knows it

    // Processors: group by description (distinct memo = distinct party). Others:
    // group by contact, else description.
    const display = proc ? (desc || r.contactName || 'Unknown') : (r.contactName || desc || 'Unknown');
    const key = proc ? `p:${descLc.trim()}` : r.contactId ? `c:${r.contactId}` : `d:${display.toLowerCase().trim()}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        merchant: display,
        contactId: proc ? null : r.contactId ?? null,
        txnIds: [],
        count: 0,
        total: 0,
        sample: { date: r.date, amount: r.amount, description: desc || null },
      };
      groups.set(key, g);
    }
    g.txnIds.push(r.id);
    g.count++;
    g.total += Math.abs(Number(r.amount ?? 0));
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}
