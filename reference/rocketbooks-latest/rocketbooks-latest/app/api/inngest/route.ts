import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest';
import { plaidSync } from '@/server/jobs/plaid-sync';
import { plaidPromoteOnSync } from '@/server/jobs/plaid-promote-on-sync';
import { plaidPromotePersonalOnSync } from '@/server/jobs/plaid-promote-personal-on-sync';
import { autoCategorize } from '@/server/jobs/auto-categorize';
import { stuckPendingFallback } from '@/server/jobs/stuck-pending-fallback';
import { qboMigration } from '@/server/jobs/qbo-migration';
import { qboInboundProcess } from '@/server/jobs/qbo-inbound-process';
import { qboOutboundDrain } from '@/server/jobs/qbo-outbound-drain';
import { qboOutboundSweep } from '@/server/jobs/qbo-outbound-sweep';
import { assetDepreciationCron } from '@/server/jobs/asset-depreciation-cron';
import { trustDobCorrection } from '@/server/jobs/trust-dob-correction';
import { trustResolutionRender } from '@/server/jobs/trust-resolution-render';
import { emailDraftReply } from '@/server/jobs/email-draft-reply';
import { qboSyncFunction, qboPromoteFunction } from '@/server/jobs/qbo-sync';
import { pdfGeneratorFunction } from '@/server/jobs/pdf-generator';
import { reconcile } from '@/server/jobs/reconcile';
import { reconcileMonthly } from '@/server/jobs/reconcile-monthly';
import { ghlSync } from '@/server/jobs/ghl-sync';
import { ghlPromoteOnSync } from '@/server/jobs/ghl-promote-on-sync';
import { auditSweep } from '@/server/jobs/audit-sweep';
import { weeklyDigest } from '@/server/jobs/weekly-digest';

// Each Inngest step runs as one invocation of this route, so its wall-clock is
// bounded by maxDuration. The QBO migration pulls large entities per step;
// without a raised cap those steps hit Vercel's low default and time out. 300s
// is the Vercel Pro ceiling.
export const maxDuration = 300;

// The Inngest SDK reads INNGEST_SIGNING_KEY from env automatically. Make sure
// that env var is set in every deployed environment so the serve handler
// rejects unsigned requests; without it, anyone hitting /api/inngest could
// trigger any registered function.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [plaidSync, plaidPromoteOnSync, plaidPromotePersonalOnSync, autoCategorize, stuckPendingFallback, qboMigration, qboInboundProcess, qboOutboundDrain, qboOutboundSweep, qboSyncFunction, qboPromoteFunction, pdfGeneratorFunction, assetDepreciationCron, trustDobCorrection, trustResolutionRender, emailDraftReply, reconcile, reconcileMonthly, ghlSync, ghlPromoteOnSync, auditSweep, weeklyDigest],
});
