import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const sidecar = readFileSync('components/ai-assistant/AIAssistantSidecar.tsx', 'utf8');
const guided = readFileSync('app/(app)/ai-chat/_components/GuidedOnboardingClient.tsx', 'utf8');

assert.match(
  sidecar,
  /useSearchParams/,
  'sidecar must inspect search params so /ai-chat?onboarding=start can opt back into the floating assistant',
);
assert.match(
  sidecar,
  /onGuidedOnboardingRoute/,
  'sidecar must distinguish guided onboarding from normal /ai-chat shell',
);
assert.match(
  sidecar,
  /if \(onAiChatRoute && !onGuidedOnboardingRoute\) return null/,
  'normal /ai-chat may hide the sidecar, but guided onboarding must not',
);
assert.match(
  guided,
  /setChatChannel\('onboarding'\)/,
  'guided onboarding must route sidecar chat through the onboarding endpoint',
);
assert.match(
  guided,
  /registerOnboardingToolResultHandler/,
  'guided onboarding must receive onboarding tool results from the sidecar',
);
assert.match(
  guided,
  /requestSidecarOpen\('side'\)/,
  'guided onboarding should open the assistant side panel by default',
);

console.log('guided-onboarding-sidecar: /ai-chat?onboarding=start keeps assistant sidecar visible and wired to onboarding tools');
