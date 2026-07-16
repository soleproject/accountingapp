import path from 'node:path';
import { AgentManager } from './manager';
import { startServer } from './server';

const HOST = process.env.AGENT_HOST_HOST ?? '127.0.0.1';
const PORT = Number(process.env.AGENT_HOST_PORT ?? 4500);
const TOKEN = process.env.AGENT_HOST_TOKEN ?? 'local-dev';
const DATA_FILE =
  process.env.AGENT_HOST_DATA ?? path.join(process.cwd(), 'agent-host', '.data', 'registry.json');
const GIT_INTERVAL = Number(process.env.AGENT_HOST_GIT_INTERVAL ?? 5000);
const OBSERVED_INTERVAL = Number(process.env.AGENT_HOST_OBSERVED_INTERVAL ?? 12000);
const OBSERVED_LIMIT = Number(process.env.AGENT_HOST_OBSERVED_LIMIT ?? 30);
const ALLOWED_ORIGINS = new Set(
  (process.env.AGENT_HOST_ALLOWED_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

async function main(): Promise<void> {
  const manager = new AgentManager(DATA_FILE);
  const resumed = await manager.loadAndResume();
  manager.startPolling(GIT_INTERVAL, OBSERVED_INTERVAL, OBSERVED_LIMIT);
  startServer({ manager, host: HOST, port: PORT, token: TOKEN, allowedOrigins: ALLOWED_ORIGINS });

  if (TOKEN === 'local-dev') {
    console.warn('[agent-host] using default token; set AGENT_HOST_TOKEN to a random value for defense-in-depth');
  }
  console.log(
    `[agent-host] listening ws://${HOST}:${PORT} · token=${TOKEN === 'local-dev' ? 'default(local-dev)' : 'set'} · origins=[${[...ALLOWED_ORIGINS].join(', ')}] · resumed ${resumed} agent(s)`,
  );
}

main().catch((err) => {
  console.error('[agent-host] fatal:', err);
  process.exit(1);
});
