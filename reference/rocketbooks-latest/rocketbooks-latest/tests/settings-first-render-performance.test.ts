import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/settings/page.tsx', 'utf8');
const settingsClient = readFileSync('app/(app)/settings/_components/SettingsClient.tsx', 'utf8');
const automationClient = readFileSync('app/(app)/settings/_components/SettingsAutomationClient.tsx', 'utf8');
const summaryRoute = readFileSync('app/api/settings/summary/route.ts', 'utf8');
const automationRoute = readFileSync('app/api/settings/automation/route.ts', 'utf8');

assert.doesNotMatch(
  page,
  /db\.select\(|getCurrentOrgId\(|hasAnyPermission\(|settingsToLevel\(|inboundConfigured\(/,
  'settings first document path must not block on org/profile DB or automation permission work',
);

assert.match(
  page,
  /<SettingsClient \/>/,
  'settings route should render a shell/client island instead of server-rendering full settings data',
);

assert.match(
  settingsClient,
  /fetch\('\/api\/settings\/summary'/,
  'settings client should fetch profile/org summary after first paint',
);

assert.match(
  automationClient,
  /fetch\('\/api\/settings\/automation'/,
  'settings automation controls should load after first paint',
);

assert.match(
  summaryRoute,
  /requireSession\(\)/,
  'settings summary API must remain authenticated',
);
assert.match(
  summaryRoute,
  /getCurrentOrgId\(\)/,
  'settings summary API must remain org-scoped',
);
assert.match(
  automationRoute,
  /hasAnyPermission\(\[/,
  'settings automation API must keep the pro/firm permission gate',
);

console.log('settings-first-render-performance: settings route returns shell first; profile/org and automation data are guarded after-paint API loads');
