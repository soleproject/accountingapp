interface Props {
  href: string;
  label?: string;
  /**
   * Disable the link and show a tooltip. Used during the self-serve demo
   * trial -- the org can view reports but can't print/download them. The
   * server route additionally returns 403, so deep-linking the PDF URL
   * directly is also blocked.
   */
  disabled?: boolean;
}

export function ExportPdfButton({ href, label = 'Export PDF', disabled = false }: Props) {
  if (disabled) {
    return (
      <span
        aria-disabled
        title="PDF export is disabled during the demo trial. Upgrade to enable."
        className="cursor-not-allowed rounded-md border border-zinc-200 bg-zinc-100 px-3 py-1 text-sm font-medium text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500"
      >
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
    >
      {label}
    </a>
  );
}
