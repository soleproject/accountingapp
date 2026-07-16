import assert from 'node:assert/strict';
import { getRequestScopedPromise, resetRequestScopedPromisesForTests } from '../lib/auth/request-dedupe';

async function main() {
  resetRequestScopedPromisesForTests();

  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { id: calls };
  };

  const [first, second, third] = await Promise.all([
    getRequestScopedPromise('request-a', 'session', loader),
    getRequestScopedPromise('request-a', 'session', loader),
    getRequestScopedPromise('request-a', 'session', loader),
  ]);
  assert.equal(calls, 1, 'concurrent calls in one request must share one loader promise');
  assert.equal(first, second);
  assert.equal(second, third);

  const again = await getRequestScopedPromise('request-a', 'session', loader);
  assert.equal(calls, 1, 'sequential calls inside the TTL must reuse the resolved promise');
  assert.equal(again, first);

  await getRequestScopedPromise('request-b', 'session', loader);
  assert.equal(calls, 2, 'different request IDs must never share auth results');

  let failures = 0;
  await assert.rejects(() =>
    getRequestScopedPromise('request-c', 'session', async () => {
      failures += 1;
      throw new Error('transient');
    }),
  );
  await assert.rejects(() =>
    getRequestScopedPromise('request-c', 'session', async () => {
      failures += 1;
      throw new Error('transient');
    }),
  );
  assert.equal(failures, 2, 'rejected promises must be evicted so retries can recover');

  console.log('request-dedupe: concurrent and sequential auth calls share one bounded per-request promise');
}

void main();
