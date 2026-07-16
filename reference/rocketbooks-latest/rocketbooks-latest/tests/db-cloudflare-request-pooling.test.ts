import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getRequestScopedValue } from '../db/requestScope';

const firstRequest = {};
const secondRequest = {};
let created = 0;
const create = () => ({ id: ++created });

const firstAccess = getRequestScopedValue(firstRequest, create);
const repeatedAccess = getRequestScopedValue(firstRequest, create);
const secondRequestAccess = getRequestScopedValue(secondRequest, create);

assert.equal(firstAccess, repeatedAccess, 'one Cloudflare request must reuse one DB client');
assert.notEqual(firstAccess, secondRequestAccess, 'separate Cloudflare requests must not share I/O clients');
assert.equal(created, 2, 'factory must run once per request context');

const dbClient = readFileSync('db/client.ts', 'utf8');
assert.match(dbClient, /getRequestScopedValue\(/, 'Cloudflare DB path must use request-scoped memoization');
assert.doesNotMatch(
  dbClient,
  /if \(getHyperdriveUrl\(\) !== undefined\) \{\s*return createDb\(\);/,
  'Cloudflare DB path must not create a client for every Proxy property access',
);

console.log('db-cloudflare-request-pooling regression passed');
