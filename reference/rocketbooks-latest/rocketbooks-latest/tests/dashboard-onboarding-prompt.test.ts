import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const dashboard = readFileSync('app/(app)/dashboard/page.tsx', 'utf8');
const summaryClient = readFileSync('app/(app)/dashboard/_components/DashboardSummaryClient.tsx', 'utf8');

assert.match(
  dashboard,
  /onboardingState/,
  'dashboard page should read org onboarding state so incomplete setup is visible outside /ai-chat',
);
assert.match(
  dashboard,
  /showOnboardingPrompt\s*=\s*[\s\S]*!onboarding[\s\S]*completed/,
  'dashboard should compute an incomplete-onboarding prompt from onboarding.completed=false',
);
assert.match(
  dashboard,
  /href=["']\/ai-chat\?onboarding=start["']/,
  'dashboard onboarding prompt should link directly to guided onboarding',
);
assert.match(
  dashboard,
  /Continue onboarding|Finish setup|Set up my company/,
  'dashboard should display a clear onboarding CTA when onboarding is incomplete',
);
assert.doesNotMatch(
  summaryClient,
  /temporarily unavailable|metrics recover|recovery/i,
  'dashboard summary error state must not show internal recovery/failure language to customers',
);

console.log('dashboard-onboarding-prompt: incomplete onboarding surfaces on dashboard and error copy is customer-safe');
