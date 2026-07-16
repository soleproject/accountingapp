import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboardFiles = [
  'app/(app)/dashboard/page.tsx',
  'app/(app)/dashboard/_components/CommandCenter.tsx',
  'app/(app)/dashboard/_components/CustomPeriodPanel.tsx',
];

for (const file of dashboardFiles) {
  const source = readFileSync(file, 'utf8');
  const openingTags = source.match(/<Link\b[\s\S]*?>/g) ?? [];
  for (const tag of openingTags) {
    assert.match(
      tag,
      /prefetch=\{false\}/,
      `${file} has a dashboard Link without prefetch={false}: ${tag.replace(/\s+/g, ' ').slice(0, 160)}`,
    );
  }
}

console.log('dashboard-prefetch: dashboard action/card Links disable default Next prefetch');
