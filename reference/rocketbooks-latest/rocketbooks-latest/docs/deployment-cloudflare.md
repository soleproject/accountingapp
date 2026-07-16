# Cloudflare Staging Deployment

RocketSuite is a full-stack Next.js app, so Cloudflare deployment uses Workers with the OpenNext adapter rather than a static Pages export.

## Build Commands

Use the `cloudflare-staging` branch.

```bash
npm ci
npm run cf:build
```

For local Worker preview:

```bash
npm run cf:preview
```

For deployment from an authenticated Wrangler environment:

```bash
npm run cf:deploy
```

## Cloudflare Settings

- Worker name: `rocketsuite-staging`
- Config file: `wrangler.jsonc`
- Worker entry: `.open-next/worker.js`
- Static assets: `.open-next/assets`
- Compatibility flag: `nodejs_compat`

## Required Environment Variables

Set these in Cloudflare as environment variables or secrets. Do not commit real values.

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
POSTGRES_URL
POSTGRES_URL_NON_POOLING
NEXT_PUBLIC_APP_URL
```

The `.env.example` file lists additional feature-specific integrations such as OpenAI, Plaid, Inngest, Resend, Sentry, QBO, Twilio, Daily, Stripe, and cron secrets. Those should be added as features are tested.

## Cron Jobs

The repo still includes the original `vercel.json` cron list. On Cloudflare, schedule these via Cloudflare scheduled triggers or an external scheduler that calls the matching HTTP routes with the app's cron authentication scheme:

- `/api/cron/scheduled-exports` every hour
- `/api/cron/plaid-sync-all` every 15 minutes
- `/api/cron/meeting-followups` at minutes 5, 20, 35, and 50
- `/api/cron/alerts-daily` daily at 08:00
- `/api/cron/alerts-weekly` Mondays at 09:00
- `/api/cron/alerts-monthly` on day 1 at 09:00
- `/api/cron/recompute-snapshots` daily at 06:00

## Current Verification

Verified on Hal, 2026-06-01:

- `npm ci` passes after lockfile repair.
- `npm run typecheck` passes.
- `npm run build` passes with the staging env.
- `npm run cf:build` generates `.open-next/worker.js`.
- `npx wrangler deploy --dry-run` passes and reads the generated assets.

Known warnings:

- Next warns that `middleware.ts` is deprecated in favor of `proxy.ts`, but the Cloudflare adapter currently rejects Node.js middleware generated from `proxy.ts`. The Cloudflare branch keeps the auth gate in `middleware.ts` so OpenNext can bundle it as Edge middleware.
- Turbopack warns about `pdfjs-dist` worker externalization. Build still passes, but PDF/tax-document flows need runtime QA after deployment.
