'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * "Select all" header checkbox for the contacts table. Mirrors the state
 * of every row checkbox (input[name="contactIds"]) on the current page:
 *   - Empty → unchecked
 *   - All checked → checked
 *   - Mix → indeterminate (visual dash)
 *
 * Clicking toggles all rows. We dispatch synthetic change events on each
 * row checkbox so the MergeBar's listener picks up the new selection
 * (it watches `change` events on the document).
 */
export function SelectAll() {
  const ref = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'unchecked' | 'checked' | 'indeterminate'>('unchecked');

  useEffect(() => {
    const sync = () => {
      const boxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[name="contactIds"]'),
      );
      if (boxes.length === 0) {
        setState('unchecked');
        return;
      }
      const checked = boxes.filter((b) => b.checked).length;
      if (checked === 0) setState('unchecked');
      else if (checked === boxes.length) setState('checked');
      else setState('indeterminate');
    };
    document.addEventListener('change', sync);
    sync();
    return () => document.removeEventListener('change', sync);
  }, []);

  // The DOM `indeterminate` flag isn't a React-controlled prop — set it
  // imperatively on every render that would change it.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'indeterminate';
  }, [state]);

  const toggle = () => {
    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="contactIds"]'),
    );
    if (boxes.length === 0) return;
    // If everything is checked, uncheck. Otherwise (unchecked or mixed),
    // check everything.
    const shouldCheck = state !== 'checked';
    for (const b of boxes) {
      if (b.checked === shouldCheck) continue;
      b.checked = shouldCheck;
      // Dispatch a real change event so the MergeBar's document-level
      // listener recounts the selection.
      b.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'checked'}
      onChange={toggle}
      aria-label="Select all contacts on this page"
      title={state === 'checked' ? 'Deselect all' : 'Select all on page'}
      className="h-4 w-4 cursor-pointer"
    />
  );
}
