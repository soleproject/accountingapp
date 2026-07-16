'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogoSlot } from '@/components/org/LogoSlot';
import {
  saveEnterpriseOnboardingStepAction,
  resetEnterpriseOnboardingAction,
  askOnboardingAssistantAction,
} from '../_actions/enterpriseOnboarding';
import { startEnterpriseOnboardingBillingAction } from '../_actions/firmBilling';
import { ThemeStudio } from './ThemeStudio';
import { SubdomainCard } from './SubdomainCard';

interface BillingInfo {
  needsBilling: boolean;
  privateLabelEnabled: boolean;
  firmPays: boolean;
  cardOnFile: boolean;
  privateLabelActive: boolean;
  /** How many clients the firm pays for ($69/mo each). */
  firmPaidClientCount: number;
}
import type {
  ClientInteractionPrefs,
  EnterpriseOnboardingStatus,
  EnterprisePhase,
  WelcomeEmailConfig,
} from '@/lib/enterprise/onboarding';

// Local default (all interactions on). Defined here rather than imported from
// the onboarding module, which is server-only — importing a runtime value from
// it would pull server code (db/client, postgres) into this client bundle.
const DEFAULT_CLIENT_INTERACTION_PREFS: ClientInteractionPrefs = {
  askNewContacts: true,
  irsDocRequests: true,
  reviewReminders: true,
  weeklyDigest: true,
  monthlyReport: true,
};

const STEP_PHASES: EnterprisePhase[] = ['private_label', 'branding', 'web_address', 'client_interaction', 'review'];
const LABELS: Record<EnterprisePhase, string> = {
  private_label: 'Private label',
  branding: 'Branding',
  web_address: 'Web address',
  client_interaction: 'Client Interaction',
  review: 'Review',
  complete: 'Done',
};

/** The automatic client-facing emails shown on the Client Interaction step. */
const CLIENT_INTERACTIONS: { key: keyof ClientInteractionPrefs; title: string; desc: string }[] = [
  {
    key: 'askNewContacts',
    title: 'Ask the Client About New Contacts',
    desc: "When we spot a new vendor or customer on a transaction, we email the client to ask who they are — so the books stay clean without you chasing the details.",
  },
  {
    key: 'irsDocRequests',
    title: 'IRS Documentation Requests',
    desc: 'When a deduction or transaction needs a receipt or backup to be IRS-ready, we request the right documentation from the client for you.',
  },
  {
    key: 'reviewReminders',
    title: 'Automatic Review Reminders',
    desc: 'We gently nudge clients to review and approve flagged items, so nothing sits waiting on their input.',
  },
  {
    key: 'weeklyDigest',
    title: 'Weekly Digest Email',
    desc: "A short weekly recap of the week's activity — money in, money out, and anything that needs their attention.",
  },
  {
    key: 'monthlyReport',
    title: 'Monthly Report Email',
    desc: 'A polished month-end summary of their key numbers and trends, sent automatically when the month closes.',
  },
];
const GUIDANCE: Record<EnterprisePhase, string> = {
  private_label:
    "Private labeling ($95/mo) puts your brand on everything — your logo, your AI's name, your colors — and lets you charge your clients your own prices (most firms spend ~30 min per client per month). Without it, you're on RocketBooks' per-service pricing. I'd recommend it if you want to build your own brand.",
  branding:
    'Upload your logo, name your AI assistant, and pick a brand color. Your clients will see these instead of RocketBooks. (The color is saved now and applied across the app in a later update.)',
  web_address:
    'Give your clients a branded sign-in URL — they log in at your own subdomain with no RocketBooks branding. Works instantly once saved (no DNS setup on your end).',
  client_interaction:
    'Your AI assistant works directly with your clients over email — gathering what it needs and keeping them in the loop — so you spend less time chasing. Pick which of these run automatically. We never bombard clients; everything is sent tastefully and at the right moment.',
  review: 'Quick review — confirm everything looks right, then finish. You can change any of this later in Settings.',
  complete: '',
};

interface FormState {
  privateLabelEnabled: boolean;
  aiAssistantName: string;
  brandColorHex: string;
  clientBillingMode: string;
  clientPriceMode: string;
  sendingFromEmail: string;
  clientOnboardingHandoff: string;
  clientBackendLoginEnabled: boolean;
  welcomeEmailConfig: WelcomeEmailConfig | null;
  welcomeEmailConfigSwitching: WelcomeEmailConfig | null;
  clientBookingUrl: string;
  clientInteractionPrefs: ClientInteractionPrefs;
}

