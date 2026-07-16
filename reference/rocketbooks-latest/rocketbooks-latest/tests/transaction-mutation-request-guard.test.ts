import assert from 'node:assert/strict';
import { validateJsonSameOrigin } from '../app/api/transactions/_lib/request-guard';

function request(headers: Record<string, string>) {
  return new Request('https://app.rocketsuite.ai/api/transactions/verify-guide', {
    method: 'POST',
    headers,
    body: '{}',
  });
}

assert.deepEqual(
  validateJsonSameOrigin(request({ origin: 'https://app.rocketsuite.ai', host: 'app.rocketsuite.ai', 'content-type': 'text/plain' })),
  { status: 415, error: 'Content-Type must be application/json.' },
);
assert.deepEqual(
  validateJsonSameOrigin(request({ origin: 'https://evil.example', host: 'app.rocketsuite.ai', 'content-type': 'application/json' })),
  { status: 403, error: 'Cross-origin request rejected.' },
);
assert.deepEqual(
  validateJsonSameOrigin(request({ host: 'app.rocketsuite.ai', 'content-type': 'application/json' })),
  { status: 403, error: 'Cross-origin request rejected.' },
);
assert.equal(
  validateJsonSameOrigin(request({ origin: 'https://staging.example', 'x-forwarded-host': 'staging.example', host: 'internal.example', 'content-type': 'application/json; charset=utf-8' })),
  null,
);

console.log('transaction-mutation-request-guard: JSON and same-origin enforcement pass');
