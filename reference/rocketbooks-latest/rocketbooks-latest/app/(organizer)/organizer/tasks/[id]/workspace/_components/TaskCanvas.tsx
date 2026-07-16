'use client';

import { Fragment, useEffect, useState } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { type DocBranding, type DocKind, contactLine, isSerif, usesLetterhead } from '@/lib/documents/layout';
import { parseDeck, withImageUrls, DECK_THEMES, getTheme, hash } from '@/lib/documents/deck';
import { generateDeckImagesAction } from '@/app/(organizer)/organizer/create/_actions/images';

type CanvasView = 'edit' | 'preview' | 'pdf';

/** The artifact kinds the workspace can produce in Phase 1. Each is text the
 *  canvas renders + the user can edit. No PowerPoint/PDF yet (later phases). */
export type ArtifactKind = 'letter' | 'email' | 'text' | 'resolution' | 'deck';

export const ARTIFACT_KINDS: { kind: ArtifactKind; label: string }[] = [
  { kind: 'letter', label: 'Letter' },
  { kind: 'email', label: 'Email' },
  { kind: 'text', label: 'Text' },
  { kind: 'resolution', label: 'Resolution' },
  { kind: 'deck', label: 'Deck' },
];

export interface Artifact {
  kind: ArtifactKind;
  title: string;
  body: string;
}

// --- Tiny, dependency-free markdown renderer ------------------------------
// Handles the small subset the assistant emits for letters/emails: headings
// (#, ##), unordered bullets (-, *), bold (**…**), and paragraphs. Builds
// React nodes directly — no dangerouslySetInnerHTML, so no injection surface.

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={`${keyBase}-b${i}`}>{p.slice(2, -2)}</strong>;
    }
    return <Fragment key={`${keyBase}-t${i}`}>{p}</Fragment>;
  });
}

function renderMarkdown(src: string): React.ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = () => {
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
      flushBullets();
      blocks.push(
        <h2 key={`h-${idx}`} className="mb-1 mt-3 text-base font-semibold">
          {renderInline(line.replace(/^#\s+/, ''), `h-${idx}`)}
        </h2>,
      );
    } else if (/^##\s+/.test(line)) {
      flushBullets();
      blocks.push(
        <h3 key={`h-${idx}`} className="mb-1 mt-2 text-sm font-semibold">
          {renderInline(line.replace(/^##\s+/, ''), `h-${idx}`)}
        </h3>,
      );
    } else if (/^[-*]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*]\s+/, ''));
    } else if (line.trim() === '') {
      flushBullets();
    } else {
      flushBullets();
      blocks.push(
        <p key={`p-${idx}`} className="my-2 leading-relaxed">
          {renderInline(line, `p-${idx}`)}
        </p>,
      );
    }
  });
  flushBullets();
  return blocks;
}

// --- Export helpers (zero-dependency, browser-native) ---------------------
// Phase 2: download as Markdown/text, open in Word (.doc HTML), or print to
// PDF via a print window. No vendor libs — matches the "keep features cheap"
// rule; a real .docx/jsPDF path can come later if needed.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineHtml(line: string): string {
  // Escape first, then turn the surviving **markers** into <strong>.
  return escapeHtml(line).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** Mirror of renderMarkdown that emits an HTML string (for Word/print). */
function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    out.push(`<ul>${bullets.map((b) => `<li>${inlineHtml(b)}</li>`).join('')}</ul>`);
    bullets = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^#\s+/.test(line)) {
      flush();
      out.push(`<h2>${inlineHtml(line.replace(/^#\s+/, ''))}</h2>`);
    } else if (/^##\s+/.test(line)) {
      flush();
      out.push(`<h3>${inlineHtml(line.replace(/^##\s+/, ''))}</h3>`);
    } else if (/^[-*]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*]\s+/, ''));
    } else if (line.trim() === '') {
      flush();
    } else {
      flush();
      out.push(`<p>${inlineHtml(line)}</p>`);
    }
  }
  flush();
  return out.join('\n');
}

function safeFilename(title: string, fallback: string): string {
  const base = title.trim() || fallback;
  return base.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || fallback;
}

