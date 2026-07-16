import 'server-only';
import { randomUUID } from 'crypto';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  personalCategories,
  personalTransactions,
  personalBudgets,
  personalTransactionRules,
} from '@/db/schema/schema';
import { deriveDefaultCategories } from './pfc';

/**
 * Default category set, derived from the full Plaid PFC detailed taxonomy
 * (lib/personal/pfc.ts) so a new user gets a complete, Monarch-style category
 * list grouped by area. Users can rename, regroup, archive, or add their own.
 */
export const DEFAULT_PERSONAL_CATEGORIES = deriveDefaultCategories();

export interface PersonalCategory {
  id: string;
  name: string;
  groupName: string;
  rollover: boolean;
  sortOrder: number;
  archived: boolean;
}

/**
 * Seed the default categories for a user the first time they need them.
 * Idempotent: the (user_id, name) unique index makes re-runs no-ops, and we
 * only insert when the user has zero categories so a user who deleted a default
 * doesn't get it resurrected.
 */
export async function ensurePersonalCategories(userId: string): Promise<void> {
  const [existing] = await db
    .select({ id: personalCategories.id })
    .from(personalCategories)
    .where(eq(personalCategories.userId, userId))
    .limit(1);
  if (existing) return;

  const now = new Date().toISOString();
  await db
    .insert(personalCategories)
    .values(
      DEFAULT_PERSONAL_CATEGORIES.map((c, i) => ({
        id: randomUUID(),
        userId,
        name: c.name,
        groupName: c.group,
        rollover: false,
        sortOrder: i,
        archived: false,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Ensure a single category exists for a user (idempotent via the (user_id,
 * name) unique index). Used by the promote path so any category derived from a
 * synced transaction's PFC has a registry entry, even if it's not in defaults.
 */
export async function ensureCategory(userId: string, name: string, group: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(personalCategories)
    .values({
      id: randomUUID(),
      userId,
      name: name.trim(),
      groupName: group.trim() || 'Other',
      rollover: false,
      sortOrder: 500,
      archived: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

export async function getPersonalCategories(userId: string, includeArchived = false): Promise<PersonalCategory[]> {
  await ensurePersonalCategories(userId);
  const rows = await db
    .select({
      id: personalCategories.id,
      name: personalCategories.name,
      groupName: personalCategories.groupName,
      rollover: personalCategories.rollover,
      sortOrder: personalCategories.sortOrder,
      archived: personalCategories.archived,
    })
    .from(personalCategories)
    .where(eq(personalCategories.userId, userId))
    .orderBy(asc(personalCategories.sortOrder), asc(personalCategories.name));
  return includeArchived ? rows : rows.filter((r) => !r.archived);
}

export async function createPersonalCategory(args: {
  userId: string;
  name: string;
  groupName: string;
  rollover?: boolean;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(personalCategories)
    .values({
      id: randomUUID(),
      userId: args.userId,
      name: args.name.trim(),
      groupName: args.groupName.trim() || 'Other',
      rollover: args.rollover ?? false,
      sortOrder: 999,
      archived: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/**
 * Update a category. When the name changes, cascade the rename to every place
 * that stores the category by text label (transactions, budgets, rules) so the
 * link isn't broken — we key categories by name, matching personal_budgets.
 */
export async function updatePersonalCategory(args: {
  userId: string;
  id: string;
  name?: string;
  groupName?: string;
  rollover?: boolean;
}): Promise<void> {
  const [current] = await db
    .select({ name: personalCategories.name })
    .from(personalCategories)
    .where(and(eq(personalCategories.id, args.id), eq(personalCategories.userId, args.userId)))
    .limit(1);
  if (!current) return;

  const now = new Date().toISOString();
  const newName = args.name?.trim();
  await db
    .update(personalCategories)
    .set({
      ...(newName ? { name: newName } : {}),
      ...(args.groupName !== undefined ? { groupName: args.groupName.trim() || 'Other' } : {}),
      ...(args.rollover !== undefined ? { rollover: args.rollover } : {}),
      updatedAt: now,
    })
    .where(and(eq(personalCategories.id, args.id), eq(personalCategories.userId, args.userId)));

  if (newName && newName !== current.name) {
    await db
      .update(personalTransactions)
      .set({ category: newName, updatedAt: now })
      .where(and(eq(personalTransactions.userId, args.userId), eq(personalTransactions.category, current.name)));
    await db
      .update(personalBudgets)
      .set({ category: newName, updatedAt: now })
      .where(and(eq(personalBudgets.userId, args.userId), eq(personalBudgets.category, current.name)));
    await db
      .update(personalTransactionRules)
      .set({ categoryName: newName })
      .where(and(eq(personalTransactionRules.userId, args.userId), eq(personalTransactionRules.categoryName, current.name)));
  }
}

export async function archivePersonalCategory(userId: string, id: string, archived: boolean): Promise<void> {
  await db
    .update(personalCategories)
    .set({ archived, updatedAt: new Date().toISOString() })
    .where(and(eq(personalCategories.id, id), eq(personalCategories.userId, userId)));
}

// ---- Rules ----

export interface PersonalRule {
  id: string;
  matchField: string;
  matchOp: string;
  matchValue: string;
  categoryName: string;
}

export async function getPersonalRules(userId: string): Promise<PersonalRule[]> {
  return db
    .select({
      id: personalTransactionRules.id,
      matchField: personalTransactionRules.matchField,
      matchOp: personalTransactionRules.matchOp,
      matchValue: personalTransactionRules.matchValue,
      categoryName: personalTransactionRules.categoryName,
    })
    .from(personalTransactionRules)
    .where(eq(personalTransactionRules.userId, userId))
    .orderBy(asc(personalTransactionRules.createdAt));
}

export async function createPersonalRule(args: {
  userId: string;
  matchValue: string;
  categoryName: string;
  matchField?: 'merchant' | 'description';
  matchOp?: 'contains' | 'equals';
}): Promise<void> {
  await db.insert(personalTransactionRules).values({
    id: randomUUID(),
    userId: args.userId,
    matchField: args.matchField ?? 'merchant',
    matchOp: args.matchOp ?? 'contains',
    matchValue: args.matchValue.trim(),
    categoryName: args.categoryName,
    createdAt: new Date().toISOString(),
  });
}

export async function deletePersonalRule(userId: string, id: string): Promise<void> {
  await db
    .delete(personalTransactionRules)
    .where(and(eq(personalTransactionRules.id, id), eq(personalTransactionRules.userId, userId)));
}

/**
 * Resolve a category from the user's rules for a given merchant/description.
 * First matching rule wins (rules are returned in creation order). Returns the
 * category name or null when nothing matches. Pure given the rules list, so the
 * promote path can fetch rules once and reuse this per transaction.
 */
export function matchRule(
  rules: PersonalRule[],
  fields: { merchant: string | null; description: string | null },
): string | null {
  for (const r of rules) {
    const hay = (r.matchField === 'description' ? fields.description : fields.merchant) ?? '';
    const needle = r.matchValue;
    if (!hay || !needle) continue;
    const h = hay.toLowerCase();
    const n = needle.toLowerCase();
    const hit = r.matchOp === 'equals' ? h === n : h.includes(n);
    if (hit) return r.categoryName;
  }
  return null;
}
