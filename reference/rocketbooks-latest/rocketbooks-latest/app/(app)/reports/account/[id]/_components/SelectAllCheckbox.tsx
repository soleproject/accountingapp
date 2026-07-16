'use client';

import { useEffect, useRef } from 'react';

/**
 * Header checkbox that toggles every row checkbox bound to the same `form`
 * attribute (matches by `input[type="checkbox"][form=<formId>]`). Listens for
 * row changes so the master reflects all/some/none with an indeterminate
 * state in the "some" case.
 */
export function SelectAllCheckbox({ formId }: { formId: string }) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const master = ref.current;
    if (!master) return;

    const getBoxes = (): HTMLInputElement[] =>
      Array.from(
        document.querySelectorAll<HTMLInputElement>(
          `input[type="checkbox"][form="${formId}"]`,
        ),
      );

    const sync = () => {
      const boxes = getBoxes();
      const checked = boxes.filter((b) => b.checked).length;
      master.checked = boxes.length > 0 && checked === boxes.length;
      master.indeterminate = checked > 0 && checked < boxes.length;
    };

    const onChange = (e: Event) => {
      const t = e.target as HTMLInputElement | null;
      if (
        t &&
        t.type === 'checkbox' &&
        t !== master &&
        t.getAttribute('form') === formId
      ) {
        sync();
      }
    };

    document.addEventListener('change', onChange);
    sync();
    return () => document.removeEventListener('change', onChange);
  }, [formId]);

  const onMasterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.currentTarget.checked;
    document
      .querySelectorAll<HTMLInputElement>(
        `input[type="checkbox"][form="${formId}"]`,
      )
      .forEach((b) => {
        b.checked = checked;
      });
  };

  return (
    <input
      ref={ref}
      type="checkbox"
      onChange={onMasterChange}
      className="h-4 w-4"
      title="Select all"
      aria-label="Select all rows"
    />
  );
}
