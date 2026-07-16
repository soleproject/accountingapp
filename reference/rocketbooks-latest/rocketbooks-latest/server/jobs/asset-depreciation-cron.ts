import 'server-only';
import { eq } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { assetSettings } from '@/db/schema/schema';
import { runAssetDepreciationCore } from '@/lib/accounting/run-asset-depreciation';
import { logger } from '@/lib/logger';

/** Last day of the calendar month that just ended, as of `now` (UTC). */
function lastDayOfPriorMonth(now: Date): string {
	// First day of THIS month minus one day → last day of prior month.
	const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
	return lastDay.toISOString().slice(0, 10);
}

/**
 * Monthly auto-depreciation. Fires at 03:00 UTC on the 1st of every
 * month and walks every org with `asset_settings.cron_enabled = true`,
 * running depreciation against the calendar month that just ended.
 *
 * Scoped to assets with `auto_depreciate = true` — manual-only assets
 * stay untouched. Cron is idempotent at the (org, book, period_end)
 * level inside runAssetDepreciationCore, so a retry on the same period
 * short-circuits without double-posting.
 *
 * Errors per-org are isolated — one org failing doesn't block the
 * others. The cron logs and continues.
 */
export const assetDepreciationCron = inngest.createFunction(
	{
		id: 'asset-depreciation-monthly',
		retries: 2,
		triggers: [{ cron: '0 3 1 * *' }],
	},
	async ({ step }) => {
		const now = new Date();
		const periodEndDate = lastDayOfPriorMonth(now);

		const orgs = await step.run('load-enabled-orgs', async () =>
			db
				.select({ organizationId: assetSettings.organizationId })
				.from(assetSettings)
				.where(eq(assetSettings.cronEnabled, true)),
		);

		if (orgs.length === 0) {
			logger.info({ periodEndDate }, 'asset-depreciation-cron: no orgs enabled — skipping');
			return { periodEndDate, orgs: 0, posted: 0 };
		}

		let totalPosted = 0;
		let totalAssets = 0;
		let totalErrors = 0;

		for (const o of orgs) {
			try {
				const r = await step.run(`run-${o.organizationId}`, () =>
					runAssetDepreciationCore({
						organizationId: o.organizationId,
						periodEndDate,
						bookType: 'fiduciary',
						triggeredBy: 'cron',
						triggeredByUserId: null,
						scope: 'auto_only',
					}),
				);
				if (r.ok) {
					totalPosted += r.totalExpense ?? 0;
					totalAssets += r.assetsIncluded ?? 0;
				} else {
					totalErrors += 1;
					logger.error(
						{ orgId: o.organizationId, error: r.error },
						'asset-depreciation-cron: org run failed',
					);
				}
			} catch (err) {
				totalErrors += 1;
				logger.error(
					{ orgId: o.organizationId, err: err instanceof Error ? err.message : String(err) },
					'asset-depreciation-cron: unexpected error',
				);
			}
		}

		logger.info(
			{ periodEndDate, orgs: orgs.length, totalAssets, totalPosted, totalErrors },
			'asset-depreciation-cron: complete',
		);
		return {
			periodEndDate,
			orgs: orgs.length,
			assetsPosted: totalAssets,
			totalExpense: totalPosted,
			errors: totalErrors,
		};
	},
);
