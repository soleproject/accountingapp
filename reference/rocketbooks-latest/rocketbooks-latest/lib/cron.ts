import 'server-only';
import { NextRequest } from 'next/server';

/**
 * Cron auth: require `Authorization: Bearer $CRON_SECRET`. Vercel sends this
 * header automatically for routes listed in vercel.json. We deliberately do
 * NOT trust `x-vercel-cron` — that header is user-controllable and was the
 * source of an auth-bypass.
 *
 * Local dev: when neither CRON_SECRET nor VERCEL_ENV is set, we allow the
 * request so `npm run dev` curls work. Any deployed environment (preview,
 * production, anything with VERCEL_ENV set) requires the secret.
 */
export function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  const isLocalDev = !process.env.VERCEL_ENV && process.env.NODE_ENV !== 'production';

  if (!secret) return isLocalDev;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}
