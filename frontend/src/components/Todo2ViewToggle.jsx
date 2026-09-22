import React from "react";
import { emitAction } from "@/lib/createBus";

/**
 * Todo2ViewToggle — small "Menu | Page" pill used on the To Do page,
 * Client Cockpit, and inside the sidebar's To Do 2 card mode. Keeps
 * one control the user can flip regardless of which surface they're
 * currently looking at.
 *
 * Props:
 *   mode       — "menu" (sidebar cards are showing) or "page" (this
 *                page is the source of truth).
 *   returnPath — the page path to send the user back to when they
 *                click "Page" from the sidebar's Todo2CardList. The
 *                sidebar reads this via the `todo2-open` action
 *                payload.
 *
 * Behavior:
 *   - Clicking "Menu" from a page fires `todo2-open` — Sidebar picks
 *     it up and swaps its nav for the Todo2CardList.
 *   - Clicking "Page" is a no-op here (the page is already showing).
 *     The equivalent toggle inside Todo2CardList handles the reverse
 *     flip (navigate + `todo2-close`).
 */
export default function Todo2ViewToggle({ mode = "page", returnPath = "/accounting/todo" }) {
  const activeCls = "px-2.5 py-1 bg-slate-900 text-white font-semibold";
  const idleCls   = "px-2.5 py-1 text-slate-700 hover:bg-slate-50";
  return (
    <div
      className="inline-flex rounded-md border border-slate-300 overflow-hidden text-[11px] bg-white"
      data-testid="todo2-view-toggle"
      role="tablist"
      aria-label="Task list view"
    >
      <button
        type="button"
        onClick={() => { if (mode !== "menu") emitAction("todo2-open", { returnPath }); }}
        className={mode === "menu" ? activeCls : `${idleCls} border-r border-slate-300`}
        data-testid="todo2-view-toggle-menu"
        aria-pressed={mode === "menu"}
      >Menu</button>
      <button
        type="button"
        onClick={() => { /* page view is intrinsic — no-op from here */ }}
        className={mode === "page" ? activeCls : idleCls}
        data-testid="todo2-view-toggle-page"
        aria-pressed={mode === "page"}
      >Page</button>
    </div>
  );
}
