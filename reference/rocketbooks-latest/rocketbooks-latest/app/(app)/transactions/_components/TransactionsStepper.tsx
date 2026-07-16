import Link from 'next/link';

export type StepStatus = 'done' | 'in_progress' | 'not_started';

export interface StepperStep {
  id: string;
  label: string;
  count: number;
  detail: string;
  status: StepStatus;
  href: string;
}

const STATUS_LABEL: Record<StepStatus, string> = {
  done: 'Done',
  in_progress: 'In progress',
  not_started: 'Not started',
};

function nodeClasses(status: StepStatus): string {
  switch (status) {
    case 'done':
      return 'border-emerald-500 bg-emerald-500 text-white';
    case 'in_progress':
      return 'border-indigo-500 bg-indigo-500 text-white dark:border-indigo-400';
    case 'not_started':
    default:
      return 'border-zinc-300 bg-white text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-500';
  }
}

function badgeClasses(status: StepStatus): string {
  switch (status) {
    case 'done':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
    case 'in_progress':
      return 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300';
    case 'not_started':
    default:
      return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  }
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** A horizontal numbered-stepper banner of transaction review milestones. */
export function TransactionsStepper({ steps }: { steps: StepperStep[] }) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <ol className="flex items-start gap-1 overflow-x-auto pb-1">
        {steps.map((step, i) => (
          <li key={step.id} className="relative flex min-w-[8rem] flex-1 flex-col items-center">
            {i < steps.length - 1 && (
              <span
                className="absolute left-1/2 top-6 -mt-px h-0.5 w-full bg-zinc-200 dark:bg-zinc-800"
                aria-hidden="true"
              />
            )}
            <Link
              href={step.href}
              prefetch={false}
              className="group flex w-full flex-col items-center gap-2 rounded-md border border-transparent px-2 pb-2 pt-2 text-center transition-colors hover:border-zinc-200 hover:bg-zinc-50 dark:hover:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <div
                className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold ${nodeClasses(step.status)}`}
              >
                {step.status === 'done' ? <CheckIcon /> : i + 1}
              </div>
              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{step.label}</span>
                  {step.count > 0 && (
                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {step.count > 99 ? '99+' : step.count}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{step.detail}</p>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeClasses(step.status)}`}>
                  {STATUS_LABEL[step.status]}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
