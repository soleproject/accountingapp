# RocketSuite Worker-bound modularization inventory

Dispatch task: c141d2ea-a68c-497d-846f-590621629d62

## Heavy candidate areas

1. PDF generation
   - Heavy deps present in package.json: @react-pdf/renderer, pdf-lib, jspdf, pdfjs-dist.
   - Existing render path: lib/signatures/render-pdf.ts uses pdf-lib.
   - Applied slice: /api/pdf/generate is now a thin queueing shim; server/jobs/pdf-generator.ts imports PDF/storage code only inside an Inngest step.

2. QBO sync/promote
   - Existing heavy worker: server/jobs/qbo-migration.ts imports QBO client and promoter modules.
   - Applied slice: /api/qbo/sync and /api/qbo/promote queue events and return 202. The existing checkpointed Inngest worker performs the heavy sync/promote outside the user-facing route.

3. Existing Inngest endpoint
   - app/api/inngest/route.ts already exists and is public-routed by the app, so this slice needs no new Cloudflare Worker deployment and no wrangler.toml changes.

4. Other future candidates
   - Imports, reports, tax PDF processing, AI/tool modules, email/recorder jobs.

## Scope guard

No production deploy was performed. Changes are repo-local and require independent review before client release.
