import { Badge, MetricTile, Panel } from '@/components/admin/AdminPage';
import { REFERRAL_GROSS_SHARE_PCT, REFERRAL_SHARE_CENTS } from '@/lib/enterprise/tiers';
import type { ShareData } from '@/lib/referral/share-data';
import { CopyButton } from './CopyButton';

/**
 * Presentational Share panels (invite link + QR + stats, then either the
 * tier cap-meter or the 20% referral panel). Renders NO page header — each
 * caller (enterprise Share page, app Share page) supplies its own shell +
 * header. Server component: it injects the pre-rendered QR SVG and embeds the
 * client CopyButton.
 */
export function ShareView({ data }: { data: ShareData }) {
  const { orgName, inviteUrl, qrSvg, counts, totalSignups, monthSignups, tier, cap, referralProjected } = data;

  return (
    <div className="flex flex-col gap-5">
      {/* Hero: invite link + QR */}
      <Panel>
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Your invite link</h2>
              <p className="mt-1 text-sm text-zinc-500">
                {tier
                  ? <>Anyone who signs up via this link is attached to {orgName} as a client.</>
                  : <>Anyone who signs up via this link is credited to {orgName} as your referral.</>}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <code className="flex-1 truncate rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm dark:border-zinc-800 dark:bg-zinc-900">
                {inviteUrl}
              </code>
              <CopyButton value={inviteUrl} label="Copy link" />
            </div>

            <p className="text-xs text-zinc-500">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {counts.source.inviteLink} of {totalSignups}
              </span>{' '}
              {totalSignups === 1 ? 'signup' : 'signups'} came via this link
              {counts.source.manual > 0 && (
                <> · {counts.source.manual} added manually</>
              )}
              {counts.source.unknown > 0 && (
                <> · {counts.source.unknown} unknown (legacy)</>
              )}
            </p>

            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Total</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{totalSignups}</dd>
              </div>
              <div className="rounded-md border border-emerald-200 p-3 dark:border-emerald-900/60">
                <dt className="text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Paying</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{counts.paying}</dd>
              </div>
              <div className="rounded-md border border-amber-200 p-3 dark:border-amber-900/60">
                <dt className="text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">Trial</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-amber-700 dark:text-amber-300">{counts.trial}</dd>
              </div>
            </dl>
            <p className="text-xs text-zinc-500">{monthSignups} {monthSignups === 1 ? 'signup' : 'signups'} in the last 30 days.</p>
          </div>

          <div className="flex shrink-0 flex-col items-center gap-2">
            <div
              className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-white"
              // QR is server-rendered SVG — safe to inject.
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <span className="text-xs text-zinc-500">Scan to sign up</span>
          </div>
        </div>
      </Panel>

      {/* Cap meter (tiered) — same numbers as the dashboard. */}
      {tier && cap && (
        <Panel>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{tier.label}</h2>
                <Badge tone="amber">{tier.shortLabel}</Badge>
                {cap.overCap && <Badge tone="amber">Over included cap</Badge>}
                {!cap.overCap && cap.spotsLeft <= 5 && (
                  <Badge tone="amber">{cap.spotsLeft} spots left</Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-zinc-500">
                Fill {tier.includedCompaniesCap} companies via your link to lock in the full ${(tier.partnerShareCentsPreCap / 100).toFixed(0)}/client share.
              </p>
            </div>
            <div className="text-right">
              <div className={`text-3xl font-semibold tabular-nums ${cap.overCap ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-900 dark:text-zinc-100'}`}>
                {totalSignups}
                <span className="text-base font-normal text-zinc-500"> / {tier.includedCompaniesCap}</span>
              </div>
              <div className="text-xs text-zinc-500">companies included</div>
            </div>
          </div>

          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className={`h-full transition-all ${cap.overCap ? 'bg-amber-500' : cap.spotsLeft <= 5 ? 'bg-amber-400' : 'bg-emerald-500'}`}
              style={{ width: `${cap.percentUsed}%` }}
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <MetricTile
              label="Projected/mo"
              value={`$${(cap.projected.totalCents / 100).toLocaleString()}`}
            />
            <MetricTile label="Paying clients" value={counts.paying} />
            <MetricTile label="Trial clients" value={counts.trial} />
            {counts.none > 0 ? (
              <MetricTile label="No subscription" value={counts.none} />
            ) : (
              <MetricTile label="Post-cap clients" value={cap.projected.postCapClients} />
            )}
          </div>
          {counts.trial > 0 && (
            <p className="mt-3 text-xs text-zinc-500">
              Trial clients fill cap slots but earn $0 until they convert to a paid subscription.
            </p>
          )}
        </Panel>
      )}

      {/* Referral model (no tier) — no seat cap, flat 20% of gross. */}
      {!tier && (
        <Panel>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">Referral partner</h2>
                <Badge tone="green">{REFERRAL_GROSS_SHARE_PCT}% of gross</Badge>
              </div>
              <p className="mt-1 text-sm text-zinc-500">
                Earn {REFERRAL_GROSS_SHARE_PCT}% of every paying referral&rsquo;s subscription —
                ${(REFERRAL_SHARE_CENTS / 100).toFixed(2)}/mo each — for as long as they pay.
                No limit, no monthly fee.
              </p>
            </div>
            <div className="text-right">
              <div className="text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {counts.paying}
              </div>
              <div className="text-xs text-zinc-500">paying referrals</div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <MetricTile
              label="Projected/mo"
              value={`$${(referralProjected.totalCents / 100).toLocaleString()}`}
            />
            <MetricTile label="Per referral/mo" value={`$${(REFERRAL_SHARE_CENTS / 100).toFixed(2)}`} />
            <MetricTile label="Paying referrals" value={counts.paying} />
            <MetricTile label="Trial referrals" value={counts.trial} />
          </div>
          {counts.trial > 0 && (
            <p className="mt-3 text-xs text-zinc-500">
              Trial referrals earn $0 until they convert to a paid subscription.
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
