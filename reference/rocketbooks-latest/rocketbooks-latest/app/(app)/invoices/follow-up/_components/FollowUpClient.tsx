'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { OverdueCustomer } from '@/lib/enterprise/ar-collections';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { draftRemindersAction, sendRemindersAction, type ReminderDraft } from '../_actions';

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface Preview extends ReminderDraft {
  included: boolean;
}

export function FollowUpClient({ customers, businessName }: { customers: OverdueCustomer[]; businessName: string }) {
  const router = useRouter();
  const { notifyAssistant } = useAssistant();
  const allInvoiceIds = useMemo(() => customers.flatMap((c) => c.invoices.map((i) => i.invoiceId)), [customers]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allInvoiceIds));
  const [phase, setPhase] = useState<'select' | 'preview'>('select');
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [busy, setBusy] = useState<null | 'draft' | 'send'>(null);
  const [result, setResult] = useState<{ sent: number; skipped: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selTotal = useMemo(
    () =>
      customers.reduce(
        (sum, c) => sum + c.invoices.filter((i) => selected.has(i.invoiceId)).reduce((s, i) => s + i.amountCents, 0),
        0,
      ),
    [customers, selected],
  );

  if (customers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        🎉 No overdue invoices with a customer email on file. Nothing to chase right now.
      </div>
    );
  }

  function toggleInvoice(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleCustomer(c: OverdueCustomer) {
    const ids = c.invoices.map((i) => i.invoiceId);
    const allOn = ids.every((id) => selected.has(id));
    setSelected((s) => {
      const n = new Set(s);
      for (const id of ids) {
        if (allOn) n.delete(id);
        else n.add(id);
      }
      return n;
    });
  }

  async function generate() {
    setBusy('draft');
    setError(null);
    const r = await draftRemindersAction([...selected]);
    setBusy(null);
    if (!r.ok || !r.drafts) {
      setError(r.error ?? 'Could not draft the reminders.');
      return;
    }
    setPreviews(r.drafts.map((d) => ({ ...d, included: true })));
    setPhase('preview');
    const count = r.drafts.length;
    notifyAssistant(
      `Overdue-invoice follow-up: the reminder drafts are generated and on screen now — ${count} ${count === 1 ? 'reminder' : 'reminders'} ready to review. Next they get reviewed/edited, then on approval they send from ${businessName} with replies routed back.`,
    );
  }

  async function send() {
    const items = previews.filter((p) => p.included).map((p) => ({ contactId: p.contactId, body: p.body }));
    if (items.length === 0) return;
    setBusy('send');
    setError(null);
    const r = await sendRemindersAction(items);
    setBusy(null);
    if (!r.ok) {
      setError(r.error ?? 'Sending failed.');
      return;
    }
    setResult({ sent: r.sent, skipped: r.skipped, failed: r.failed });
    notifyAssistant(
      `Overdue-invoice follow-up: ${r.sent} reminder${r.sent === 1 ? '' : 's'} sent from ${businessName}${r.failed ? `, ${r.failed} failed` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}.`,
    );
    router.refresh();
  }

  if (result) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-6 text-center dark:border-emerald-900/60 dark:bg-emerald-950/20">
        <h2 className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">Reminders sent ✓</h2>
        <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-200">
          Sent {result.sent} reminder{result.sent === 1 ? '' : 's'}
          {result.skipped ? `, ${result.skipped} skipped` : ''}
          {result.failed ? `, ${result.failed} failed` : ''}. Replies will come straight to you.
        </p>
        <Link href="/invoices" className="mt-4 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Back to invoices
        </Link>
      </div>
    );
  }

  const selectedCount = selected.size;

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">{error}</div>}

      {phase === 'select' ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-zinc-600 dark:text-zinc-300">
              <strong>{selectedCount}</strong> invoice{selectedCount === 1 ? '' : 's'} selected · <strong>{money(selTotal)}</strong> past due
            </div>
            <div className="flex gap-2 text-xs">
              <button type="button" onClick={() => setSelected(new Set(allInvoiceIds))} className="text-blue-600 hover:underline dark:text-blue-400">Select all</button>
              <button type="button" onClick={() => setSelected(new Set())} className="text-zinc-500 hover:underline">Clear</button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {customers.map((c) => {
              const ids = c.invoices.map((i) => i.invoiceId);
              const allOn = ids.every((id) => selected.has(id));
              return (
                <div key={c.contactId} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <label className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
                    <input type="checkbox" checked={allOn} onChange={() => toggleCustomer(c)} className="h-4 w-4 rounded border-zinc-300 accent-blue-600" />
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-zinc-400">{c.email}</span>
                    <span className="ml-auto text-sm text-zinc-600 dark:text-zinc-300">{money(c.totalCents)}</span>
                  </label>
                  <div className="flex flex-col">
                    {c.invoices.map((inv) => (
                      <label key={inv.invoiceId} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
                        <input type="checkbox" checked={selected.has(inv.invoiceId)} onChange={() => toggleInvoice(inv.invoiceId)} className="h-4 w-4 rounded border-zinc-300 accent-blue-600" />
                        <span className="text-zinc-700 dark:text-zinc-200">Invoice {inv.number ?? '(no #)'}</span>
                        {inv.dueDate && <span className="text-xs text-zinc-400">due {inv.dueDate}</span>}
                        <span className="ml-auto tabular-nums text-zinc-600 dark:text-zinc-300">{money(inv.amountCents)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={generate}
            disabled={selectedCount === 0 || busy === 'draft'}
            className="self-start rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'draft' ? 'Drafting previews…' : 'Generate previews →'}
          </button>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-zinc-600 dark:text-zinc-300">
              Review each reminder below. They send from <strong>{businessName}</strong>, reply-to you.
            </div>
            <button type="button" onClick={() => setPhase('select')} className="text-xs text-zinc-500 hover:underline">← Change selection</button>
          </div>

          <div className="flex flex-col gap-3">
            {previews.map((p, idx) => (
              <div key={p.contactId} className={`rounded-lg border p-4 ${p.included ? 'border-zinc-200 dark:border-zinc-800' : 'border-zinc-100 opacity-50 dark:border-zinc-900'}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-zinc-400">{p.email}</span>
                  <span className="text-xs text-zinc-500">· {p.invoiceCount} invoice{p.invoiceCount === 1 ? '' : 's'} · {money(p.totalCents)}</span>
                  {p.lastRemindedDays != null && p.lastRemindedDays <= 7 && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                      reminded {p.lastRemindedDays === 0 ? 'today' : `${p.lastRemindedDays}d ago`}
                    </span>
                  )}
                  <label className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
                    <input
                      type="checkbox"
                      checked={p.included}
                      onChange={() => setPreviews((ps) => ps.map((x, i) => (i === idx ? { ...x, included: !x.included } : x)))}
                      className="h-3.5 w-3.5 rounded border-zinc-300 accent-blue-600"
                    />
                    Include
                  </label>
                </div>
                <textarea
                  value={p.body}
                  onChange={(e) => setPreviews((ps) => ps.map((x, i) => (i === idx ? { ...x, body: e.target.value } : x)))}
                  rows={6}
                  disabled={!p.included}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed dark:border-zinc-700 dark:bg-zinc-950 disabled:opacity-60"
                />
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={send}
            disabled={busy === 'send' || previews.every((p) => !p.included)}
            className="self-start rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'send' ? 'Sending…' : `Approve all & send (${previews.filter((p) => p.included).length})`}
          </button>
        </>
      )}
    </div>
  );
}
