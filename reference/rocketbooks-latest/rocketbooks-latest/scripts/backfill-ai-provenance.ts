/**
 * One-off backfill: populate transactions.ai_confidence / ai_reason / ai_source
 * for already-categorized rows so the accountant review queue's Confidence
 * column + "Why?" drawer light up on historical data.
 *
 * PROVENANCE ONLY — this does NOT change any category, contact, or journal
 * entry. It runs the same categorizer the live job uses (one call per
 * merchant+type group) and writes only the ai_* display columns. Safe to
 * re-run.
 *
 * Run: npx tsx scripts/backfill-ai-provenance.ts "1134, LLC" [limit]
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
config({ path: '.env.local' });

// tsx can't resolve `import 'server-only'` (Next aliases it at build). Copy
// Next's compiled empty stub into node_modules/server-only/ so the lib modules
// — which all start with `import 'server-only'` — load. Same approach as
// scripts/smoke-test-templates.ts. Must run before the dynamic imports below.
function bootstrapServerOnlyStub() {
  const stubDir = join(process.cwd(), 'node_modules', 'server-only');
  const nextEmpty = join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled', 'server-only', 'empty.js');
  const nextPkg = join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled', 'server-only', 'package.json');
  if (!existsSync(nextEmpty)) return;
  if (!existsSync(stubDir)) mkdirSync(stubDir, { recursive: true });
  if (!existsSync(join(stubDir, 'package.json'))) copyFileSync(nextPkg, join(stubDir, 'package.json'));
  copyFileSync(nextEmpty, join(stubDir, 'index.js'));
}

async function main() {
  bootstrapServerOnlyStub();
  const orgNameArg = process.argv[2] ?? '1134, LLC';
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : 1000;

  const { and, eq, or, isNull, ilike, inArray } = await import('drizzle-orm');
  const { db } = await import('../db/client');
  const { organizations, transactions, plaidRawTransactions } = await import('../db/schema/schema');
  const { categorizeTransaction } = await import('../lib/ai/categorization');

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(ilike(organizations.name, `%${orgNameArg}%`))
    .limit(1);
  if (!org) { console.error(`✗ no org matching "${orgNameArg}"`); process.exit(1); }
  console.log(`Org: ${org.name} (${org.id})`);

  // Unreviewed rows that can actually be categorized.
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, org.id),
        or(eq(transactions.reviewed, false), isNull(transactions.reviewed)),
      ),
    )
    .limit(limit);

  const candidates = rows.filter((r) => r.amount != null && r.type && r.accountId);
  console.log(`Unreviewed rows: ${rows.length} (${candidates.length} categorizable)`);

  // Group by merchant (contact or description) + type — one AI call per group.
  const groups = new Map<string, typeof candidates>();
  for (const t of candidates) {
    const merchant = t.contactId ? `c:${t.contactId}` : `d:${(t.bankDescription ?? t.description ?? '').toLowerCase().trim()}`;
    const key = `${merchant}|${t.type ?? '?'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  console.log(`Merchant groups: ${groups.size} (= AI calls)`);

  async function loadPfc(reference: string | null) {
    if (!reference?.startsWith('plaid:')) return null;
    const id = reference.slice('plaid:'.length);
    if (!id) return null;
    const [raw] = await db
      .select({ rawJson: plaidRawTransactions.rawJson })
      .from(plaidRawTransactions)
      .where(eq(plaidRawTransactions.plaidTransactionId, id))
      .limit(1);
    const pfc = (raw?.rawJson as { personal_finance_category?: { primary?: string | null; detailed?: string | null; confidence_level?: string | null } } | undefined)?.personal_finance_category;
    return pfc ? { primary: pfc.primary, detailed: pfc.detailed, confidenceLevel: pfc.confidence_level } : null;
  }

  let updated = 0;
  let calls = 0;
  const stamp = new Date().toISOString();
  for (const [key, group] of groups) {
    const rep = [...group].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
    try {
      const pfc = await loadPfc(rep.reference);
      const suggestion = await categorizeTransaction({
        organizationId: org.id,
        description: rep.userDescription || rep.bankDescription || rep.description || '',
        amount: rep.amount!,
        type: rep.type!,
        date: rep.date,
        contactId: rep.contactId ?? null,
        plaidPfc: pfc,
        actor: 'backfill',
      });
      calls++;
      await db
        .update(transactions)
        .set({
          aiConfidence: suggestion.confidence,
          aiReason: suggestion.reason,
          aiSource: suggestion.source,
          aiCategorizedAt: stamp,
        })
        .where(inArray(transactions.id, group.map((g) => g.id)));
      updated += group.length;
      console.log(`  ✓ ${key.slice(0, 50)} — ${(suggestion.confidence * 100).toFixed(0)}% (${suggestion.source}) → ${group.length} row(s)`);
    } catch (err) {
      console.error(`  ✗ ${key.slice(0, 50)} — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone. AI calls: ${calls}, rows stamped: ${updated}.`);
  process.exit(0);
}
main().catch((err) => { console.error('✗ backfill failed:', err); process.exit(1); });
