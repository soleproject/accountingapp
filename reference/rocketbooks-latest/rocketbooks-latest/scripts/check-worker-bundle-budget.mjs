import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const handler = '.open-next/server-functions/default/handler.mjs';
const MAX_RAW_BYTES = 38_000_000;
const MAX_GZIP_BYTES = 9_150_000;

if (!existsSync(handler)) {
  console.error(`Worker bundle budget: ${handler} is missing; run npm run cf:build first.`);
  process.exit(2);
}

const raw = readFileSync(handler);
const gzipBytes = gzipSync(raw, { level: 9 }).byteLength;
const rawBytes = raw.byteLength;
const report = {
  rawBytes,
  gzipBytes,
  maxRawBytes: MAX_RAW_BYTES,
  maxGzipBytes: MAX_GZIP_BYTES,
  rawHeadroom: MAX_RAW_BYTES - rawBytes,
  gzipHeadroom: MAX_GZIP_BYTES - gzipBytes,
};
console.log(JSON.stringify(report));

if (rawBytes > MAX_RAW_BYTES || gzipBytes > MAX_GZIP_BYTES) {
  console.error('Worker bundle budget exceeded. Split/remove server dependencies before deploy.');
  process.exit(1);
}
