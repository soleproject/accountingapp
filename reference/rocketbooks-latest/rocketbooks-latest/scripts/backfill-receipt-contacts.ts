/**
 * Backfill receipts.contact_id for receipts uploaded under the old
 * exact-match-only rules. For every receipt where contact_id IS NULL,
 * pull veryfi vendor.name out of veryfi_raw_json and run
 * resolveVendorContact (normalized match → AI fuzzy → auto-create).
 *
 * Defaults to DRY-RUN. Pass --apply to commit.
 *
 * Run:
 *   npx tsx scripts/backfill-receipt-contacts.ts            # dry-run
 *   npx tsx scripts/backfill-receipt-contacts.ts --apply    # commit
 */
import { config } from 'dotenv';
import { isNull, eq, and } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const apply = process.argv.includes('--apply');
  const { db } = await import('../db/client');
  const { receipts, organizations } = await import('../db/schema/schema');
  const { resolveVendorContact } = await import('../lib/receipts/resolve-vendor-contact');

  const rows = await db
    .select({
      id: receipts.id,
      orgId: receipts.organizationId,
      orgName: organizations.name,
      raw: receipts.veryfiRawJson,
    })
    .from(receipts)
    .leftJoin(organizations, eq(receipts.organizationId, organizations.id))
    .where(isNull(receipts.contactId));

  console.log(`Found ${rows.length} unlinked receipt(s) ${apply ? '— applying' : '(dry-run — pass --apply to commit)'}`);

  const stats = { exact: 0, ai: 0, created: 0, skipped: 0, errored: 0 };
  for (const r of rows) {
    let vendor: string | null = null;
    if (r.raw) {
      try {
        const p = JSON.parse(r.raw) as { vendor?: { name?: string } };
        vendor = p.vendor?.name?.trim() || null;
      } catch {}
    }
    if (!vendor) {
      console.log(`  ${r.id.slice(0, 8)} | ${r.orgName} | (no vendor in veryfi raw) — skipping`);
      stats.skipped += 1;
      continue;
    }
    try {
      const result = await resolveVendorContact({ organizationId: r.orgId, vendorName: vendor });
      if (!result.contactId) {
        console.log(`  ${r.id.slice(0, 8)} | ${r.orgName} | vendor="${vendor}" — resolver returned null`);
        stats.skipped += 1;
        continue;
      }
      console.log(`  ${r.id.slice(0, 8)} | ${r.orgName} | vendor="${vendor}" → ${result.source} (${result.contactName})`);
      if (result.source === 'exact_match') stats.exact += 1;
      else if (result.source === 'ai_match') stats.ai += 1;
      else if (result.source === 'created') stats.created += 1;
      if (apply) {
        await db
          .update(receipts)
          .set({ contactId: result.contactId })
          .where(and(eq(receipts.id, r.id), eq(receipts.organizationId, r.orgId)));
      }
    } catch (err) {
      console.log(`  ${r.id.slice(0, 8)} | ${r.orgName} | ERROR: ${err instanceof Error ? err.message : String(err)}`);
      stats.errored += 1;
    }
  }

  console.log(
    `\nDone. exact_match=${stats.exact} ai_match=${stats.ai} created=${stats.created} skipped=${stats.skipped} errored=${stats.errored}`,
  );
  if (!apply) console.log('No DB writes performed — re-run with --apply to commit.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
