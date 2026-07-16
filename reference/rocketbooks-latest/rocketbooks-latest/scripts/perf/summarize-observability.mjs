#!/usr/bin/env node
import { createInterface } from 'node:readline';

const values = new Map();
let parsed = 0;
let rejected = 0;

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.marker === 'RS_PERF_EVENT') {
    if (typeof value.routeClass !== 'string' || typeof value.phase !== 'string' || typeof value.durationMs !== 'number') {
      rejected += 1;
      return;
    }
    parsed += 1;
    const key = `${value.routeClass}|${value.phase}|${value.outcome ?? 'unknown'}`;
    const bucket = values.get(key) ?? [];
    bucket.push(value.durationMs);
    values.set(key, bucket);
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') visit(nested);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try { visit(JSON.parse(line)); } catch { rejected += 1; }
}

const groups = [...values.entries()].map(([key, durations]) => {
  durations.sort((a, b) => a - b);
  const [routeClass, phase, outcome] = key.split('|');
  return {
    routeClass,
    phase,
    outcome,
    count: durations.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: durations.at(-1),
    alert: outcome !== 'ok' || (phase === 'browser_visible_completion' && percentile(durations, 0.95) > 5000),
  };
});

process.stdout.write(`${JSON.stringify({ marker: 'RS_PERF_SUMMARY', schemaVersion: 1, parsed, rejected, groups }, null, 2)}\n`);
