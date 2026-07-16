import Link from 'next/link';
import { requirePermission } from '@/lib/auth/permissions';

type Accent = 'violet' | 'blue' | 'emerald' | 'amber' | 'slate' | 'teal';

interface ReportCard {
  href: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  accent: Accent;
}

// Color tokens are pinned per report so Tailwind sees the full class names
// at build time (it doesn't see interpolated strings). The mapping itself is
// declared explicitly below.
const TONE: Record<
  Accent,
  {
    card: string;
    iconBg: string;
    iconText: string;
    accentBar: string;
  }
> = {
  violet: {
    card: 'border-violet-200 bg-violet-50/60 hover:border-violet-400 dark:border-violet-900 dark:bg-violet-950/30 dark:hover:border-violet-700',
    iconBg: 'bg-violet-100 dark:bg-violet-900/50',
    iconText: 'text-violet-700 dark:text-violet-300',
    accentBar: 'bg-violet-500',
  },
  blue: {
    card: 'border-blue-200 bg-blue-50/60 hover:border-blue-400 dark:border-blue-900 dark:bg-blue-950/30 dark:hover:border-blue-700',
    iconBg: 'bg-blue-100 dark:bg-blue-900/50',
    iconText: 'text-blue-700 dark:text-blue-300',
    accentBar: 'bg-blue-500',
  },
  emerald: {
    card: 'border-emerald-200 bg-emerald-50/60 hover:border-emerald-400 dark:border-emerald-900 dark:bg-emerald-950/30 dark:hover:border-emerald-700',
    iconBg: 'bg-emerald-100 dark:bg-emerald-900/50',
    iconText: 'text-emerald-700 dark:text-emerald-300',
    accentBar: 'bg-emerald-500',
  },
  amber: {
    card: 'border-amber-200 bg-amber-50/60 hover:border-amber-400 dark:border-amber-900 dark:bg-amber-950/30 dark:hover:border-amber-700',
    iconBg: 'bg-amber-100 dark:bg-amber-900/50',
    iconText: 'text-amber-700 dark:text-amber-300',
    accentBar: 'bg-amber-500',
  },
  slate: {
    card: 'border-slate-200 bg-slate-50/60 hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900/40 dark:hover:border-slate-600',
    iconBg: 'bg-slate-100 dark:bg-slate-800',
    iconText: 'text-slate-700 dark:text-slate-300',
    accentBar: 'bg-slate-500',
  },
  teal: {
    card: 'border-teal-200 bg-teal-50/60 hover:border-teal-400 dark:border-teal-900 dark:bg-teal-950/30 dark:hover:border-teal-700',
    iconBg: 'bg-teal-100 dark:bg-teal-900/50',
    iconText: 'text-teal-700 dark:text-teal-300',
    accentBar: 'bg-teal-500',
  },
};

// Inline SVG icons keep the cards crisp at any zoom and stay consistent
// across OSes (unlike emoji glyphs).
const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const ScalesIcon = () => (
  <Icon>
    <path d="M12 3v18" />
    <path d="M5 21h14" />
    <path d="M5 7h14" />
    <path d="M3 14l3-7 3 7c-1 1.2-5 1.2-6 0z" />
    <path d="M15 14l3-7 3 7c-1 1.2-5 1.2-6 0z" />
  </Icon>
);
const PillarsIcon = () => (
  <Icon>
    <path d="M3 21h18" />
    <path d="M3 6h18" />
    <path d="M3 3h18" />
    <path d="M5 6v15" />
    <path d="M9 6v15" />
    <path d="M15 6v15" />
    <path d="M19 6v15" />
  </Icon>
);
const TrendUpIcon = () => (
  <Icon>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M14 7h7v7" />
  </Icon>
);
const LedgerIcon = () => (
  <Icon>
    <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5z" />
    <path d="M4 4.5V20a2.5 2.5 0 0 1 2.5-2H20" />
    <path d="M9 7h6" />
    <path d="M9 11h6" />
  </Icon>
);
const CashFlowIcon = () => (
  <Icon>
    <path d="M3 7h13a4 4 0 0 1 0 8H8" />
    <path d="M6 12l-3 3 3 3" />
    <path d="M21 17h-13a4 4 0 0 1 0-8h8" />
    <path d="M18 4l3 3-3 3" />
  </Icon>
);
const PercentIcon = () => (
  <Icon>
    <path d="M19 5L5 19" />
    <circle cx="6.5" cy="6.5" r="2.5" />
    <circle cx="17.5" cy="17.5" r="2.5" />
  </Icon>
);
const FormIcon = () => (
  <Icon>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8" />
    <path d="M8 17h5" />
  </Icon>
);

const REPORTS: ReportCard[] = [
  {
    href: '/reports/trial-balance',
    title: 'Trial Balance',
    desc: 'Verify debits = credits across all accounts',
    icon: <ScalesIcon />,
    accent: 'violet',
  },
  {
    href: '/reports/balance-sheet',
    title: 'Balance Sheet',
    desc: 'Assets = Liabilities + Equity at a point in time',
    icon: <PillarsIcon />,
    accent: 'blue',
  },
  {
    href: '/reports/income-statement',
    title: 'Income Statement',
    desc: 'Revenue, expenses, and net income for a period',
    icon: <TrendUpIcon />,
    accent: 'emerald',
  },
  {
    href: '/reports/general-ledger',
    title: 'General Ledger',
    desc: 'Drill into entries by account and date range',
    icon: <LedgerIcon />,
    accent: 'slate',
  },
  {
    href: '/reports/cash-flow',
    title: 'Cash Flow',
    desc: 'Operating, investing, and financing cash movements',
    icon: <CashFlowIcon />,
    accent: 'amber',
  },
  {
    href: '/reports/sales-tax',
    title: 'Sales Tax Liability',
    desc: 'Sales tax collected vs. remitted and what you still owe',
    icon: <PercentIcon />,
    accent: 'teal',
  },
  {
    href: '/reports/form-1099',
    title: '1099 Summary',
    desc: 'Contractors paid ≥ $600, W-9 status, and 1099-NEC prep',
    icon: <FormIcon />,
    accent: 'slate',
  },
];

export default async function ReportsIndexPage() {
  await requirePermission('accounting.reports.view');
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Financial statements and analyses</p>
      </header>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => {
          const tone = TONE[r.accent];
          return (
            <Link
              key={r.href}
              href={r.href}
              className={`group relative overflow-hidden rounded-lg border p-4 transition-colors ${tone.card}`}
            >
              <span className={`absolute left-0 top-0 h-full w-1 ${tone.accentBar}`} aria-hidden="true" />
              <div className="flex items-start gap-3 pl-2">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${tone.iconBg} ${tone.iconText}`}>
                  {r.icon}
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.title}</div>
                  <div className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{r.desc}</div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
