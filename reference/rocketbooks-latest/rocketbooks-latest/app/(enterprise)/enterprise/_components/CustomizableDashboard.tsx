'use client';

import { useState, useTransition, type ReactNode } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  defaultLayout,
  widgetLabel,
  widgetDescription,
  type DashboardLayout,
  type DashboardTab,
  type WidgetSize,
} from '@/lib/enterprise/dashboard-widgets';
import { saveEnterpriseDashboardLayout } from './saveDashboardLayout';

interface Props {
  /** Server-rendered content for each widget, keyed by widget id. */
  nodes: Record<string, ReactNode>;
  /** The user's layout, already reconciled against `nodes` on the server. */
  initialLayout: DashboardLayout;
}

function spanClass(size: WidgetSize): string {
  return size === 'full' ? 'lg:col-span-2' : 'lg:col-span-1';
}

function newTabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/** Read-only grid of widgets for one tab (or the whole flat dashboard). */
function WidgetGrid({
  ids,
  nodes,
  sizes,
}: {
  ids: string[];
  nodes: Record<string, ReactNode>;
  sizes: Record<string, WidgetSize>;
}) {
  if (ids.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
        Nothing here yet. Use <span className="font-medium">Customize</span> to add blocks to this tab.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {ids.map((id) => (
        <div key={id} className={spanClass(sizes[id] ?? 'full')}>
          {nodes[id]}
        </div>
      ))}
    </div>
  );
}

/** Rendered (non-edit) tabbed dashboard. */
function TabbedView({ nodes, layout }: { nodes: Record<string, ReactNode>; layout: DashboardLayout }) {
  const [active, setActive] = useState<string>(layout.tabs[0]?.id ?? '');
  const hiddenSet = new Set(layout.hidden);
  const activeId = layout.tabs.some((t) => t.id === active) ? active : layout.tabs[0]?.id ?? '';

  const idsFor = (tabId: string) =>
    layout.order.filter((id) => !hiddenSet.has(id) && nodes[id] != null && layout.tabOf[id] === tabId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {layout.tabs.map((t) => {
          const count = idsFor(t.id).length;
          const isActive = t.id === activeId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              {t.name}
              {count > 0 && <span className="ml-1.5 text-xs text-zinc-400">{count}</span>}
            </button>
          );
        })}
      </div>
      <WidgetGrid ids={idsFor(activeId)} nodes={nodes} sizes={layout.sizes} />
    </div>
  );
}

