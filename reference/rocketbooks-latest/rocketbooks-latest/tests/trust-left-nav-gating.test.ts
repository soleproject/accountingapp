import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const appLayout = readFileSync('app/(app)/layout.tsx', 'utf8');
const orgAuth = readFileSync('lib/auth/org.ts', 'utf8');
const sidebar = readFileSync('components/layout/Sidebar.tsx', 'utf8');

assert.match(orgAuth, /organizations\.entityType/, 'Authorized org context must select the current organization entity type');
assert.match(orgAuth, /getCurrentOrgContext/, 'Trust gating must reuse the authorized org context');
assert.doesNotMatch(appLayout, /organizations\.entityType|@\/db\/client/, 'Trust nav must not add a second layout database query');
assert.match(appLayout, /beneficial_trust[\s\S]*business_trust/, 'Both supported trust entity types must enable trust navigation');
assert.match(
  appLayout,
  /isTrustOrg\s*\?\s*\[\]\s*:\s*\[['"]\/trust-review['"][\s\S]*['"]\/trust-beneficiaries['"][\s\S]*['"]\/trust-documents['"]\]/,
  'Non-trust entities must keep every trust navigation path hidden',
);
assert.doesNotMatch(
  sidebar,
  /fetch\(['"]\/api\/org\/features['"]|hasTrustFeature/,
  'Sidebar must not reveal trust navigation from accounting feature-pack flags',
);

const navBlock = sidebar.slice(sidebar.indexOf('const NAV'), sidebar.indexOf('function isActive'));
assert.doesNotMatch(navBlock, /^  \{ href: ['"]\/trust-review['"], label: ['"]Trust Review['"]/m);
assert.doesNotMatch(navBlock, /^  \{ href: ['"]\/trust-beneficiaries['"], label: ['"]Trust Beneficiaries['"]/m);
assert.doesNotMatch(navBlock, /^  \{ href: ['"]\/trust-documents['"], label: ['"]Trust Documents['"]/m);
assert.match(
  sidebar,
  /key:\s*['"]trust['"][\s\S]*label:\s*['"]Trust['"][\s\S]*items:\s*\[[\s\S]*href:\s*['"]\/trust-review['"][\s\S]*href:\s*['"]\/trust-beneficiaries['"][\s\S]*href:\s*['"]\/trust-documents['"]/,
  'Trust routes should remain consolidated under one collapsible Trust nav group',
);

console.log('trust-left-nav-gating: trust routes are server-gated by entity type and grouped under Trust');
