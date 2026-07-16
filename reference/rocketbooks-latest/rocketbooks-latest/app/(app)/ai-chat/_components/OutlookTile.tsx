import { Sparkline } from './Sparkline';

function fmtDollars(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Math.round(n));
}

interface FlowProps {
  variant: 'flow';
  title: string;
  /** Trailing total, e.g. 12_400. */
  actual: number;
  /** Trailing window label, e.g. "Last 60 days". */
  actualLabel: string;
  /** Forward total (scheduled + extrapolated). Ignored when notEnoughHistory. */
  projected: number;
  projectedLabel: string;
  /** Suppresses the projected dollar line. Trailing sparkline still renders. */
  notEnoughHistory: boolean;
  trailing: number[];
  projectedDaily: number[];
  /** Tone classes: text color for sparkline. */
  toneClass: string;
}

interface StockProps {
  variant: 'stock';
  title: string;
  actual: number;
  actualLabel: string;
  projected: number;
  projectedLabel: string;
  /** Shown when both actual and projected are 0. */
  emptyLabel: string;
  /** Shown under the single bar when actual > 0 but projected = 0. */
  noneDueLabel: string;
  /** Tone class for bar fill. */
  toneClass: string;
}

type Props = FlowProps | StockProps;

export function OutlookTile(props: Props) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {props.title}
      </div>

      <div className="mt-2 space-y-1.5">
        <Line label={props.actualLabel} value={fmtDollars(props.actual)} />
        {props.variant === 'flow' && props.notEnoughHistory ? (
          <div className="text-xs italic text-zinc-500 dark:text-zinc-500">
            Not enough history to project
          </div>
        ) : (
          <Line
            label={props.projectedLabel}
            value={fmtDollars(props.projected)}
            muted
          />
        )}
      </div>

      <div className="mt-3">
        {props.variant === 'flow' ? (
          <Sparkline
            trailing={props.trailing}
            projected={props.notEnoughHistory ? [] : props.projectedDaily}
            className={props.toneClass}
          />
        ) : (
          <StockBars
            actual={props.actual}
            projected={props.projected}
            emptyLabel={props.emptyLabel}
            noneDueLabel={props.noneDueLabel}
            toneClass={props.toneClass}
          />
        )}
      </div>
    </div>
  );
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className={muted ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-700 dark:text-zinc-300'}>
        {label}
      </span>
      <span className={`tabular-nums ${muted ? 'text-zinc-600 dark:text-zinc-400' : 'font-medium text-zinc-900 dark:text-zinc-100'}`}>
        {value}
      </span>
    </div>
  );
}

interface BarsProps {
  actual: number;
  projected: number;
  emptyLabel: string;
  noneDueLabel: string;
  toneClass: string;
}

/**
 * Mini bars for AR/AP. Three states:
 * - both zero  → no bars, italic empty-label text only
 * - actual > 0, projected 0 → single bar with "None due in window" subtext
 * - both > 0 → two bars side-by-side, scaled to max(actual, projected)
 */
function StockBars({ actual, projected, emptyLabel, noneDueLabel, toneClass }: BarsProps) {
  const HEIGHT = 40;

  if (actual <= 0 && projected <= 0) {
    return (
      <div
        style={{ height: HEIGHT }}
        className="flex items-center text-xs italic text-zinc-500 dark:text-zinc-500"
      >
        {emptyLabel}
      </div>
    );
  }

  const max = Math.max(actual, projected, 1);
  const actualPx = Math.max(2, (actual / max) * HEIGHT);
  const projectedPx = Math.max(2, (projected / max) * HEIGHT);

  if (projected <= 0) {
    return (
      <div className="flex items-end gap-3" style={{ height: HEIGHT + 16 }}>
        <div className="flex flex-col items-center gap-1">
          <div
            className={`w-5 rounded-sm ${toneClass}`}
            style={{ height: actualPx }}
          />
        </div>
        <div className="flex-1 self-center text-xs italic text-zinc-500 dark:text-zinc-500">
          {noneDueLabel}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-end gap-3" style={{ height: HEIGHT }}>
      <div
        className={`w-5 rounded-sm ${toneClass}`}
        style={{ height: actualPx }}
        aria-label="open balance"
      />
      <div
        className={`w-5 rounded-sm opacity-60 ${toneClass}`}
        style={{ height: projectedPx }}
        aria-label="due in window"
      />
    </div>
  );
}
