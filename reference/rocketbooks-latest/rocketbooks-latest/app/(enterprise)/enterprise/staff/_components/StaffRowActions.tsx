'use client';

import {
  archiveEnterpriseStaffAction,
  restoreEnterpriseStaffAction,
  deleteEnterpriseStaffAction,
} from '../../_actions/staff';

interface Props {
  staffId: string;
  archived: boolean;
  name: string;
}

export function StaffRowActions({ staffId, archived, name }: Props) {
  return (
    <div className="flex items-center justify-end gap-2">
      <form action={archived ? restoreEnterpriseStaffAction : archiveEnterpriseStaffAction}>
        <input type="hidden" name="staffId" value={staffId} />
        <button
          type="submit"
          className={
            archived
              ? 'rounded-md border border-emerald-300 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40'
              : 'rounded-md border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40'
          }
        >
          {archived ? 'Restore' : 'Archive'}
        </button>
      </form>
      <form
        action={deleteEnterpriseStaffAction}
        onSubmit={(e) => {
          if (!window.confirm(`Permanently remove ${name} from this firm? This can't be undone.`)) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="staffId" value={staffId} />
        <button
          type="submit"
          className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          Delete
        </button>
      </form>
    </div>
  );
}
