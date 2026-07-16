import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const org = readFileSync('lib/auth/org.ts', 'utf8');

assert.match(
  org,
  /if \(fromCookie === dbOrgId\) return \{ id: fromCookie, entityType: dbEntityType \};/,
  'authorized org context should accept the DB-backed active-org cookie without loading the full org switcher list',
);

assert.match(
  org,
  /if \(fromCookie\)[\s\S]*if \(fromCookie === dbOrgId\) return \{ id: fromCookie, entityType: dbEntityType \};[\s\S]*const accessible = await listAccessibleOrgs\(\)/,
  'authorized org context should only call listAccessibleOrgs for non-default cookie validation',
);

console.log('current-org-fast-cookie: default active-org cookie avoids full accessible-org list before page render');
