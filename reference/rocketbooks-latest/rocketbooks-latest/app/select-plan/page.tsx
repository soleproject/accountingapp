import { requireSession } from '@/lib/auth/session';
import { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS, isAccountingTierKey, type AccountingTier } from '@/lib/accounting/tiers';
import { chooseSignupPlanAction } from './_actions/choosePlan';

export const dynamic = 'force-dynamic';

/** Headline, differentiating bullets for each tier card. */
function planBullets(t: AccountingTier): string[] {
  const b: string[] = [];
  b.push(t.limits.bankConnections === null ? 'Unlimited bank / credit-card connections' : `${t.limits.bankConnections} bank / credit-card connection`);
  b.push(t.limits.seats === null ? 'Unlimited team seats' : `${t.limits.seats} team seat${t.limits.seats === 1 ? '' : 's'}`);
  b.push('AI transaction categorization');
  if (t.capabilities.reconciliation) b.push('AI reconciliation (bank + CC)');
  if (t.capabilities.apBills) b.push('AP / bill management');
  if (t.capabilities.aiCollections) b.push('AI AR collections');
  if (t.capabilities.advancedReporting) b.push('Advanced + custom reports');
  if (t.capabilities.inventory) b.push('Inventory');
  if (t.capabilities.multiEntity) b.push('Multi-entity');
  return b;
}

/**
 * In-app "Choose your plan" step shown right after a plan-less signup. Lists the
 * three tiers (Plus highlighted as Most Popular); picking one stamps the org tier
 * and opens that plan's Stripe card form to start the 7-day trial. Full-width page
 * (outside the auth glass card + the app sidebar) styled like the pricing table.
 */
export default async function SelectPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; org?: string; add?: string }>;
}) {
  await requireSession();
  const { plan, org, add } = await searchParams;
  // Add-company mode: a NEW org id + add=1 → this is an ADDITIONAL company, billed
  // right away (no trial). Otherwise it's the first-company signup 7-day trial.
  const addOrg = (org ?? '').trim() || null;
  const addMode = add === '1' && !!addOrg;
  // Safety net: a ?plan= hint (misrouted link / back-button) pre-selects that tier
  // as a one-click "Continue" confirm instead of a blank re-pick.
  const hinted = isAccountingTierKey(plan) ? plan : null;
  // The visually-primary card: the hinted plan when present, else Plus (default).
  const highlightKey = hinted ?? 'plus';

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
            {addMode ? 'Choose a plan for your new company' : hinted ? 'Confirm your plan' : 'Choose your plan'}
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            {addMode
              ? 'Each company has its own plan. Billed today · cancel anytime · change plans later in Billing.'
              : '7-day free trial · no charge for 7 days · cancel anytime. You can change plans later in Billing.'}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {ACCOUNTING_TIER_KEYS.map((key) => {
            const t = ACCOUNTING_TIERS[key];
            const popular = key === 'plus';
            const highlight = key === highlightKey;
            const buttonLabel =
              addMode || hinted
                ? highlight
                  ? `Continue with ${t.label} →`
                  : `Choose ${t.label}`
                : 'Start 7-day trial';
            return (
              <form
                key={key}
                action={chooseSignupPlanAction}
                className={`relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm dark:bg-zinc-900 ${
                  highlight
                    ? 'border-blue-500 ring-2 ring-blue-500/30 dark:border-blue-500'
                    : 'border-zinc-200 dark:border-zinc-800'
                }`}
              >
                <input type="hidden" name="tier" value={key} />
                {addMode && <input type="hidden" name="org" value={addOrg} />}
                {addMode && <input type="hidden" name="add" value="1" />}
                {popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-0.5 text-xs font-semibold text-white shadow-sm">
                    Most Popular
                  </span>
                )}
                <div className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t.label}</div>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-100">${Math.round(t.priceCents / 100)}</span>
                  <span className="text-sm text-zinc-500 dark:text-zinc-400">/mo</span>
                </div>
                <p className="mt-2 min-h-[2.5rem] text-sm text-zinc-500 dark:text-zinc-400">{t.description}</p>

                <ul className="mt-4 flex flex-1 flex-col gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                  {planBullets(t).map((b) => (
                    <li key={b} className="flex items-start gap-2">
                      <span className="mt-0.5 text-emerald-500" aria-hidden>✓</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>

                <button
                  type="submit"
                  className={`mt-6 rounded-xl px-4 py-2.5 text-sm font-semibold shadow-sm transition ${
                    highlight
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'border border-zinc-300 text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  {buttonLabel}
                </button>
              </form>
            );
          })}
        </div>

        <p className="mt-8 text-center text-xs text-zinc-400">
          {addMode
            ? 'Payment is required to add a company — billing starts today.'
            : "A card is required to start — you won't be charged during the trial."}
        </p>
      </div>
    </main>
  );
}
