import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const form = readFileSync('app/(auth)/login/_components/LoginForm.tsx', 'utf8');
const legal = readFileSync('components/legal/LegalFooter.tsx', 'utf8');

assert.match(form, /createClient.*@\/lib\/supabase\/browser|from '@\/lib\/supabase\/browser'/, 'login should authenticate directly through the browser Supabase client instead of a heavy Worker server action');
assert.doesNotMatch(form, /useActionState|from '\.\.\/_actions\/login'/, 'login must not depend on the server-action round trip');
assert.match(form, /signInForBrowser/, 'login must use the bounded resilient browser-auth helper');
const browserClient = readFileSync('lib/supabase/browser.ts', 'utf8');
const timeoutPolicy = readFileSync('lib/supabase/auth-timeout.ts', 'utf8');
assert.match(timeoutPolicy, /SUPABASE_AUTH_TIMEOUT_MS\s*=\s*10_000/, 'browser, middleware, and page auth must share a 10-second hard timeout');
assert.match(browserClient, /AbortController/, 'browser auth timeout must abort the underlying fetch');
const proxyAuth = readFileSync('lib/supabase/proxy.ts', 'utf8');
const pageAuth = readFileSync('lib/auth/session.ts', 'utf8');
assert.match(proxyAuth, /SUPABASE_AUTH_TIMEOUT_MS/, 'middleware must use the shared auth timeout');
assert.doesNotMatch(proxyAuth, /Promise\.race/, 'middleware must not leave an orphaned auth request after a timer race');
assert.doesNotMatch(pageAuth, /Promise\.race|AUTH_TIMEOUT_MS\s*=\s*3000/, 'page auth must not reject a session earlier than middleware');
assert.match(form, /rawNext\?\.startsWith\('\/'\)[\s\S]*!rawNext\.startsWith\('\/\/'\)/, 'client redirect must keep the same-origin next-path guard');
assert.match(form, /rs_trial_banner_dismissed/, 'fresh login must reset trial-banner dismissal');
assert.match(form, /rs_demo_banner_dismissed/, 'fresh login must reset demo-banner dismissal');

for (const href of ['/legal/terms', '/legal/privacy', '/legal/sms-disclosure']) {
  const escaped = href.replaceAll('/', '\\/');
  assert.match(legal, new RegExp(`<Link href="${escaped}" prefetch=\\{false\\}`), `${href} must not create a background RSC Worker request on the login page`);
}

console.log('login-path-latency: browser auth removes the Worker server-action hop and legal links do not prefetch');
