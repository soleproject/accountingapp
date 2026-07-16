'use client';

import { useEffect, useRef, useState } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { saveTaskArtifactAction } from '@/app/(organizer)/organizer/tasks/_actions/artifact';
import { saveDocumentAction } from '@/app/(organizer)/organizer/create/_actions/document';
import type { DocBranding } from '@/lib/documents/layout';
import { TaskCanvas, type Artifact, type ArtifactKind } from './TaskCanvas';

interface Props {
  /** Null in the task-less "Create" workspace — task autosave is disabled. */
  taskId: string | null;
  /** When true (Create workspace), autosave to the standalone documents store
   *  instead of task_artifacts. */
  persistDocument?: boolean;
  /** When true (dashboard step canvas), autosave to BOTH the task artifact AND
   *  the standalone documents store, so the draft shows up on the Documents
   *  page and in the attach-document dropdown ("the doc I just created"). */
  mirrorToDocuments?: boolean;
  /** Existing document id when reopening a saved Create doc. */
  initialDocumentId?: string | null;
  /** Assistant page-context title + route (differ between task / create). */
  pageTitle: string;
  route: string;
  /** Server-built grounding payload (plain data). */
  grounding: Record<string, unknown>;
  /** The previously-saved draft for this task/document, if any. */
  initialArtifact: { kind: string; title: string; body: string } | null;
  /** Org branding for the document letterhead. */
  branding: DocBranding;
  /** Optional: notified (debounced) with the live draft body, so a host (the
   *  dashboard doc-step runner) can surface remaining [placeholder] fields. */
  onBodyChange?: (body: string) => void;
}

const VALID_KINDS = new Set<ArtifactKind>(['letter', 'email', 'text', 'resolution', 'deck']);

function normalize(a: Props['initialArtifact']): Artifact | null {
  if (!a || !a.body) return null;
  const kind = (VALID_KINDS.has(a.kind as ArtifactKind) ? a.kind : 'letter') as ArtifactKind;
  return { kind, title: a.title ?? '', body: a.body };
}

const serialize = (a: Artifact | null) => (a ? JSON.stringify([a.kind, a.title, a.body]) : '');
/** Cap the draft echoed into the system prompt so a long letter can't blow the
 *  context budget — revisions still work, the AI just sees a generous prefix. */
const DRAFT_CTX_LIMIT = 4000;

/**
 * Owns the canvas draft and wires it to the assistant:
 *  - registers the `render_artifact` client action (AI → canvas)
 *  - mirrors the LIVE draft into page context as `current_draft` (canvas → AI),
 *    so "make it more formal" / manual edits are visible when the AI revises.
 *
 * Holding the state here (rather than inside TaskCanvas) is what lets a single
 * effect own setPageContext — avoiding two components racing on the one slot.
 */
