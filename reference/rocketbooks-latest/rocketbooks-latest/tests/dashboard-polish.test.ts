import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function main() {
  const source = await readFile(new URL('../app/(app)/dashboard/page.tsx', import.meta.url), 'utf8');
  const layout = await readFile(new URL('../app/(app)/layout.tsx', import.meta.url), 'utf8');

  assert(!source.includes('Dashboard recovery mode'), 'dashboard route must not present recovery-mode copy to users');
  assert(!source.includes('temporarily bypassed'), 'dashboard route must not expose internal bypass language');
  assert(source.includes('RocketSuite Command Center') || source.includes('Accounting summary'), 'dashboard should present polished accounting command-center copy');
  assert(layout.includes('AssistantProvider'), 'protected app shell should provide assistant context');
  assert(layout.includes('AIAssistantSidecar'), 'protected app shell should mount the AI assistant bubble');
  assert(source.includes('/transactions'), 'dashboard should link users to transactions');
  assert(source.includes('/billing') || source.includes('/settings'), 'dashboard should link users to a core operating/settings route');
  assert(source.includes('/reports'), 'dashboard should link users to reports');
  assert(source.includes('/integrations/plaid'), 'dashboard should link users to bank connection setup');

  console.log('dashboard-polish: dashboard has polished command-center copy, assistant shell, and core links');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
