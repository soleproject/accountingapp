'use client';

import { useState } from 'react';

export interface WelcomeEmailConfig {
  subject: string;
  body: string;
  cta: string;
}

/** Default welcome-email copy for a given new-client-setup choice — the preview's
 *  starting point until the firm edits it (which stores an override). Mirrors the
 *  copy in the onboarding + add-company wizards. */
export function defaultEmailCopy(handoff: string, type: 'new' | 'switching', firm: string, ai: string): WelcomeEmailConfig {
  const NEW: Record<string, WelcomeEmailConfig> = {
    meeting: {
      subject: `Welcome to ${firm} — let's set up your books`,
      body: `Thanks for joining ${firm}! ${ai} will help get you up and running. Pick a time below for a quick setup call and we'll take it from there.`,
      cta: 'Book your setup call',
    },
    self: {
      subject: `Welcome to ${firm}!`,
      body: `You're all set to get started. Log in and ${ai} will walk you through setting up your books — it only takes a few minutes.`,
      cta: 'Get started',
    },
    pro: {
      subject: `Welcome to ${firm}!`,
      body: `Great news — there's nothing you need to do. Our team will set up your books for you and let you know the moment everything's ready.`,
      cta: 'View your account',
    },
  };
  const SWITCHING: Record<string, WelcomeEmailConfig> = {
    meeting: {
      subject: `Welcome to ${firm} — let's move your books over`,
      body: `Thanks for moving to ${firm}! ${ai} will help migrate your books from your old system. Pick a time below and we'll handle the transition for you.`,
      cta: 'Book your transition call',
    },
    self: {
      subject: `Welcome to ${firm} — let's bring your books over`,
      body: `We're moving your books to our new system. Log in and ${ai} will walk you through bringing your existing data over — it's quick.`,
      cta: 'Get started',
    },
    pro: {
      subject: `Welcome to ${firm}!`,
      body: `We're migrating your books from your old system — nothing for you to do. We'll let you know the moment everything's moved over.`,
      cta: 'View your account',
    },
  };
  const table = type === 'switching' ? SWITCHING : NEW;
  return table[handoff] ?? table.meeting;
}

/** Live, editable mockup of the welcome email — subject/body/CTA inline-editable;
 *  edits stored as an override (resetting reverts to the handoff-derived default).
 *  Exported so the add-company wizard (custom side-by-side layout) can reuse it. */
export function EmailPreview({
  value,
  customized,
  logoUrl,
  firm,
  brandColor,
  onChange,
  onReset,
}: {
  value: WelcomeEmailConfig;
  customized: boolean;
  logoUrl: string | null;
  firm: string;
  brandColor: string;
  onChange: (next: WelcomeEmailConfig) => void;
  onReset: () => void;
}) {
  const color = brandColor?.trim() || '#2563eb';
  const editCls =
    'w-full rounded border border-transparent bg-transparent hover:border-zinc-200 focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-300 dark:hover:border-zinc-700 dark:focus:bg-zinc-900';
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
        <span className="shrink-0 font-medium text-zinc-600 dark:text-zinc-300">Subject:</span>
        <input
          value={value.subject}
          onChange={(e) => onChange({ ...value, subject: e.target.value })}
          placeholder="Email subject"
          className={`${editCls} px-1 py-0.5 text-xs text-zinc-700 dark:text-zinc-200`}
        />
      </div>
      <div className="p-5">
        <div className="mb-4 flex h-9 items-center">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={firm} className="h-9 w-auto max-w-[60%] object-contain" />
          ) : (
            <span className="text-lg font-bold text-zinc-800 dark:text-zinc-100">{firm}</span>
          )}
        </div>
        <p className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-100">Hi there,</p>
        <textarea
          value={value.body}
          onChange={(e) => onChange({ ...value, body: e.target.value })}
          rows={4}
          placeholder="Email body"
          className={`${editCls} mb-5 resize-none px-1.5 py-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300`}
        />
        <span className="inline-flex rounded-md" style={{ backgroundColor: color }}>
          <input
            value={value.cta}
            onChange={(e) => onChange({ ...value, cta: e.target.value })}
            placeholder="Button label"
            size={Math.max(value.cta.length || 10, 6)}
            className="rounded-md border-none bg-transparent px-4 py-2 text-center text-sm font-medium text-white placeholder-white/70 focus:outline-none focus:ring-2 focus:ring-white/60"
          />
        </span>
        <p className="mt-6 flex items-center justify-between border-t border-zinc-100 pt-3 text-xs text-zinc-400 dark:border-zinc-800">
          <span>Sent by {firm}</span>
          {customized && (
            <button
              type="button"
              onClick={onReset}
              className="font-medium text-zinc-400 underline underline-offset-2 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              Reset to default
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * The client welcome-email editor: a New client / Switching client toggle over the
 * inline-editable EmailPreview. Holds no config itself — the parent owns the two
 * variant configs (null = use the handoff-derived default copy) and gets edits back
 * via onChangeNew/onChangeSwitching. Shared by the client import page (and available
 * for the onboarding/add-company wizards, which currently inline their own copy).
 */
export function WelcomeEmailEditor({
  logoUrl,
  firmName,
  brandColor,
  aiName,
  handoff,
  configNew,
  configSwitching,
  onChangeNew,
  onChangeSwitching,
}: {
  logoUrl: string | null;
  firmName: string;
  brandColor: string;
  aiName: string;
  handoff: string;
  configNew: WelcomeEmailConfig | null;
  configSwitching: WelcomeEmailConfig | null;
  onChangeNew: (c: WelcomeEmailConfig | null) => void;
  onChangeSwitching: (c: WelcomeEmailConfig | null) => void;
}) {
  const [variant, setVariant] = useState<'new' | 'switching'>('new');
  const activeConfig = variant === 'new' ? configNew : configSwitching;
  const setActive = variant === 'new' ? onChangeNew : onChangeSwitching;
  const value = activeConfig ?? defaultEmailCopy(handoff, variant, firmName, aiName);

  const tabCls = (active: boolean) =>
    `rounded px-2.5 py-1 font-medium ${active ? 'bg-blue-600 text-white' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-300'}`;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-800">
          <button type="button" onClick={() => setVariant('new')} className={tabCls(variant === 'new')}>
            New client
          </button>
          <button type="button" onClick={() => setVariant('switching')} className={tabCls(variant === 'switching')}>
            Switching client
          </button>
        </div>
        <span className="text-xs text-zinc-400">Click any text to edit</span>
      </div>
      <EmailPreview
        value={value}
        customized={activeConfig != null}
        logoUrl={logoUrl}
        firm={firmName}
        brandColor={brandColor}
        onChange={setActive}
        onReset={() => setActive(null)}
      />
    </div>
  );
}
