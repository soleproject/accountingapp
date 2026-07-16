import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { chartOfAccounts, pfcOrgOverrides } from '@/db/schema/schema';
import { aiMapPfcToCoa } from './ai-map-pfc-to-coa';
import { logger } from '@/lib/logger';
import type { PromoteResult } from './promoter';

interface FinalizeCtx {
  organizationId: string;
  realmId: string;
  migrationJobId: string;
}

/**
 * Post-QB-sync CoA finalize. The user-facing rule: once QuickBooks is
 * connected, the rocketsuite CoA mirrors QB exactly. Every seed row is
 * hidden, every PFC is wired to a QB-imported account via AI.
 *
 * Sequence:
 *   1. Run AI mapping (each PFC → a specific QB row; the AI is prompted
 *      to fall back to the QB Uncategorized rows rather than ever
 *      returning null). If the AI call itself fails, the phase aborts
 *      WITHOUT hiding any seeds — safer to leave the org as-is than to
 *      end up with no seeds AND no overrides.
 *   2. Hide every system_generated row (isActive=false). Historical
 *      transactions referencing those rows are unaffected — the FK is
 *      ON DELETE NO ACTION and category names still join in for display;
 *      we only stop surfacing seeds in pickers and the CoA listing.
 *   3. Upsert one pfc_org_overrides row per PFC the AI mapped (source
 *      always 'ai' now — no seed_fallback path). Any PFC the AI somehow
 *      did return null for is intentionally left without an override;
 *      resolve-pfc-coa.ts will fall through to its uncategorized path.
 *
 * Idempotent: re-running upserts overrides by (org, pfc) and re-hides
 * any seeds that crept back active.
 *
 * Returns PromoteResult shape: `created` is overrides written this run,
 * `skipped` is the count of PFCs AI couldn't map (defensive — should
 * always be 0 with the current prompt), `errored` is non-zero only if
 * the AI call failed or write transactions errored.
 */
export async function finalizeCoaAfterQb(ctx: FinalizeCtx): Promise<PromoteResult> {
  let aiMappings: Awaited<ReturnType<typeof aiMapPfcToCoa>>;
  try {
    aiMappings = await aiMapPfcToCoa({ organizationId: ctx.organizationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { organizationId: ctx.organizationId, err: msg },
      'qbo finalize: AI mapping failed — leaving CoA untouched',
    );
    return { created: 0, skipped: 0, errored: 1 };
  }
  if (aiMappings.length === 0) {
    logger.warn(
      { organizationId: ctx.organizationId },
      'qbo finalize: AI returned no mappings — leaving CoA untouched',
    );
    return { created: 0, skipped: 0, errored: 1 };
  }

  // Load every seed row id — we hide ALL of them unconditionally.
  const seeds = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.organizationId, ctx.organizationId),
      eq(chartOfAccounts.systemGenerated, true),
    ));
  const seedIds = seeds.map((s) => s.id);

  interface OverrideToWrite {
    pfcDetailed: string;
    categoryAccountId: string;
    source: 'ai';
    confidence: number;
    reasoning: string;
    aiModel: string;
  }

  const overrides: OverrideToWrite[] = [];
  let unmappedSkipped = 0;
  for (const m of aiMappings) {
    if (m.coaId === null) {
      // Defensive: prompt instructs AI to never return null. If it
      // happens anyway, log and skip — resolve-pfc-coa.ts will land
      // these PFCs in uncategorized.
      unmappedSkipped++;
      logger.warn(
        { organizationId: ctx.organizationId, pfc: m.pfcDetailed, reasoning: m.reasoning },
        'qbo finalize: AI returned null mapping; PFC will fall through to uncategorized',
      );
      continue;
    }
    overrides.push({
      pfcDetailed: m.pfcDetailed,
      categoryAccountId: m.coaId,
      source: 'ai',
      confidence: m.confidence,
      reasoning: m.reasoning,
      aiModel: m.aiModel,
    });
  }

  let errored = 0;

  try {
    await db.transaction(async (tx) => {
      if (seedIds.length > 0) {
        await tx
          .update(chartOfAccounts)
          .set({ isActive: false })
          .where(inArray(chartOfAccounts.id, seedIds));
      }

      const now = new Date().toISOString();
      const CHUNK = 100;
      for (let i = 0; i < overrides.length; i += CHUNK) {
        const slice = overrides.slice(i, i + CHUNK).map((o) => ({
          id: randomUUID(),
          organizationId: ctx.organizationId,
          pfcDetailed: o.pfcDetailed,
          categoryAccountId: o.categoryAccountId,
          source: o.source,
          confidence: o.confidence.toFixed(2),
          reasoning: o.reasoning,
          aiModel: o.aiModel,
          createdAt: now,
          updatedAt: now,
        }));
        await tx
          .insert(pfcOrgOverrides)
          .values(slice)
          .onConflictDoUpdate({
            target: [pfcOrgOverrides.organizationId, pfcOrgOverrides.pfcDetailed],
            set: {
              categoryAccountId: sql`excluded.category_account_id`,
              source: sql`excluded.source`,
              confidence: sql`excluded.confidence`,
              reasoning: sql`excluded.reasoning`,
              aiModel: sql`excluded.ai_model`,
              updatedAt: now,
            },
          });
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { organizationId: ctx.organizationId, err: msg },
      'qbo finalize: write transaction failed',
    );
    errored = 1;
  }

  const lowConfidence = aiMappings.filter((m) => m.coaId !== null && m.confidence < 0.6).length;
  logger.info(
    {
      organizationId: ctx.organizationId,
      aiMappings: aiMappings.length,
      overridesWritten: overrides.length,
      lowConfidence,
      unmappedSkipped,
      seedsHidden: seedIds.length,
      errored,
    },
    'qbo finalize coa done',
  );

  return {
    created: overrides.length,
    skipped: unmappedSkipped,
    errored,
  };
}
