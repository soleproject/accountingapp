/**
 * Cross-source duplicate sweep — backfill existing dupes + cross-account clusters.
 *
 * DRY-RUN by default (prints the plan, changes nothing). Per the double-post
 * incident protocol: review a dry-run per org before applying.
 *
 *   npx tsx scripts/sweep-cross-source-dupes.ts <orgId>            # dry-run report
 *   npx tsx scripts/sweep-cross-source-dupes.ts <orgId> --apply    # quarantine
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const orgId = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!orgId || orgId.startsWith('--')) {
    console.error('usage: tsx scripts/sweep-cross-source-dupes.ts <orgId> [--apply]');
    process.exit(1);
  }

  const { sweepOrgDuplicates } = await import('../lib/audit/dedupe-sweep');
  const report = await sweepOrgDuplicates(orgId, { apply });

  console.log(`\nCross-source dedupe sweep — org ${orgId}`);
  console.log(`  scanned (recognized-source, active): ${report.scannedRows}`);
  console.log(`  cross-account clusters (same bank, different label): ${report.clusters.length}`);
  for (const c of report.clusters) {
    console.log(`    • ${c.accountA} ↔ ${c.accountB}: ${c.matched}/${c.minCount} matched (${(c.ratio * 100).toFixed(0)}%)`);
  }
  const sameAcct = report.plan.filter((p) => p.scope === 'same-account').length;
  const crossAcct = report.plan.filter((p) => p.scope === 'cross-account').length;
  console.log(`  duplicates to quarantine: ${report.plan.length} (same-account ${sameAcct}, cross-account ${crossAcct})`);
  console.log(`  total amount removed from GL: $${report.totalQuarantineAmount.toFixed(2)}`);
  for (const p of report.plan.slice(0, 50)) {
    console.log(`    - keep ${p.survivorRef} | remove ${p.loserRef}  $${p.amount.toFixed(2)}  [${p.scope}]`);
  }
  if (report.plan.length > 50) console.log(`    …and ${report.plan.length - 50} more`);

  if (report.applied) {
    console.log(`\n✓ APPLIED — ${report.plan.length} rows quarantined (JEs reversed, moved to Removed-duplicates bucket).`);
  } else {
    console.log(`\nDRY RUN — nothing changed. Re-run with --apply to quarantine.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
