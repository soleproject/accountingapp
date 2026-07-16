import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';

export interface DeleteOrgResult {
  organizationId: string;
  organizationName: string;
  totalRowsDeleted: number;
  perTable: Record<string, number>;
}

/**
 * Hard delete an organization and EVERY row that belongs to it across the
 * whole schema. This is a destructive nuclear operation — the caller must
 * be 100% sure the user wants it.
 *
 * Strategy:
 *   1. Open a single transaction
 *   2. Set session_replication_role = 'replica' so FK checks don't fire
 *      (lets us delete in any order without orphan errors mid-transaction)
 *   3. Discover every table that has an organization_id or org_id column
 *      and DELETE WHERE that = orgId
 *   4. Clean the few tables that link via a non-standard column (plaid_accounts.linked_organization_id)
 *   5. Clean orphaned children whose parents we just deleted (journal_entry_lines,
 *      general_ledger, invoice_lines, plaid_raw_transactions, etc.)
 *   6. DELETE FROM organizations
 *   7. Restore session_replication_role and commit
 *
 * Requires the connection role to have permission to set session_replication_role.
 * In Supabase the postgres role does.
 */
export async function deleteOrganizationCascade(orgId: string): Promise<DeleteOrgResult> {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error('Organization not found');

  const perTable: Record<string, number> = {};

  await db.transaction(async (tx) => {
    // Defer FK checks. session_replication_role=replica makes Postgres skip
    // user triggers including FK constraint triggers.
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);

    // Step 1: clean orphan-prone children of org-scoped tables BEFORE we
    //         delete the parents. With FK checks off this isn't strictly
    //         required for the transaction to succeed, but it leaves
    //         no dangling rows after we restore session_replication_role.
    const orphanCleanups: Array<{ name: string; sql: ReturnType<typeof sql> }> = [
      {
        name: 'general_ledger (by JE)',
        sql: sql`DELETE FROM general_ledger WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id = ${orgId})`,
      },
      {
        name: 'journal_entry_lines',
        sql: sql`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id = ${orgId})`,
      },
      {
        name: 'invoice_lines',
        sql: sql`DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${orgId})`,
      },
      {
        name: 'invoice_payment_applications',
        sql: sql`DELETE FROM invoice_payment_applications WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${orgId})`,
      },
      {
        name: 'plaid_raw_transactions',
        sql: sql`DELETE FROM plaid_raw_transactions WHERE plaid_account_id IN (SELECT id FROM plaid_accounts WHERE linked_organization_id = ${orgId})`,
      },
    ];
    for (const c of orphanCleanups) {
      try {
        const result = await tx.execute(c.sql);
        const n =
          (result as { rowCount?: number; rowsAffected?: number }).rowCount ??
          (result as { rowCount?: number; rowsAffected?: number }).rowsAffected ??
          0;
        if (n > 0) perTable[c.name] = n;
      } catch {
        // table may not exist in some envs — keep going
      }
    }

    // Tables we never delete from in the cascade — even though they may
    // have an organization_id column. The 'users' table has organization_id
    // as a back-pointer to the user's primary org; deleting user rows here
    // would nuke the deleting user themselves.
    const TABLE_SAFELIST = new Set<string>(['users', 'organizations']);

    // Step 2: delete from every public table with an organization_id column
    const orgIdRows = await tx.execute(sql`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'organization_id' AND table_schema = 'public'
    `);
    const orgIdTables = (orgIdRows as Array<{ table_name: string }> | { rows?: Array<{ table_name: string }> });
    const orgIdList: string[] = Array.isArray(orgIdTables)
      ? orgIdTables.map((r) => r.table_name)
      : (orgIdTables.rows ?? []).map((r) => r.table_name);

    for (const tableName of orgIdList) {
      if (TABLE_SAFELIST.has(tableName)) continue;
      try {
        const r = await tx.execute(
          sql.raw(`DELETE FROM "${tableName}" WHERE organization_id = '${orgId.replace(/'/g, "''")}'`),
        );
        const n =
          (r as { rowCount?: number; rowsAffected?: number }).rowCount ??
          (r as { rowCount?: number; rowsAffected?: number }).rowsAffected ??
          0;
        if (n > 0) perTable[tableName] = (perTable[tableName] ?? 0) + n;
      } catch (err) {
        throw new Error(`Failed deleting from ${tableName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Users had this org as their primary or active org — clear those
    // pointers to NULL so they don't dangle. The user who initiated the
    // delete is repointed by the caller (deleteBusinessAction) right after.
    await tx.execute(sql`
      UPDATE users
      SET organization_id = NULL,
          active_organization_id = NULL
      WHERE organization_id = ${orgId} OR active_organization_id = ${orgId}
    `);

    // Step 3: tables that use a different column name. org_id is used by the
    //         onboarding tables.
    const orgIdAltRows = await tx.execute(sql`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'org_id' AND table_schema = 'public'
    `);
    const orgIdAlt = (orgIdAltRows as Array<{ table_name: string }> | { rows?: Array<{ table_name: string }> });
    const orgIdAltList: string[] = Array.isArray(orgIdAlt)
      ? orgIdAlt.map((r) => r.table_name)
      : (orgIdAlt.rows ?? []).map((r) => r.table_name);
    for (const tableName of orgIdAltList) {
      try {
        const r = await tx.execute(
          sql.raw(`DELETE FROM "${tableName}" WHERE org_id = '${orgId.replace(/'/g, "''")}'`),
        );
        const n =
          (r as { rowCount?: number; rowsAffected?: number }).rowCount ??
          (r as { rowCount?: number; rowsAffected?: number }).rowsAffected ??
          0;
        if (n > 0) perTable[tableName] = (perTable[tableName] ?? 0) + n;
      } catch (err) {
        throw new Error(`Failed deleting from ${tableName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 4: special-case columns that don't fit the patterns above
    const specials: Array<{ table: string; sql: ReturnType<typeof sql> }> = [
      {
        table: 'plaid_accounts',
        sql: sql`DELETE FROM plaid_accounts WHERE linked_organization_id = ${orgId}`,
      },
    ];
    for (const s of specials) {
      try {
        const r = await tx.execute(s.sql);
        const n =
          (r as { rowCount?: number; rowsAffected?: number }).rowCount ??
          (r as { rowCount?: number; rowsAffected?: number }).rowsAffected ??
          0;
        if (n > 0) perTable[s.table] = (perTable[s.table] ?? 0) + n;
      } catch (err) {
        throw new Error(`Failed deleting from ${s.table}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 5: finally the org itself
    const orgDel = await tx.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
    const orgN =
      (orgDel as { rowCount?: number; rowsAffected?: number }).rowCount ??
      (orgDel as { rowCount?: number; rowsAffected?: number }).rowsAffected ??
      0;
    perTable['organizations'] = orgN;

    // Restore replication role for the rest of the connection lifetime.
    await tx.execute(sql`SET LOCAL session_replication_role = 'origin'`);
  });

  const totalRowsDeleted = Object.values(perTable).reduce((s, n) => s + n, 0);
  return {
    organizationId: orgId,
    organizationName: org.name,
    totalRowsDeleted,
    perTable,
  };
}
