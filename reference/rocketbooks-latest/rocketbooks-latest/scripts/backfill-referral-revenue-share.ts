/**
 * Retroactively credit referral revenue share to UNTIERED enterprises.
 *
 * Background: untiered enterprises (organizations.enterprise_tier IS NULL)
 * now earn a flat 20%-of-gross referral share — see resolveRevenueShareLine()
 * in lib/enterprise/tiers.ts. The live writers (recordInitialClientRevenueShare
 * on signup, recordPaidBillingPeriodForClient on Stripe events) emit those
 * rows going forward, but clients who joined an untiered enterprise BEFORE
 * that change have no ledger row. This script writes the missing initial rows.
 *
 *   npx tsx scripts/backfill-referral-revenue-share.ts            # dry run
 *   npx tsx scripts/backfill-referral-revenue-share.ts --commit   # write
 *
 * Scope & semantics:
 *   - Only untiered enterprises (enterprise_tier IS NULL). Tier'd enterprises
 *     are untouched — their rows already exist via the live writers.
 *   - Only PAYING client orgs: a client organization with a non-demo
 *     (feature_key <> 'demo_full'), unexpired subscription. This matches what
 *     the Share page projects earnings on — demo workspaces, 7-day trials, and
 *     no-subscription orgs earn $0 and are intentionally excluded.
 *   - Only orgs with NO existing revenue-share row at all, so a client already
 *     credited (by live code or a prior run) is skipped — safe to re-run, no
 *     double-credit.
 *   - Writes ONE row per paying org for its CURRENT subscription period
 *     (current_period_start..end), mirroring recordPaidBillingPeriodForClient.
 *     It does NOT reconstruct every past period — there is no periodic billing
 *     job yet, so historical month-by-month reconstruction is out of scope.
 *
 * Note on imports: the live writer lib/enterprise/revenue-share.ts is
 * `server-only`, which tsx can't resolve (Next aliases it at build). So we
 * mirror its insert here but pull the actual referral amount from the pure
 * resolveRevenueShareLine() in tiers.ts — the single source of truth for the
 * money — so this script and production can't disagree on what's owed.
 *
 * Idempotent: the unique (client_organization_id, billing_period_start) index
 * plus the "no existing row" filter make re-runs harmless.
 */
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });

const COMMIT = process.argv.includes('--commit');

