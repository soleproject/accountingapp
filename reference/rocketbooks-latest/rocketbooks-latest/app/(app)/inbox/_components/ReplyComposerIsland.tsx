'use client';

import dynamic from 'next/dynamic';

const ReplyComposer = dynamic(
  () => import('./ReplyComposer').then((mod) => mod.ReplyComposer),
  {
    ssr: false,
    loading: () => (
      <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        Loading reply editor…
      </div>
    ),
  },
);

interface Props {
  messageId: string;
  initialSubject: string;
  initialHtml: string;
  toAddress: string;
  mayNotShowInSent: boolean;
}

export function ReplyComposerIsland(props: Props) {
  return <ReplyComposer {...props} />;
}
