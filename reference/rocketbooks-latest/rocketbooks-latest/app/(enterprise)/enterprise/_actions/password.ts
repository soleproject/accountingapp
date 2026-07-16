'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/session';

const Schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(8, 'New password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Confirm your new password'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'New password and confirmation do not match',
    path: ['confirmPassword'],
  });

export type UpdatePasswordState =
  | { ok: true }
  | { error: string; fieldErrors?: Record<string, string[]> }
  | undefined;

export async function updatePasswordAction(
  _prev: UpdatePasswordState,
  formData: FormData,
): Promise<UpdatePasswordState> {
  const user = await requireSession();
  if (!user.email) return { error: 'Your account has no email on file' };

  const parsed = Schema.safeParse({
    currentPassword: formData.get('currentPassword'),
    newPassword: formData.get('newPassword'),
    confirmPassword: formData.get('confirmPassword'),
  });
  if (!parsed.success) {
    return {
      error: 'Invalid input',
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();

  // Verify the current password before allowing the change. signInWithPassword
  // is the only built-in way to confirm a password without admin keys.
  const verify = await supabase.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.currentPassword,
  });
  if (verify.error) {
    return { error: 'Current password is incorrect' };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.newPassword });
  if (error) return { error: error.message || 'Could not update password' };

  revalidatePath('/enterprise/settings');
  return { ok: true };
}
