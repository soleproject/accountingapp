import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appLayout = readFileSync('app/(app)/layout.tsx', 'utf8');
const features = readFileSync('lib/accounting/get-org-feature.ts', 'utf8');
const featuresApi = readFileSync('app/api/org/features/route.ts', 'utf8');

assert.doesNotMatch(
  appLayout,
  /getOrgFeatures\(/,
  'Accounting app layout must not block first render on feature queries',
);

assert.match(
  featuresApi,
  /getOrgFeatures\(orgId, \['beneficial_trust', 'business_trust'\]\)/,
  'Trust feature hydration API should bundle trust feature checks into one DB call',
);

assert.match(
  features,
  /export async function getOrgFeatures\(/,
  'Feature helper should expose a batched lookup for layout-level feature flags',
);

assert.match(
  features,
  /inArray\(organizationAccountingFeatures\.featurePack, featurePacks\)/,
  'Batched feature lookup should use one IN query over requested feature packs',
);

console.log('app-layout-feature-bundle: trust nav feature checks are bundled off the first-render path');
