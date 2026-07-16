# RocketSuite

Next.js rewrite of the AI accounting platform (formerly `soleproject/ai_platform`).

## Stack

- **Next.js 16** (App Router) · **React 19** · **TypeScript** strict
- **Drizzle ORM** + `postgres-js` against **Supabase Postgres**
- **Supabase Auth** (`@supabase/ssr`)
- **Inngest** for long-running jobs (Plaid sync, QBO migration)
- **Vercel Cron** for scheduled tasks
- **Sentry** + **Vercel Analytics** + **Pino** structured logging
- **Vitest** + **Playwright** for tests
- **Tailwind CSS v4**

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev
```

## Scripts

- `npm run dev` — start dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint
- `npm run db:pull` — re-introspect Supabase schema
- `npm run db:generate` — generate migration from schema diff
- `npm run db:push` — push schema directly (dev only)
- `npm run db:studio` — open Drizzle Studio
- `npm run import-users` — one-shot argon2 import from `public.users` → `auth.users`

## Status

This is M1 (foundation) of a multi-milestone migration plan. See the project plan for the full roadmap.
