import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const layout = readFileSync('app/(organizer)/organizer/layout.tsx', 'utf8');

assert.doesNotMatch(
  layout,
  /Promise\.all\(\[\s*db\.select[\s\S]*isRecorderEnabled\(/,
  'organizer layout must not fan out core shell DB reads with optional recorder/text feature gates',
);
assert.match(
  layout,
  /async function loadOrganizerFeatureFlags\(/,
  'organizer layout should isolate optional recorder/text feature gates in a small guarded loader',
);
assert.match(
  layout,
  /loadOrganizerFeatureFlags\([\s\S]*\)\.catch\(/,
  'organizer optional feature gates must catch transient DB pool failures instead of crashing document render',
);
assert.match(
  layout,
  /loadOrganizerBranding\([\s\S]*\)\.catch\(/,
  'organizer branding lookup must catch transient DB pool failures instead of crashing document render',
);
assert.match(
  layout,
  /organizer feature gates degraded/,
  'organizer feature gate degradation should be logged for Cloudflare tail debugging',
);
assert.match(
  layout,
  /organizer branding degraded/,
  'organizer branding degradation should be logged for Cloudflare tail debugging',
);

console.log('organizer-layout-db-fanout: optional recorder/text gates are isolated and degradable');
