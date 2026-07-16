import { Panel } from '@/components/admin/AdminPage';
import { updateRateAction } from '../_actions/rates';
import type { RateRow } from '@/lib/usage/rates';

/**
 * Editable per-unit rate card. Each row is its own server-action form so a
 * save touches only that key. LLM token pricing is intentionally absent —
 * it has a different shape (in/out/cached) and lives in lib/ai/usage.ts.
 */
export function RatesPanel({ rates }: { rates: RateRow[] }) {
  return (
    <Panel title="Per-unit rates (editable)">
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
        Cost for non-token services is computed as quantity × rate. Defaults are public list prices —
        edit to match your contracts. LLM token rates (input/output/cached) live in code (
        <code className="font-mono">lib/ai/usage.ts</code>).
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="py-2">Service</th>
            <th className="py-2">Unit</th>
            <th className="py-2 text-right">Rate (USD)</th>
            <th className="py-2" />
            <th className="py-2">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rates.map((r) => (
            <tr key={r.key}>
              <td className="py-2">
                <div className="font-medium">{r.label}</div>
                <div className="font-mono text-xs text-zinc-500">{r.key}</div>
              </td>
              <td className="py-2 text-zinc-600 dark:text-zinc-400">/ {r.unit}</td>
              <td className="py-2 text-right">
                <form action={updateRateAction} className="flex items-center justify-end gap-2">
                  <input type="hidden" name="key" value={r.key} />
                  <span className="text-zinc-400">$</span>
                  <input
                    name="rateUsd"
                    type="number"
                    step="0.00000001"
                    min="0"
                    defaultValue={r.rateUsd}
                    className="w-32 rounded-md border border-zinc-200 bg-white px-2 py-1 text-right font-mono text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                  >
                    Save
                  </button>
                </form>
              </td>
              <td />
              <td className="py-2 text-xs text-zinc-500">
                {r.updatedAt ? new Date(r.updatedAt).toLocaleDateString('en-US') : <span className="text-zinc-400">default</span>}
                {r.updatedBy ? <div className="text-zinc-400">{r.updatedBy}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
