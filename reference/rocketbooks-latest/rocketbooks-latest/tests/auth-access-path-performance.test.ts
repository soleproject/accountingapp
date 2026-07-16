import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const layout = readFileSync('app/(app)/layout.tsx', 'utf8');
const workspace = readFileSync('lib/auth/workspace.ts', 'utf8');

assert.match(
  layout,
  /Promise\.all\(\[\s*requireSession\(\),\s*getCurrentOrgContext\(\),?\s*\]\)/,
  'app shell should overlap session with one joined authorized org context',
);
assert.doesNotMatch(layout, /loadOrgEntityType|@\/db\/client|drizzle-orm/, 'app shell must not add a second organization query');
assert.doesNotMatch(layout, /listAccessibleWorkspaces\(/, 'workspace enumeration must stay off the protected document path');

assert.doesNotMatch(
  workspace,
  /hasAnyPermission\(/,
  'workspace resolution should resolve the permission set once instead of awaiting the same permission helper per product',
);
assert.match(
  workspace,
  /getUserPermissions\(\)/,
  'workspace resolution should reuse one per-request resolved permission set',
);
assert.doesNotMatch(
  workspace,
  /users\.role/,
  'workspace resolution should reuse the role already resolved with permissions instead of querying the user twice',
);
assert.match(
  workspace,
  /Promise\.all\(\[[\s\S]*getUserPermissions\(\)[\s\S]*enterpriseStaff/,
  'permission and enterprise-membership resolution should overlap rather than form a DB waterfall',
);

console.log('auth-access-path-performance: app-shell auth/org/workspace work starts concurrently and workspace permissions resolve once');
