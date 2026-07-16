'use client';

import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';

interface Props {
  /** Initial HTML. Only read on mount; later updates aren't reflected
   *  to keep the editor uncontrolled w.r.t. parent re-renders. */
  initial?: string;
  /** Fires on every keystroke with the current HTML body. */
  onChange: (html: string) => void;
}

/**
 * Tiptap-backed WYSIWYG for the manual-email composer.
 *
 * Outputs HTML; the server action derives a plain-text fallback before
 * sending so every email carries both representations. We deliberately
 * keep the toolbar small (bold/italic/headings/lists/link) — anything
 * more elaborate belongs in Phase 2 once we know what people actually
 * reach for.
 */
export function EmailBodyEditor({ initial = '', onChange }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({
        // Open links in a new tab when clicked in the recipient's inbox.
        // autolink turns pasted URLs into anchors automatically.
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
      }),
    ],
    content: initial,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          'min-h-[240px] max-h-[480px] overflow-y-auto rounded-b-md border border-t-0 border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 prose prose-sm dark:prose-invert max-w-none',
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  if (!editor) {
    return (
      <div className="min-h-[280px] rounded-md border border-zinc-200 bg-white text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="p-3">Loading editor…</div>
      </div>
    );
  }

  return (
    <div>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const promptForLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', previous ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-t-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
      <Btn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} label="Bold">
        <span className="font-bold">B</span>
      </Btn>
      <Btn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} label="Italic">
        <span className="italic">I</span>
      </Btn>
      <Sep />
      <Btn active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} label="Heading 2">
        H2
      </Btn>
      <Btn active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} label="Heading 3">
        H3
      </Btn>
      <Sep />
      <Btn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} label="Bullet list">
        •
      </Btn>
      <Btn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} label="Numbered list">
        1.
      </Btn>
      <Sep />
      <Btn active={editor.isActive('link')} onClick={promptForLink} label="Link">
        🔗
      </Btn>
      <Btn active={false} onClick={() => editor.chain().focus().unsetLink().run()} label="Remove link" disabled={!editor.isActive('link')}>
        ⛓️‍💥
      </Btn>
      <Sep />
      <Btn active={false} onClick={() => editor.chain().focus().undo().run()} label="Undo" disabled={!editor.can().undo()}>
        ↶
      </Btn>
      <Btn active={false} onClick={() => editor.chain().focus().redo().run()} label="Redo" disabled={!editor.can().redo()}>
        ↷
      </Btn>
    </div>
  );
}

function Btn({
  children,
  onClick,
  active,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`flex h-7 min-w-[28px] items-center justify-center rounded px-2 text-xs transition-colors ${
        active
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
          : 'text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />;
}
