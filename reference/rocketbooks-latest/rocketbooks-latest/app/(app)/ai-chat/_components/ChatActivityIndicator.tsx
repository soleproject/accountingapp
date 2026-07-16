'use client';

// Sibling visual to ActivityIndicator in VoiceMode.tsx — kept separate intentionally
// so the voice and text surfaces can evolve independently. If you change the look
// here, consider whether the voice indicator should mirror the change.

type ChatActivity = 'idle' | 'thinking' | 'tool' | 'speaking';

interface ChatActivityIndicatorProps {
  activity: ChatActivity;
  label?: string;
}

export function ChatActivityIndicator({ activity, label = '' }: ChatActivityIndicatorProps) {
  if (activity === 'idle') return null;

  const config = {
    thinking: {
      icon: '💭',
      text: 'Thinking…',
      color:
        'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200',
    },
    tool: {
      icon: '⚙',
      text: label || 'Running tool…',
      color:
        'border-purple-300 bg-purple-50 text-purple-900 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-200',
    },
    speaking: {
      icon: '💬',
      text: 'Speaking…',
      color:
        'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200',
    },
  }[activity];

  return (
    <div className={`mx-4 flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${config.color}`}>
      <span className="text-base">{config.icon}</span>
      <span>{config.text}</span>
      <span className="ml-auto flex gap-1">
        <span className="h-2 w-2 animate-pulse rounded-full bg-current opacity-50" style={{ animationDelay: '0ms' }} />
        <span className="h-2 w-2 animate-pulse rounded-full bg-current opacity-50" style={{ animationDelay: '150ms' }} />
        <span className="h-2 w-2 animate-pulse rounded-full bg-current opacity-50" style={{ animationDelay: '300ms' }} />
      </span>
    </div>
  );
}
