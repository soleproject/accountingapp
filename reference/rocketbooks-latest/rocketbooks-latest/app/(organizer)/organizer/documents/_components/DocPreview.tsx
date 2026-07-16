'use client';

import { Fragment } from 'react';
import { type DocBranding, type DocKind, contactLine, isSerif, usesLetterhead } from '@/lib/documents/layout';
import { parseDeck, getTheme, hash } from '@/lib/documents/deck';

// Read-only mirror of the Create canvas preview. Same tiny, dependency-free
// markdown subset the assistant emits (headings, bullets, bold, paragraphs);
// builds React nodes directly so there's no dangerouslySetInnerHTML surface.

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? (
      <strong key={`${keyBase}-b${i}`}>{p.slice(2, -2)}</strong>
    ) : (
      <Fragment key={`${keyBase}-t${i}`}>{p}</Fragment>
    ),
  );
}

function renderMarkdown(src: string): React.ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-2 list-disc space-y-1 pl-5">
        {items.map((b, i) => (
          <li key={i}>{renderInline(b, `li-${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (/^#\s+/.test(line)) {
      flush();
      blocks.push(
        <h2 key={`h-${idx}`} className="mb-1 mt-3 text-base font-semibold">
          {renderInline(line.replace(/^#\s+/, ''), `h-${idx}`)}
        </h2>,
      );
    } else if (/^##\s+/.test(line)) {
      flush();
      blocks.push(
        <h3 key={`h-${idx}`} className="mb-1 mt-2 text-sm font-semibold">
          {renderInline(line.replace(/^##\s+/, ''), `h-${idx}`)}
        </h3>,
      );
    } else if (/^[-*]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*]\s+/, ''));
    } else if (line.trim() === '') {
      flush();
    } else {
      flush();
      blocks.push(
        <p key={`p-${idx}`} className="my-2 leading-relaxed">
          {renderInline(line, `p-${idx}`)}
        </p>,
      );
    }
  });
  flush();
  return blocks;
}

function PreviewLetterhead({ branding }: { branding: DocBranding }) {
  const contact = contactLine(branding);
  if (!branding.logoUrl && !branding.orgName && branding.addressLines.length === 0 && !contact) return null;
  return (
    <header className="mb-5 border-b-2 border-zinc-800 pb-3 text-center dark:border-zinc-300">
      {branding.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={branding.logoUrl} alt="" className="mx-auto mb-2 max-h-14 max-w-[200px] object-contain" />
      )}
      {branding.orgName && <div className="text-lg font-bold tracking-wide text-zinc-900 dark:text-zinc-100">{branding.orgName}</div>}
      {branding.addressLines.length > 0 && (
        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{branding.addressLines.join('  ·  ')}</div>
      )}
      {contact && <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{contact}</div>}
    </header>
  );
}

function DeckPreview({ body }: { body: string }) {
  const slides = parseDeck(body);
  const theme = getTheme('classic');
  if (slides.length === 0) return <p className="text-center text-sm text-zinc-400">No slides.</p>;
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4">
      {slides.map((s, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-xl border border-zinc-200 shadow-sm dark:border-zinc-700"
          style={{ aspectRatio: '16 / 9', backgroundColor: hash(theme.bg) }}
        >
          <div className="h-1.5 w-full" style={{ backgroundColor: hash(theme.accent) }} />
          <div className="flex h-[calc(100%-0.375rem)] flex-col p-5">
            <div className="text-lg font-bold" style={{ color: hash(theme.title) }}>{s.title}</div>
            <div className="mt-3 flex flex-1 gap-4 overflow-hidden">
              <div className={s.imageUrl ? 'w-1/2' : 'w-full'}>
                {s.bullets.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: hash(theme.text) }}>
                    {s.bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                )}
              </div>
              {s.imageUrl && (
                <div className="flex w-1/2 items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.imageUrl} alt="" className="max-h-full max-w-full rounded-md object-contain" />
                </div>
              )}
            </div>
            <div className="mt-1 text-right text-[10px]" style={{ color: hash(theme.text), opacity: 0.5 }}>
              {i + 1} / {slides.length}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Read-only render of a created document (or deck) for the view page. */
export function DocPreview({
  kind,
  title,
  body,
  branding,
}: {
  kind: DocKind;
  title: string;
  body: string;
  branding: DocBranding;
}) {
  if (kind === 'deck') return <DeckPreview body={body} />;
  const serif = isSerif(kind);
  return (
    <article className={`mx-auto max-w-[680px] text-sm text-zinc-800 dark:text-zinc-200 ${serif ? 'font-serif' : ''}`}>
      {usesLetterhead(kind) && branding.showLetterhead && <PreviewLetterhead branding={branding} />}
      {title && <h1 className={`mb-3 text-lg font-bold ${serif ? 'text-center' : ''}`}>{title}</h1>}
      {renderMarkdown(body)}
    </article>
  );
}