function seed(a: EnterpriseOnboardingStatus['answers']): FormState {
  return {
    privateLabelEnabled: a.privateLabelEnabled,
    aiAssistantName: a.aiAssistantName ?? '',
    brandColorHex: a.brandColorHex ?? '#2563eb',
    // Default to clients-pay-directly until the firm chooses otherwise.
    clientBillingMode: a.clientBillingMode ?? 'client_pays',
    clientPriceMode: a.clientPriceMode ?? '',
    sendingFromEmail: a.sendingFromEmail ?? '',
    clientOnboardingHandoff: a.clientOnboardingHandoff ?? '',
    clientBackendLoginEnabled: a.clientBackendLoginEnabled ?? false,
    welcomeEmailConfig: a.welcomeEmailConfig ?? null,
    welcomeEmailConfigSwitching: a.welcomeEmailConfigSwitching ?? null,
    clientBookingUrl: a.clientBookingUrl ?? '',
    clientInteractionPrefs: { ...DEFAULT_CLIENT_INTERACTION_PREFS, ...(a.clientInteractionPrefs ?? {}) },
  };
}

const fieldCls =
  'w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';

export function EnterpriseOnboardingWizard({
  initial,
  billing,
  subdomainRoot,
}: {
  initial: EnterpriseOnboardingStatus;
  billing: BillingInfo;
  subdomainRoot: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  // Firm setup only requires the $95 private-label seat to be active (when chosen).
  // Per-client (firm-pays) card collection now happens on the client pages, so it no
  // longer gates finishing onboarding.
  const billingComplete = !billing.privateLabelEnabled || billing.privateLabelActive;
  const [form, setForm] = useState<FormState>(seed(initial.answers));
  const [saving, setSaving] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // Keep the wizard in lock-step with the server phase after the AI's
  // advance_onboarding_step (which advances the DB + refreshes the page). Without
  // this, useState(initial) ignores the new prop and the wizard lags behind the
  // assistant. `initial` only changes on a server refresh (Continue or AI advance),
  // so this won't clobber edits during normal typing.
  useEffect(() => {
    setStatus(initial);
    setForm(seed(initial.answers));
  }, [initial]);

  const phase = status.phase;
  // Branding always shows; for non-private-label firms its fields are disabled
  // and it doubles as a subtle private-label upsell.
  const visiblePhases = STEP_PHASES;
  const currentIndex = visiblePhases.indexOf(phase);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  // Firm-pays requires private label — if PL is turned off, fall back to
  // clients-pay so a stale firm_pays value can't silently persist.
  useEffect(() => {
    if (!form.privateLabelEnabled && form.clientBillingMode === 'firm_pays') {
      setForm((f) => ({ ...f, clientBillingMode: 'client_pays' }));
    }
  }, [form.privateLabelEnabled, form.clientBillingMode]);

  function patchFor(p: EnterprisePhase) {
    switch (p) {
      case 'private_label':
        return { privateLabelEnabled: form.privateLabelEnabled };
      case 'branding':
        return {};
      case 'client_interaction':
        return { clientInteractionPrefs: form.clientInteractionPrefs };
      default:
        return {};
    }
  }

  async function go(to: EnterprisePhase | 'next' | 'stay', withPatch: boolean) {
    setSaving(true);
    setAnswer(null);
    setAskOpen(false);
    const res = await saveEnterpriseOnboardingStepAction({ patch: withPatch ? patchFor(phase) : undefined, to });
    setStatus(res);
    setForm(seed(res.answers));
    setSaving(false);
    // Refresh so the AI walkthrough (which reads the server phase) re-seeds and
    // coaches the next step when the user advances via the Continue button.
    router.refresh();
  }

  const next = () => go(phase === 'review' ? 'complete' : 'next', true);
  const back = () => {
    if (currentIndex <= 0) return;
    void go(visiblePhases[currentIndex - 1], false);
  };

  async function ask() {
    if (!question.trim()) return;
    setAsking(true);
    setAnswer(null);
    const res = await askOnboardingAssistantAction({ phase, question: question.trim() });
    setAsking(false);
    setAnswer(res.ok ? res.answer ?? '' : res.error ?? 'Sorry, I could not answer that.');
  }

  // ── completed ──────────────────────────────────────────────────────
  if (phase === 'complete' || status.completed) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-8 text-center dark:border-emerald-900/60 dark:bg-emerald-950/20">
        <div className="text-2xl">🎉</div>
        <h2 className="mt-2 text-lg font-semibold text-emerald-800 dark:text-emerald-200">Your firm is set up</h2>
        <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">
          You can change any of these answers anytime in Settings.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => router.push('/enterprise/dashboard')}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            Go to dashboard
          </button>
          <button
            type="button"
            onClick={async () => {
              await resetEnterpriseOnboardingAction();
              router.refresh();
            }}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Reconfigure
          </button>
        </div>
      </div>
    );
  }

  const inviteLink =
    status.answers.inviteSlug && typeof window !== 'undefined'
      ? `${window.location.origin}/signup?ref=${status.answers.inviteSlug}`
      : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Stepper */}
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {visiblePhases.map((p, i) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => { if (p !== phase) void go(p, true); }}
              disabled={saving}
              title={`Go to ${LABELS[p]}`}
              className={`flex items-center gap-1.5 rounded transition hover:opacity-70 disabled:cursor-default disabled:hover:opacity-100 ${
                i === currentIndex
                  ? 'font-semibold text-blue-700 dark:text-blue-300'
                  : i < currentIndex
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-zinc-400'
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                  i === currentIndex
                    ? 'bg-blue-600 text-white'
                    : i < currentIndex
                      ? 'bg-emerald-500 text-white'
                      : 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800'
                }`}
              >
                {i < currentIndex ? '✓' : i + 1}
              </span>
              {LABELS[p]}
            </button>
          </li>
        ))}
      </ol>

      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-lg font-semibold">{LABELS[phase]}</h2>

        {/* Assistant guidance */}
        <div className="mt-2 whitespace-pre-line rounded-md border border-violet-200 bg-violet-50/60 p-3 text-sm text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-200">
          <span className="mr-1 font-medium">Assistant:</span>
          {GUIDANCE[phase]}
          <div className="mt-2">
            {!askOpen ? (
              <button type="button" onClick={() => setAskOpen(true)} className="text-xs font-medium text-violet-700 underline dark:text-violet-300">
                Ask a question
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <input
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && ask()}
                    placeholder="Ask about this step…"
                    className={fieldCls}
                  />
                  <button
                    type="button"
                    onClick={ask}
                    disabled={asking}
                    className="shrink-0 rounded-md bg-violet-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    {asking ? '…' : 'Ask'}
                  </button>
                </div>
                {answer && <div className="rounded-md bg-white/70 p-2 text-xs text-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300">{answer}</div>}
              </div>
            )}
          </div>
        </div>

        {/* Phase body */}
        <div className="mt-4">
          {phase === 'private_label' && (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={form.privateLabelEnabled}
                onChange={(e) => set('privateLabelEnabled', e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-zinc-300 accent-blue-600"
              />
              <span className="text-sm">
                <span className="font-medium">Yes, private label my service</span> ($95/month) — use my own brand, AI
                name, colors, and pricing.
              </span>
            </label>
          )}

          {phase === 'branding' && (
            <div className="flex flex-col gap-4">
              {!form.privateLabelEnabled && (
                <div className="rounded-md border border-blue-200 bg-blue-50/70 p-3 text-sm text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
                  <span className="font-medium">Make it your own with Private Label.</span> Upload your logo, name your
                  AI assistant, and pick a brand color so clients see <em>your</em> brand instead of RocketBooks.{' '}
                  <button
                    type="button"
                    onClick={() => go('private_label', false)}
                    className="font-medium underline underline-offset-2 hover:no-underline"
                  >
                    Enable Private Label ($95/mo)
                  </button>
                </div>
              )}
              <div
                className={!form.privateLabelEnabled ? 'pointer-events-none select-none opacity-50' : ''}
                aria-disabled={!form.privateLabelEnabled}
              >
                <div className="flex flex-col gap-4">
                  <div>
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Logo</div>
                    <p className="mb-2 text-xs text-zinc-500">
                      The light logo is the default; dark variants and icons are used in dark mode and when the sidebar
                      is collapsed. Only the light logo is required.
                    </p>
                    <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Logo · light</span>
                        <LogoSlot logoUrl={status.answers.logoUrl} uploadUrl="/api/enterprise/logo" slot="light" size="lg" />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Logo · dark</span>
                        <LogoSlot logoUrl={status.answers.logoUrlDark} uploadUrl="/api/enterprise/logo" slot="dark" dark size="lg" />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Icon · light</span>
                        <LogoSlot logoUrl={status.answers.logoIconUrl} uploadUrl="/api/enterprise/logo" slot="icon" size="md" />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Icon · dark</span>
                        <LogoSlot logoUrl={status.answers.logoIconDarkUrl} uploadUrl="/api/enterprise/logo" slot="iconDark" dark size="md" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Theme</div>
                <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
                  Customize your colors across the app — accents, sidebar, topbar, and chat. Anything left as
                  &ldquo;default&rdquo; uses the RocketBooks look.
                </p>
                <ThemeStudio
                  initial={status.answers.themeConfig}
                  brandColorHex={form.brandColorHex || null}
                  privateLabel={form.privateLabelEnabled}
                  logoUrl={status.answers.logoUrl}
                  collapsibleTokens
                />
              </div>
            </div>
          )}

          {phase === 'web_address' && (
            <div className="flex flex-col gap-4">
              {!form.privateLabelEnabled && (
                <div className="rounded-md border border-blue-200 bg-blue-50/70 p-3 text-sm text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
                  <span className="font-medium">Branded sign-in with Private Label.</span> Your clients log in at your
                  own subdomain with no RocketBooks branding.{' '}
                  <button
                    type="button"
                    onClick={() => go('private_label', false)}
                    className="font-medium underline underline-offset-2 hover:no-underline"
                  >
                    Enable Private Label ($95/mo)
                  </button>
                </div>
              )}
              <div
                className={!form.privateLabelEnabled ? 'pointer-events-none select-none opacity-50' : ''}
                aria-disabled={!form.privateLabelEnabled}
              >
                <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
                  Give your clients a branded sign-in URL — they log in at your own subdomain with no RocketBooks
                  branding. Works instantly once saved (no DNS setup on your end).
                </p>
                <SubdomainCard current={status.answers.subdomain} root={subdomainRoot} />
              </div>
            </div>
          )}

          {phase === 'client_interaction' && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                Your AI assistant interacts with each client over email so your books stay current and
                IRS-ready — without you doing the chasing. Choose which interactions run automatically.
              </p>
              <div className="flex flex-col divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {CLIENT_INTERACTIONS.map((item) => (
                  <label key={item.key} className="flex cursor-pointer items-start gap-3 p-4 transition hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
                    <input
                      type="checkbox"
                      checked={form.clientInteractionPrefs[item.key]}
                      onChange={(e) =>
                        set('clientInteractionPrefs', { ...form.clientInteractionPrefs, [item.key]: e.target.checked })
                      }
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 accent-blue-600"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{item.title}</span>
                      <span className="text-sm text-zinc-500 dark:text-zinc-400">{item.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
                <span className="font-medium">We never bombard your clients.</span> Every message is sent
                tastefully and at the right moment. In our experience clients don&rsquo;t just tolerate this
                interaction — they love it. It makes them feel looked after, and it keeps their books clean for you.
              </div>
            </div>
          )}

          {phase === 'review' && (
            <>
              <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <Review label="Private label" value={form.privateLabelEnabled ? 'Yes ($95/mo)' : 'No'} />
                <Review label="AI name" value={form.aiAssistantName || '—'} />
                <Review label="Brand color" value={form.brandColorHex || '—'} />
                <Review label="Client interaction" value={`${CLIENT_INTERACTIONS.filter((i) => form.clientInteractionPrefs[i.key]).length} of ${CLIENT_INTERACTIONS.length} on`} />
              </dl>

              {/* Firm setup only bills the $95 private-label seat. Per-client charges
                  (firm-pays) are set up separately when clients are added. */}
              {billing.privateLabelEnabled && (
                <div className="mt-4 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="text-sm font-medium">Billing</div>
                  <ul className="mt-1 list-disc pl-4 text-xs text-zinc-600 dark:text-zinc-400">
                    <li>Private label — $95/mo</li>
                  </ul>
                  <div className="mt-1.5 text-sm font-semibold">Total — $95/mo</div>
                  <div className="mt-2 flex items-center gap-2">
                    {billingComplete ? (
                      <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">Private label active ✓</span>
                    ) : (
                      <form action={startEnterpriseOnboardingBillingAction}>
                        <button
                          type="submit"
                          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
                        >
                          Set up billing &amp; pay $95/mo
                        </button>
                      </form>
                    )}
                  </div>
                  {!billingComplete && (
                    <p className="mt-1 text-xs text-zinc-400">Card stored securely by Stripe — we never see it.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Nav */}
        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            onClick={back}
            disabled={currentIndex <= 0 || saving}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            Back
          </button>
          <button
            type="button"
            onClick={next}
            disabled={saving || (phase === 'review' && !billingComplete)}
            title={phase === 'review' && !billingComplete ? 'Set up billing first' : undefined}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : phase === 'review' ? 'Finish setup' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Review({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
