'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { saveSubstantiationAction } from '../_actions/save';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import type { DocType } from '@/lib/accounting/substantiation-types';

export interface SubstAskField {
  key: string;
  label: string;
  optional?: boolean;
}

export interface SubstItem {
  transactionId: string;
  docType: DocType;
  docLabel: string;
  date: string | null;
  amount: number | null;
  description: string | null;
  /** Ordered required-first, optional-last (see page buildItem). */
  askFields: SubstAskField[];
  /** Prefilled ASK-field values (already-provided answers). */
  values: Record<string, string>;
}

/** Common shape for activating a card in the assistant (an item, or the `next` from the save tool). */
interface TargetLike {
  transactionId: string;
  docType: DocType;
  docLabel: string;
  date: string | null;
  amount: number | null;
  description: string | null;
  askFields: SubstAskField[];
}

const fmt = (n: number | null) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/**
 * Card-per-transaction fill-in for IRS documentation. Fields are typed directly,
 * or "Ask AI" hands the transaction to the Assistant sidecar: it asks about the
 * charge in chat, the user answers, and the assistant calls fill_substantiation_card
 * (values land in THIS card) then, on the user's OK, save_substantiation_card — which
 * persists it, drops the card off the list, and advances to the next one to review.
 */
export function SubstantiationForm({ items }: { items: SubstItem[] }) {
  const { seedPrompt, requestSidecarOpen, setPageContext, registerClientAction } = useAssistant();
  const [pending, start] = useTransition();
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [askingId, setAskingId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, Record<string, string>>>(() => {
    const m: Record<string, Record<string, string>> = {};
    for (const it of items) m[it.transactionId] = { ...it.values };
    return m;
  });

  // Point the assistant at a specific card (no chat message — used both by the
  // "Ask AI" button and when the save tool advances us to the next transaction).
  function setActiveContext(t: TargetLike) {
    setAskingId(t.transactionId);
    setPageContext({
      pageId: 'substantiation',
      pageTitle: 'IRS Documentation',
      route: '/substantiation',
      data: {
        activeTransaction: {
          transactionId: t.transactionId,
          docType: t.docType,
          docLabel: t.docLabel,
          description: t.description,
          amount: t.amount,
          date: t.date,
          askFields: t.askFields.map((f) => ({ key: f.key, label: f.label, optional: !!f.optional })),
          alreadyFilled: values[t.transactionId] ?? {},
        },
      },
      toolNames: ['fill_substantiation_card', 'save_substantiation_card'],
    });
    if (typeof document !== 'undefined') {
      requestAnimationFrame(() =>
        document.getElementById(`subst-${t.transactionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      );
    }
  }

  // The assistant writes extracted fields back into the right card.
  useEffect(() => {
    const off = registerClientAction('fill_substantiation_card', (args) => {
      const txnId = typeof args.transactionId === 'string' ? args.transactionId : '';
      const raw = args.fields && typeof args.fields === 'object' ? (args.fields as Record<string, unknown>) : {};
      if (!txnId) return;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v != null && String(v).trim()) clean[k] = String(v).trim();
      }
      if (Object.keys(clean).length === 0) return;
      setValues((v) => ({ ...v, [txnId]: { ...v[txnId], ...clean } }));
      setSavedIds((s) => {
        if (!s.has(txnId)) return s;
        const n = new Set(s);
        n.delete(txnId);
        return n;
      });
      setAskingId(txnId);
    });
    return () => off();
  }, [registerClientAction]);

  // The assistant saved a card via the save tool → drop it off the list and, if a
  // `next` came back, activate that card (the assistant asks about it in the same turn).
  useEffect(() => {
    const off = registerClientAction('substantiation_saved', (args) => {
      const txnId = typeof args.transactionId === 'string' ? args.transactionId : '';
      if (txnId) {
        setDoneIds((s) => new Set(s).add(txnId));
        setSavedIds((s) => {
          if (!s.has(txnId)) return s;
          const n = new Set(s);
          n.delete(txnId);
          return n;
        });
      }
      const next = args.next && typeof args.next === 'object' ? (args.next as Record<string, unknown>) : null;
      if (next && typeof next.transactionId === 'string' && Array.isArray(next.askFields)) {
        setActiveContext({
          transactionId: next.transactionId,
          docType: String(next.docType ?? '') as DocType,
          docLabel: String(next.docLabel ?? ''),
          description: (next.description as string | null) ?? null,
          amount: (next.amount as number | null) ?? null,
          date: (next.date as string | null) ?? null,
          askFields: next.askFields as SubstAskField[],
        });
      } else {
        setAskingId(null);
        setPageContext(null);
      }
    });
    return () => off();
    // setActiveContext closes over `values` but only for prefill display — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerClientAction, setPageContext]);

  // Clear the page context (active transaction) when leaving the page.
  useEffect(() => () => setPageContext(null), [setPageContext]);

  const visible = items.filter((it) => !doneIds.has(it.transactionId));
  if (visible.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-emerald-300 bg-emerald-50/40 p-6 text-center text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300">
        {items.length === 0 ? 'No transactions awaiting IRS documentation. ✓' : 'All documented — nice work. ✓'}
      </p>
    );
  }

  function setField(txnId: string, key: string, val: string) {
    setValues((v) => ({ ...v, [txnId]: { ...v[txnId], [key]: val } }));
    setSavedIds((s) => {
      if (!s.has(txnId)) return s;
      const n = new Set(s);
      n.delete(txnId);
      return n;
    });
  }

  // Hand this transaction to the Assistant sidecar and prime it to ask about it.
  function askAi(item: SubstItem) {
    setActiveContext(item);
    requestSidecarOpen('side');
    const needs = item.askFields.filter((f) => !f.optional).map((f) => f.label);
    const needsPhrase = needs.length ? needs.join(' and ') : 'the details';
    // Hidden operational instruction — the user never sees this; only the
    // assistant's natural question renders.
    seedPrompt(
      `The user clicked "Ask AI" to document this ${item.docLabel.toLowerCase()}: ` +
        `"${item.description ?? 'this transaction'}"${item.amount != null ? `, ${fmt(item.amount)}` : ''}` +
        `${item.date ? ` on ${item.date}` : ''} (transactionId ${item.transactionId}). ` +
        `Ask them for it in ONE short, natural, friendly sentence — like a helpful bookkeeper, NOT a numbered ` +
        `list and without echoing the field labels verbatim. They need to tell you: ${needsPhrase}. ` +
        `When they answer, call fill_substantiation_card with { transactionId, fields } (exact askFields keys), then tell ` +
        `them it's filled in and to say "save" when it looks right. When they confirm, call save_substantiation_card ` +
        `with { transactionId, docType, fields } to save and pull up the next transaction, then ask about that one.`,
      { hidden: true },
    );
  }

  // Manual save (typed the fields in + clicked Save).
  function save(item: SubstItem) {
    setSavingId(item.transactionId);
    start(async () => {
      const res = await saveSubstantiationAction({
        transactionId: item.transactionId,
        docType: item.docType,
        fields: values[item.transactionId] ?? {},
      });
      setSavingId(null);
      if (!res.ok) return;
      if (res.status === 'provided') {
        setDoneIds((s) => new Set(s).add(item.transactionId)); // filed → drop off the list
      } else {
        setSavedIds((s) => new Set(s).add(item.transactionId)); // partial → keep, flag missing
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {visible.map((item) => {
        const isSaving = savingId === item.transactionId;
        const saved = savedIds.has(item.transactionId);
        const asking = askingId === item.transactionId;
        return (
          <div
            key={item.transactionId}
            id={`subst-${item.transactionId}`}
            className={`scroll-mt-24 rounded-lg border bg-white p-4 dark:bg-zinc-950 ${
              asking
                ? 'border-violet-300 ring-1 ring-violet-200 dark:border-violet-800 dark:ring-violet-900/50'
                : 'border-zinc-200 dark:border-zinc-800'
            }`}
          >
            <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <Link
                href={`/transactions/${item.transactionId}`}
                className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
              >
                {item.description ?? 'Transaction'}
              </Link>
              <span className="text-zinc-500">
                · {item.date ?? ''} · {fmt(item.amount)}
              </span>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {item.docLabel}
              </span>
              {asking && (
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                  ✨ Answer in the Assistant →
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {item.askFields.map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-zinc-600 dark:text-zinc-400">
                    {f.label}
                    {f.optional && <span className="text-zinc-400"> (optional)</span>}
                  </span>
                  <input
                    type="text"
                    value={values[item.transactionId]?.[f.key] ?? ''}
                    onChange={(e) => setField(item.transactionId, f.key, e.target.value)}
                    disabled={isSaving}
                    className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-blue-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </label>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => save(item)}
                disabled={isSaving || pending}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => askAi(item)}
                className="rounded-md border border-violet-300 px-3 py-1.5 text-sm font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/30"
              >
                ✨ Ask AI
              </button>
              {saved && !isSaving && (
                <span className="text-xs text-amber-600 dark:text-amber-400">Saved — still missing a required field</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
