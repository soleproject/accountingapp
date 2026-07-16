import { performance } from 'node:perf_hooks';

type RouteResult = {
  route: string;
  run: number;
  status: number | null;
  ms: number;
  bytes: number;
  ok: boolean;
  markerFound: boolean;
  error?: string;
};

const baseUrl = process.env.PERF_BASE_URL ?? 'http://127.0.0.1:3000';
const cookie = process.env.PERF_COOKIE ?? '';
const runs = Number.parseInt(process.env.PERF_RUNS ?? '7', 10);
const routeSpec = process.env.PERF_ROUTES ?? '/transactions:Transactions,/enterprise/clients:Clients,/enterprise/dashboard:Enterprise Dashboard,/super-admin/ai-usage:Usage';

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function parseRoutes(): Array<{ route: string; marker: string }> {
  return routeSpec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [route, marker] = part.split(':');
      return { route, marker: marker ?? '' };
    });
}

async function measure(route: string, marker: string, run: number): Promise<RouteResult> {
  const url = new URL(route, baseUrl).toString();
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: {
        ...(cookie ? { cookie } : {}),
        'user-agent': 'RocketSuitePerfProbe/1.0',
      },
      redirect: 'manual',
    });
    const body = await response.text();
    const ms = Math.round((performance.now() - started) * 100) / 100;
    const markerFound = marker ? body.includes(marker) : true;
    const badMarker = /Error 1101|Worker threw exception|Application error|Internal Server Error/i.test(body);
    return {
      route,
      run,
      status: response.status,
      ms,
      bytes: Buffer.byteLength(body),
      ok: response.status >= 200 && response.status < 400 && markerFound && !badMarker,
      markerFound,
    };
  } catch (error) {
    const ms = Math.round((performance.now() - started) * 100) / 100;
    return {
      route,
      run,
      status: null,
      ms,
      bytes: 0,
      ok: false,
      markerFound: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const routes = parseRoutes();
  const results: RouteResult[] = [];
  for (const { route, marker } of routes) {
    for (let run = 1; run <= runs; run += 1) {
      const result = await measure(route, marker, run);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }

  console.log('\n## Summary');
  for (const { route } of routes) {
    const group = results.filter((r) => r.route === route);
    const times = group.map((r) => r.ms);
    const okCount = group.filter((r) => r.ok).length;
    console.log(
      JSON.stringify({
        route,
        runs: group.length,
        ok: okCount,
        p50Ms: percentile(times, 50),
        p95Ms: percentile(times, 95),
        maxMs: Math.max(...times),
        minMs: Math.min(...times),
      }),
    );
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
