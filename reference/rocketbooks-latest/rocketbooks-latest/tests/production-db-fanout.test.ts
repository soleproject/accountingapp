import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

async function main() {
  const aiUsage = await source('app/(super-admin)/super-admin/ai-usage/page.tsx');
  assert(
    !aiUsage.includes('const [[totals], categories, byUser, byFeature, byModel, recent, rates] =\n    await Promise.all'),
    'super-admin ai usage must not open seven DB queries concurrently',
  );
  assert(
    !aiUsage.includes('const [clientLinks, staffLinks] = await Promise.all'),
    'super-admin ai usage enterprise link lookups must not run concurrently',
  );

  const enterpriseDashboard = await source('app/(enterprise)/enterprise/dashboard/page.tsx');
  assert(
    !enterpriseDashboard.includes('const [counts, activity, [org], health] = await Promise.all'),
    'enterprise dashboard must not open its four expensive DB reads concurrently',
  );

  const enterpriseClients = await source('app/(enterprise)/enterprise/clients/page.tsx');
  assert(
    !enterpriseClients.includes('const [rows, [actor]] = await Promise.all'),
    'enterprise clients must not open rows and actor role DB reads concurrently',
  );

  const appLayout = await source('app/(app)/layout.tsx');
  assert(
    !/await\s+Promise\.all/.test(appLayout),
    'protected app layout must not fan out DB/auth/branding/billing reads before first render',
  );
  assert(
    !appLayout.includes('BillingStatusBanner'),
    'protected app layout must not mount billing status queries before first render',
  );

  console.log('production-db-fanout: protected hot routes and app shell avoid known DB Promise.all fanout');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