export function TaskWorkspaceClient({
  taskId,
  persistDocument = false,
  mirrorToDocuments = false,
  initialDocumentId = null,
  pageTitle,
  route,
  grounding,
  initialArtifact,
  branding,
  onBodyChange,
}: Props) {
  const { registerClientAction, setPageContext } = useAssistant();
  const initial = normalize(initialArtifact);
  const [artifact, setArtifact] = useState<Artifact | null>(initial);

  // AI → canvas. generate_artifact returns a render_artifact client action.
  useEffect(() => {
    return registerClientAction('render_artifact', (raw) => {
      const kind = String(raw.kind ?? '') as ArtifactKind;
      const body = typeof raw.body === 'string' ? raw.body : '';
      if (!VALID_KINDS.has(kind) || !body.trim()) return;
      setArtifact({ kind, title: typeof raw.title === 'string' ? raw.title : '', body });
    });
  }, [registerClientAction]);

  // Debounce the draft once: it both feeds page context (so the AI only needs
  // it when a turn is sent — no per-keystroke sidecar re-render) and drives the
  // autosave below. Seeded with the loaded draft so current_draft is present on
  // the very first turn.
  const [draftForCtx, setDraftForCtx] = useState<Artifact | null>(initial);
  useEffect(() => {
    const t = setTimeout(() => setDraftForCtx(artifact), 300);
    return () => clearTimeout(t);
  }, [artifact]);

  // Surface the live body to an optional host (debounced via draftForCtx) so it
  // can recompute remaining [placeholder] fields as the AI fills them in.
  useEffect(() => {
    onBodyChange?.(draftForCtx?.body ?? '');
  }, [draftForCtx, onBodyChange]);

  // Autosave: persist the (debounced) draft whenever it changes from what was
  // last saved. Seeded with the loaded draft so the initial settle is a no-op.
  const lastSaved = useRef<string>(serialize(initial));
  const docIdRef = useRef<string | null>(initialDocumentId);
  useEffect(() => {
    if (!taskId && !persistDocument) return; // nowhere to persist (e.g. legacy)
    if (!draftForCtx || draftForCtx.body.trim() === '') return;
    const key = serialize(draftForCtx);
    if (key === lastSaved.current) return;
    lastSaved.current = key;
    const { kind, title, body } = draftForCtx;
    if (taskId) {
      void saveTaskArtifactAction({ taskId, kind, title, body });
      // Step canvases also mirror the draft into the standalone documents
      // store so it appears on the Documents page and in the attach-document
      // dropdown. Same docIdRef trick keeps it ONE row across autosaves.
      if (mirrorToDocuments) {
        void saveDocumentAction({ id: docIdRef.current, kind, title, body }).then((res) => {
          if (res?.id) docIdRef.current = res.id;
        });
      }
    } else {
      // Standalone Create doc: insert on first save, then keep updating the
      // same row via the returned id.
      void saveDocumentAction({ id: docIdRef.current, kind, title, body }).then((res) => {
        if (res?.id) docIdRef.current = res.id;
      });
    }
  }, [draftForCtx, taskId, persistDocument, mirrorToDocuments]);

  // canvas → AI: register page context (grounding + live draft + capabilities).
  useEffect(() => {
    setPageContext({
      pageId: 'task-workspace',
      pageTitle,
      route,
      data: {
        ...grounding,
        default_signatory: branding.signatoryName
          ? { name: branding.signatoryName, title: branding.signatoryTitle ?? null }
          : null,
        current_draft: draftForCtx
          ? {
              kind: draftForCtx.kind,
              title: draftForCtx.title,
              body: draftForCtx.body.slice(0, DRAFT_CTX_LIMIT),
              truncated: draftForCtx.body.length > DRAFT_CTX_LIMIT,
            }
          : null,
        capabilities: [
          'generate_artifact — draft OR revise an artifact on the canvas: a letter, email, text, resolution, or a slide deck (kind="deck"). For a deck, write the body as slides separated by a line of "---"; each slide is "# Title" + "-" bullets, optional "> " speaker-note lines, and (if the user wants pictures) an "img: <description>" line per slide. You do NOT render images — the user clicks "Generate images" on the canvas; never claim the deck already has images. If page state has current_draft, treat the call as a revision: start from current_draft.body, apply the requested change, and return the FULL updated body. When default_signatory is present, sign letters/resolutions with that name and title unless the user says otherwise.',
          'send_email — send the email on the canvas (email artifacts only). Resolve the recipient (linked contact email, or ask), read the draft back, and send ONLY after explicit confirmation — sending is irreversible.',
          'get_contact_context — pull more recent notes / tasks / appointments / inbox for a linked contact',
          'find_contact — resolve a contact id by name',
          'create_note — save a note for the user',
          'update_task — edit the task title / description / dueDate / priority',
          'complete_task — mark this task done once the work is finished',
        ],
      },
    });
    return () => setPageContext(null);
  }, [setPageContext, pageTitle, route, grounding, draftForCtx, branding]);

  return <TaskCanvas artifact={artifact} onChange={setArtifact} branding={branding} />;
}
