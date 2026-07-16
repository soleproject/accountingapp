'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { runReturnAction, tickReturnAction, type RunReturnState } from '../_actions/runReturn';
import { recordFactAction, deleteFactAction, confirmFactAction, type RecordFactState } from '../_actions/recordFacts';
import { uploadDocumentAction, type UploadDocState } from '../_actions/uploadDocument';
import { TAX_INPUT_REFS } from '@/lib/tax/input-refs';
import type { TaxReturnDetail, TaxFormRow } from '@/lib/tax/store';

const FORM_STATUS_STYLE: Record<string, string> = {
  pending: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  acquiring: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  comprehending: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  needs_input: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  ready: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  filling: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  filled: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  verified: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  skipped: 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500',
  failed: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
};

const REF_LABEL = new Map(TAX_INPUT_REFS.map((r) => [r.ref, r.label] as const));
const REF_DEF = new Map(TAX_INPUT_REFS.map((r) => [r.ref, r] as const));

// Group refs by their namespace prefix for the picker.
const REF_GROUPS = (() => {
  const groups = new Map<string, typeof TAX_INPUT_REFS>();
  for (const r of TAX_INPUT_REFS) {
    const g = r.ref.split('.')[0];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(r);
  }
  return [...groups.entries()];
})();

function missingRefs(error: string | null): string[] {
  if (!error) return [];
  const m = error.match(/missing required inputs:\s*(.+)$/i);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

interface Prefill {
  ref: string;
  entityKey: string;
  nonce: number; // forces the editor to re-sync when the same ref is clicked twice
}

// Form states that mean the crawl still has work to do (so the poller should run).
const WORKING_STATUSES = new Set(['pending', 'acquiring', 'comprehending', 'ready', 'filling']);

export function TaxReturnWorkspace({ detail, pdfUrls }: { detail: TaxReturnDetail; pdfUrls: Record<string, string> }) {
  const { return: ret, forms, inputs } = detail;
  const router = useRouter();
  const [runState, runAction, running] = useActionState<RunReturnState | undefined, FormData>(runReturnAction, undefined);
  const [prefill, setPrefill] = useState<Prefill>({ ref: '', entityKey: '', nonce: 0 });
  const ticking = useRef(false);

  const draftCount = forms.filter((f) => f.status === 'filled' || f.status === 'verified').length;
  const needsInput = forms.filter((f) => f.status === 'needs_input');
  const working = forms.some((f) => WORKING_STATUSES.has(f.status));

  // Async crawl poller: while any form is mid-crawl, advance one batch then refresh — so a
  // 6-8 form fan-out completes across several short requests (no single-request timeout)
  // and the readiness spinners animate as forms move acquiring → filled. Guarded against
  // overlap; backs off the loop via the server round-trip latency itself.
  useEffect(() => {
    if (!working || ticking.current) return;
    let cancelled = false;
    ticking.current = true;
    (async () => {
      try {
        const res = await tickReturnAction(ret.id);
        if (cancelled) return;
        // Refresh to pull the new form statuses; the effect re-fires if still working.
        router.refresh();
        // If the server says nothing remains, a final refresh already reflects it.
        void res;
      } finally {
        if (!cancelled) ticking.current = false;
      }
    })();
    return () => {
      cancelled = true;
      ticking.current = false;
    };
  }, [working, ret.id, router, ret.updatedAt]);

  const focusFact = (ref: string, entityKey = '') => setPrefill((p) => ({ ref, entityKey, nonce: p.nonce + 1 }));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {ret.taxYear} {ret.returnType === 'business' ? 'Business' : 'Personal'} Return
            <span className="ml-2 align-middle text-sm font-normal text-zinc-400">{ret.seedFormCode}</span>
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {ret.jurisdictions.join(', ')}
            {ret.entityType ? ` · ${ret.entityType.replace(/_/g, ' ')}` : ''} · status {ret.status}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {working && (
            <span className="inline-flex items-center gap-1.5 text-xs text-sky-600 dark:text-sky-400">
              <Spinner /> Filling forms…
            </span>
          )}
          <form action={runAction}>
            <input type="hidden" name="return_id" value={ret.id} />
            <button type="submit" disabled={running || working} className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              {running ? 'Starting…' : working ? 'Working…' : forms.length ? 'Re-run return' : 'Run return'}
            </button>
          </form>
        </div>
      </header>

      {runState?.error && <p className="text-sm text-rose-600">{runState.error}</p>}

      <div className="rounded-xl border border-amber-200/70 bg-amber-50/60 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
        Forms below are <span className="font-semibold">drafts for preparer review</span> — verify every figure before relying on them. Not e-filed.
      </div>

      {/* Needs-input nudge — clicking a missing ref prefills the fact editor below. */}
      {needsInput.length > 0 && (
        <div className="rounded-2xl border border-amber-200/70 bg-white p-4 shadow-sm dark:border-amber-900/40 dark:bg-zinc-900">
          <h2 className="mb-2 text-sm font-semibold text-amber-700 dark:text-amber-300">Waiting on facts</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {needsInput.map((f) => (
              <li key={f.id} className="text-zinc-600 dark:text-zinc-300">
                <span className="font-medium">{f.formCode}</span>
                {f.instanceLabel ? <span className="text-zinc-400"> ({f.instanceLabel})</span> : null} needs:{' '}
                {missingRefs(f.error).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => focusFact(r, f.instanceLabel ?? '')}
                    title={`Record ${REF_LABEL.get(r) ?? r}`}
                    className="mx-0.5 rounded bg-amber-100 px-1 py-0.5 text-xs text-amber-800 hover:bg-amber-200 hover:underline dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-900/60"
                  >
                    {r}
                  </button>
                ))}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-zinc-400">Click a fact to fill it in below, then re-run the return.</p>
        </div>
      )}

      {/* Upload a document → extract */}
      <DocumentUpload returnId={ret.id} />

      {/* Fact editor */}
      <FactEditor returnId={ret.id} prefill={prefill} />

      {/* Form tree */}
      <section className="rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Forms</h2>
          <span className="text-xs text-zinc-400">{draftCount} drafted · {forms.length} total</span>
        </div>
        {forms.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No forms yet. Record the client&apos;s facts above, then click <span className="font-medium">Run return</span> to determine and fill the forms.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {forms.map((f) => (
              <FormRowItem key={f.id} form={f} pdfUrl={pdfUrls[f.id]} />
            ))}
          </ul>
        )}
      </section>

      {/* Recorded facts */}
      <section className="rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Recorded facts <span className="font-normal text-zinc-400">({inputs.length})</span></h2>
        </div>
        {inputs.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No facts recorded yet. Upload a W-2 / 1099 above to auto-extract, add them by hand, or ask the AI Assistant to interview the client.
          </p>
        ) : (
          <>
            {inputs.some((i) => !i.confirmedByUser) && (
              <p className="border-b border-zinc-100 bg-amber-50/50 px-4 py-1.5 text-xs text-amber-700 dark:border-zinc-800 dark:bg-amber-950/20 dark:text-amber-300">
                Amber rows are AI-extracted and <span className="font-medium">unconfirmed</span> — review the value, then Confirm. Low-confidence reads are marked “review”.
              </p>
            )}
            <table className="w-full text-sm">
              <tbody>
                {inputs.map((i) => (
                  <FactRow
                    key={`${i.ref}:${i.entityKey ?? ''}`}
                    returnId={ret.id}
                    ref_={i.ref}
                    entityKey={i.entityKey}
                    value={i.value}
                    confirmed={i.confirmedByUser}
                    confidence={i.confidence}
                    onEdit={focusFact}
                  />
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </div>
  );
}

function FactEditor({ returnId, prefill }: { returnId: string; prefill: Prefill }) {
  const [state, action, pending] = useActionState<RecordFactState | undefined, FormData>(recordFactAction, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const [ref, setRef] = useState('');
  const [entityKey, setEntityKey] = useState('');
  const [lastNonce, setLastNonce] = useState(0);

  // Sync from an external prefill click (missing-ref chip or row "edit") without an effect.
  if (prefill.nonce !== lastNonce) {
    setLastNonce(prefill.nonce);
    setRef(prefill.ref);
    setEntityKey(prefill.entityKey);
  }

  const def = REF_DEF.get(ref);
  const perEntity = def?.perEntity ?? false;
  const valueType = def?.valueType ?? 'text';

  return (
    <section className="rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50/50 to-white p-4 shadow-sm dark:border-indigo-900/40 dark:from-indigo-950/20 dark:to-zinc-900">
      <h2 className="mb-3 text-sm font-semibold text-zinc-800 dark:text-zinc-100">Add or update a fact</h2>
      <form ref={formRef} action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="return_id" value={returnId} />

        <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          Fact
          <select
            name="ref"
            required
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            className="min-w-[16rem] rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <option value="" disabled>Choose a fact…</option>
            {REF_GROUPS.map(([group, refs]) => (
              <optgroup key={group} label={group}>
                {refs.map((r) => (
                  <option key={r.ref} value={r.ref}>{r.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          Value
          {valueType === 'bool' ? (
            <select name="value" className="w-28 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" defaultValue="true">
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : (
            <input
              name="value"
              required
              inputMode={valueType === 'currency' || valueType === 'number' ? 'decimal' : 'text'}
              placeholder={valueType === 'currency' ? '0.00' : ''}
              className="w-44 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          )}
        </label>

        {perEntity && (
          <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            For (business / payer)
            <input
              name="entity_key"
              value={entityKey}
              onChange={(e) => setEntityKey(e.target.value)}
              placeholder="e.g. Acme LLC"
              className="w-40 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
        )}

        <button type="submit" disabled={pending || !ref} className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {pending ? 'Saving…' : 'Save fact'}
        </button>
        {state?.error && <span className="text-sm text-rose-600">{state.error}</span>}
        {state?.ok && !state.error && <span className="text-sm text-emerald-600">Saved.</span>}
      </form>
      {perEntity && (
        <p className="mt-2 text-xs text-zinc-400">This is a per-entity fact — set &ldquo;For&rdquo; to group it with one business/employer (e.g. multiple W-2s).</p>
      )}
    </section>
  );
}

function FactRow({
  returnId,
  ref_,
  entityKey,
  value,
  confirmed,
  confidence,
  onEdit,
}: {
  returnId: string;
  ref_: string;
  entityKey: string | null;
  value: unknown;
  confirmed: boolean;
  confidence: number | null;
  onEdit: (ref: string, entityKey: string) => void;
}) {
  const [, del, deleting] = useActionState<RecordFactState | undefined, FormData>(deleteFactAction, undefined);
  const [, confirmAct, confirming] = useActionState<RecordFactState | undefined, FormData>(confirmFactAction, undefined);

  // Unconfirmed = AI-extracted, awaiting review. Low confidence ⇒ a stronger "review" flag.
  const lowConf = confidence !== null && confidence < 0.6;
  const rowTint = confirmed
    ? ''
    : lowConf
      ? 'bg-rose-50/40 dark:bg-rose-950/10'
      : 'bg-amber-50/40 dark:bg-amber-950/10';

  return (
    <tr className={`border-t border-zinc-100 first:border-t-0 dark:border-zinc-800 ${rowTint}`}>
      <td className="px-4 py-1.5">
        <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{ref_}</div>
        <div className="text-xs text-zinc-400">{REF_LABEL.get(ref_) ?? ''}</div>
      </td>
      {entityKey ? <td className="px-2 py-1.5 text-xs text-zinc-400">{entityKey}</td> : <td className="px-2 py-1.5" />}
      <td className="px-4 py-1.5 text-zinc-700 dark:text-zinc-200">{formatValue(value)}</td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {confirmed ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            ✓ confirmed
          </span>
        ) : lowConf ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300" title="The two AI reads disagreed or a check failed — verify this value.">
            ⚠ review{confidence !== null ? ` · ${Math.round(confidence * 100)}%` : ''}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" title="AI-extracted — confirm after checking.">
            extracted{confidence !== null ? ` · ${Math.round(confidence * 100)}%` : ''}
          </span>
        )}
      </td>
      <td className="px-4 py-1.5 text-right whitespace-nowrap">
        {!confirmed && (
          <form action={confirmAct} className="mr-3 inline">
            <input type="hidden" name="return_id" value={returnId} />
            <input type="hidden" name="ref" value={ref_} />
            <input type="hidden" name="entity_key" value={entityKey ?? ''} />
            <button type="submit" disabled={confirming} className="text-xs font-medium text-emerald-600 hover:underline disabled:opacity-50 dark:text-emerald-400">
              {confirming ? '…' : 'Confirm'}
            </button>
          </form>
        )}
        <button type="button" onClick={() => onEdit(ref_, entityKey ?? '')} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Edit
        </button>
        <form action={del} className="ml-3 inline">
          <input type="hidden" name="return_id" value={returnId} />
          <input type="hidden" name="ref" value={ref_} />
          <input type="hidden" name="entity_key" value={entityKey ?? ''} />
          <button type="submit" disabled={deleting} className="text-xs font-medium text-rose-500 hover:underline disabled:opacity-50">
            {deleting ? '…' : 'Delete'}
          </button>
        </form>
      </td>
    </tr>
  );
}

const DOC_TYPE_OPTIONS = ['W-2', '1099-NEC', '1099-MISC', '1099-INT', '1099-DIV', 'K-1'] as const;

function DocumentUpload({ returnId }: { returnId: string }) {
  const [state, action, pending] = useActionState<UploadDocState | undefined, FormData>(uploadDocumentAction, undefined);
  return (
    <section className="rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50/50 to-white p-4 shadow-sm dark:border-indigo-900/40 dark:from-indigo-950/20 dark:to-zinc-900">
      <h2 className="mb-1 text-sm font-semibold text-zinc-800 dark:text-zinc-100">Upload a document</h2>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        Drop a W-2, 1099, or K-1 to read its box values — or pick <span className="font-medium">Last year&apos;s return</span> to import a prior return: RocketBooks carries forward your details and lists the forms you filed. Everything lands as drafts to confirm.
      </p>
      <form action={action} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="return_id" value={returnId} />
        <input
          type="file"
          name="file"
          accept="application/pdf,.pdf"
          required
          className="max-w-xs rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-zinc-200 file:px-3 file:py-1 file:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:file:bg-zinc-700 dark:file:text-zinc-100"
        />
        <select name="doc_type" defaultValue="" className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
          <option value="">Auto-detect type</option>
          <option value="PRIOR_RETURN">Last year&apos;s return (import)</option>
          {DOC_TYPE_OPTIONS.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button type="submit" disabled={pending} className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {pending ? 'Reading…' : 'Upload & extract'}
        </button>
      </form>
      {state?.error && <p className="mt-2 text-sm text-rose-600">{state.error}</p>}
      {state?.ok && (
        <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">
          {state.priorReturn
            ? `Imported your ${state.docType ?? ''} prior return — carried forward ${state.extracted} field${state.extracted === 1 ? '' : 's'}${state.seededForms && state.seededForms.length ? ` and pre-listed ${state.seededForms.length} form${state.seededForms.length === 1 ? '' : 's'} (${state.seededForms.join(', ')})` : ''}. Confirm the carried-forward facts below, then add this year's documents.`
            : state.docType === 'unknown'
              ? (state.message ?? 'Could not identify the document.')
              : `Read ${state.extracted} value${state.extracted === 1 ? '' : 's'} from your ${state.docType}${state.flagged ? ` — ${state.flagged} flagged for review` : ''}. Check the facts below and confirm.`}
        </p>
      )}
    </section>
  );
}

function FormRowItem({ form, pdfUrl }: { form: TaxFormRow; pdfUrl?: string }) {
  const indent = Math.min(form.depth, 4) * 16;
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: indent }}>
        {form.depth > 0 && <span className="text-zinc-300 dark:text-zinc-600">↳</span>}
        <span className="font-medium text-zinc-800 dark:text-zinc-200">{form.formCode}</span>
        {form.jurisdiction !== 'US' && <span className="text-xs text-zinc-400">{form.jurisdiction}</span>}
        {form.instanceLabel && <span className="truncate text-xs text-zinc-400">· {form.instanceLabel}</span>}
        {form.relationship && form.depth > 0 && <span className="text-xs text-zinc-300 dark:text-zinc-600">({form.relationship})</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <FormReadiness form={form} />
        {form.isDraft && (form.status === 'filled' || form.status === 'verified') && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">DRAFT</span>
        )}
        {pdfUrl && (
          <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            View PDF
          </a>
        )}
        {form.specId && (
          <Link href={`/taxes/specs/${form.specId}`} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Review spec
          </Link>
        )}
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${FORM_STATUS_STYLE[form.status] ?? FORM_STATUS_STYLE.pending}`}>
          {form.status.replace(/_/g, ' ')}
        </span>
      </div>
    </li>
  );
}

/**
 * "Is this form ready in the system?" badge — the wizard's per-form readiness indicator.
 * - acquiring/comprehending → animated spinner ("Preparing…"): the form is being
 *   downloaded + mapped right now.
 * - filled/verified → it's done (the status pill already says so; no readiness badge).
 * - otherwise (pending/needs_input/etc.): "✓ in system" when a spec already exists for
 *   this form+year (ready to fill), or "⬇ needs download" when it doesn't yet.
 */
function FormReadiness({ form }: { form: TaxFormRow }) {
  if (form.status === 'acquiring' || form.status === 'comprehending') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" title="Downloading the official form and mapping its fields…">
        <Spinner /> Preparing…
      </span>
    );
  }
  if (form.status === 'filled' || form.status === 'verified') return null; // status pill covers it
  if (form.inSystem) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" title="RocketBooks already has this form mapped — ready to fill.">
        ✓ in system
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" title="Not mapped yet — RocketBooks will download and map it on the next run.">
      ⬇ needs download
    </span>
  );
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}
