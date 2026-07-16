import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const layout = readFileSync('app/(app)/layout.tsx', 'utf8');
const sidebar = readFileSync('components/layout/Sidebar.tsx', 'utf8');
const switcher = readFileSync('components/layout/WorkspaceSwitcher.tsx', 'utf8');
const routePath = 'app/api/workspaces/options/route.ts';
const route = existsSync(routePath) ? readFileSync(routePath, 'utf8') : '';

assert.doesNotMatch(
  layout,
  /listAccessibleWorkspaces/,
  'protected layout must not resolve every accessible workspace before first render',
);
assert.match(
  layout,
  /<Sidebar\b[\s\S]*hiddenNavPaths=\{hiddenNavPaths\}/,
  'protected layout should render Sidebar without awaiting a workspace list',
);
assert.match(
  sidebar,
  /optionsEndpoint=\{[\s\S]*['"]\/api\/workspaces\/options['"][\s\S]*\}/,
  'accounting Sidebar should seed its current workspace and lazily load authorized options',
);
assert.match(
  switcher,
  /fetch\(optionsEndpoint/,
  'WorkspaceSwitcher should fetch authorized options only when its lazy endpoint is used',
);
assert.match(
  switcher,
  /Loading workspaces/,
  'WorkspaceSwitcher should expose a safe loading state while options resolve',
);
assert.match(
  switcher,
  /Unable to load workspaces/,
  'WorkspaceSwitcher should fail closed to an error instead of showing unauthorized choices',
);
assert.match(
  route,
  /listAccessibleWorkspaces\(\)/,
  'workspace options route should reuse the existing authorization-derived resolver',
);

console.log('workspace-switcher-lazy: protected shell defers authorized workspace enumeration until first open');
