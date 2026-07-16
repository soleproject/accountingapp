# c141d2ea implementation plan and gate notes

## Applied first slice

- QBO sync/promote route shims:
  - app/api/qbo/sync/route.ts
  - app/api/qbo/promote/route.ts
  - server/jobs/qbo-sync.ts
- PDF async generation route/job:
  - app/api/pdf/generate/route.ts
  - app/api/pdf/status/[jobId]/route.ts
  - server/jobs/pdf-generator.ts
- Inngest registration/event typing:
  - lib/inngest.ts
  - app/api/inngest/route.ts
- DB support:
  - db/migrations/0069_async_pdf_and_qbo_modularization.sql
- Bundle guard:
  - tests/bundle-safety.test.ts

## QA caveats applied

- App Router handlers export POST/GET, not POST_qbo_sync-style names.
- PDF render and upload happen in the same step.run() so no Buffer crosses an Inngest step boundary.
- QBO shims return JSON-serializable queue results only.
- app/api/inngest/route.ts imports and registers the new function exports.

## Protected gate

Do not publish/deploy. Submit to QA/review with checksums, diff, typecheck/build output, and dry-run result.
