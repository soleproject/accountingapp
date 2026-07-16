import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const tasksPage = readFileSync('app/(app)/tasks/page.tsx', 'utf8');
const attentionCards = readFileSync('app/(app)/tasks/_components/AttentionCards.tsx', 'utf8');
const aiChatPage = readFileSync('app/(app)/ai-chat/page.tsx', 'utf8');

assert.doesNotMatch(
  tasksPage,
  /getActionCards\(/,
  'tasks page must not call the full action-card fanout on the document path',
);
assert.doesNotMatch(
  tasksPage,
  /Promise\.all\(\[/,
  'tasks page must not open count/list/onboarding reads concurrently on Cloudflare session pool',
);
assert.match(
  tasksPage,
  /onboardingState/,
  'tasks page should still load the lightweight onboarding state card',
);
assert.match(
  tasksPage,
  /id:\s*['"]onboarding['"]/,
  'tasks page should still surface the Finish setting up onboarding card',
);
assert.match(
  attentionCards,
  /router\.push\(`\/ai-chat\?onboarding=start&from=\$\{source\}`\)/,
  'onboarding task action must route to the guided onboarding URL with from=tasks',
);
assert.match(
  aiChatPage,
  /resumeOnboarding=\{resumeOnboarding\}/,
  'ai-chat page must pass onboarding=start into the guided onboarding workspace',
);
assert.match(
  aiChatPage,
  /onboarding\s*===\s*['"]start['"]/,
  'ai-chat page must explicitly recognize onboarding=start',
);

console.log('tasks-onboarding-regression: tasks page loads lightweight onboarding card and routes to guided onboarding workspace');
