'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  /** Current logo URL (data URL or external URL). null when none set. */
  logoUrl: string | null;
  /** When true, allow uploading. When false (e.g. shared invoice link),
   *  the slot only displays the existing logo. */
  editable?: boolean;
  /** Visual size variant. */
  size?: 'sm' | 'md' | 'lg';
  /** Endpoint to POST/DELETE the logo. Defaults to the org logo route. */
  uploadUrl?: string;
  /** Which logo variant this slot manages (appended as ?slot=). */
  slot?: 'light' | 'dark' | 'icon' | 'iconDark';
  /** Render the upload zone on a dark surface (for previewing white logos). */
  dark?: boolean;
}

/**
 * Drag-and-drop logo slot, Wave-Apps style. Renders the org's logo if set;
 * otherwise renders a dotted upload zone. Clicking opens a file picker.
 * On successful upload, the page refreshes so the new logo appears
 * everywhere it's used.
 */
export function LogoSlot({ logoUrl, editable = true, size = 'md', uploadUrl = '/api/org/logo', slot, dark }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Append the variant slot to the endpoint (e.g. ?slot=dark). The enterprise
  // URL already carries ?enterpriseId, so pick the right separator.
  const endpoint = slot ? `${uploadUrl}${uploadUrl.includes('?') ? '&' : '?'}slot=${slot}` : uploadUrl;

  const sizeClass = {
    sm: 'h-12 w-24',
    md: 'h-16 w-32',
    lg: 'h-20 w-40',
  }[size];

  const upload = (file: File) => {
    setError(null);
    const form = new FormData();
    form.append('file', file);
    startTransition(async () => {
      const res = await fetch(endpoint, { method: 'POST', body: form });
      if (!res.ok) {
        const msg = (await res.json().catch(() => null))?.error;
        setError(msg ?? 'Upload failed');
        return;
      }
      router.refresh();
    });
  };

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(endpoint, { method: 'DELETE' });
      if (!res.ok) {
        setError('Remove failed');
        return;
      }
      router.refresh();
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(file);
    e.currentTarget.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!editable) return;
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  };

  if (logoUrl) {
    return (
      <div className="flex flex-col items-start gap-1">
        {/* Note: data URLs and arbitrary external URLs aren't whitelisted by
            next/image; using a plain <img> avoids that gauntlet. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt="Business logo"
          className={`${sizeClass} object-contain ${dark ? 'rounded-md bg-zinc-900 p-1' : ''}`}
        />
        {editable && (
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={pending}
              className="text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
            >
              Replace
            </button>
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
            <button
              type="button"
              onClick={remove}
              disabled={pending}
              className="text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
            >
              Remove
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={onChange}
          className="hidden"
        />
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  if (!editable) {
    // No logo + read-only context → render nothing so the layout collapses.
    return null;
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        disabled={pending}
        className={`${sizeClass} flex flex-col items-center justify-center rounded-md border-2 border-dashed text-center text-[11px] transition-colors disabled:opacity-50 ${
          dragOver
            ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/20 dark:text-blue-300'
            : dark
              ? 'border-zinc-600 bg-zinc-800 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-700'
              : 'border-zinc-300 bg-zinc-50 text-zinc-500 hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:bg-zinc-800'
        }`}
      >
        {pending ? (
          'Uploading…'
        ) : (
          <>
            <span className="font-medium">Drop logo</span>
            <span className="text-[10px] opacity-75">or click to upload</span>
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={onChange}
        className="hidden"
      />
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
