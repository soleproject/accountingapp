import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appLayout = readFileSync('app/(app)/layout.tsx', 'utf8');
const sidebar = readFileSync('components/layout/Sidebar.tsx', 'utf8');

assert.doesNotMatch(appLayout, /getOrgFeatures\(/, 'Accounting layout must not gate trust navigation on feature packs');
assert.doesNotMatch(appLayout, /drizzle-orm|@\/db\/client|loadOrgEntityType|db\./, 'App shell must not issue a second organization query for trust gating');
assert.match(appLayout, /getCurrentOrgContext\(\)/, 'App shell should resolve one authorized org context with entity type');
assert.match(
  appLayout,
  /Promise\.all\(\[[\s\S]*requireSession\(\)[\s\S]*getCurrentOrgContext\(\)/,
  'Session and authorized org context must overlap in the app shell',
);
assert.doesNotMatch(appLayout, /listAccessibleWorkspaces\(/, 'Trust gating must not restore eager workspace enumeration');
assert.doesNotMatch(sidebar, /fetch\(['"]\/api\/org\/features['"]/, 'Sidebar must not perform a post-paint trust feature lookup');
assert.match(
  appLayout,
  /['"]\/trust-review['"][\s\S]*['"]\/trust-beneficiaries['"][\s\S]*['"]\/trust-documents['"]/,
  'Accounting layout must hide all trust routes for non-trust entities',
);

console.log('app-layout-trust-feature-deferred: entity gating is server-authoritative and overlapped with app-shell access work');
