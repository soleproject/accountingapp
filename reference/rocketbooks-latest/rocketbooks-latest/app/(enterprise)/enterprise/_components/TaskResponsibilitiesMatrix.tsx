import {
  TASK_CATALOG,
  TASK_CADENCES,
  AI_PLANNED_KEYS,
  type CatalogTask,
  type TaskOwner,
} from '@/lib/enterprise/task-catalog';

/**
 * The Pro/Client responsibility grid (cadence groups + AI column + radios named
 * resp_<key>). Server-rendered; lives inside a parent <form>. `ownerFor` returns
 * the pre-checked owner per task — the caller decides the resolution (enterprise
 * default on Settings, or client-override→enterprise-default→smart on a client).
 */
export function TaskResponsibilitiesMatrix({ ownerFor }: { ownerFor: (task: CatalogTask) => TaskOwner }) {
  return (
    <div className="flex flex-col gap-5">
      {TASK_CADENCES.map((cad) => {
        const tasks = TASK_CATALOG.filter((t) => t.cadence === cad.key);
        return (
          <div key={cad.key} className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center justify-between bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{cad.label}</span>
              <span className="flex shrink-0 items-center gap-4 pr-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                <span className="w-60">What the AI does</span>
                <span className="w-24 text-center">Accounting Pro</span>
                <span className="w-16 text-center">Client</span>
              </span>
            </div>
            <ul>
              {tasks.map((t) => {
                const owner = ownerFor(t);
                // "Categorize & review" fans into three sub-reviews. The Pro/Client
                // radial IS the "Review AI Categorized" choice (still stored as
                // resp_categorize_transactions — no save change). Review Deposits +
                // Review Uncategorized are ALWAYS the client's (only they know what
                // those are), so they're shown locked, not a real choice.
                if (t.key === 'categorize_transactions') {
                  return (
                    <li key={t.key} className="border-t border-zinc-100 dark:border-zinc-800">
                      <div className="flex items-center justify-between gap-4 px-3 pb-1 pt-2.5 text-sm">
                        <div className="min-w-0">
                          <div className="font-medium">{t.label}</div>
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">{t.description}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-4 pr-1">
                          <span className="w-60 text-xs leading-snug">
                            <span className="mr-1 font-semibold text-violet-600 dark:text-violet-400" aria-hidden="true">✦</span>
                            <span className="text-zinc-500 dark:text-zinc-400">{t.ai}</span>
                          </span>
                          <span className="w-24" />
                          <span className="w-16" />
                        </div>
                      </div>
                      {/* Review AI Categorized — the one real choice (the radial). */}
                      <div className="flex items-center justify-between gap-4 px-3 py-1.5 pl-7 text-sm">
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">↳ Review AI Categorized</div>
                          <div className="text-xs text-zinc-400 dark:text-zinc-500">Verify the AI&apos;s confident categorizations are correct.</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-4 pr-1">
                          <span className="w-60" />
                          <span className="flex w-24 items-center justify-center">
                            <input type="radio" name="resp_categorize_transactions" value="pro" defaultChecked={owner === 'pro'} aria-label="Review AI Categorized: Accounting Pro" className="h-4 w-4 accent-blue-600" />
                          </span>
                          <span className="flex w-16 items-center justify-center">
                            <input type="radio" name="resp_categorize_transactions" value="client" defaultChecked={owner === 'client'} aria-label="Review AI Categorized: Client" className="h-4 w-4 accent-blue-600" />
                          </span>
                        </div>
                      </div>
                      {/* Review Deposits — always client. */}
                      <div className="flex items-center justify-between gap-4 px-3 py-1.5 pl-7 text-sm">
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">↳ Review Deposits</div>
                          <div className="text-xs text-zinc-400 dark:text-zinc-500">Only the client can confirm what a deposit is — the AI walks them through it.</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-4 pr-1">
                          <span className="w-60" />
                          <span className="flex w-24 items-center justify-center text-zinc-300 dark:text-zinc-600">—</span>
                          <span className="flex w-16 items-center justify-center" title="Always the client — they hold the information">
                            <input type="radio" defaultChecked disabled aria-label="Review Deposits: Client (always)" className="h-4 w-4 accent-blue-600 opacity-60" />
                          </span>
                        </div>
                      </div>
                      {/* Review Uncategorized — always client. */}
                      <div className="flex items-center justify-between gap-4 px-3 pb-2.5 pl-7 pt-1.5 text-sm">
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">↳ Review Uncategorized</div>
                          <div className="text-xs text-zinc-400 dark:text-zinc-500">Needs the client&apos;s context — the AI drafts the &quot;what was this?&quot; question.</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-4 pr-1">
                          <span className="w-60" />
                          <span className="flex w-24 items-center justify-center text-zinc-300 dark:text-zinc-600">—</span>
                          <span className="flex w-16 items-center justify-center" title="Always the client — they hold the information">
                            <input type="radio" defaultChecked disabled aria-label="Review Uncategorized: Client (always)" className="h-4 w-4 accent-blue-600 opacity-60" />
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                }
                return (
                  <li
                    key={t.key}
                    className="flex items-center justify-between gap-4 border-t border-zinc-100 px-3 py-2.5 text-sm dark:border-zinc-800"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{t.label}</div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">{t.description}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-4 pr-1">
                      <span className="w-60 text-xs leading-snug">
                        {AI_PLANNED_KEYS.has(t.key) ? (
                          <>
                            <span className="mr-1 rounded bg-zinc-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                              Planned
                            </span>
                            <span className="text-zinc-400 dark:text-zinc-500">{t.ai}</span>
                          </>
                        ) : (
                          <>
                            <span className="mr-1 font-semibold text-violet-600 dark:text-violet-400" aria-hidden="true">
                              ✦
                            </span>
                            <span className="text-zinc-500 dark:text-zinc-400">{t.ai}</span>
                          </>
                        )}
                      </span>
                      <span className="flex w-24 items-center justify-center">
                        <input
                          type="radio"
                          name={`resp_${t.key}`}
                          value="pro"
                          defaultChecked={owner === 'pro'}
                          aria-label={`${t.label}: Accounting Pro`}
                          className="h-4 w-4 accent-blue-600"
                        />
                      </span>
                      <span className="flex w-16 items-center justify-center">
                        <input
                          type="radio"
                          name={`resp_${t.key}`}
                          value="client"
                          defaultChecked={owner === 'client'}
                          aria-label={`${t.label}: Client`}
                          className="h-4 w-4 accent-blue-600"
                        />
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
