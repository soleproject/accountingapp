const BUILD_COMMIT =
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.NEXT_PUBLIC_GIT_COMMIT ||
  process.env.GIT_COMMIT_SHA ||
  null;

const BUILD_ID =
  process.env.ROCKETSUITE_BUILD_ID || process.env.NEXT_PUBLIC_BUILD_ID || process.env.CF_VERSION_METADATA_ID || null;

function nonEmpty(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getBuildInfo() {
  return {
    commit: nonEmpty(BUILD_COMMIT),
    buildId: nonEmpty(BUILD_ID),
  };
}
