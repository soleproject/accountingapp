'use server';

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import {
  getCategoryBreakdown,
  getCategoryDetail,
  type CategoryBreakdown,
  type CategoryDetail,
} from '@/lib/personal/reports';

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RANGE = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), period: z.enum(['this_month', 'last_month', 'last_30_days', 'this_year', 'all']) }),
  z.object({ kind: z.literal('custom'), start: ISO, end: ISO }),
]);

export async function fetchBreakdownAction(range: unknown): Promise<CategoryBreakdown> {
  const user = await requireSession();
  return getCategoryBreakdown(user.id, RANGE.parse(range), new Date());
}

export async function fetchCategoryDetailAction(input: unknown): Promise<CategoryDetail> {
  const user = await requireSession();
  const { range, category } = z.object({ range: RANGE, category: z.string().min(1).max(120) }).parse(input);
  return getCategoryDetail(user.id, range, category, new Date());
}
