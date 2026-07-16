import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { updateSession, isPublicPath, type AuthSessionClient } from '../lib/supabase/proxy';

function requestFor(path: string) {
  return new NextRequest(new URL(path, 'https://rocketsuite.test'));
}

function authClient(user: unknown): AuthSessionClient {
  return {
    auth: {
      async getUser() {
        throw new Error('middleware must use locally verifiable getClaims, not remote getUser');
      },
      async getClaims() {
        return user ? { data: { claims: { sub: 'user_123' } }, error: null } : { data: null, error: null };
      },
    },
  } as unknown as AuthSessionClient;
}

async function main() {
  assert.equal(isPublicPath('/api/stripe/webhook'), true);
  assert.equal(isPublicPath('/api/stripe/webhook/extra'), false);
  assert.equal(isPublicPath('/api/twilio/inbound'), true);
  assert.equal(isPublicPath('/api/twilio/status'), true);
  assert.equal(isPublicPath('/api/inbox/ingest'), true);
  assert.equal(isPublicPath('/api/public/trial-signup'), true);
  assert.equal(isPublicPath('/dashboard'), false);

  let createClientCalls = 0;
  for (const path of ['/api/stripe/webhook', '/api/twilio/inbound', '/api/twilio/status', '/api/inbox/ingest']) {
    const publicResponse = await updateSession(requestFor(path), {
      createClient() {
        createClientCalls += 1;
        throw new Error(`${path} must not initialize Supabase auth`);
      },
    });
    assert.equal(publicResponse.headers.get('location'), null, `${path} should continue without redirect`);
  }
  assert.equal(createClientCalls, 0, 'public routes should bypass Supabase client creation');

  const protectedResponse = await updateSession(requestFor('/dashboard'), {
    createClient() {
      createClientCalls += 1;
      return authClient(null);
    },
  });
  assert.equal(createClientCalls, 1, 'protected route should initialize Supabase auth');
  assert.equal(protectedResponse.status, 307);
  assert.equal(protectedResponse.headers.get('location'), 'https://rocketsuite.test/login?next=%2Fdashboard');

  const authenticatedProtectedResponse = await updateSession(requestFor('/dashboard'), {
    createClient() {
      return authClient({ id: 'user_123' });
    },
  });
  assert.equal(
    authenticatedProtectedResponse.headers.get('location'),
    null,
    'verified claims should authorize protected middleware without remote getUser',
  );

  const loginResponse = await updateSession(requestFor('/login'), {
    createClient() {
      throw new Error('login is public and should not initialize Supabase auth');
    },
  });
  assert.equal(loginResponse.headers.get('location'), null, 'login should be public for unauthenticated users');

  const authenticatedLoginResponse = await updateSession(requestFor('/login'), {
    createClient() {
      return authClient({ id: 'user_123' });
    },
  });
  assert.equal(
    authenticatedLoginResponse.headers.get('location'),
    null,
    'public-route short-circuit means login does not perform authenticated redirect in middleware',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
