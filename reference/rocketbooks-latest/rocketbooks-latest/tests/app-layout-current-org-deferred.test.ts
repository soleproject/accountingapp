import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appLayout = readFileSync('app/(app)/layout.tsx', 'utf8');
const orgSwitcher = readFileSync('components/layout/OrgSwitcher.tsx', 'utf8');
const orgOptionsApi = readFileSync('app/api/orgs/options/route.ts', 'utf8');

assert.doesNotMatch(
  appLayout,
  /db\s*\.select\([\s\S]*organizations\.name[\s\S]*from\(organizations\)/,
  'Accounting app layout must not block first render on current organization name lookup',
);

assert.match(
  appLayout,
  /const currentOrg = \{ id: orgContext\.id, name: ['"]Workspace['"], entityType: orgContext\.entityType \}/,
  'Accounting layout should seed a lightweight current-org placeholder from the joined authorized context',
);

assert.match(
  orgOptionsApi,
  /currentOrg/,
  'Org options API should return the hydrated current org name after first paint',
);

assert.match(
  orgSwitcher,
  /setHydratedCurrent/,
  'OrgSwitcher should hydrate the visible current org name after loading org options',
);

console.log('app-layout-current-org-deferred: current org name hydrates after first paint');