function downloadBlob(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/** Branded letterhead as an HTML string (Word/print). Empty when there's no
 *  branding to show. Logo renders as an <img>; falls back to text if absent. */
function letterheadHtml(b: DocBranding): string {
  const logo = b.logoUrl
    ? `<img src='${escapeAttr(b.logoUrl)}' alt='' style='max-height:54px;max-width:200px;display:block;margin:0 auto 8px' />`
    : '';
  const name = b.orgName ? `<div style='font-size:18px;font-weight:700;letter-spacing:.5px'>${escapeHtml(b.orgName)}</div>` : '';
  const addr = b.addressLines.length
    ? `<div style='font-size:11px;color:#555'>${b.addressLines.map(escapeHtml).join('  ·  ')}</div>`
    : '';
  const contact = contactLine(b);
  const contactHtml = contact ? `<div style='font-size:11px;color:#555'>${escapeHtml(contact)}</div>` : '';
  if (!logo && !name && !addr && !contactHtml) return '';
  return `<header style='text-align:center;border-bottom:2px solid #222;padding-bottom:10px;margin-bottom:22px'>${logo}${name}${addr}${contactHtml}</header>`;
}

/** A standalone, branded HTML doc wrapping the artifact — used for both Word
 *  export and the Print/PDF window. Letters/resolutions get serif + letterhead. */
function artifactHtmlDoc(kind: DocKind, title: string, body: string, branding: DocBranding, forPrint: boolean): string {
  const serif = isSerif(kind);
  const family = serif
    ? "'Times New Roman', Times, Georgia, serif"
    : "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
  const styles =
    `body{font-family:${family};font-size:13px;line-height:1.6;color:#111;` +
    (forPrint ? 'max-width:680px;margin:40px auto;padding:0 24px}' : 'margin:24px}') +
    `h1{font-size:${serif ? '20' : '18'}px;text-align:${serif ? 'center' : 'left'};margin:0 0 16px}` +
    'h2{font-size:15px}h3{font-size:13px}ul{padding-left:20px}p{margin:10px 0}';
  const lh = usesLetterhead(kind) && branding.showLetterhead ? letterheadHtml(branding) : '';
  const heading = title ? `<h1>${escapeHtml(title)}</h1>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title || 'Document')}</title><style>${styles}</style></head><body>${lh}${heading}${markdownToHtml(body)}</body></html>`;
}

// --- Branded preview (React) ----------------------------------------------

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

function DocumentPreview({
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
  const serif = isSerif(kind);
  return (
    <article
      className={`mx-auto max-w-[680px] text-sm text-zinc-800 dark:text-zinc-200 ${serif ? 'font-serif' : ''}`}
    >
      {usesLetterhead(kind) && branding.showLetterhead && <PreviewLetterhead branding={branding} />}
      {title && (
        <h1 className={`mb-3 text-lg font-bold ${serif ? 'text-center' : ''}`}>{title}</h1>
      )}
      {renderMarkdown(body)}
    </article>
  );
}

/** Slide-card preview for decks, themed to match the .pptx export. */
function DeckPreview({ body, themeKey }: { body: string; themeKey: string }) {
  const slides = parseDeck(body);
  const theme = getTheme(themeKey);
  if (slides.length === 0) {
    return <p className="text-center text-sm text-zinc-400">No slides yet — start with “# Slide title” and bullets.</p>;
  }
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4">
      {slides.map((s, i) => {
        const img = s.imageUrl;
        return (
          <div
            key={i}
            className="overflow-hidden rounded-xl border border-zinc-200 shadow-sm dark:border-zinc-700"
            style={{ aspectRatio: '16 / 9', backgroundColor: hash(theme.bg) }}
          >
            <div className="h-1.5 w-full" style={{ backgroundColor: hash(theme.accent) }} />
            <div className="flex h-[calc(100%-0.375rem)] flex-col p-5">
              <div className="text-lg font-bold" style={{ color: hash(theme.title) }}>
                {s.title}
              </div>
              <div className="mt-3 flex flex-1 gap-4 overflow-hidden">
                <div className={img ? 'w-1/2' : 'w-full'}>
                  {s.bullets.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: hash(theme.text) }}>
                      {s.bullets.map((b, j) => (
                        <li key={j}>{b}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {s.imagePrompt && (
                  <div className="flex w-1/2 items-center justify-center">
                    {img ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img} alt="" className="max-h-full max-w-full rounded-md object-contain" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center rounded-md border border-dashed border-current/30 p-2 text-center text-[11px] opacity-50" style={{ color: hash(theme.text) }}>
                        🖼 {s.imagePrompt}
                        <br />
                        <span className="italic">(use the image button above)</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {s.notes.trim() && (
                <div className="mt-2 border-t border-black/10 pt-2 text-[11px] italic opacity-70" style={{ color: hash(theme.text) }}>
                  Notes: {s.notes}
                </div>
              )}
              <div className="mt-1 text-right text-[10px]" style={{ color: hash(theme.text), opacity: 0.5 }}>
                {i + 1} / {slides.length}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  /** Controlled artifact — owned by TaskWorkspaceClient so the live draft can
   *  be mirrored into the assistant's page context for AI revisions. */
  artifact: Artifact | null;
  onChange: (next: Artifact) => void;
  /** Org branding for the document letterhead (preview / Word / PDF). */
  branding: DocBranding;
}

/**
 * The open canvas (controlled). Renders the current artifact and lets the user
 * switch kind, edit raw text, preview, export, or ask the AI to refine it. The
 * AI fills/revises it via the `render_artifact` client action registered by the
 * parent; the user can always take over by typing.
 */
export function TaskCanvas({ artifact, onChange, branding }: Props) {
  const { seedPrompt, requestSidecarOpen, requestMicOn } = useAssistant();
  const [view, setView] = useState<CanvasView>('preview');
  const [copied, setCopied] = useState(false);
  const [pdf, setPdf] = useState<{ url: string; pages: number } | null>(null);
  const [pdfError, setPdfError] = useState(false);
  const [themeKey, setThemeKey] = useState('classic'); // deck theme (local, not persisted)
  const [imgSource, setImgSource] = useState<'ai' | 'stock'>('ai');
  const [imgQuality, setImgQuality] = useState<'low' | 'medium' | 'high'>('low');
  const [pptxBusy, setPptxBusy] = useState(false);
  const [imgBusy, setImgBusy] = useState(false);

  const kind = artifact?.kind ?? 'letter';
  const body = artifact?.body ?? '';
  const title = artifact?.title ?? '';

  // Lazily build a real text PDF (jsPDF) only while the PDF view is open, and
  // rebuild it when the content changes. The blob URL is revoked on cleanup so
  // we don't leak object URLs as the user iterates.
  useEffect(() => {
    if (view !== 'pdf' || kind === 'deck' || body.trim().length === 0) return;
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const { buildArtifactPdf } = await import('./buildArtifactPdf');
        const { blob, pages } = await buildArtifactPdf(kind, title, body, branding);
        if (cancelled) return;
        setPdfError(false);
        url = URL.createObjectURL(blob);
        setPdf({ url, pages });
      } catch {
        if (!cancelled) setPdfError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setPdf(null); // clear so re-entering PDF view shows "Building…" not a revoked URL
    };
  }, [view, kind, title, body, branding]);

  const update = (patch: Partial<Artifact>) =>
    onChange({
      kind: artifact?.kind ?? 'letter',
      title: artifact?.title ?? '',
      body: artifact?.body ?? '',
      ...patch,
    });

  // Ask the AI to revise the current draft. The live draft already rides along
  // in the page context (current_draft), so the seed just tells the AI to wait
  // for the user's change request and return the FULL revised body.
  const refine = () => {
    requestSidecarOpen('side');
    seedPrompt(
      'The user wants to revise the draft currently on the canvas (it is in your page state as `current_draft`). ' +
        'In ONE short line, ask what they want changed. When they tell you, call generate_artifact with the FULL revised body — ' +
        "start from current_draft.body and apply only their requested change; do not drop content they didn't ask to touch.",
      { mode: 'side', hidden: true },
    );
    requestMicOn();
  };

  // Send the email currently on the canvas via the assistant's send_email tool.
  // Routed through the AI so it resolves the recipient and reads the draft back
  // for explicit confirmation before the (irreversible) send.
  const send = () => {
    requestSidecarOpen('side');
    seedPrompt(
      'The user wants to SEND the email currently on the canvas (it is in your page state as `current_draft`). ' +
        'Determine the recipient: if a linked contact in page state has an email, use it; otherwise ask who to send it to. ' +
        'Use current_draft.title as the subject and current_draft.body as the body. ' +
        'Read the recipient, subject, and a one-line summary back and ask the user to confirm. ' +
        'ONLY after they confirm, call send_email(to, subject, body). After it succeeds, tell them it was sent. Sending is irreversible — never send without an explicit yes.',
      { mode: 'side', hidden: true },
    );
    requestMicOn();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  const fileBase = safeFilename(title, kind);

  const downloadMarkdown = () => downloadBlob(`${fileBase}.md`, 'text/markdown;charset=utf-8', body);

  const downloadWord = () =>
    downloadBlob(`${fileBase}.doc`, 'application/msword', artifactHtmlDoc(kind, title, body, branding, false));

  const downloadPptx = async () => {
    setPptxBusy(true);
    try {
      const { buildDeckPptx } = await import('./buildDeckPptx');
      const blob = await buildDeckPptx(parseDeck(body), getTheme(themeKey));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileBase}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* export failed — no-op; user can retry */
    } finally {
      setPptxBusy(false);
    }
  };

  // Generate one image per slide that has an `img:` prompt, then keep them in
  // state so the preview shows them and the .pptx embeds them. Explicit (and
  // costed) — only runs on the button click.
  const generateImages = async () => {
    const prompts = Array.from(
      new Set(parseDeck(body).map((s) => s.imagePrompt).filter((p): p is string => !!p)),
    );
    if (prompts.length === 0) return;
    setImgBusy(true);
    try {
      const results = await generateDeckImagesAction({ prompts, source: imgSource, quality: imgQuality });
      const urlByPrompt: Record<string, string> = {};
      for (const r of results) if (r.url) urlByPrompt[r.prompt] = r.url;
      if (Object.keys(urlByPrompt).length > 0) {
        // Write the URLs back into the body (imgsrc: lines) → autosaves, so the
        // images persist with the deck and reload without regenerating.
        update({ body: withImageUrls(body, urlByPrompt) });
      }
    } catch {
      /* generation failed — no-op; user can retry */
    } finally {
      setImgBusy(false);
    }
  };

  const printPdf = () => {
    const w = window.open('', '_blank', 'width=800,height=900');
    if (!w) return; // popup blocked — user can use Download instead
    w.document.write(artifactHtmlDoc(kind, title, body, branding, true));
    w.document.close();
    w.focus();
    // Let the new document lay out before invoking the print dialog.
    w.onload = () => w.print();
    // Fallback for browsers that finish writing before onload binds.
    if (w.document.readyState === 'complete') w.print();
  };

  const isEmpty = body.trim().length === 0;
  const hasImagePrompts = kind === 'deck' && parseDeck(body).some((s) => !!s.imagePrompt);

  return (
    <section className="flex min-h-[60vh] flex-col rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-1">
          {ARTIFACT_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              onClick={() => update({ kind: k.kind })}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                kind === k.kind
                  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={refine}
            disabled={isEmpty}
            title="Ask the assistant to revise this draft"
            className="rounded-md px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
          >
            Refine with AI
          </button>
          {kind === 'email' && (
            <button
              type="button"
              onClick={send}
              disabled={isEmpty}
              title="Send this email (the assistant confirms the recipient first)"
              className="rounded-md px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
            >
              Send
            </button>
          )}
          <div className="flex items-center rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800">
            {(kind === 'deck' ? (['edit', 'preview'] as const) : (['edit', 'preview', 'pdf'] as const)).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded px-2 py-0.5 text-xs font-medium capitalize transition-colors ${
                  view === v
                    ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                {v === 'pdf' ? 'PDF' : v}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={copy}
            disabled={isEmpty}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <span className="mx-0.5 h-4 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />
          <button
            type="button"
            onClick={downloadMarkdown}
            disabled={isEmpty}
            title="Download as Markdown (.md)"
            className="rounded-md px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            .md
          </button>
          {kind !== 'deck' && (
            <>
              <button
                type="button"
                onClick={downloadWord}
                disabled={isEmpty}
                title="Open in Word (.doc)"
                className="rounded-md px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Word
              </button>
              <button
                type="button"
                onClick={printPdf}
                disabled={isEmpty}
                title="Print or save as PDF"
                className="rounded-md px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Print / PDF
              </button>
            </>
          )}
          {kind === 'deck' && (
            <>
              <select
                value={themeKey}
                onChange={(e) => setThemeKey(e.target.value)}
                title="Slide theme"
                className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
              >
                {DECK_THEMES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
              {hasImagePrompts && (
                <>
                  <select
                    value={imgSource}
                    onChange={(e) => setImgSource(e.target.value as 'ai' | 'stock')}
                    title="Image source"
                    className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
                  >
                    <option value="ai">AI images</option>
                    <option value="stock">Stock (free)</option>
                  </select>
                  {imgSource === 'ai' && (
                    <select
                      value={imgQuality}
                      onChange={(e) => setImgQuality(e.target.value as 'low' | 'medium' | 'high')}
                      title="AI image quality (affects cost)"
                      className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
                    >
                      <option value="low">Low (~$0.02)</option>
                      <option value="medium">Medium (~$0.06)</option>
                      <option value="high">High (~$0.25)</option>
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={generateImages}
                    disabled={imgBusy}
                    title={imgSource === 'stock' ? 'Find a free stock photo for each slide' : 'Generate an AI image for each slide'}
                    className="rounded-md px-2.5 py-1 text-xs font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-40 dark:text-violet-300 dark:hover:bg-violet-950/40"
                  >
                    {imgBusy ? (imgSource === 'stock' ? 'Finding…' : 'Generating…') : imgSource === 'stock' ? 'Find images' : 'Generate images'}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={downloadPptx}
                disabled={isEmpty || pptxBusy}
                title="Download as PowerPoint (.pptx)"
                className="rounded-md px-2.5 py-1 text-xs font-medium text-orange-600 hover:bg-orange-50 disabled:opacity-40 dark:text-orange-300 dark:hover:bg-orange-950/40"
              >
                {pptxBusy ? 'Building…' : '.pptx'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Title */}
      <div className="border-b border-zinc-100 px-4 py-2 dark:border-zinc-800">
        <input
          value={title}
          onChange={(e) => update({ title: e.target.value })}
          placeholder="Untitled draft"
          className="w-full bg-transparent text-sm font-medium text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-200"
        />
      </div>

      {/* Body: edit (textarea) ⇄ preview (rendered) ⇄ pdf (embedded) */}
      <div className="flex-1 p-4">
        {view === 'edit' ? (
          <textarea
            value={body}
            onChange={(e) => update({ body: e.target.value })}
            placeholder="Start writing, or ask the assistant to draft this for you…"
            className="h-full min-h-[48vh] w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-200"
          />
        ) : isEmpty ? (
          <div className="flex min-h-[48vh] items-center justify-center text-center">
            <p className="max-w-sm text-sm text-zinc-400">
              This is your canvas. Ask the assistant to draft this task — a letter, email, text, or
              resolution — or click <span className="font-medium">Edit</span> to write it yourself.
            </p>
          </div>
        ) : view === 'pdf' ? (
          pdfError ? (
            <div className="flex min-h-[48vh] items-center justify-center text-center">
              <p className="max-w-sm text-sm text-rose-500">
                Couldn’t build the PDF preview. Try <span className="font-medium">Print / PDF</span>{' '}
                instead.
              </p>
            </div>
          ) : pdf ? (
            <iframe
              src={`${pdf.url}#zoom=100`}
              title="PDF preview"
              // Size the frame to the whole document (≈1056px per US-Letter page
              // at 100% + the viewer's chrome) so the full doc shows at 100%
              // and the page — not a cramped inner box — does the scrolling.
              style={{ height: `${pdf.pages * 1056 + 96}px` }}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800"
            />
          ) : (
            <div className="flex min-h-[48vh] items-center justify-center text-center">
              <p className="text-sm text-zinc-400">Building PDF…</p>
            </div>
          )
        ) : kind === 'deck' ? (
          <DeckPreview body={body} themeKey={themeKey} />
        ) : (
          <DocumentPreview kind={kind} title={title} body={body} branding={branding} />
        )}
      </div>
    </section>
  );
}
