import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync('app/(app)/dashboard/page.tsx', 'utf8');

assert.match(
  dashboard,
  /async function loadDashboardGate\(/,
  'dashboard should isolate first-render profile/onboarding reads in a small guarded loader',
);
assert.match(
  dashboard,
  /loadDashboardGate\([\s\S]*\)\.catch\(/,
  'dashboard must catch profile/onboarding DB failures so a transient pool miss does not render a customer error boundary',
);
assert.match(
  dashboard,
  /welcomeDismissedAt:\s*new Date\(0\)/,
  'dashboard fallback should suppress welcome takeover when profile lookup fails, preserving a usable dashboard shell',
);
assert.match(
  dashboard,
  /onboarding:\s*null/,
  'dashboard fallback should suppress onboarding prompt when onboarding lookup fails instead of crashing',
);
assert.match(
  dashboard,
  /logger\.error\([\s\S]*dashboard first-render gate degraded/,
  'dashboard fallback should log a sanitized degradation for tail/debugging',
);

console.log('dashboard-first-render-resilience: dashboard degrades profile/onboarding gate instead of throwing error boundary');
