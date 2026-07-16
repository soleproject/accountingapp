import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('lib/accounting/onboarding.ts', 'utf8');
const body = source.match(/export async function getOnboardingStatus[\s\S]*?\n}\n\nasync function upsertState/)?.[0] ?? source;

assert.doesNotMatch(
  body,
  /\]\s*=\s*await Promise\.all\(/,
  'getOnboardingStatus must not acquire 11 independent sessions concurrently',
);
assert.match(
  body,
  /db\.transaction\(async \(tx\) => Promise\.all\(/,
  'related onboarding snapshot reads must share one reserved transaction connection',
);
assert.match(
  body,
  /const entityTypeOnboardingEnabled = await getEntityTypeOnboardingEnabledForOrg/,
  'entitlement lookup must run after the snapshot transaction instead of joining its fanout',
);

console.log('onboarding-session-pool: onboarding status reads are bounded to a reserved transaction connection');
