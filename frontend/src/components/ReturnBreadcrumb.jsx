/**
 * ReturnBreadcrumb — small "← Back to <label>" link rendered at the top
 * of any destination page that supports being deep-linked into from a
 * responsibilities panel (Client Cockpit / To Do).
 *
 * Reads `return_to` (path) and `return_label` (display text) from the
 * URL query params. Renders nothing when neither is present, so it's
 * safe to drop on any page unconditionally.
 *
 * The responsibilities panel's `buildOpenHref` and the inline tiles
 * (Reconciliation, Month Close, etc.) all pass these params through, so
 * a client landing on `/accounting/reconciliation?month=2026-09&return_to=/cockpit/client&return_label=Back+to+Client+Cockpit`
 * sees the breadcrumb and can pop back in one click.
 */
import React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

export default function ReturnBreadcrumb() {
  const [params] = useSearchParams();
  const to = params.get("return_to");
  const label = params.get("return_label");
  if (!to) return null;
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 hover:underline mb-2"
      data-testid="return-breadcrumb"
    >
      <ChevronLeft size={13} />
      {label || "Back"}
    </Link>
  );
}