async function main() {
  // Dynamic imports — load after dotenv so POSTGRES_URL is populated. Both
  // modules are plain (non-server-only): db/client just wires drizzle, and
  // tiers.ts is the pure tier/referral registry.
  const { db } = await import('../db/client');
  const { enterpriseClientRevenueShare } = await import('../db/schema/schema');
  const { resolveRevenueShareLine, REFERRAL_SHARE_CENTS, REFERRAL_GROSS_SHARE_PCT } =
    await import('../lib/enterprise/tiers');

  // Gather paying client orgs of untiered enterprises that have no ledger row.
  // - ent: an untiered enterprise (enterprise_tier IS NULL).
  // - o:   a company owned by one of that enterprise's clients (exclude any
  //        enterprise-plan org the client might own).
  // - os/bp: the org's subscription must be non-demo and unexpired — same
  //        "paying" test as classifyEnterpriseClients/the Share projection.
  // - NOT EXISTS: skip orgs that already have a revenue-share row.
  // DISTINCT ON (o.id): one row per org even if it somehow has multiple
  //   qualifying subs — take the latest-ending period.
  type Target = {
    enterprise_id: string;
    enterprise_name: string | null;
    client_org_id: string;
    client_org_name: string | null;
    subscription_id: string;
    period_start: string | null;
    period_end: string | null;
  };
  const rows = await db.execute<Target>(sql`
    select distinct on (o.id)
      ent.id   as enterprise_id,
      ent.name as enterprise_name,
      o.id     as client_org_id,
      o.name   as client_org_name,
      os.id    as subscription_id,
      os.current_period_start as period_start,
      os.current_period_end   as period_end
    from enterprise_clients ec
    join organizations ent
      on ent.id = ec.enterprise_id
     and ent.enterprise_tier is null
    join organizations o
      on o.owner_user_id = ec.client_user_id
     and o.plan_type is distinct from 'enterprise'
    join organization_subscriptions os
      on os.organization_id = o.id
    join billing_products bp
      on bp.id = os.billing_product_id
    where bp.feature_key <> 'demo_full'
      and (os.current_period_end is null or os.current_period_end > now())
      and not exists (
        select 1
        from enterprise_client_revenue_share rs
        where rs.client_organization_id = o.id
      )
    order by o.id, os.current_period_end desc nulls last
  `);

  const list = Array.from(rows as Iterable<Target>);
  list.sort((a, b) =>
    (a.enterprise_name ?? '').localeCompare(b.enterprise_name ?? '') ||
    (a.client_org_name ?? '').localeCompare(b.client_org_name ?? ''),
  );

  if (list.length === 0) {
    console.log('· nothing to backfill — every paying untiered-enterprise client already has a revenue-share row.');
    process.exit(0);
  }

  const perClient = `$${(REFERRAL_SHARE_CENTS / 100).toFixed(2)}/mo (${REFERRAL_GROSS_SHARE_PCT}% of gross)`;
  console.log(
    `${COMMIT ? 'CREDITING' : 'DRY RUN — would credit'} ${list.length} client${list.length === 1 ? '' : 's'} ` +
    `across untiered enterprises at ${perClient}:\n`,
  );

  let credited = 0;
  let skipped = 0;
  for (const r of list) {
    // Credited period = the subscription's current period. Fall back to "now"
    // for the start if Stripe didn't populate it (mirrors the live writer's
    // initial-row default); derive the end from the referral interval.
    const periodStart = r.period_start ? new Date(r.period_start) : new Date();
    const periodEnd = r.period_end
      ? new Date(r.period_end)
      : (() => {
          const e = new Date(periodStart);
          e.setMonth(e.getMonth() + 1);
          return e;
        })();

    const label = `${r.enterprise_name ?? r.enterprise_id} → ${r.client_org_name ?? r.client_org_id}` +
      ` (period ${periodStart.toLocaleDateString()}–${periodEnd.toLocaleDateString()})`;

    if (!COMMIT) {
      console.log(`  • ${label}`);
      continue;
    }

    // Mirror recordInitialClientRevenueShare: 1-indexed position among this
    // enterprise's already-recorded clients. For referral the index doesn't
    // affect the amount (no cap), but the column is NOT NULL and we keep the
    // same meaning the live writer uses.
    const [existing] = await db
      .select({ n: sql<number>`count(distinct ${enterpriseClientRevenueShare.clientOrganizationId})::int` })
      .from(enterpriseClientRevenueShare)
      .where(eq(enterpriseClientRevenueShare.enterpriseId, r.enterprise_id));
    const clientIndex = (existing?.n ?? 0) + 1;

    // Untiered → referral line (20% of $89, no cap, 'referral' sentinel).
    const share = resolveRevenueShareLine(null, clientIndex);

    // onConflictDoNothing backstops the NOT EXISTS filter against the unique
    // (client_org, period_start) index — a concurrent live insert can't cause
    // a double-credit or a crash.
    const inserted = await db
      .insert(enterpriseClientRevenueShare)
      .values({
        id: randomUUID(),
        enterpriseId: r.enterprise_id,
        clientOrganizationId: r.client_org_id,
        clientSubscriptionId: r.subscription_id,
        enterpriseTier: share.enterpriseTier,
        billingPeriodStart: periodStart.toISOString(),
        billingPeriodEnd: periodEnd.toISOString(),
        clientPriceCents: share.clientPriceCents,
        partnerShareCents: share.partnerShareCents,
        isWithinCap: share.isWithinCap,
        clientIndexAtWrite: clientIndex,
        currency: 'usd',
      })
      .onConflictDoNothing()
      .returning({ id: enterpriseClientRevenueShare.id });

    if (inserted.length > 0) {
      credited++;
      console.log(`  ✓ ${label}`);
    } else {
      skipped++;
      console.log(`  – ${label} — skipped (already had a row)`);
    }
  }

  if (COMMIT) {
    console.log(`\ndone. credited ${credited}, skipped ${skipped}.`);
  } else {
    console.log(`\ndry run only — re-run with --commit to write these ${list.length} rows.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ referral revenue-share backfill failed:', err);
  process.exit(1);
});
