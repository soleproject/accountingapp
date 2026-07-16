import { requireSession } from '@/lib/auth/session';
import { getPersonalCategories, getPersonalRules } from '@/lib/personal/categories';
import { CategoriesManager } from './_components/CategoriesManager';

export const dynamic = 'force-dynamic';

export default async function PersonalCategoriesPage() {
  const user = await requireSession();
  const [categories, rules] = await Promise.all([
    getPersonalCategories(user.id, true), // include archived; the manager filters
    getPersonalRules(user.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Categories</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Organize spending into categories and groups. Rules auto-categorize future transactions.
        </p>
      </header>
      <CategoriesManager categories={categories} rules={rules} />
    </div>
  );
}
