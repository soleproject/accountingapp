'use client';

import { useState } from 'react';

export function PasswordField() {
  const [visible, setVisible] = useState(false);

  return (
    <label className="flex flex-col gap-1.5 text-sm sm:col-span-2">
      <span className="font-medium">Password</span>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          name="password"
          autoComplete="new-password"
          minLength={8}
          placeholder="Leave blank to keep current password"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 pr-20 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      <span className="text-xs text-zinc-500">
        Existing passwords are stored as one-way hashes by Supabase and cannot be revealed. Enter a value here to overwrite the user&apos;s password; leave blank to keep it unchanged. Minimum 8 characters.
      </span>
    </label>
  );
}
