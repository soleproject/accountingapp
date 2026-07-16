import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const appLayout = readFileSync('app/(app)/layout.tsx', 'utf8');
const sidebar = readFileSync('components/layout/Sidebar.tsx', 'utf8');

assert.match(
  appLayout,
  /hiddenNavPaths\s*=\s*\[[\s\S]*['"]\/ai-chat['"][\s\S]*\]/,
  'Accounting app layout should explicitly hide /ai-chat from the left nav',
);
assert.doesNotMatch(
  appLayout,
  /import\s+\{\s*listAccessibleWorkspaces\s*\}\s+from\s+['"]@\/lib\/auth\/workspace['"]/,
  'Accounting app layout should not import workspace enumeration into the document path',
);
assert.doesNotMatch(
  appLayout,
  /listAccessibleWorkspaces\(\)/,
  'Accounting app layout should defer workspace options until the dropdown opens',
);
assert.match(
  appLayout,
  /<Sidebar\b[\s\S]*hiddenNavPaths=\{hiddenNavPaths\}/,
  'Accounting app layout should pass the hide list while Sidebar lazily loads workspace options',
);
assert.match(sidebar, /['"]\/api\/workspaces\/options['"]/, 'Sidebar should keep the top-left workspace dropdown via the lazy options endpoint');
assert.match(
  appLayout,
  /<LazyAIAssistantSidecar\b/,
  'AI Sidecar must remain mounted through its lazy client boundary while hiding only the left-nav entry',
);
assert.match(
  appLayout,
  /<AssistantProvider>/,
  'AssistantProvider must remain mounted for the AI button and sidecar',
);
assert.match(
  sidebar,
  /\{\s*href:\s*['"]\/ai-chat['"],\s*label:\s*['"]AI Assistant['"]/,
  'Sidebar should keep the AI Assistant entry defined so this is a reversible nav-visibility change, not a route/feature removal',
);
assert.match(
  sidebar,
  /hiddenSet\.has\(entry\.href\)\) return null/,
  'Sidebar must filter hidden top-level nav entries from visible output',
);

console.log('left-nav-ai-hidden: /ai-chat hidden from accounting left nav while AI Provider/Sidecar remain mounted');
