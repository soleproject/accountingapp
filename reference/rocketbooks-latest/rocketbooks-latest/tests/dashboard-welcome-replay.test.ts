import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync('app/(app)/dashboard/page.tsx', 'utf8');
const replayButton = readFileSync('app/(app)/settings/_components/RelaunchWelcomeButton.tsx', 'utf8');
const welcome = readFileSync('app/(app)/dashboard/_components/DashboardWelcome.tsx', 'utf8');

assert.match(
  replayButton,
  /router\.push\('\/dashboard\?welcome=fresh'\)/,
  'Settings replay button should route to the dashboard welcome replay URL',
);
assert.match(
  dashboard,
  /searchParams/,
  'dashboard page must read searchParams so ?welcome=fresh is not ignored',
);
assert.match(
  dashboard,
  /welcome\s*===\s*['"]fresh['"]/,
  'dashboard page must explicitly recognize ?welcome=fresh',
);
assert.match(
  dashboard,
  /DashboardWelcome/,
  'dashboard page must import/render DashboardWelcome for first-run and replay flows',
);
assert.match(
  dashboard,
  /welcomeDismissedAt/,
  'dashboard page must check users.welcomeDismissedAt for first-run clients',
);
assert.match(
  dashboard,
  /TourPickerHost/,
  'dashboard page must preserve ?tour=pick handling for the top-bar tour picker',
);
assert.match(
  dashboard,
  /showTourPicker\s*=\s*params\.tour\s*===\s*['"]pick['"]/,
  'dashboard page must explicitly recognize ?tour=pick',
);
assert.match(
  dashboard,
  /\{showTourPicker\s*&&\s*<TourPickerHost/,
  'tour picker should render whenever ?tour=pick is present, even if welcomeDismissedAt is null',
);
assert.match(
  dashboard,
  /\{!showTourPicker\s*&&\s*showWelcome\s*&&\s*<DashboardWelcome/,
  'welcome takeover must not override the explicit top-bar tour picker request',
);
assert.match(
  welcome,
  /router\.push\('\/ai-chat\?onboarding=start'\)/,
  'welcome setup chip must still launch the onboarding wizard path',
);

console.log('dashboard-welcome-replay: dashboard handles welcome replay, first-run welcome, and tour picker entrypoints');
