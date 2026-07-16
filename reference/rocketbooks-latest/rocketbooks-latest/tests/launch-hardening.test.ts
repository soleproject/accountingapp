import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function testDeployScriptUsesMinifyAndInjectsCommit() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const deploy = String(pkg.scripts?.['cf:deploy'] ?? '');
  assert.match(deploy, /--minify\b/, 'cf:deploy must use --minify to stay under Cloudflare Worker size limit');
  assert.match(
    deploy,
    /NEXT_PUBLIC_GIT_COMMIT=\$\(git rev-parse HEAD\)/,
    'cf:deploy must inject the current git commit for live health proof',
  );
}

async function testNextConfigEmbedsBuildProofEnv() {
  const source = await readFile(new URL('../next.config.ts', import.meta.url), 'utf8');
  assert.match(source, /NEXT_PUBLIC_GIT_COMMIT/, 'next.config.ts must expose commit env to the bundled runtime');
  assert.match(source, /ROCKETSUITE_BUILD_ID/, 'next.config.ts must expose build id env to the bundled runtime');
}

async function testHealthBuildInfoSupportsCommitAndBuildId() {
  const previous = {
    NEXT_PUBLIC_GIT_COMMIT: process.env.NEXT_PUBLIC_GIT_COMMIT,
    CF_PAGES_COMMIT_SHA: process.env.CF_PAGES_COMMIT_SHA,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    ROCKETSUITE_BUILD_ID: process.env.ROCKETSUITE_BUILD_ID,
  };

  try {
    delete process.env.CF_PAGES_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.NEXT_PUBLIC_GIT_COMMIT = '7606f8e864ec246b0332a1d3be5f1dd7b5453912';
    process.env.ROCKETSUITE_BUILD_ID = 'deploy-20260624T153825Z';
    const { getBuildInfo } = await import('../lib/build-info');

    assert.deepEqual(getBuildInfo(), {
      commit: '7606f8e864ec246b0332a1d3be5f1dd7b5453912',
      buildId: 'deploy-20260624T153825Z',
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  await testDeployScriptUsesMinifyAndInjectsCommit();
  await testNextConfigEmbedsBuildProofEnv();
  await testHealthBuildInfoSupportsCommitAndBuildId();
  console.log('launch-hardening: deploy script and health build info conventions verified');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
