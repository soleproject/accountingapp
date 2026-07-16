'use client';

import Link from 'next/link';
import { useState, useMemo, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  bulkAssignEnterpriseAction,
  bulkSetUserPermissionSetAction,
  deactivateUserAction,
  reactivateUserAction,
} from '../_actions/admin';
import { userTypeLabel, userTypeTone, type BadgeTone } from './userType';

interface UserRow {
  id: string;
  email: string;
  fullName: string | null;
  role: string;
  isActive: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
  ownedCount: number;
  supportCount: number;
  enterpriseRoles: string[] | null;
  permissionSetName: string | null;
}

interface PermissionSetOption {
  id: string;
  name: string;
}

interface EnterpriseOption {
  id: string;
  name: string;
}

interface Props {
  rows: UserRow[];
  permissionSets: PermissionSetOption[];
  enterprises?: EnterpriseOption[];
}

const TONE_MAP: Record<BadgeTone, string> = {
  red: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  zinc: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
};

export function AllUsersTable({ rows, permissionSets, enterprises = [] }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPermSetId, setBulkPermSetId] = useState<string>('');
  const [bulkEnterpriseId, setBulkEnterpriseId] = useState<string>('');
  const [bulkEnterpriseKind, setBulkEnterpriseKind] = useState<'client' | 'staff'>('client');
  const [bulkStaffRole, setBulkStaffRole] = useState<string>('staff');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const anyChecked = selected.size > 0;

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      if (rows.every((r) => prev.has(r.id))) {
        // All currently selected → clear them
        const next = new Set(prev);
        for (const r of rows) next.delete(r.id);
        return next;
      }
      const next = new Set(prev);
      for (const r of rows) next.add(r.id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const selectedPermSetLabel = useMemo(() => {
    if (!bulkPermSetId) return '— None —';
    return permissionSets.find((p) => p.id === bulkPermSetId)?.name ?? bulkPermSetId;
  }, [bulkPermSetId, permissionSets]);

  const applyBulk = () => {
    setError(null);
    const fd = new FormData();
    fd.set('permissionSetId', bulkPermSetId);
    for (const id of selected) fd.append('userIds', id);
    startTransition(async () => {
      try {
        await bulkSetUserPermissionSetAction(fd);
        clearSelection();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to update');
      }
    });
  };

  const applyBulkEnterprise = () => {
    setError(null);
    if (!bulkEnterpriseId) {
      setError('Pick an enterprise');
      return;
    }
    const fd = new FormData();
    fd.set('enterpriseId', bulkEnterpriseId);
    fd.set('kind', bulkEnterpriseKind);
    if (bulkEnterpriseKind === 'staff') fd.set('role', bulkStaffRole);
    for (const id of selected) fd.append('userIds', id);
    startTransition(async () => {
      try {
        await bulkAssignEnterpriseAction(fd);
        clearSelection();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to assign enterprise');
      }
    });
  };

  return (
    <>
      {anyChecked && (
        <div className="sticky top-0 z-10 mb-2 flex flex-col gap-2 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm shadow-sm dark:border-blue-800 dark:bg-blue-950/40">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium text-blue-900 dark:text-blue-200">
              {selected.size} selected
            </span>
            <span className="text-blue-800/70 dark:text-blue-300/70">·</span>
            <span className="text-blue-800 dark:text-blue-200">Set User Type to</span>
            <select
              value={bulkPermSetId}
              onChange={(e) => setBulkPermSetId(e.target.value)}
              disabled={pending}
              className="rounded-md border border-blue-300 bg-white px-2 py-1 text-sm dark:border-blue-700 dark:bg-zinc-950"
            >
              <option value="">— None —</option>
              {permissionSets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={applyBulk}
              disabled={pending}
              className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
              title={`Apply "${selectedPermSetLabel}" to ${selected.size} user${selected.size === 1 ? '' : 's'}`}
            >
              {pending ? 'Applying…' : 'Apply'}
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={pending}
              className="text-xs text-blue-800/80 hover:underline dark:text-blue-300/80"
            >
              Clear selection
            </button>
            {error && <span className="ml-2 text-xs text-red-700 dark:text-red-300">{error}</span>}
          </div>

          {enterprises.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-t border-blue-200 pt-2 dark:border-blue-800">
              <span className="text-blue-800 dark:text-blue-200">Assign to Enterprise</span>
              <select
                value={bulkEnterpriseId}
                onChange={(e) => setBulkEnterpriseId(e.target.value)}
                disabled={pending}
                className="rounded-md border border-blue-300 bg-white px-2 py-1 text-sm dark:border-blue-700 dark:bg-zinc-950"
              >
                <option value="">— Select Enterprise —</option>
                {enterprises.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
              <span className="text-blue-800/80 dark:text-blue-300/80">as</span>
              <select
                value={bulkEnterpriseKind}
                onChange={(e) => setBulkEnterpriseKind(e.target.value === 'staff' ? 'staff' : 'client')}
                disabled={pending}
                className="rounded-md border border-blue-300 bg-white px-2 py-1 text-sm dark:border-blue-700 dark:bg-zinc-950"
              >
                <option value="client">Client</option>
                <option value="staff">Staff</option>
              </select>
              {bulkEnterpriseKind === 'staff' && (
                <select
                  value={bulkStaffRole}
                  onChange={(e) => setBulkStaffRole(e.target.value)}
                  disabled={pending}
                  className="rounded-md border border-blue-300 bg-white px-2 py-1 text-sm dark:border-blue-700 dark:bg-zinc-950"
                  aria-label="Staff role"
                >
                  <option value="staff">staff</option>
                  <option value="admin">admin</option>
                  <option value="owner">owner</option>
                </select>
              )}
              <button
                type="button"
                onClick={applyBulkEnterprise}
                disabled={pending || !bulkEnterpriseId}
                className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                title={`Move ${selected.size} user${selected.size === 1 ? '' : 's'} to the selected enterprise (replaces any existing enterprise memberships)`}
              >
                {pending ? 'Applying…' : 'Apply'}
              </button>
              <span className="text-xs text-blue-800/70 dark:text-blue-300/70">
                Replaces existing enterprise memberships
              </span>
            </div>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = anyChecked && !allChecked;
                  }}
                  onChange={toggleAll}
                  aria-label="Select all rows on this page"
                />
              </th>
              <th className="px-3 py-2.5">ID</th>
              <th className="px-3 py-2.5">Name</th>
              <th className="px-3 py-2.5">Email</th>
              <th className="px-3 py-2.5">User Type</th>
              <th className="px-3 py-2.5">Enterprise Role(s)</th>
              <th className="px-3 py-2.5 text-right">Owned</th>
              <th className="px-3 py-2.5 text-right">Support</th>
              <th className="px-3 py-2.5">Created</th>
              <th className="px-3 py-2.5">Last Login</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-3 py-12 text-center text-zinc-500">
                  No users match these filters.
                </td>
              </tr>
            ) : (
              rows.map((u) => {
                const label = userTypeLabel(u.permissionSetName, u.role);
                const tone = userTypeTone(label);
                const isSelected = selected.has(u.id);
                return (
                  <tr
                    key={u.id}
                    className={`border-t border-zinc-100 dark:border-zinc-800 ${isSelected ? 'bg-blue-50/40 dark:bg-blue-950/20' : ''}`}
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(u.id)}
                        aria-label={`Select ${u.fullName ?? u.email}`}
                      />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-zinc-500">{u.id.slice(0, 8)}…</td>
                    <td className="px-3 py-2.5 font-medium">
                      <Link href={`/super-admin/all-users/${u.id}`} className="text-blue-700 hover:underline dark:text-blue-300">
                        {u.fullName ?? '—'}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400">{u.email}</td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_MAP[tone]}`}>
                        {label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {u.enterpriseRoles && u.enterpriseRoles.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {u.enterpriseRoles.map((r, i) => (
                            <span key={i} className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">{r}</span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{Number(u.ownedCount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{Number(u.supportCount)}</td>
                    <td className="px-3 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                      {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${u.isActive ? TONE_MAP.green : TONE_MAP.red}`}>
                        {u.isActive ? 'active' : 'inactive'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <form action={u.isActive ? deactivateUserAction : reactivateUserAction} className="inline">
                        <input type="hidden" name="userId" value={u.id} />
                        <button
                          type="submit"
                          className={`rounded-md border px-2 py-1 text-xs ${
                            u.isActive
                              ? 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40'
                              : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40'
                          }`}
                        >
                          {u.isActive ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
