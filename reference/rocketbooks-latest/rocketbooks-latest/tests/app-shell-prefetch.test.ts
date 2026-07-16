import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shellFiles = [
  'components/layout/Sidebar.tsx',
  'components/layout/TopBar.tsx',
  'components/layout/BackToTasksBanner.tsx',
  'components/layout/EnterpriseSidebar.tsx',
  'components/layout/SuperAdminSidebar.tsx',
  'components/layout/TaxesSidebar.tsx',
  'components/layout/OrganizerSidebar.tsx',
  'components/layout/PersonalSidebar.tsx',
  'components/layout/OrgSwitcher.tsx',
];

for (const file of shellFiles) {
  const source = readFileSync(file, 'utf8');
  const openingTags = source.match(/<Link\b[\s\S]*?>/g) ?? [];
  for (const tag of openingTags) {
    assert.match(
      tag,
      /prefetch=\{false\}/,
      `${file} has an app-shell Link without prefetch={false}: ${tag.replace(/\s+/g, ' ').slice(0, 160)}`,
    );
  }
}

console.log('app-shell-prefetch: all shared shell Links disable default Next prefetch');
