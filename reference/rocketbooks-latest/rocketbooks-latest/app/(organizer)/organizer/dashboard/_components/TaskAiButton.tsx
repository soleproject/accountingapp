'use client';

import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  taskId: string;
  title: string;
  dueDate: string | null;
  priority: string | null;
}

/**
 * Inline AI affordance on each task row. Click → opens the floating
 * sidecar in side mode, seeds a "standing by" prompt scoped to this
 * specific task (with its id so the AI can call complete_task /
 * update_task / delete_task accurately), and flips the mic on so the
 * user can speak the action without typing.
 *
 * The seed deliberately tells the AI NOT to take action yet — it
 * should reply with a short "what would you like to do?" and wait for
 * the user's spoken instruction. Otherwise the AI sees a contextful
 * message and might start guessing.
 */
export function TaskAiButton({ taskId, title, dueDate, priority }: Props) {
  const { requestSidecarOpen, seedPrompt, requestMicOn } = useAssistant();

  const onClick = () => {
    const ctx: string[] = [`task id: ${taskId}`, `title: "${title}"`];
    if (dueDate) ctx.push(`due: ${dueDate}`);
    if (priority) ctx.push(`priority: ${priority}`);
    const opener =
      `I want to do something with a task. Don't take any action yet — wait for me to tell you what. ` +
      `Context for the task: ${ctx.join(', ')}. ` +
      `When I tell you what I want (edit, change date, set priority, add detail, reassign, mark complete, delete), ` +
      `use the appropriate tool (update_task / complete_task / delete_task or whatever fits). ` +
      `For now, reply with exactly: "Listening — what about this task?"`;
    requestSidecarOpen('side');
    seedPrompt(opener, { mode: 'side' });
    requestMicOn();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Talk to AI about: ${title}`}
      title="Talk to AI about this task"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-violet-600 hover:bg-violet-50 hover:text-violet-700 dark:text-violet-400 dark:hover:bg-violet-950/40 dark:hover:text-violet-300"
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 13l.75 2.25L22 16l-2.25.75L19 19l-.75-2.25L16 16l2.25-.75L19 13z" />
      </svg>
    </button>
  );
}