/** One draggable wireframe card in the editor grid. */
function SortableCard({
  id,
  size,
  hidden,
  tabs,
  tabId,
  onSetSize,
  onToggleHide,
  onSetTab,
}: {
  id: string;
  size: WidgetSize;
  hidden: boolean;
  tabs: DashboardTab[];
  tabId: string | undefined;
  onSetSize: (id: string, size: WidgetSize) => void;
  onToggleHide: (id: string) => void;
  onSetTab: (id: string, tabId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style} className={`${spanClass(size)} ${isDragging ? 'z-10' : ''}`}>
      <div
        className={`flex h-full flex-col gap-2 rounded-lg border bg-white p-3 dark:bg-zinc-950 ${
          isDragging
            ? 'border-blue-400 shadow-lg ring-2 ring-blue-400/50'
            : 'border-zinc-200 dark:border-zinc-800'
        } ${hidden ? 'opacity-50' : ''}`}
      >
        <div className="flex items-start gap-2">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag ${widgetLabel(id)}`}
            className="mt-0.5 cursor-grab touch-none rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 active:cursor-grabbing dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <circle cx="7" cy="5" r="1.4" /><circle cx="13" cy="5" r="1.4" />
              <circle cx="7" cy="10" r="1.4" /><circle cx="13" cy="10" r="1.4" />
              <circle cx="7" cy="15" r="1.4" /><circle cx="13" cy="15" r="1.4" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{widgetLabel(id)}</div>
            <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{widgetDescription(id)}</div>
          </div>
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <div className="inline-flex overflow-hidden rounded-md border border-zinc-200 text-xs dark:border-zinc-800">
            {(['half', 'full'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSetSize(id, s)}
                className={`px-2 py-1 font-medium ${
                  size === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-zinc-600 hover:bg-zinc-50 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
                }`}
              >
                {s === 'half' ? 'Half' : 'Full'}
              </button>
            ))}
          </div>

          {tabs.length > 0 && (
            <select
              value={tabId ?? tabs[0]?.id}
              onChange={(e) => onSetTab(id, e.target.value)}
              aria-label={`Tab for ${widgetLabel(id)}`}
              className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
            >
              {tabs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={() => onToggleHide(id)}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {hidden ? 'Show' : 'Hide'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CustomizableDashboard({ nodes, initialLayout }: Props) {
  const available = Object.keys(nodes);
  const [layout, setLayout] = useState<DashboardLayout>(initialLayout);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardLayout>(initialLayout);
  const [pending, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function openEditor() {
    setDraft(layout);
    setEditing(true);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setDraft((d) => {
      const from = d.order.indexOf(String(active.id));
      const to = d.order.indexOf(String(over.id));
      if (from < 0 || to < 0) return d;
      return { ...d, order: arrayMove(d.order, from, to) };
    });
  }

  function setSize(id: string, size: WidgetSize) {
    setDraft((d) => ({ ...d, sizes: { ...d.sizes, [id]: size } }));
  }

  function toggleHidden(id: string) {
    setDraft((d) => ({
      ...d,
      hidden: d.hidden.includes(id) ? d.hidden.filter((x) => x !== id) : [...d.hidden, id],
    }));
  }

  function setTabOf(id: string, tabId: string) {
    setDraft((d) => ({ ...d, tabOf: { ...d.tabOf, [id]: tabId } }));
  }

  function enableTabs() {
    setDraft((d) => {
      if (d.tabs.length > 0) return d;
      const tab: DashboardTab = { id: newTabId(), name: 'Main' };
      const tabOf: Record<string, string> = {};
      for (const id of d.order) tabOf[id] = tab.id;
      return { ...d, tabs: [tab], tabOf };
    });
  }

  function disableTabs() {
    setDraft((d) => ({ ...d, tabs: [], tabOf: {} }));
  }

  function addTab() {
    setDraft((d) => ({ ...d, tabs: [...d.tabs, { id: newTabId(), name: `Tab ${d.tabs.length + 1}` }] }));
  }

  function renameTab(tabId: string, name: string) {
    setDraft((d) => ({ ...d, tabs: d.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)) }));
  }

  function deleteTab(tabId: string) {
    setDraft((d) => {
      const remaining = d.tabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) return { ...d, tabs: [], tabOf: {} };
      const fallback = remaining[0].id;
      const tabOf = { ...d.tabOf };
      for (const id of Object.keys(tabOf)) if (tabOf[id] === tabId) tabOf[id] = fallback;
      return { ...d, tabs: remaining, tabOf };
    });
  }

  function resetDefault() {
    setDraft(defaultLayout(available));
  }

  function save() {
    startTransition(async () => {
      await saveEnterpriseDashboardLayout(draft);
      setLayout(draft);
      setEditing(false);
    });
  }

  const hiddenSet = new Set(layout.hidden);
  const visible = layout.order.filter((id) => !hiddenSet.has(id) && nodes[id] != null);
  const tabsOn = draft.tabs.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-end">
        {!editing ? (
          <button
            type="button"
            onClick={openEditor}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M7 3a1 1 0 0 1 2 0v1h2V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v1H3V6a2 2 0 0 1 2-2h2V3Zm10 6v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9h14Z" />
            </svg>
            Customize
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resetDefault}
              disabled={pending}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Reset to default
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={pending}
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save layout'}
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
          {/* Tab management */}
          <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={tabsOn}
                onChange={(e) => (e.target.checked ? enableTabs() : disableTabs())}
                className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500 dark:border-zinc-700"
              />
              Organize into tabs
            </label>
            {tabsOn && (
              <div className="mt-3 flex flex-col gap-2">
                {draft.tabs.map((t) => (
                  <div key={t.id} className="flex items-center gap-2">
                    <input
                      value={t.name}
                      onChange={(e) => renameTab(t.id, e.target.value)}
                      placeholder="Tab name"
                      className="w-48 rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                    />
                    <button
                      type="button"
                      onClick={() => deleteTab(t.id)}
                      className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      Delete
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addTab}
                  className="self-start rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  + Add tab
                </button>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-4 py-2.5 text-xs text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
            Drag the <span className="font-medium">⋮⋮</span> handle to reorder. Set each block to <span className="font-medium">Half</span> or <span className="font-medium">Full</span> width{tabsOn ? ', pick its tab,' : ''} and hide what you don&apos;t use. This view is yours alone.
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={draft.order} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {draft.order
                  .filter((id) => nodes[id] != null)
                  .map((id) => (
                    <SortableCard
                      key={id}
                      id={id}
                      size={draft.sizes[id] ?? 'full'}
                      hidden={draft.hidden.includes(id)}
                      tabs={draft.tabs}
                      tabId={draft.tabOf[id]}
                      onSetSize={setSize}
                      onToggleHide={toggleHidden}
                      onSetTab={setTabOf}
                    />
                  ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      ) : layout.tabs.length > 0 ? (
        <TabbedView nodes={nodes} layout={layout} />
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
          Every block is hidden. Use <span className="font-medium">Customize</span> to bring some back.
        </div>
      ) : (
        <WidgetGrid ids={visible} nodes={nodes} sizes={layout.sizes} />
      )}
    </div>
  );
}
