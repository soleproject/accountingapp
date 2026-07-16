import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const appLayout = readFileSync('app/(app)/layout.tsx', 'utf8');
const topBar = readFileSync('components/layout/TopBar.tsx', 'utf8');
const orgSwitcher = readFileSync('components/layout/OrgSwitcher.tsx', 'utf8');
const orgOptionsApi = readFileSync('app/api/orgs/options/route.ts', 'utf8');

assert.doesNotMatch(
  appLayout,
  /listAccessibleOrgs\(/,
  'Accounting layout must not block every protected page render on the full accessible-org dropdown query',
);

assert.match(
  appLayout,
  /const orgs = \[\{ \.\.\.currentOrg, role: ['"]primary['"] as const \}\]/,
  'Accounting layout should seed only the current org so the dropdown trigger renders immediately',
);

assert.match(
  appLayout,
  /<TopBar[\s\S]*orgs=\{orgs\}[\s\S]*currentOrg=\{currentOrg\}/,
  'Accounting layout should keep passing org options into TopBar',
);

assert.match(
  topBar,
  /<OrgSwitcher key=\{currentOrg\.id\} current=\{currentOrg\} options=\{orgs\} \/>/,
  'TopBar should remount the OrgSwitcher at the organization boundary with initial options',
);

assert.match(
  orgSwitcher,
  /aria-haspopup="menu"[\s\S]*aria-expanded=\{open\}/,
  'OrgSwitcher should keep an accessible dropdown trigger visible in the app shell',
);

assert.match(
  orgSwitcher,
  /fetch\('\/api\/orgs\/options'/,
  'OrgSwitcher should lazy-load all accessible orgs only when the user opens the dropdown',
);

assert.match(
  orgSwitcher,
  /optionsState\.map\(\(o\) =>/,
  'OrgSwitcher should render every fetched accessible org option in the dropdown',
);

assert.match(orgOptionsApi, /requireSession\(\)/, 'Org options API must require auth');
assert.match(orgOptionsApi, /listAccessibleOrgs\(\)/, 'Org options API should provide the full accessible org list after first paint');

console.log('accounting-org-switcher-visible: dropdown stays visible while options lazy-load off the document path');
