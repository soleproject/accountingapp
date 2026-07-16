import { AllUsersTable } from './AllUsersTable';

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

interface EnterpriseLink {
  userId: string;
  enterpriseId: string;
  enterpriseName: string;
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
  links: EnterpriseLink[];
  permissionSets: PermissionSetOption[];
  enterprises?: EnterpriseOption[];
}

export function GroupedByEnterpriseUsers({ rows, links, permissionSets, enterprises }: Props) {
  const byId = new Map(rows.map((r) => [r.id, r]));

  // enterpriseId → { name, userIds }
  const groups = new Map<string, { name: string; userIds: Set<string> }>();
  const linkedUserIds = new Set<string>();
  for (const link of links) {
    if (!byId.has(link.userId)) continue;
    linkedUserIds.add(link.userId);
    const g = groups.get(link.enterpriseId);
    if (g) {
      g.userIds.add(link.userId);
    } else {
      groups.set(link.enterpriseId, {
        name: link.enterpriseName,
        userIds: new Set([link.userId]),
      });
    }
  }

  const orderedGroups = Array.from(groups.entries())
    .map(([id, g]) => ({ id, name: g.name, userIds: Array.from(g.userIds) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const orphanRows = rows.filter((r) => !linkedUserIds.has(r.id));

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-zinc-200 px-3 py-12 text-center text-sm text-zinc-500 dark:border-zinc-800">
        No users match these filters.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {orderedGroups.map((g) => {
        const groupRows = g.userIds
          .map((id) => byId.get(id))
          .filter((r): r is UserRow => Boolean(r));
        return (
          <section key={g.id}>
            <h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {g.name}
              <span className="text-xs font-normal text-zinc-500">
                ({groupRows.length} user{groupRows.length === 1 ? '' : 's'})
              </span>
            </h3>
            <AllUsersTable rows={groupRows} permissionSets={permissionSets} enterprises={enterprises} />
          </section>
        );
      })}

      {orphanRows.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            No Enterprise
            <span className="text-xs font-normal text-zinc-500">
              ({orphanRows.length} user{orphanRows.length === 1 ? '' : 's'})
            </span>
          </h3>
          <AllUsersTable rows={orphanRows} permissionSets={permissionSets} enterprises={enterprises} />
        </section>
      )}
    </div>
  );
}
