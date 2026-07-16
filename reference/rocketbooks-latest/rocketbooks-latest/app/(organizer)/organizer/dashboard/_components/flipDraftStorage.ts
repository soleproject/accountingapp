/**
 * Per-conversation draft persistence for the flip reply editors. An unsent
 * reply (AI-drafted or hand-typed) is saved in localStorage keyed by the
 * message/contact, so it's still there when you reopen the editor and doesn't
 * need to be regenerated. Cleared only when the reply is actually sent.
 */
export interface SavedDraft {
  subject?: string;
  body: string;
}

// v2: a pre-fix build could write a draft under the wrong message's key (the
// editor instance was reused across messages). Bumping the prefix orphans any
// of those bad entries so everyone starts clean.
export const emailDraftKey = (messageId: string) => `rb-draft:v2:email:${messageId}`;
export const textDraftKey = (contactId: string) => `rb-draft:v2:text:${contactId}`;

export function loadDraft(key: string): SavedDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return typeof d?.body === 'string' ? (d as SavedDraft) : null;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, draft: SavedDraft): void {
  if (typeof window === 'undefined') return;
  try {
    // Only persist when there's actual body text; an empty box clears it.
    if (draft.body && draft.body.trim()) {
      window.localStorage.setItem(key, JSON.stringify(draft));
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // localStorage unavailable (private mode / quota) — drafting still works,
    // it just won't persist.
  }
}

export function clearDraft(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
