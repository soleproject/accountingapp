import Link from 'next/link';

interface Crumb {
  label: string;
  href?: string;
}

interface Props {
  title: string;
  crumbs: Crumb[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function AdminPage({ title, crumbs, actions, children }: Props) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <nav className="mt-1 flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="flex items-center gap-1">
                {c.href ? (
                  <Link href={c.href} className="hover:text-zinc-700 hover:underline dark:hover:text-zinc-300">
                    {c.label}
                  </Link>
                ) : (
                  <span>{c.label}</span>
                )}
                {i < crumbs.length - 1 && <span className="text-zinc-300 dark:text-zinc-600">/</span>}
              </span>
            ))}
          </nav>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

interface MetricTileProps {
  label: string;
  value: string | number;
  delta?: { value: string; positive?: boolean };
  icon?: React.ReactNode;
  iconColor?: string;
}

export function MetricTile({ label, value, delta, icon, iconColor = 'text-blue-600 dark:text-blue-400' }: MetricTileProps) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
        {icon && <span className={iconColor}>{icon}</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {delta && (
          <span className={`text-xs font-medium ${delta.positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
            ↑ {delta.value}
          </span>
        )}
      </div>
    </div>
  );
}

interface PanelProps {
  title?: string;
  className?: string;
  children: React.ReactNode;
}

export function Panel({ title, className = '', children }: PanelProps) {
  return (
    <div className={`rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${className}`}>
      {title && (
        <div className="border-b border-zinc-200 px-5 py-3 text-sm font-medium dark:border-zinc-800">{title}</div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

interface CollapsiblePanelProps {
  title: string;
  /** Whether the panel starts expanded. Defaults to collapsed. */
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * A Panel whose body collapses. Uses a native <details> so it works without
 * client JS (safe in server components). The title row is the toggle, with a
 * chevron that rotates when open.
 */
export function CollapsiblePanel({ title, defaultOpen = false, className = '', children }: CollapsiblePanelProps) {
  return (
    <details
      open={defaultOpen}
      className={`group rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-5 py-3 text-sm font-medium hover:bg-zinc-50 group-open:rounded-b-none group-open:border-b group-open:border-zinc-200 dark:hover:bg-zinc-900 dark:group-open:border-zinc-800 [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <svg
          className="h-4 w-4 shrink-0 text-zinc-400 transition-transform group-open:rotate-90"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M7 5l6 5-6 5z" />
        </svg>
      </summary>
      <div className="p-5">{children}</div>
    </details>
  );
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-zinc-200 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
      {children}
    </div>
  );
}

interface StatusDotProps {
  status: 'ok' | 'warn' | 'error' | 'unknown';
  label?: string;
}

export function StatusDot({ status, label }: StatusDotProps) {
  const color =
    status === 'ok'
      ? 'bg-emerald-500'
      : status === 'warn'
        ? 'bg-amber-500'
        : status === 'error'
          ? 'bg-red-500'
          : 'bg-zinc-300 dark:bg-zinc-600';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label && <span className="text-xs text-zinc-600 dark:text-zinc-400">{label}</span>}
    </span>
  );
}

interface BadgeProps {
  tone?: 'green' | 'amber' | 'red' | 'blue' | 'zinc';
  children: React.ReactNode;
}

export function Badge({ tone = 'zinc', children }: BadgeProps) {
  const map = {
    green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    red: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
    zinc: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
  } as const;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${map[tone]}`}>{children}</span>;
}
