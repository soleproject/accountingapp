import Link from 'next/link';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboConflicts, qboEntityMap } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { dismissConflict } from './_actions/dismissConflict';
import { applyLocalState } from './_actions/applyLocalState';
import { applyQboState } from './_actions/applyQboState';

// Capability matrix per entity. Both directions supported for all mirrored
// entities now that Items + Invoice outbound landed.
const USE_QBO_SUPPORTED = new Set(['account', 'customer', 'vendor', 'invoice', 'bill', 'payment', 'billPayment']);
const USE_OURS_SUPPORTED = new Set(['account', 'customer', 'vendor', 'invoice', 'bill', 'payment', 'billPayment']);

export const dynamic = 'force-dynamic';

interface ConflictRow {
  id: string;
  detectedAt: string;
  entityType: string;
  qboId: string;
  localId: string;
  qboSnapshot: Record<string, unknown>;
  localSnapshot: Record<string, unknown>;
}

async function loadOpenConflicts(orgId: string): Promise<ConflictRow[]> {
  const rows = await db
    .select({
      id: qboConflicts.id,
      detectedAt: qboConflicts.detectedAt,
      qboSnapshot: qboConflicts.qboSnapshot,
      localSnapshot: qboConflicts.localSnapshot,
      entityType: qboEntityMap.entityType,
      qboId: qboEntityMap.qboId,
      localId: qboEntityMap.localId,
    })
    .from(qboConflicts)
    .innerJoin(qboEntityMap, eq(qboConflicts.entityMapId, qboEntityMap.id))
    .where(and(eq(qboConflicts.organizationId, orgId), isNull(qboConflicts.resolvedAt)))
    .orderBy(desc(qboConflicts.detectedAt));
  return rows.map((r) => ({
    id: r.id,
    detectedAt: r.detectedAt,
    entityType: r.entityType,
    qboId: r.qboId,
    localId: r.localId,
    qboSnapshot: r.qboSnapshot as Record<string, unknown>,
    localSnapshot: r.localSnapshot as Record<string, unknown>,
  }));
}

export default async function QboConflictsPage() {
  const orgId = await getCurrentOrgId();
  const conflicts = await loadOpenConflicts(orgId);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">QuickBooks Sync Conflicts</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Records changed in BOTH RocketSuite and QuickBooks between syncs. Each conflict pauses outbound for that
            record until you resolve it.
          </p>
        </div>
        <Link href="/integrations/qbo" className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
          ← Back to integration
        </Link>
      </header>

      {conflicts.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No open conflicts. 🎉</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {conflicts.map((c) => (
            <ConflictCard key={c.id} conflict={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConflictCard({ conflict }: { conflict: ConflictRow }) {
  async function handleDismiss() {
    'use server';
    await dismissConflict(conflict.id);
  }
  async function handleUseQbo() {
    'use server';
    await applyQboState(conflict.id);
  }
  async function handleUseLocal() {
    'use server';
    await applyLocalState(conflict.id);
  }
  const canUseQbo = USE_QBO_SUPPORTED.has(conflict.entityType);
  const canUseOurs = USE_OURS_SUPPORTED.has(conflict.entityType);
  const sideActionsAvailable = canUseQbo || canUseOurs;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 dark:border-amber-900/40 dark:bg-amber-950/20">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
              {conflict.entityType}
            </span>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              detected {new Date(conflict.detectedAt).toLocaleString()}
            </span>
          </div>
          <div className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
            QBO id <code className="font-mono">{conflict.qboId}</code> · local id <code className="font-mono">{conflict.localId.slice(0, 8)}</code>
          </div>
        </div>
        <div className="flex gap-2">
          {canUseQbo && (
            <form action={handleUseQbo}>
              <button
                type="submit"
                className="rounded-md border border-emerald-300 bg-emerald-100 px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-200 dark:border-emerald-900/50 dark:bg-emerald-900/30 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
                title="Replace the local record with QBO's current state"
              >
                Use QBO
              </button>
            </form>
          )}
          {canUseOurs && (
            <form action={handleUseLocal}>
              <button
                type="submit"
                className="rounded-md border border-blue-300 bg-blue-100 px-3 py-1.5 text-xs font-medium text-blue-900 hover:bg-blue-200 dark:border-blue-900/50 dark:bg-blue-900/30 dark:text-blue-200 dark:hover:bg-blue-900/50"
                title="Push local state to QBO, overwriting the QBO record"
              >
                Use Ours
              </button>
            </form>
          )}
          <form action={handleDismiss}>
            <button
              type="submit"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              title="Mark resolved without applying either side"
            >
              Dismiss
            </button>
          </form>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <SnapshotPane label="QBO snapshot" data={conflict.qboSnapshot} tone="amber" />
        <SnapshotPane label="Local snapshot" data={conflict.localSnapshot} tone="zinc" />
      </div>
      <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
        {sideActionsAvailable ? (
          <>
            {canUseQbo && (<><strong>Use QBO</strong> overwrites the local record with QBO&rsquo;s current state. </>)}
            {canUseOurs && (<><strong>Use Ours</strong> pushes the local state to QBO (refreshing SyncToken first). </>)}
            <strong>Dismiss</strong> just marks resolved if you&rsquo;ve reconciled outside the app.
          </>
        ) : (
          <>Side-applying actions for {conflict.entityType} aren&rsquo;t available yet — use <strong>Dismiss</strong> after reconciling manually in QuickBooks or RocketSuite.</>
        )}
      </p>
    </div>
  );
}

function SnapshotPane({ label, data, tone }: { label: string; data: Record<string, unknown>; tone: 'amber' | 'zinc' }) {
  const bg = tone === 'amber' ? 'bg-amber-100/50 dark:bg-amber-900/20' : 'bg-zinc-100 dark:bg-zinc-900';
  return (
    <div className={`rounded-md border border-zinc-200 ${bg} p-3 dark:border-zinc-800`}>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{label}</div>
      <pre className="max-h-64 overflow-auto text-xs text-zinc-800 dark:text-zinc-200">{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
