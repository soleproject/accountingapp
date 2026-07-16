import { fmtQty, fmtUsd } from '../_lib/format';
import type { CostRow } from '../_lib/categories';

/**
 * Renders the full cost-category breakdown — every tracked service/category,
 * zero-filled where unused (dimmed), with quantity, unit rate, and cost. Shared
 * by the main Usage & Costs page and the per-user usage page so they stay
 * identical.
 */
export function CostCategoriesTable({ rows }: { rows: CostRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
        <tr>
          <th className="py-2">Service</th>
          <th className="py-2 text-right">Quantity</th>
          <th className="py-2 text-right">Rate</th>
          <th className="py-2 text-right">Cost</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows.map((r) => {
          const used = r.cost > 0 || r.qty > 0;
          return (
            <tr key={r.label} className={used ? '' : 'text-zinc-400 dark:text-zinc-600'}>
              <td className="py-2">
                <span className={used ? 'font-medium' : ''}>{r.label}</span>
                {r.unit && <span className="ml-2 text-xs text-zinc-400">/ {r.unit.replace(/s$/, '')}</span>}
              </td>
              <td className="py-2 text-right">{used ? `${fmtQty(r.qty)} ${r.unit}` : '—'}</td>
              <td className="py-2 text-right text-zinc-500">{r.rate}</td>
              <td className={`py-2 text-right ${used ? 'font-medium' : ''}`}>{fmtUsd(r.cost)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
