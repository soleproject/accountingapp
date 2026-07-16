'use client';

interface PageSize {
  width: number;
  height: number;
}

interface Props {
  url: string;
  targetWidth?: number;
  renderPageOverlay?: (pageIndex: number, size: PageSize) => React.ReactNode;
  onReady?: (pageCount: number) => void;
}

export function PdfCanvas({ onReady }: Props) {
  onReady?.(0);

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-sm text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
      PDF preview is temporarily disabled on Cloudflare staging.
    </div>
  );
}
