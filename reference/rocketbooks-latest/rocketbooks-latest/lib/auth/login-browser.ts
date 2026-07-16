export type LoginCredentials = { email: string; password: string };

type AuthErrorLike = { message?: string; status?: number; name?: string };
type SignInResult = { data?: { session?: unknown | null }; error: AuthErrorLike | null };
type SessionResult = { data?: { session?: unknown | null }; error?: AuthErrorLike | null };

export type LoginAuthClient = {
  auth: {
    signInWithPassword(credentials: LoginCredentials): Promise<SignInResult>;
    getSession(): Promise<SessionResult>;
  };
};

export type BrowserLoginResult =
  | { ok: true }
  | { ok: false; kind: 'credentials' | 'rate_limit' | 'timeout' | 'network' | 'provider' | 'persistence'; message: string };

function retryable(error: AuthErrorLike): boolean {
  const status = error.status ?? 0;
  const text = `${error.name ?? ''} ${error.message ?? ''}`;
  return status >= 500 || status === 0 || /abort|timeout|network|fetch/i.test(text);
}

function failure(error: AuthErrorLike): BrowserLoginResult {
  const status = error.status ?? 0;
  const text = `${error.name ?? ''} ${error.message ?? ''}`;
  if (status === 429) return { ok: false, kind: 'rate_limit', message: 'Too many sign-in attempts. Wait a moment and try again.' };
  if (/abort|timeout/i.test(text)) return { ok: false, kind: 'timeout', message: 'Authentication is taking too long. Please try again.' };
  if (status >= 500) return { ok: false, kind: 'provider', message: 'Authentication is temporarily unavailable. Please try again.' };
  if (status === 0 || /network|fetch/i.test(text)) return { ok: false, kind: 'network', message: 'Could not reach authentication. Check your connection and try again.' };
  return { ok: false, kind: 'credentials', message: error.message || 'Invalid email or password.' };
}

export async function signInForBrowser(
  client: LoginAuthClient,
  credentials: LoginCredentials,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<BrowserLoginResult> {
  let result = await client.auth.signInWithPassword(credentials);
  if (result.error && retryable(result.error) && result.error.status !== 429) {
    await wait(200);
    result = await client.auth.signInWithPassword(credentials);
  }
  if (result.error) return failure(result.error);

  const session = await client.auth.getSession();
  if (session.error || !session.data?.session) {
    return {
      ok: false,
      kind: 'persistence',
      message: 'Sign-in succeeded, but this browser did not save the session. Enable cookies and try again.',
    };
  }
  return { ok: true };
}
