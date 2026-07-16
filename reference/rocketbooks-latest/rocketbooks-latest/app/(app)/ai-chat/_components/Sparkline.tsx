interface Props {
  /** Trailing-window daily values, oldest first. */
  trailing: number[];
  /** Forward-window daily values. Empty array hides the projection segment. */
  projected: number[];
  /** Pixel height of the SVG. Width fills the container. */
  height?: number;
  /** Tailwind text-color class; the strokes use currentColor. */
  className?: string;
}

/**
 * Auto-scaled SVG sparkline. Solid trailing line + dotted projection extension
 * sharing one y-axis. Honest about extreme ratios — at >50× max:min the small
 * values flatten near zero. No log scale tricks (per spec).
 *
 * Width fills the parent via 100%; the SVG uses preserveAspectRatio="none" to
 * stretch horizontally and `vectorEffect="non-scaling-stroke"` so the line
 * stays 1.5px no matter how it's stretched.
 */
export function Sparkline({ trailing, projected, height = 40, className }: Props) {
  const all = [...trailing, ...projected];
  if (all.length < 2) return <div style={{ height }} aria-hidden="true" />;

  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const range = max - min || 1;
  const total = trailing.length + projected.length;

  const yFor = (v: number) => height - ((v - min) / range) * height;

  const trailingPoints = trailing
    .map((v, i) => `${i},${yFor(v).toFixed(2)}`)
    .join(' ');
  const projectedPoints = projected
    .map((v, i) => `${trailing.length + i},${yFor(v).toFixed(2)}`)
    .join(' ');

  return (
    <svg
      className={className ?? 'text-zinc-500 dark:text-zinc-400'}
      viewBox={`0 0 ${Math.max(1, total - 1)} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      aria-hidden="true"
    >
      {trailing.length >= 2 && (
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          points={trailingPoints}
        />
      )}
      {projected.length >= 2 && (
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
          points={projectedPoints}
        />
      )}
    </svg>
  );
}
