import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { signInForBrowser, type LoginAuthClient } from '../lib/auth/login-browser';

const credentials = { email: 'test@example.com', password: 'secret' };
function client(results: Array<{ error: { message?: string; status?: number; name?: string } | null }>, session: unknown = { user: {} }) {
  let calls = 0;
  const value: LoginAuthClient = {
    auth: {
      async signInWithPassword() { return results[calls++] ?? results.at(-1)!; },
      async getSession() { return { data: { session }, error: null }; },
    },
  };
  return { value, calls: () => calls };
}

async function main() {
const loginForm = readFileSync('app/(auth)/login/_components/LoginForm.tsx', 'utf8');
assert.match(loginForm, /<form[^>]*method="post"/, 'login credentials must never fall back to a query-string GET before hydration');
{
  const c = client([{ error: { name: 'AbortError', message: 'aborted', status: 0 } }, { error: null }]);
  assert.deepEqual(await signInForBrowser(c.value, credentials, async () => {}), { ok: true });
  assert.equal(c.calls(), 2, 'retry one transient abort');
}
{
  const c = client([{ error: { message: 'Invalid login credentials', status: 400 } }]);
  const r = await signInForBrowser(c.value, credentials, async () => {});
  assert.equal(r.ok, false); assert.equal(!r.ok && r.kind, 'credentials'); assert.equal(c.calls(), 1);
}
{
  const c = client([{ error: { message: 'rate limited', status: 429 } }]);
  const r = await signInForBrowser(c.value, credentials, async () => {});
  assert.equal(r.ok, false); assert.equal(!r.ok && r.kind, 'rate_limit'); assert.equal(c.calls(), 1);
}
{
  const c = client([{ error: { message: 'upstream', status: 503 } }, { error: null }]);
  assert.deepEqual(await signInForBrowser(c.value, credentials, async () => {}), { ok: true });
  assert.equal(c.calls(), 2, 'retry one provider 5xx');
}
{
  const c = client([{ error: null }], null);
  const r = await signInForBrowser(c.value, credentials);
  assert.equal(r.ok, false); assert.equal(!r.ok && r.kind, 'persistence');
}
console.log('browser-login-resilience: transient retry, no credential/429 retry, and session persistence verification pass');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
