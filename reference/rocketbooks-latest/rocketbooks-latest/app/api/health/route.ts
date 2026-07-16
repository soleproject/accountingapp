import { getCloudflareContext } from '@opennextjs/cloudflare';

import { getBuildInfo } from '@/lib/build-info';

export const dynamic = 'force-dynamic';

type HyperdriveBinding = { connectionString?: string };

function getRuntimeName() {
  try {
    const { env } = getCloudflareContext();
    return (env as Record<string, unknown>).HYPERDRIVE ? 'cloudflare-hyperdrive' : 'cloudflare';
  } catch {
    return 'node';
  }
}

export async function GET() {
  return Response.json(
    {
      ok: true,
      service: 'rocketsuite',
      runtime: getRuntimeName(),
      timestamp: new Date().toISOString(),
      ...getBuildInfo(),
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
