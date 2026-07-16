import { logout } from '@/app/(auth)/login/_actions/login';
import { ThemeToggle } from './ThemeToggle';
import { FeedbackButton } from '@/components/feedback/FeedbackButton';

interface Props {
  email: string;
  title?: string;
}

export function AdminTopBar({ email, title }: Props) {
  return (
    <header data-surface="topbar" className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-3 text-sm">
        {title && <span className="font-medium text-zinc-800 dark:text-zinc-200">{title}</span>}
        <span className="text-zinc-500 dark:text-zinc-400">{email}</span>
      </div>
      <div className="flex items-center gap-3">
        <FeedbackButton />
        <ThemeToggle />
        <form action={logout}>
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
