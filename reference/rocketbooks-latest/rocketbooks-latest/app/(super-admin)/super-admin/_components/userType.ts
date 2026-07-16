/**
 * Pure helpers shared by the All Users server page and the client-side
 * AllUsersTable. Plain module — no 'use server' / 'use client' markers —
 * so it can be imported from both sides without crossing the RSC boundary
 * as a function prop (which Next.js refuses to serialize).
 */

export type BadgeTone = 'red' | 'blue' | 'green' | 'amber' | 'zinc';

/**
 * Resolve the user type label shown in the User Type column.
 * Prefers the assigned permission set name; otherwise maps users.role to
 * the closest canonical type name from the permission-set dropdown.
 */
export function userTypeLabel(permSetName: string | null, role: string | null): string {
  if (permSetName) return permSetName;
  const map: Record<string, string> = {
    super_admin: 'Super Admin',
    superadmin: 'Super Admin',
    admin: 'Admin',
    enterprise_owner: 'Enterprise Owner',
    enterprise_staff: 'Enterprise Staff',
    paying_user: 'Paying User',
    client: 'Paying User',
    support_user: 'Support User',
    base_user: 'Base User',
    user: 'Base User',
    investor: 'Investor',
    free_account: 'Free Account',
    free: 'Free Account',
  };
  if (role && map[role]) return map[role];
  if (!role) return '—';
  return role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function userTypeTone(label: string): BadgeTone {
  if (label === 'Super Admin') return 'red';
  if (label === 'Admin') return 'red';
  if (label === 'Paying User') return 'green';
  if (label === 'Support User') return 'amber';
  if (label === 'Investor') return 'blue';
  if (label === 'Free Account') return 'zinc';
  if (label.startsWith('Enterprise')) return 'blue';
  if (label.startsWith('Documents')) return 'blue';
  return 'zinc';
}
